// projectAgentConversation: one Work Item's chat-style conversation
// (posse.agent_conversation.v1 §3). Entries come from durable sources merged
// by order_key with a per-source limit: agent and operator interactions,
// gates, attempt markers, snapshotted tool groups of finished jobs, and live
// groups of running jobs. One malformed source row is skipped; the page does
// not fail. The newest page comes first; entries are oldest → newest.
import {
  AGENT_CONVERSATION_BOUNDS as BOUNDS,
  AGENT_CONVERSATION_PROTOCOL,
  AGENT_CONVERSATION_TIER,
} from "../../../catalog/agent-conversation.js";
import { BACKGROUND_JOB_TYPES } from "../../../catalog/job.js";
import { FEEDBACK_PHASES, FEEDBACK_STATUSES } from "../../../catalog/work-item-interactions.js";
import { decodeConversationCursor, encodeConversationCursor } from "./conversation-cursor.js";
import {
  agentMessageEntry,
  fitConversationEntry,
  gateEntry,
  jobMarkerEntry,
  operatorMessageEntry,
  toolGroupEntry,
  unretainedToolGroupEntry,
} from "./conversation-entries.js";
import { computeJobToolGroups, isTerminalJob, readPersistedJobToolGroups } from "./tool-group-store.js";
import { isVisibleToolGroup } from "./tool-groups.js";

const SOURCE_SLACK = 16;
const NON_AGENT_JOB_TYPES = new Set(["human_input", ...BACKGROUND_JOB_TYPES]);
const FEEDBACK_PHASE_SQL = [...FEEDBACK_PHASES].map((value) => `'${value}'`).join(",");
const FEEDBACK_STATUS_SQL = [...FEEDBACK_STATUSES].map((value) => `'${value}'`).join(",");
const MAX_TIME = "9999-12-31T23:59:59.999Z";

function positiveId(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : NaN;
}

