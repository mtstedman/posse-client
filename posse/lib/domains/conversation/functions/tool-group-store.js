// Reads one job's conversation sources and snapshots its closed tool groups
// into agent_tool_groups. job_observations rows survive only until the job is
// terminal plus a grace window (db-tail.js), so closeout and the orphan
// reconcilers persist every closed group; the projection then reads finished
// jobs from the snapshot and running jobs from the live rows.
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { AGENT_COMMENTARY_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { FEEDBACK_PHASES, FEEDBACK_STATUSES } from "../../../catalog/work-item-interactions.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { readRunTelemetryEntries } from "../../../shared/telemetry/functions/run-telemetry.js";
import { mergeObservationRows } from "../../observability/functions/observation-row-projection.js";
import { groupJobConversation } from "./tool-groups.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const DIGEST_VERSION = 1;

export function parseConversationObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "null"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isConversationObservationType(type) {
  const text = String(type || "");
  return text.startsWith("tool.") || text === AGENT_COMMENTARY_OBSERVATION_TYPE;
}

/** A typed agent_feedback interaction (the agent's own message). */
export function isAgentMessageInteraction(row) {
  const metadata = parseConversationObject(row?.metadata_json);
  return FEEDBACK_PHASES.has(String(metadata.phase || "")) && FEEDBACK_STATUSES.has(String(metadata.status || metadata.action || ""));
}

export function isTerminalJob(job) {
  return TERMINAL_JOB_STATUS_SET.has(String(job?.status || ""));
}

function archivedObservationRows(jobId) {
  // Closeout runs in the run that owns the job; its archive holds any rows the
  // tail prune already reclaimed from this run.
  try {
    return readRunTelemetryEntries("observations", {
      limit: null,
      order: "asc",
      currentEpochOnly: true,
      predicate: (entry) => Number(entry.job_id ?? entry.job) === Number(jobId)
        && isConversationObservationType(entry.observation_type ?? entry.type),
    });
  } catch {
    return [];
  }
}

/**
 * Load the rows groupJobConversation needs for one job. `includeArchive`
 * merges the current run's observation archive (closeout only).
 */
export function loadJobConversationSources(db, jobId, { includeArchive = false } = {}) {
  const job = db.prepare(`
    SELECT id, work_item_id, job_type, status, title, provider, model_name, model_tier,
           attempt_count, created_at, started_at, finished_at, updated_at
    FROM jobs WHERE id = ?
  `).get(jobId);
  if (!job) return null;
  const calls = db.prepare(`
    SELECT id, attempt_id, parent_agent_call_id, child_kind, role, status, started_at, finished_at,
           provider, model_name, model_tier
    FROM agent_calls WHERE job_id = ? ORDER BY id
  `).all(jobId);
  const attempts = db.prepare(`
    SELECT id, attempt_number, worker_type, model_name, status, started_at, finished_at
    FROM job_attempts WHERE job_id = ? ORDER BY attempt_number, id
  `).all(jobId);
  const liveRows = db.prepare(`
    SELECT id, work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at
    FROM job_observations
    WHERE job_id = ? AND (observation_type LIKE 'tool.%' OR observation_type = ?)
    ORDER BY id
  `).all(jobId, AGENT_COMMENTARY_OBSERVATION_TYPE);
  const observations = includeArchive
    ? mergeObservationRows([...archivedObservationRows(jobId), ...liveRows], "asc", null)
    : liveRows;
  const messages = db.prepare(`
    SELECT id, agent_call_id, attempt_id, created_at, metadata_json
    FROM agent_interactions
    WHERE job_id = ? AND kind = 'activity' AND direction = 'agent_to_user'
    ORDER BY id
  `).all(jobId).filter(isAgentMessageInteraction);
  const gates = db.prepare(`
    SELECT gate_job_id, created_at FROM human_gates WHERE original_job_id = ? ORDER BY gate_job_id
  `).all(jobId);
  return {
    job: { ...job, terminal: isTerminalJob(job), ended_at: job.finished_at || job.updated_at || null },
    calls,
    attempts,
    observations,
    messages,
    gates,
  };
}

export function computeJobToolGroups(db, jobId, options = {}) {
  const sources = loadJobConversationSources(db, jobId, options);
  if (!sources) return null;
  return { sources, ...groupJobConversation(sources) };
}

function digestFor(group) {
  return JSON.stringify({
    v: DIGEST_VERSION,
    role: group.role,
    unattributed: group.unattributed,
    running_count: group.running_count,
    member_count: group.member_count,
    by_tool: group.by_tool,
    items: group.items,
    omitted_items: group.omitted_items,
    rev: group.rev,
  });
}

function tableReady(db) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_tool_groups'").get();
  } catch {
    return false;
  }
}

/**
 * Snapshot every closed tool group of a job. Idempotent: a parked job that
 * resumes re-persists by upsert. A snapshot never replaces one that holds more
 * calls, so a run whose source rows were already pruned keeps the earlier one.
 */
