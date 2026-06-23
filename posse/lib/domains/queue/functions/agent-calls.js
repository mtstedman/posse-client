// Per-LLM-call accounting backed by the `agent_calls` table, plus the
// tool-invocation join over `job_observations` and the scope-context
// health metrics that summarize related event types.
//
// Each `agent_calls` row represents one round-trip into a provider —
// open with createAgentCall when a worker starts a call, close with
// completeAgentCall when it finishes (or with cleanupRunningAgentCalls
// at startup for any rows orphaned by a crash). Everything else here
// is read-mostly aggregation for dashboards and the delegator.

import { getDb } from "../../../shared/storage/functions/index.js";
import { normalizeSkillsColumn, now, LEASE_HOLDING_STATUSES_SQL, runImmediateTransaction } from "./common.js";
import { leaseNowMs } from "./lease-clock.js";
import { logEvent } from "./events.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { DEADLOCK_TERMINAL_STATUSES } from "../../../catalog/job.js";
import { appendRunTelemetry } from "../../../shared/telemetry/functions/run-telemetry.js";

// Provider-native web tool uses are replayed after the agent process returns,
// so they can land a beat after finished_at while still belonging to the call.
const WEB_TOOL_LOG_FINISH_GRACE_SECONDS = 10;
// SQLite default timestamps and JS timestamps can differ by a few milliseconds
// around call creation/finish. Replay prefers a complete transcript over
// dropping the first/last tool observation because of clock precision.
const TOOL_LOG_BOUNDARY_GRACE_SECONDS = 2;
const TOOL_LOG_FINISH_BOUNDARY_GRACE_SECONDS = 0.25;

export function createAgentCall({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  role,
  model_tier,
  model_name = null,
  activity = null,
  prompt_chars = null,
  max_turns_configured = null,
  provider = "claude",
  reasoning_effort = "medium",
  extended_thinking = false,
  atlas_method = null,
  atlas_prefetch_status = null,
  skills = null,
  prior_session_handle = null,
  session_handle = null,
} = {}) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO agent_calls (
      work_item_id, job_id, attempt_id,
      role, model_tier, model_name, activity,
      prompt_chars, max_turns_configured, provider,
      reasoning_effort, extended_thinking, atlas_method, atlas_prefetch_status, skills,
      prior_session_handle, session_handle, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    work_item_id, job_id, attempt_id,
    role, model_tier, model_name, activity,
    prompt_chars, max_turns_configured, provider,
    reasoning_effort, extended_thinking ? 1 : 0, atlas_method, atlas_prefetch_status, normalizeSkillsColumn(skills),
    prior_session_handle == null ? null : String(prior_session_handle),
    session_handle == null ? null : String(session_handle),
    now(),
  );
  const row = db.prepare(`SELECT * FROM agent_calls WHERE id = ?`).get(info.lastInsertRowid);
  appendRunTelemetry("agent-calls", { phase: "started", ...row });
  return row;
}

/**
 * Complete an agent_call record with results.
 */
export function completeAgentCall(id, {
  status = "succeeded",
  output_chars = null,
  input_tokens = null,
  output_tokens = null,
  cached_input_tokens = null,
  model_name = null,
  duration_ms = null,
  exit_code = null,
  error_text = null,
  atlas_method = null,
  atlas_prefetch_status = null,
  cost_estimate_usd = null,
  skills = null,
  session_handle = null,
} = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE agent_calls
    SET status = ?, finished_at = ?, duration_ms = ?,
        output_chars = ?, input_tokens = ?, output_tokens = ?, cached_input_tokens = ?,
        model_name = COALESCE(?, model_name),
        exit_code = ?, error_text = ?,
        atlas_method = COALESCE(?, atlas_method),
        atlas_prefetch_status = COALESCE(?, atlas_prefetch_status),
        skills = COALESCE(?, skills),
        session_handle = COALESCE(?, session_handle),
        cost_estimate_usd = COALESCE(?, cost_estimate_usd)
    WHERE id = ?
  `).run(
    status, now(), duration_ms,
    output_chars, input_tokens, output_tokens, cached_input_tokens,
    model_name,
    exit_code, error_text,
    atlas_method,
    atlas_prefetch_status,
    normalizeSkillsColumn(skills),
    session_handle == null ? null : String(session_handle),
    cost_estimate_usd,
    id,
  );
  const row = db.prepare(`SELECT * FROM agent_calls WHERE id = ?`).get(id);
  if (row) appendRunTelemetry("agent-calls", { phase: "completed", ...row });
}

/**
 * Get all agent calls for a job.
 */
export function getAgentCalls(jobId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM agent_calls WHERE job_id = ? ORDER BY created_at`).all(jobId);
}

