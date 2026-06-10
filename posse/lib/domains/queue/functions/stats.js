// Read-only aggregate queries over jobs / work_items / agent_calls.
// Used by the dashboard, delegator routing decisions, and the
// `posse health` / `posse status` CLI commands. No mutation, no
// side effects.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  ACTIVE_LEASE_STATUSES_SQL,
  COMPLETED_OUTCOME_JOB_STATUSES_SQL,
  FAILED_JOB_STATUSES_SQL,
  PARKED_JOB_STATUSES_SQL,
  PROVIDER_QUEUE_JOB_STATUSES_SQL,
  now,
} from "./common.js";

export function getDurationStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      role,
      model_tier,
      COALESCE(provider, 'claude') as provider,
      COUNT(*) as sample_count,
      CAST(AVG(duration_ms) AS INTEGER) as avg_ms,
      CAST(MIN(duration_ms) AS INTEGER) as min_ms,
      CAST(MAX(duration_ms) AS INTEGER) as max_ms
    FROM agent_calls
    WHERE status = 'succeeded' AND duration_ms IS NOT NULL
    GROUP BY role, model_tier, provider
    ORDER BY role, model_tier, provider
  `).all();
}

/**
 * Get aggregate provider stats for delegator context.
 * Returns per-provider token usage, call counts, costs, and queue depth.
 */
export function getProviderStats() {
  const db = getDb();
  const callStats = db.prepare(`
    SELECT
      provider,
      COUNT(*) as call_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(duration_ms) as total_duration_ms,
      AVG(duration_ms) as avg_duration_ms,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM agent_calls
    GROUP BY provider
  `).all();

  const queueDepth = db.prepare(`
    SELECT
      COALESCE(provider, 'unassigned') as provider,
      status,
      COUNT(*) as count
    FROM jobs
    WHERE status IN (${PROVIDER_QUEUE_JOB_STATUSES_SQL})
    GROUP BY provider, status
  `).all();

  return { callStats, queueDepth };
}

/**
 * Get failure/retry stats grouped by job_type, model_tier, and provider.
 * Used by the delegator to make data-driven optimization decisions.
 */
export function getFailureStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      job_type,
      model_tier,
      COALESCE(provider, 'unassigned') as provider,
      COUNT(*) as total_jobs,
      SUM(CASE WHEN status IN (${FAILED_JOB_STATUSES_SQL}) THEN 1 ELSE 0 END) as failed_count,
      ROUND(
        CAST(SUM(CASE WHEN status IN (${FAILED_JOB_STATUSES_SQL}) THEN 1 ELSE 0 END) AS REAL)
        / NULLIF(COUNT(*), 0), 3
      ) as fail_rate,
      ROUND(AVG(attempt_count), 1) as avg_attempts,
      MAX(attempt_count) as max_attempts_seen
    FROM jobs
    WHERE status IN (${COMPLETED_OUTCOME_JOB_STATUSES_SQL})
      AND job_type IN ('dev', 'fix', 'artificer')
    GROUP BY job_type, model_tier, provider
    HAVING total_jobs >= 2
    ORDER BY fail_rate DESC
  `).all();
}

export function getPipelineHealth(opts = {}) {
  const db = getDb();
  const staleAfterHours = Number.isFinite(opts.staleAfterHours) ? opts.staleAfterHours : 2;
  const signatureLimit = Number.isFinite(opts.signatureLimit) ? opts.signatureLimit : 5;
  const staleThreshold = new Date(Date.now() - staleAfterHours * 60 * 60 * 1000).toISOString().replace("Z", "").slice(0, 23) + "Z";

  const workItemsByStatus = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM work_items
    GROUP BY status
    ORDER BY count DESC, status ASC
  `).all();

  const jobsByStatus = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM jobs
    GROUP BY status
    ORDER BY count DESC, status ASC
  `).all();

  const deadLettersByType = db.prepare(`
    SELECT job_type, COUNT(*) as count, MAX(updated_at) as last_seen_at
    FROM jobs
    WHERE status = 'dead_letter'
    GROUP BY job_type
    ORDER BY count DESC, job_type ASC
  `).all();

  const recentDeadLetters = db.prepare(`
    SELECT id, work_item_id, job_type, title, last_error, attempt_count, updated_at
    FROM jobs
    WHERE status = 'dead_letter'
    ORDER BY updated_at DESC, id DESC
    LIMIT 5
  `).all();

  const parkedJobs = db.prepare(`
    SELECT id, work_item_id, job_type, title, status, updated_at
    FROM jobs
    WHERE status IN (${PARKED_JOB_STATUSES_SQL})
    ORDER BY updated_at ASC, id ASC
    LIMIT 10
  `).all();

  const stuckJobs = db.prepare(`
    SELECT id, work_item_id, job_type, title, status, updated_at, lease_expires_at
    FROM jobs
    WHERE status IN (${ACTIVE_LEASE_STATUSES_SQL})
      AND updated_at <= ?
    ORDER BY updated_at ASC, id ASC
    LIMIT 10
  `).all(staleThreshold);

  const topErrorSignatures = db.prepare(`
    SELECT
      TRIM(
        CASE
          WHEN INSTR(COALESCE(last_error, ''), CHAR(10)) > 0
            THEN SUBSTR(last_error, 1, INSTR(last_error, CHAR(10)) - 1)
          ELSE COALESCE(last_error, '')
        END
      ) as error_signature,
      COUNT(*) as count,
      SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) as dead_letter_count,
      MAX(updated_at) as last_seen_at
    FROM jobs
    WHERE COALESCE(last_error, '') != ''
    GROUP BY error_signature
    ORDER BY count DESC, last_seen_at DESC
    LIMIT ?
  `).all(signatureLimit);

  const providerHealth = db.prepare(`
    SELECT
      COALESCE(provider, 'unknown') as provider,
      COUNT(*) as total_calls,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded_calls,
      SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) as failed_calls,
      MAX(CASE WHEN status = 'succeeded' THEN COALESCE(created_at, started_at) END) as last_success_at,
      MAX(CASE WHEN status IN ('failed', 'timeout') THEN COALESCE(created_at, started_at) END) as last_failure_at
    FROM agent_calls
    GROUP BY COALESCE(provider, 'unknown')
    ORDER BY provider ASC
  `).all();

  return {
    staleAfterHours,
    generated_at: now(),
    workItemsByStatus,
    jobsByStatus,
    deadLettersByType,
    recentDeadLetters,
    parkedJobs,
    stuckJobs,
    topErrorSignatures,
    providerHealth,
  };
}

export function countJobsByStatus() {
  const db = getDb();
  const rows = db.prepare(`SELECT status, COUNT(*) AS cnt FROM jobs GROUP BY status`).all();
  const counts = Object.create(null);
  for (const row of rows) counts[row.status] = row.cnt;
  return counts;
}

/**
 * Get a summary of job counts by status for dashboard display.
 */
export function getJobStats() {
  const db = getDb();
  return db.prepare(`
    SELECT status, COUNT(*) as count FROM jobs GROUP BY status
  `).all();
}

/**
 * Get a summary of job counts by status for a specific work item.
 */
export function getWorkItemJobStats(workItemId) {
  const db = getDb();
  return db.prepare(`
    SELECT status, job_type, COUNT(*) as count
    FROM jobs WHERE work_item_id = ?
    GROUP BY status, job_type
  `).all(workItemId);
}