export function persistJobToolGroups(jobId, { db = getDb() } = {}) {
  const id = Number(jobId);
  if (!Number.isSafeInteger(id) || id <= 0 || !tableReady(db)) return { job_id: id, persisted: 0, skipped: "unavailable" };
  const computed = computeJobToolGroups(db, id, { includeArchive: true });
  if (!computed) return { job_id: id, persisted: 0, skipped: "no_job" };
  const closed = computed.groups.filter((group) => group.state === "closed");
  const existing = db.prepare(`
    SELECT COUNT(*) AS rows, COALESCE(SUM(call_count), 0) AS calls FROM agent_tool_groups WHERE job_id = ?
  `).get(id);
  const computedCalls = closed.reduce((sum, group) => sum + group.call_count, 0);
  if (Number(existing.rows) > 0 && computedCalls < Number(existing.calls)) {
    return { job_id: id, persisted: 0, skipped: "source_pruned" };
  }
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO agent_tool_groups (
      work_item_id, job_id, attempt_id, agent_call_id, parent_agent_call_id, partition_key, group_seq,
      closed_by, closing_entry_id, closed_at, first_observation_id, last_observation_id, first_at, last_at,
      call_count, failed_count, rejected_count, digest_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, partition_key, group_seq) DO UPDATE SET
      work_item_id = excluded.work_item_id,
      attempt_id = excluded.attempt_id,
      agent_call_id = excluded.agent_call_id,
      parent_agent_call_id = excluded.parent_agent_call_id,
      closed_by = excluded.closed_by,
      closing_entry_id = excluded.closing_entry_id,
      closed_at = excluded.closed_at,
      first_observation_id = excluded.first_observation_id,
      last_observation_id = excluded.last_observation_id,
      first_at = excluded.first_at,
      last_at = excluded.last_at,
      call_count = excluded.call_count,
      failed_count = excluded.failed_count,
      rejected_count = excluded.rejected_count,
      digest_json = excluded.digest_json,
      updated_at = excluded.updated_at
  `);
  const keep = new Set(closed.map((group) => `${group.partition_key}\u0000${group.group_seq}`));
  const write = db.transaction(() => {
    for (const group of closed) {
      upsert.run(
        group.work_item_id, id, group.attempt_id, group.agent_call_id, group.parent_agent_call_id,
        group.partition_key, group.group_seq, group.closed_by, group.closing_entry_id, group.closed_at,
        group.first_observation_id, group.last_observation_id, group.first_at, group.last_at,
        group.call_count, group.failed_count, group.rejected_count, digestFor(group), now, now,
      );
    }
    // Boundaries only append, so a stale row means the earlier snapshot saw
    // a different boundary set; the current computation is authoritative.
    const stale = db.prepare("SELECT id, partition_key, group_seq FROM agent_tool_groups WHERE job_id = ?").all(id)
      .filter((row) => !keep.has(`${row.partition_key}\u0000${row.group_seq}`));
    const remove = db.prepare("DELETE FROM agent_tool_groups WHERE id = ?");
    for (const row of stale) remove.run(row.id);
  });
  write.immediate();
  return { job_id: id, persisted: closed.length, skipped: null };
}

/** Best-effort snapshot for jobs a reconciler just closed out. */
export function persistToolGroupsForJobs(jobIds, { db = getDb() } = {}) {
  let persisted = 0;
  for (const jobId of new Set([...(jobIds || [])].map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))) {
    try {
      persisted += persistJobToolGroups(jobId, { db }).persisted;
    } catch {
      // Conversation snapshots are advisory; reconciliation must not fail.
    }
  }
  return persisted;
}

/** Rebuild a group object from its persisted row. */
export function persistedToolGroup(row) {
  if (!row) return null;
  const digest = parseConversationObject(row.digest_json);
  return {
    group_id: `tools:${row.job_id}:${row.partition_key}:${row.group_seq}`,
    job_id: Number(row.job_id),
    work_item_id: row.work_item_id == null ? null : Number(row.work_item_id),
    attempt_id: row.attempt_id == null ? null : Number(row.attempt_id),
    agent_call_id: row.agent_call_id == null ? null : Number(row.agent_call_id),
    parent_agent_call_id: row.parent_agent_call_id == null ? null : Number(row.parent_agent_call_id),
    role: digest.role ?? null,
    partition_key: row.partition_key,
    unattributed: digest.unattributed === true,
    group_seq: Number(row.group_seq),
    state: "closed",
    closed_by: row.closed_by,
    closing_entry_id: row.closing_entry_id,
    closed_at: row.closed_at,
    first_observation_id: row.first_observation_id,
    last_observation_id: row.last_observation_id,
    first_at: row.first_at,
    last_at: row.last_at,
    call_count: Number(row.call_count || 0),
    failed_count: Number(row.failed_count || 0),
    rejected_count: Number(row.rejected_count || 0),
    running_count: Number(digest.running_count || 0),
    member_count: Number(digest.member_count || 0),
    by_tool: Array.isArray(digest.by_tool) ? digest.by_tool : [],
    items: Array.isArray(digest.items) ? digest.items : [],
    omitted_items: Number(digest.omitted_items || 0),
    rev: Number(digest.rev || 0),
  };
}

export function readPersistedJobToolGroups(db, jobId) {
  if (!tableReady(db)) return [];
  return db.prepare(`
    SELECT * FROM agent_tool_groups WHERE job_id = ? ORDER BY closed_at, partition_key, group_seq
  `).all(jobId).map(persistedToolGroup);
}

export function countPersistedJobToolGroups(db, jobId) {
  if (!tableReady(db)) return 0;
  return Number(db.prepare("SELECT COUNT(*) AS count FROM agent_tool_groups WHERE job_id = ?").get(jobId)?.count || 0);
}