/**
 * Get all agent calls for a work item.
 */
export function getAgentCallsByWorkItem(workItemId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM agent_calls WHERE work_item_id = ? ORDER BY created_at`).all(workItemId);
}

/**
 * Aggregate stats across all agent calls, grouped by role.
 */
export function getAgentCallStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      role,
      model_tier,
      COUNT(*) as call_count,
      SUM(duration_ms) as total_duration_ms,
      AVG(duration_ms) as avg_duration_ms,
      SUM(prompt_chars) as total_prompt_chars,
      SUM(output_chars) as total_output_chars,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM agent_calls
    GROUP BY role, model_tier
    ORDER BY role, model_tier
  `).all();
}

export function getResearcherGuardrailStats({ sinceIso = null, limit = 50, includeDetached = false } = {}) {
  const db = getDb();
  const filters = ["ac.role = 'researcher'"];
  const params = [];
  if (!includeDetached) {
    filters.push("ac.work_item_id IS NOT NULL");
    filters.push("ac.job_id IS NOT NULL");
  }
  if (sinceIso) {
    filters.push("COALESCE(ac.started_at, ac.created_at) >= ?");
    params.push(String(sinceIso));
  }
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.floor(Number(limit)), 500)
    : 50;
  const whereSql = filters.join(" AND ");
  const byJob = db.prepare(`
    SELECT
      ac.work_item_id,
      ac.job_id,
      COALESCE(j.status, 'unknown') AS job_status,
      COUNT(*) AS call_count,
      SUM(CASE WHEN ac.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_calls,
      SUM(CASE WHEN ac.status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed_calls,
      SUM(CASE WHEN COALESCE(j.status, '') IN ('succeeded') THEN 1 ELSE 0 END) AS succeeded_job_rows,
      SUM(COALESCE(ac.input_tokens, 0)) AS input_tokens,
      SUM(COALESCE(ac.output_tokens, 0)) AS output_tokens,
      SUM(COALESCE(ac.cached_input_tokens, 0)) AS cached_input_tokens,
      SUM(COALESCE(ac.cost_estimate_usd, 0)) AS cost_usd,
      SUM(COALESCE(ac.duration_ms, 0)) AS duration_ms,
      MAX(COALESCE(ac.started_at, ac.created_at)) AS last_call_at,
      COALESCE(ev.evidence_count, 0) AS evidence_count,
      COALESCE(ev.novel_relevant_files, 0) AS novel_relevant_files,
      COALESCE(ev.synthesis_required_count, 0) AS synthesis_required_count
    FROM agent_calls ac
    LEFT JOIN jobs j ON j.id = ac.job_id
    LEFT JOIN (
      SELECT
        job_id,
        SUM(CASE WHEN observation_type = 'research.evidence' THEN 1 ELSE 0 END) AS evidence_count,
        SUM(CASE
          WHEN observation_type = 'research.evidence'
            AND json_valid(COALESCE(detail_json, '{}')) = 1
            AND json_extract(detail_json, '$.novel_relevant_file') = 1
          THEN 1 ELSE 0 END
        ) AS novel_relevant_files,
        SUM(CASE WHEN observation_type = 'research.synthesis_required' THEN 1 ELSE 0 END) AS synthesis_required_count
      FROM job_observations
      WHERE observation_type IN ('research.evidence', 'research.synthesis_required')
      ${sinceIso ? "AND created_at >= ?" : ""}
      GROUP BY job_id
    ) ev ON ev.job_id = ac.job_id
    WHERE ${whereSql}
    GROUP BY ac.work_item_id, ac.job_id, job_status
    ORDER BY input_tokens DESC, cost_usd DESC, call_count DESC
    LIMIT ?
  `).all(...(sinceIso ? [String(sinceIso), ...params, safeLimit] : [...params, safeLimit]));

  const totals = byJob.reduce((acc, row) => {
    acc.jobs += 1;
    if (row.job_status === "succeeded") acc.succeeded_jobs += 1;
    if (DEADLOCK_TERMINAL_STATUSES.includes(row.job_status)) acc.failed_jobs += 1;
    acc.call_count += Number(row.call_count || 0);
    acc.succeeded_calls += Number(row.succeeded_calls || 0);
    acc.failed_calls += Number(row.failed_calls || 0);
    acc.input_tokens += Number(row.input_tokens || 0);
    acc.output_tokens += Number(row.output_tokens || 0);
    acc.cached_input_tokens += Number(row.cached_input_tokens || 0);
    acc.cost_usd += Number(row.cost_usd || 0);
    acc.duration_ms += Number(row.duration_ms || 0);
    acc.evidence_count += Number(row.evidence_count || 0);
    acc.novel_relevant_files += Number(row.novel_relevant_files || 0);
    acc.synthesis_required_count += Number(row.synthesis_required_count || 0);
    return acc;
  }, {
    jobs: 0,
    succeeded_jobs: 0,
    failed_jobs: 0,
    call_count: 0,
    succeeded_calls: 0,
    failed_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cost_usd: 0,
    duration_ms: 0,
    evidence_count: 0,
    novel_relevant_files: 0,
    synthesis_required_count: 0,
  });

  return {
    since_iso: sinceIso || null,
    limit: safeLimit,
    totals,
    by_job: byJob,
  };
}