function safely(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

function beforeTime(beforeKey) {
  return beforeKey ? beforeKey.split("|")[0] : MAX_TIME;
}

function olderThan(entry, beforeKey) {
  return !beforeKey || entry.order_key < beforeKey;
}

function jobsForWorkItem(db, workItemId) {
  return db.prepare(`
    SELECT * FROM jobs WHERE work_item_id = ? ORDER BY id
  `).all(workItemId);
}

function agentJobs(jobs) {
  return jobs.filter((job) => !NON_AGENT_JOB_TYPES.has(job.job_type));
}

function markerEntries(db, { jobs, filter, beforeKey, fetchLimit }) {
  if (filter.agentCallId != null) return [];
  const byId = new Map(agentJobs(jobs).map((job) => [Number(job.id), job]));
  const ids = [...byId.keys()].filter((jobId) => filter.jobId == null || jobId === filter.jobId);
  if (ids.length === 0) return [];
  const attempts = db.prepare(`
    SELECT * FROM job_attempts
    WHERE job_id IN (${ids.map(() => "?").join(",")}) AND started_at <= ?
    ORDER BY started_at DESC, id DESC LIMIT ?
  `).all(...ids, beforeTime(beforeKey), fetchLimit);
  const firstCall = db.prepare(`
    SELECT provider, model_name, model_tier FROM agent_calls
    WHERE attempt_id = ? AND parent_agent_call_id IS NULL ORDER BY id LIMIT 1
  `);
  return attempts.map((attempt) => safely(() => jobMarkerEntry({
    job: byId.get(Number(attempt.job_id)),
    attempt,
    firstCall: firstCall.get(attempt.id) || null,
  }))).filter(Boolean);
}

function interactionRows(db, { workItemId, filter, beforeKey, fetchLimit, kind }) {
  const agentMessages = kind === "agent_message";
  return db.prepare(`
    SELECT ai.*, jobs.job_type, jobs.status AS job_status,
           calls.role AS call_role, calls.parent_agent_call_id AS call_parent_agent_call_id
    FROM agent_interactions ai
    LEFT JOIN jobs ON jobs.id = ai.job_id
    LEFT JOIN agent_calls calls ON calls.id = ai.agent_call_id
    WHERE ai.work_item_id = ?
      AND ${agentMessages
    ? `ai.kind = 'activity' AND ai.direction = 'agent_to_user'
         AND json_extract(ai.metadata_json, '$.phase') IN (${FEEDBACK_PHASE_SQL})
         AND COALESCE(json_extract(ai.metadata_json, '$.status'), json_extract(ai.metadata_json, '$.action')) IN (${FEEDBACK_STATUS_SQL})`
    : "ai.kind = 'nudge' AND ai.direction = 'user_to_agent'"}
      AND (? IS NULL OR ai.job_id = ?)
      AND (? IS NULL OR ai.agent_call_id = ?)
      -- Without a call filter only top-level calls speak; a child is reached
      -- through its subagent item or the agent_call_id filter (§2.7).
      AND (? IS NOT NULL OR ai.agent_call_id IS NULL OR calls.parent_agent_call_id IS NULL)
      AND ai.created_at <= ?
    ORDER BY ai.created_at DESC, ai.id DESC
    LIMIT ?
  `).all(workItemId, filter.jobId, filter.jobId, filter.agentCallId, filter.agentCallId, filter.agentCallId,
    beforeTime(beforeKey), fetchLimit);
}

function supersededByFallback(db, row) {
  return safely(() => db.prepare(`
    SELECT MIN(id) AS id FROM agent_interactions
    WHERE job_id IS ? AND id > ? AND kind = 'nudge' AND direction = 'user_to_agent'
  `).get(row.job_id, row.id)?.id ?? null);
}

function gateRows(db, { workItemId, filter, beforeKey, fetchLimit }) {
  return db.prepare(`
    SELECT jobs.*,
           hg.gate_state AS hg_gate_state, hg.generation AS hg_generation,
           hg.original_job_id AS hg_original_job_id, hg.resolution_action AS hg_resolution_action,
           hg.resolution_payload_json AS hg_resolution_payload_json, hg.resolved_at AS hg_resolved_at,
           hg.created_at AS hg_created_at, hg.updated_at AS hg_updated_at
    FROM jobs
    LEFT JOIN human_gates hg ON hg.gate_job_id = jobs.id
    WHERE jobs.work_item_id = ? AND jobs.job_type = 'human_input'
      AND (? IS NULL OR hg.original_job_id = ? OR jobs.id = ?)
      AND COALESCE(hg.created_at, jobs.created_at) <= ?
    ORDER BY COALESCE(hg.created_at, jobs.created_at) DESC, jobs.id DESC
    LIMIT ?
  `).all(workItemId, filter.jobId, filter.jobId, filter.jobId, beforeTime(beforeKey), fetchLimit);
}

function acceptedGateAction(db, gateJobId) {
  return safely(() => {
    const rows = db.prepare(`
      SELECT metadata_json, created_at, source FROM agent_interactions
      WHERE job_id = ? AND kind = 'approval' AND status = 'applied' ORDER BY id DESC
    `).all(gateJobId);
    for (const row of rows) {
      const action = JSON.parse(row.metadata_json || "{}")?.work_item_action;
      if (action?.action_kind === "question.answer" && action?.result?.outcome === "accepted"
        && action?.target?.question_id === `gate:${gateJobId}:0`) {
        return { choice_id: String(action.target.choice_id || ""), answered_at: action.result.observed_at || row.created_at, origin: row.source || null };
      }
    }
    return null;
  });
}

/**
 * Tool groups of the Work Item's agent jobs: snapshots for finished jobs,
 * live computation otherwise, and a retained:false placeholder for a
 * finished job whose calls are gone. Returns groups and their closers.
 */
function toolGroupState(db, { jobs, filter }) {
  const groups = [];
  const placeholders = [];
  for (const job of agentJobs(jobs)) {
    if (filter.jobId != null && Number(job.id) !== filter.jobId) continue;
    const terminal = isTerminalJob(job);
    const persisted = terminal ? safely(() => readPersistedJobToolGroups(db, job.id), []) : [];
    if (persisted.length > 0) {
      groups.push(...persisted);
      continue;
    }
    const computed = safely(() => computeJobToolGroups(db, job.id));
    if (computed && (computed.hasCallRows || !terminal)) {
      groups.push(...computed.groups);
    } else if (terminal && (computed?.sources?.calls || []).some((call) => call.parent_agent_call_id == null)) {
      placeholders.push(job);
    }
  }
  const visible = groups.filter((group) => {
    if (filter.agentCallId != null) return group.agent_call_id === filter.agentCallId;
    return group.parent_agent_call_id == null;
  });
  const byCloser = new Map();
  for (const group of visible) {
    if (group.closing_entry_id && isVisibleToolGroup(group) && !byCloser.has(group.closing_entry_id)) {
      byCloser.set(group.closing_entry_id, group.group_id);
    }
  }
  return {
    groups: visible.filter(isVisibleToolGroup),
    byCloser,
    placeholders: filter.agentCallId != null ? [] : placeholders,
  };
}

function boundedPage(entries) {
  const kept = [];
  let bytes = 0;
  // Entries are newest-first here; drop the oldest once the page is full.
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (kept.length > 0 && bytes + size > BOUNDS.PAGE_BYTES) break;
    kept.push(entry);
    bytes += size;
  }
  return kept;
}

export function resolveConversationTier(requested, context = {}) {
  return context.detailTier === AGENT_CONVERSATION_TIER.LOCAL && requested !== AGENT_CONVERSATION_TIER.REMOTE
    ? AGENT_CONVERSATION_TIER.LOCAL
    : AGENT_CONVERSATION_TIER.REMOTE;
}

