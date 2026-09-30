// Read-only aggregate queries over jobs / work_items / agent_calls.
// Used by the dashboard and the `posse health` / `posse status` CLI
// commands. No mutation, no side effects.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  ACTIVE_LEASE_STATUSES_SQL,
  PARKED_JOB_STATUSES_SQL,
  PUSH_OFFER_SUBTYPE,
  now,
} from "./common.js";

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
    WHERE NOT (
      job_type = 'human_input'
      AND COALESCE(
        CASE WHEN json_valid(payload_json) = 1
          THEN json_extract(payload_json, '$.subtype')
        END,
        ''
      ) = ?
    )
    GROUP BY status
    ORDER BY count DESC, status ASC
  `).all(PUSH_OFFER_SUBTYPE);

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
      AND NOT (
        job_type = 'human_input'
        AND COALESCE(
          CASE WHEN json_valid(payload_json) = 1
            THEN json_extract(payload_json, '$.subtype')
          END,
          ''
        ) = ?
      )
    ORDER BY updated_at ASC, id ASC
    LIMIT 10
  `).all(PUSH_OFFER_SUBTYPE);
  const publicationOffers = db.prepare(`
    SELECT id, work_item_id, job_type, title, status, updated_at
    FROM jobs
    WHERE status IN (${PARKED_JOB_STATUSES_SQL})
      AND job_type = 'human_input'
      AND COALESCE(
        CASE WHEN json_valid(payload_json) = 1
          THEN json_extract(payload_json, '$.subtype')
        END,
        ''
      ) = ?
    ORDER BY updated_at ASC, id ASC
    LIMIT 10
  `).all(PUSH_OFFER_SUBTYPE);

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
    publicationOffers,
    stuckJobs,
    topErrorSignatures,
    providerHealth,
  };
}

export function countJobsByStatus({ excludeJobTypes = [] } = {}) {
  const db = getDb();
  const excluded = [...new Set(
    (Array.isArray(excludeJobTypes) ? excludeJobTypes : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
  const placeholders = excluded.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS cnt
    FROM jobs
    ${excluded.length > 0 ? `WHERE job_type NOT IN (${placeholders})` : ""}
    GROUP BY status
  `).all(...excluded);
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