function isUnderScopedPlanInvalidEvent(row) {
  if (!row || row.event_type !== EVENT_TYPES.PLAN_TASK_INVALID) return false;
  const message = String(row.message || "").toLowerCase();
  if (message.includes("under-scoped")) return true;
  if (message.includes("broad task with narrow writable scope")) return true;
  if (message.includes("research identified") && message.includes("candidate files")) return true;
  const rawJson = row.event_json;
  if (!rawJson || typeof rawJson !== "string") return false;
  try {
    const parsed = JSON.parse(rawJson);
    const reason = String(parsed?.reason || "").toLowerCase();
    return reason === "under_scoped_drop"
      || reason === "research_candidates_missing_scope"
      || reason === "broad_narrow_scope_enforce";
  } catch {
    return false;
  }
}

function blankScopeContextMetrics() {
  return {
    context_trimmed_packets: 0,
    under_scoped_drops: 0,
    recovery_escalations: 0,
    scope_cleaned_noops: 0,
    strict_shadow_conflicts: 0,
  };
}

function foldScopeContextRows(rows = []) {
  const metrics = blankScopeContextMetrics();
  for (const row of rows) {
    const type = String(row?.event_type || "");
    if (type === EVENT_TYPES.PACKET_CONTEXT_TRIMMED) {
      metrics.context_trimmed_packets += 1;
    } else if (type === EVENT_TYPES.PLAN_RECOVERY_ESCALATED) {
      metrics.recovery_escalations += 1;
    } else if (type === EVENT_TYPES.JOB_SCOPE_CLEANED_NOOP) {
      metrics.scope_cleaned_noops += 1;
    } else if (type === EVENT_TYPES.SCHEDULER_SCOPE_WOULD_HAVE_CONFLICTED) {
      metrics.strict_shadow_conflicts += 1;
    } else if (type === EVENT_TYPES.PLAN_TASK_INVALID && isUnderScopedPlanInvalidEvent(row)) {
      metrics.under_scoped_drops += 1;
    }
  }
  return metrics;
}

/**
 * Aggregate context/scope-rot signals from existing event telemetry.
 * Returns both all-time counts and a trailing-window snapshot.
 */
export function getScopeContextHealthMetrics({ trailingDays = 7 } = {}) {
  const db = getDb();
  const parsedDays = Number.parseInt(String(trailingDays ?? 7), 10);
  const safeDays = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
  const sinceIso = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const relevantTypes = [
    EVENT_TYPES.PACKET_CONTEXT_TRIMMED,
    EVENT_TYPES.PLAN_TASK_INVALID,
    EVENT_TYPES.PLAN_RECOVERY_ESCALATED,
    EVENT_TYPES.JOB_SCOPE_CLEANED_NOOP,
    EVENT_TYPES.SCHEDULER_SCOPE_WOULD_HAVE_CONFLICTED,
  ];
  const placeholders = relevantTypes.map(() => "?").join(", ");
  const sql = `
    SELECT event_type, message, event_json, created_at
    FROM events
    WHERE event_type IN (${placeholders})
    ORDER BY id DESC
  `;
  const rows = db.prepare(sql).all(...relevantTypes);
  const allTime = foldScopeContextRows(rows);
  const trailing = foldScopeContextRows(rows.filter((row) => String(row?.created_at || "") >= sinceIso));
  return {
    all_time: allTime,
    trailing,
    trailing_days: safeDays,
    since_iso: sinceIso,
  };
}

