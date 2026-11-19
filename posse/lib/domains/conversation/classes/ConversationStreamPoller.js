// Live conversation_entry upserts (posse.agent_conversation.v1 §3.3).
//
// Cursors run over the durable tables, not the ~20-row events tail: agent
// interactions by (updated_at, id), job_observations by id, human_gates by
// (updated_at, gate_job_id), and jobs, attempts and agent calls for markers
// and boundaries. Each poll rebuilds the touched entries, drops unchanged
// ones, and coalesces tool-group upserts to one per entry per interval.
// Frames are hints and always use the remote tier: they fan out to the relay,
// LAN and Bossy sockets alike. Clients re-fetch the page after reconnecting.
import {
  AGENT_CONVERSATION_BOUNDS as BOUNDS,
  AGENT_CONVERSATION_ENTRY_KIND as KIND,
  AGENT_CONVERSATION_LIVE_COALESCE_MS,
  AGENT_CONVERSATION_PROTOCOL,
  AGENT_CONVERSATION_TIER,
} from "../../../catalog/agent-conversation.js";
import { BACKGROUND_JOB_TYPES } from "../../../catalog/job.js";
import { AGENT_COMMENTARY_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import {
  agentMessageEntry,
  fitConversationEntry,
  gateEntry,
  jobMarkerEntry,
  operatorMessageEntry,
  toolGroupEntry,
} from "../functions/conversation-entries.js";
import { computeJobToolGroups, isAgentMessageInteraction } from "../functions/tool-group-store.js";
import { isVisibleToolGroup } from "../functions/tool-groups.js";

const BATCH = 250;
const MAX_REMEMBERED = 5000;
// Room for the frame envelope so a whole event frame stays within ENTRY_BYTES.
const FRAME_ENTRY_BYTES = BOUNDS.ENTRY_BYTES - 512;
const NON_AGENT_JOB_TYPES = new Set(["human_input", ...BACKGROUND_JOB_TYPES]);

function cursorAfter(cursor, row, timeKey, idKey) {
  return { at: String(row[timeKey] || cursor.at), id: Number(row[idKey] || 0) };
}

export class ConversationStreamPoller {
  constructor({
    db,
    coalesceMs = AGENT_CONVERSATION_LIVE_COALESCE_MS,
    observedAt = () => new Date().toISOString(),
  } = {}) {
    this.db = db;
    this.coalesceMs = Math.max(0, Number(coalesceMs) || 0);
    this.observedAt = observedAt;
    this.interactionCursor = { at: "", id: 0 };
    this.gateCursor = { at: "", id: 0 };
    this.jobCursor = { at: "", id: 0 };
    this.observationCursor = 0;
    this.callCursor = { id: 0, finishedAt: "" };
    this.attemptCursor = { id: 0, finishedAt: "" };
    this.sent = new Map();
    this.pending = new Map();
  }

  maxValue(sql) {
    try { return this.db.prepare(sql).get() || {}; } catch { return {}; }
  }

  seed() {
    const interaction = this.maxValue("SELECT updated_at AS at, id FROM agent_interactions ORDER BY updated_at DESC, id DESC LIMIT 1");
    this.interactionCursor = { at: String(interaction.at || ""), id: Number(interaction.id || 0) };
    const gate = this.maxValue("SELECT updated_at AS at, gate_job_id AS id FROM human_gates ORDER BY updated_at DESC, gate_job_id DESC LIMIT 1");
    this.gateCursor = { at: String(gate.at || ""), id: Number(gate.id || 0) };
    const job = this.maxValue("SELECT updated_at AS at, id FROM jobs ORDER BY updated_at DESC, id DESC LIMIT 1");
    this.jobCursor = { at: String(job.at || ""), id: Number(job.id || 0) };
    this.observationCursor = Number(this.maxValue("SELECT COALESCE(MAX(id), 0) AS id FROM job_observations").id || 0);
    const call = this.maxValue("SELECT COALESCE(MAX(id), 0) AS id, COALESCE(MAX(finished_at), '') AS finished FROM agent_calls");
    this.callCursor = { id: Number(call.id || 0), finishedAt: String(call.finished || "") };
    const attempt = this.maxValue("SELECT COALESCE(MAX(id), 0) AS id, COALESCE(MAX(finished_at), '') AS finished FROM job_attempts");
    this.attemptCursor = { id: Number(attempt.id || 0), finishedAt: String(attempt.finished || "") };
  }

  collectChanges() {
    const dirty = { interactions: new Set(), groupJobs: new Set(), gates: new Set(), markerJobs: new Set() };
    const rows = (sql, ...params) => { try { return this.db.prepare(sql).all(...params); } catch { return []; } };
    for (const row of rows(`
      SELECT id, job_id, kind, updated_at,
             json_extract(metadata_json, '$.work_item_action.target.question_id') AS question_id
      FROM agent_interactions
      WHERE (updated_at > ? OR (updated_at = ? AND id > ?)) AND kind IN ('activity', 'nudge', 'approval')
      ORDER BY updated_at, id LIMIT ?
    `, this.interactionCursor.at, this.interactionCursor.at, this.interactionCursor.id, BATCH)) {
      this.interactionCursor = cursorAfter(this.interactionCursor, row, "updated_at", "id");
      if (row.kind === "approval") {
        // A reserved or applied question.answer moves its gate's state.
        const gateJob = /^gate:([1-9]\d*):/u.exec(String(row.question_id || ""))?.[1];
        if (gateJob) dirty.gates.add(Number(gateJob));
        continue;
      }
      dirty.interactions.add(Number(row.id));
      if (row.kind === "activity" && row.job_id != null) dirty.groupJobs.add(Number(row.job_id));
    }
    for (const row of rows(`
      SELECT id, job_id FROM job_observations
      WHERE id > ? AND (observation_type LIKE 'tool.%' OR observation_type = ?)
      ORDER BY id LIMIT ?
    `, this.observationCursor, AGENT_COMMENTARY_OBSERVATION_TYPE, BATCH * 4)) {
      this.observationCursor = Math.max(this.observationCursor, Number(row.id));
      if (row.job_id != null) dirty.groupJobs.add(Number(row.job_id));
    }
    for (const row of rows(`
      SELECT gate_job_id, original_job_id, updated_at FROM human_gates
      WHERE updated_at > ? OR (updated_at = ? AND gate_job_id > ?)
      ORDER BY updated_at, gate_job_id LIMIT ?
    `, this.gateCursor.at, this.gateCursor.at, this.gateCursor.id, BATCH)) {
      this.gateCursor = cursorAfter(this.gateCursor, row, "updated_at", "gate_job_id");
      dirty.gates.add(Number(row.gate_job_id));
      if (row.original_job_id != null) dirty.groupJobs.add(Number(row.original_job_id));
    }
    for (const row of rows(`
      SELECT id, job_type, updated_at FROM jobs
      WHERE updated_at > ? OR (updated_at = ? AND id > ?)
      ORDER BY updated_at, id LIMIT ?
    `, this.jobCursor.at, this.jobCursor.at, this.jobCursor.id, BATCH)) {
      this.jobCursor = cursorAfter(this.jobCursor, row, "updated_at", "id");
      if (row.job_type === "human_input") dirty.gates.add(Number(row.id));
      else if (!BACKGROUND_JOB_TYPES.has(row.job_type)) {
        dirty.markerJobs.add(Number(row.id));
        dirty.groupJobs.add(Number(row.id));
      }
    }
    for (const row of rows(`
      SELECT id, job_id, finished_at FROM agent_calls
      WHERE id > ? OR finished_at > ? ORDER BY id LIMIT ?
    `, this.callCursor.id, this.callCursor.finishedAt, BATCH)) {
      this.callCursor = {
        id: Math.max(this.callCursor.id, Number(row.id)),
        finishedAt: row.finished_at && row.finished_at > this.callCursor.finishedAt ? row.finished_at : this.callCursor.finishedAt,
      };
      if (row.job_id != null) dirty.groupJobs.add(Number(row.job_id));
    }
    for (const row of rows(`
      SELECT id, job_id, finished_at FROM job_attempts
      WHERE id > ? OR finished_at > ? ORDER BY id LIMIT ?
    `, this.attemptCursor.id, this.attemptCursor.finishedAt, BATCH)) {
      this.attemptCursor = {
        id: Math.max(this.attemptCursor.id, Number(row.id)),
        finishedAt: row.finished_at && row.finished_at > this.attemptCursor.finishedAt ? row.finished_at : this.attemptCursor.finishedAt,
      };
      dirty.markerJobs.add(Number(row.job_id));
    }
    return dirty;
  }

  agentJob(jobId) {
    try {
      const job = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
      return job && job.work_item_id != null && !NON_AGENT_JOB_TYPES.has(job.job_type) ? job : null;
    } catch {
      return null;
    }
  }

  groupsForJob(jobId, cache) {
    if (!cache.has(jobId)) {
      let computed = null;
      try { computed = this.agentJob(jobId) ? computeJobToolGroups(this.db, jobId) : null; } catch { computed = null; }
      cache.set(jobId, computed?.groups || []);
    }
    return cache.get(jobId);
  }

  buildEntries(dirty, observedAt) {
    const built = [];
    const groupCache = new Map();
    const add = (build) => {
      try {
        const entry = build();
        if (entry) built.push(entry);
      } catch {
        // One malformed source row never blocks the other entries.
      }
    };
    for (const jobId of dirty.groupJobs) {
      for (const group of this.groupsForJob(jobId, groupCache)) {
        if (isVisibleToolGroup(group)) add(() => toolGroupEntry({ group, tier: AGENT_CONVERSATION_TIER.REMOTE }));
      }
    }
    const interaction = this.db.prepare(`
      SELECT ai.*, jobs.job_type, jobs.status AS job_status,
             calls.role AS call_role, calls.parent_agent_call_id AS call_parent_agent_call_id
      FROM agent_interactions ai
      LEFT JOIN jobs ON jobs.id = ai.job_id
      LEFT JOIN agent_calls calls ON calls.id = ai.agent_call_id
      WHERE ai.id = ? AND ai.work_item_id IS NOT NULL
    `);
    for (const interactionId of dirty.interactions) {
      add(() => {
        const row = interaction.get(interactionId);
        if (!row) return null;
        if (row.kind === "nudge" && row.direction === "user_to_agent") {
          const fallback = this.db.prepare(`
            SELECT MIN(id) AS id FROM agent_interactions
            WHERE job_id IS ? AND id > ? AND kind = 'nudge' AND direction = 'user_to_agent'
          `).get(row.job_id, row.id)?.id ?? null;
          return operatorMessageEntry({ row, observedAt, supersededByFallback: fallback });
        }
        if (row.kind !== "activity" || row.direction !== "agent_to_user" || !isAgentMessageInteraction(row)) return null;
        const group = row.job_id == null ? null : this.groupsForJob(Number(row.job_id), groupCache)
          .find((candidate) => candidate.closing_entry_id === `msg:${row.id}` && isVisibleToolGroup(candidate));
        return agentMessageEntry({ row, toolGroupId: group?.group_id ?? null });
      });
    }
    const gate = this.db.prepare(`
      SELECT jobs.*,
             hg.gate_state AS hg_gate_state, hg.generation AS hg_generation,
             hg.original_job_id AS hg_original_job_id, hg.resolution_action AS hg_resolution_action,
             hg.resolution_payload_json AS hg_resolution_payload_json, hg.resolved_at AS hg_resolved_at,
             hg.created_at AS hg_created_at, hg.updated_at AS hg_updated_at
      FROM jobs LEFT JOIN human_gates hg ON hg.gate_job_id = jobs.id
      WHERE jobs.id = ? AND jobs.job_type = 'human_input' AND jobs.work_item_id IS NOT NULL
    `);
    for (const gateJobId of dirty.gates) {
      add(() => {
        const gateJob = gate.get(gateJobId);
        if (!gateJob) return null;
        const originalId = gateJob.hg_original_job_id == null ? null : Number(gateJob.hg_original_job_id);
        const group = originalId == null ? null : this.groupsForJob(originalId, groupCache)
          .find((candidate) => candidate.closing_entry_id === `gate:${gateJobId}` && isVisibleToolGroup(candidate));
        return gateEntry({
          db: this.db,
          gateJob,
          observedAt,
          toolGroupId: group?.group_id ?? null,
          originalJob: originalId == null ? null : this.agentJob(originalId),
        });
      });
    }
    const attempts = this.db.prepare("SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number, id");
    const firstCall = this.db.prepare(`
      SELECT provider, model_name, model_tier FROM agent_calls
      WHERE attempt_id = ? AND parent_agent_call_id IS NULL ORDER BY id LIMIT 1
    `);
    for (const jobId of dirty.markerJobs) {
      const job = this.agentJob(jobId);
      if (!job) continue;
      for (const attempt of attempts.all(jobId)) {
        add(() => jobMarkerEntry({ job, attempt, firstCall: firstCall.get(attempt.id) || null }));
      }
    }
    return built;
  }

  remember(entry, nowMs) {
    this.sent.set(entry.entry_id, { json: JSON.stringify(entry), at: nowMs });
    if (this.sent.size > MAX_REMEMBERED) this.sent.delete(this.sent.keys().next().value);
  }

  /** Payloads to emit as conversation_entry events, oldest first. */
  poll(nowMs = Date.now()) {
    if (!this.db) return [];
    const observedAt = this.observedAt();
    let built;
    try {
      built = this.buildEntries(this.collectChanges(), observedAt);
    } catch {
      // Frames are hints over durable state: a schema the poller cannot read
      // (an older or minimal database) yields no frames rather than failures.
      return [];
    }
    const ready = [];
    for (const raw of built) {
      const entry = fitConversationEntry(raw, FRAME_ENTRY_BYTES);
      if (!entry) continue;
      const previous = this.sent.get(entry.entry_id);
      if (previous && previous.json === JSON.stringify(entry)) {
        this.pending.delete(entry.entry_id);
        continue;
      }
      if (entry.kind === KIND.TOOL_GROUP && previous && nowMs - previous.at < this.coalesceMs) {
        this.pending.set(entry.entry_id, entry);
        continue;
      }
      this.pending.delete(entry.entry_id);
      ready.push(entry);
    }
    for (const [entryId, entry] of this.pending) {
      if (nowMs - (this.sent.get(entryId)?.at ?? 0) < this.coalesceMs) continue;
      this.pending.delete(entryId);
      ready.push(entry);
    }
    ready.sort((left, right) => (left.order_key < right.order_key ? -1 : left.order_key > right.order_key ? 1 : 0));
    return ready.map((entry) => {
      this.remember(entry, nowMs);
      return { protocol: AGENT_CONVERSATION_PROTOCOL, work_item_id: entry.work_item_id, op: "upsert", entry };
    });
  }
}