/**
 * @param {{work_item_id:number|string, job_id?:number|string|null, agent_call_id?:number|string|null,
 *   before?:string|null, limit?:number, tier?:"remote"|"local"}} request
 * @param {{db:any, observedAt?:string, ownerGeneration?:string|null}} options
 */
export function projectAgentConversation(request = {}, { db, observedAt = new Date().toISOString(), ownerGeneration = null } = {}) {
  const workItemId = positiveId(request.work_item_id);
  if (!workItemId) return { ok: false, reason: "invalid_work_item_id" };
  const jobId = positiveId(request.job_id);
  const agentCallId = positiveId(request.agent_call_id);
  if (Number.isNaN(jobId) || Number.isNaN(agentCallId)) return { ok: false, reason: "invalid_identity" };
  const limitValue = request.limit == null || request.limit === "" ? BOUNDS.PAGE_DEFAULT_ENTRIES : Number(request.limit);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > BOUNDS.PAGE_ENTRIES) return { ok: false, reason: "invalid_limit" };
  const tier = request.tier === AGENT_CONVERSATION_TIER.LOCAL ? AGENT_CONVERSATION_TIER.LOCAL : AGENT_CONVERSATION_TIER.REMOTE;

  if (!db.prepare("SELECT 1 FROM work_items WHERE id = ?").get(workItemId)) return { ok: false, reason: "no_such_wi" };
  let filterJobId = jobId;
  if (jobId != null && !db.prepare("SELECT 1 FROM jobs WHERE id = ? AND work_item_id = ?").get(jobId, workItemId)) {
    return { ok: false, reason: "target_not_found" };
  }
  if (agentCallId != null) {
    const call = db.prepare("SELECT job_id FROM agent_calls WHERE id = ? AND work_item_id = ?").get(agentCallId, workItemId);
    if (!call || (jobId != null && Number(call.job_id) !== jobId)) return { ok: false, reason: "target_not_found" };
    filterJobId = Number(call.job_id);
  }
  const filter = { jobId: filterJobId, agentCallId };
  const identity = JSON.stringify({ work_item_id: workItemId, job_id: jobId, agent_call_id: agentCallId });
  let beforeKey = null;
  if (request.before != null && request.before !== "") {
    beforeKey = decodeConversationCursor(request.before, identity);
    if (!beforeKey) return { ok: false, reason: "invalid_cursor" };
  }

  const fetchLimit = limitValue + 1 + SOURCE_SLACK;
  const jobs = jobsForWorkItem(db, workItemId);
  const jobById = new Map(jobs.map((job) => [Number(job.id), job]));
  const tools = toolGroupState(db, { jobs, filter });
  const candidates = [];
  const push = (build) => {
    const entry = safely(build);
    const fitted = entry ? fitConversationEntry(entry) : null;
    if (fitted && olderThan(fitted, beforeKey)) candidates.push(fitted);
  };
  for (const entry of safely(() => markerEntries(db, { jobs, filter, beforeKey, fetchLimit }), [])) push(() => entry);
  for (const row of safely(() => interactionRows(db, { workItemId, filter, beforeKey, fetchLimit, kind: "agent_message" }), [])) {
    push(() => agentMessageEntry({ row, toolGroupId: tools.byCloser.get(`msg:${row.id}`) ?? null }));
  }
  for (const row of safely(() => interactionRows(db, { workItemId, filter, beforeKey, fetchLimit, kind: "operator_message" }), [])) {
    push(() => operatorMessageEntry({ row, observedAt, supersededByFallback: supersededByFallback(db, row) }));
  }
  if (filter.agentCallId == null) {
    for (const gateJob of safely(() => gateRows(db, { workItemId, filter, beforeKey, fetchLimit }), [])) {
      push(() => gateEntry({
        db,
        gateJob,
        observedAt,
        toolGroupId: tools.byCloser.get(`gate:${gateJob.id}`) ?? null,
        originalJob: jobById.get(Number(gateJob.hg_original_job_id)) || null,
        acceptedAction: acceptedGateAction(db, gateJob.id),
      }));
    }
  }
  for (const group of tools.groups) push(() => toolGroupEntry({ group, tier }));
  for (const job of tools.placeholders) push(() => unretainedToolGroupEntry({ job }));

  candidates.sort((left, right) => (left.order_key < right.order_key ? 1 : left.order_key > right.order_key ? -1 : 0));
  const page = boundedPage(candidates.slice(0, limitValue));
  const hasOlder = candidates.length > page.length;
  const entries = page.reverse();
  return {
    protocol: AGENT_CONVERSATION_PROTOCOL,
    work_item_id: workItemId,
    observed_at: observedAt,
    owner_generation: ownerGeneration,
    tier,
    entries,
    page: {
      limit: limitValue,
      has_older: hasOlder,
      older_cursor: hasOlder && entries.length > 0 ? encodeConversationCursor(entries[0].order_key, identity) : null,
    },
  };
}