/**
 * Mark any orphaned 'running' agent calls as 'timeout'.
 * Called at wrap-up time to clean up calls from crashed/killed workers.
 */
export function cleanupRunningAgentCalls() {
  const db = getDb();
  const result = db.prepare(`
    UPDATE agent_calls
    SET status = 'timeout', finished_at = COALESCE(finished_at, ?),
        error_text = 'Process terminated before completion'
    WHERE status = 'running'
  `).run(now()).changes;
  if (result > 0) {
    appendRunTelemetry("agent-calls", {
      phase: "cleanup_running",
      status: "timeout",
      count: result,
      finished_at: now(),
      error_text: "Process terminated before completion",
    });
  }
  return result;
}

/**
 * Boot-time reconciliation of agent_calls left in 'running' by a crashed or
 * force-killed worker. Mirrors reconcileOrphanedAttempts(): if we hold the
 * scheduler lock, no live worker owns a running call, so any row whose owning
 * job is no longer actively leased (or has no job at all) is an orphan.
 *
 * Unlike cleanupRunningAgentCalls() — which unconditionally times out every
 * running row at wrap-up — this is lease-guarded so it is safe to run during
 * boot maintenance, and it logs a queryable event per reconciled row instead
 * of only appending run telemetry. Returns the number of rows reconciled.
 */
export function reconcileOrphanedAgentCalls() {
  const db = getDb();
  const ts = new Date(leaseNowMs()).toISOString();
  const execute = () => {
    const stuck = db.prepare(`
      SELECT ac.id, ac.job_id
      FROM agent_calls ac
      LEFT JOIN jobs j ON j.id = ac.job_id
      WHERE ac.status = 'running'
        AND (
          ac.job_id IS NULL
          OR j.id IS NULL
          OR j.status NOT IN (${LEASE_HOLDING_STATUSES_SQL})
          OR j.lease_expires_at IS NULL
          OR j.lease_expires_at < ?
        )
    `).all(ts);

    if (stuck.length === 0) return 0;

    const fix = db.prepare(`
      UPDATE agent_calls
      SET status = 'timeout',
          finished_at = COALESCE(finished_at, ?),
          error_text = COALESCE(error_text, 'Orphaned by scheduler crash')
      WHERE id = ? AND status = 'running'
    `);

    let reconciled = 0;
    for (const { id, job_id } of stuck) {
      const result = fix.run(ts, id);
      if (result.changes === 0) continue;
      reconciled += 1;
      logEvent({
        job_id,
        event_type: EVENT_TYPES.AGENT_CALL_ORPHAN_RECONCILED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Orphaned running agent call #${id} marked as timeout`,
      });
    }
    return reconciled;
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

/**
 * Get all agent calls, optionally filtered by role or limited.
 */
export function listAgentCalls({ role = null, limit = 50 } = {}) {
  const db = getDb();
  if (role) {
    return db.prepare(`SELECT * FROM agent_calls WHERE role = ? ORDER BY created_at DESC LIMIT ?`).all(role, limit);
  }
  return db.prepare(`SELECT * FROM agent_calls ORDER BY created_at DESC LIMIT ?`).all(limit);
}

/**
 * List every work item with aggregate rollups of its agent_calls:
 * call_count, job_count, input/output tokens, total duration, cost, tool_calls.
 * Rollups draw only from completed agent_calls (running calls have no totals yet).
 */
export function listWorkItemsWithCallRollups({ limit = 200 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT
      wi.id, wi.title, wi.status, wi.priority, wi.mode,
      wi.branch_name, wi.merge_state,
      wi.created_at, wi.started_at, wi.completed_at,
      COALESCE(ac.call_count, 0)       AS call_count,
      COALESCE(ac.succeeded_calls, 0)  AS succeeded_calls,
      COALESCE(ac.failed_calls, 0)     AS failed_calls,
      COALESCE(ac.running_calls, 0)    AS running_calls,
      COALESCE(ac.input_tokens, 0)     AS input_tokens,
      COALESCE(ac.output_tokens, 0)    AS output_tokens,
      COALESCE(ac.total_duration_ms, 0) AS total_duration_ms,
      COALESCE(ac.cost_usd, 0)         AS cost_usd,
      COALESCE(jc.job_count, 0)        AS job_count,
      COALESCE(obs.tool_calls, 0)      AS tool_calls
    FROM work_items wi
    LEFT JOIN (
      SELECT
        work_item_id,
        COUNT(*)                                          AS call_count,
        SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_calls,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed_calls,
        SUM(CASE WHEN status = 'running'   THEN 1 ELSE 0 END) AS running_calls,
        SUM(COALESCE(input_tokens, 0))                    AS input_tokens,
        SUM(COALESCE(output_tokens, 0))                   AS output_tokens,
        SUM(COALESCE(duration_ms, 0))                     AS total_duration_ms,
        SUM(COALESCE(cost_estimate_usd, 0))               AS cost_usd
      FROM agent_calls
      WHERE work_item_id IS NOT NULL
      GROUP BY work_item_id
    ) ac ON ac.work_item_id = wi.id
    LEFT JOIN (
      SELECT work_item_id, COUNT(*) AS job_count
      FROM jobs
      WHERE work_item_id IS NOT NULL
      GROUP BY work_item_id
    ) jc ON jc.work_item_id = wi.id
    LEFT JOIN (
      SELECT work_item_id, COUNT(*) AS tool_calls
      FROM job_observations
      WHERE work_item_id IS NOT NULL
        AND observation_type LIKE 'tool.%'
        AND observation_type != 'tool.chain_read'
      GROUP BY work_item_id
    ) obs ON obs.work_item_id = wi.id
    ORDER BY wi.id DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Per-agent-call rows for a single work item, with a derived tool_calls
 * count joined from job_observations by matching job_id and time window
 * (observations between the call's started_at and finished_at, with a short
 * grace window for replayed provider-native web tool observations).
 */
export function getAgentCallsWithToolCountsByWorkItem(workItemId) {
  const db = getDb();
  return db.prepare(`
    SELECT
      ac.*,
      j.job_type, j.status AS job_status,
      (
        SELECT COUNT(*) FROM job_observations o
        WHERE o.job_id = ac.job_id
          AND o.observation_type LIKE 'tool.%'
          AND o.observation_type != 'tool.chain_read'
          AND o.created_at >= ac.started_at
          AND (
            ac.finished_at IS NULL
            OR o.created_at <= ac.finished_at
            OR (
              o.observation_type IN ('tool.web_fetch', 'tool.web_search')
              AND julianday(o.created_at) <= julianday(ac.finished_at) + (${WEB_TOOL_LOG_FINISH_GRACE_SECONDS} / 86400.0)
            )
          )
      ) AS tool_calls
    FROM agent_calls ac
    LEFT JOIN jobs j ON j.id = ac.job_id
    WHERE ac.work_item_id = ?
    ORDER BY ac.created_at ASC, ac.id ASC
  `).all(workItemId);
}

/**
 * Fetch a single agent_call row by id.
 */
export function getAgentCallById(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM agent_calls WHERE id = ?`).get(id) || null;
}

/**
 * Tool invocations captured during a single agent_call's execution window.
 * Joined by job_id + time range, with small boundary grace for timestamp
 * precision and a longer grace window for replayed provider-native web tools.
 */
export function getToolInvocationsForAgentCall(agentCallId) {
  const db = getDb();
  const call = db.prepare(`SELECT id, job_id, started_at, finished_at FROM agent_calls WHERE id = ?`).get(agentCallId);
  if (!call || call.job_id == null) return [];
  return db.prepare(`
    SELECT id, observation_type, summary, detail_json, created_at
    FROM job_observations
    WHERE job_id = ?
      AND observation_type LIKE 'tool.%'
      AND observation_type != 'tool.chain_read'
      AND julianday(created_at) >= julianday(?) - (${TOOL_LOG_BOUNDARY_GRACE_SECONDS} / 86400.0)
      AND (
        ? IS NULL
        OR created_at <= ?
        OR julianday(created_at) <= julianday(?) + (${TOOL_LOG_FINISH_BOUNDARY_GRACE_SECONDS} / 86400.0)
        OR (
          observation_type IN ('tool.web_fetch', 'tool.web_search')
          AND julianday(created_at) <= julianday(?) + (${WEB_TOOL_LOG_FINISH_GRACE_SECONDS} / 86400.0)
        )
      )
    ORDER BY id ASC
  `).all(call.job_id, call.started_at, call.finished_at, call.finished_at, call.finished_at, call.finished_at);
}
