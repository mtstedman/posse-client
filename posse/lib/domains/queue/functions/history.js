import { getDb } from "../../../shared/storage/functions/index.js";
import { COMPLETED_OUTCOME_JOB_STATUSES_SQL } from "./common.js";
import { parseJobPayload } from "./payload.js";

/**
 * Get recent completed jobs that touched any of the given files.
 * @param {{ file_paths: string[], limit?: number }} opts
 */
export function getRecentJobsByFiles({ file_paths = [], limit = 10 } = {}) {
  if (file_paths.length === 0) return [];
  const db = getDb();
  // Get recent terminal jobs that have payload_json containing any of the target files
  const rows = db.prepare(`
    SELECT id, work_item_id, title, job_type, status, assessor_verdict, last_error, payload_json
    FROM jobs
    WHERE status IN (${COMPLETED_OUTCOME_JOB_STATUSES_SQL})
    ORDER BY finished_at DESC
    LIMIT ?
  `).all(limit * 5);

  const targetSet = new Set(file_paths.map(p => p.replace(/\\/g, "/")));
  const results = [];
  for (const row of rows) {
    if (results.length >= limit) break;
    const payload = parseJobPayload(row);
    const jobFiles = [
      ...(payload.files_to_modify || []),
      ...(payload.files_to_create || []),
    ].map(p => p.replace(/\\/g, "/"));
    const overlap = jobFiles.filter(f => targetSet.has(f));
    if (overlap.length > 0) {
      results.push({
        job_id: row.id,
        title: row.title,
        job_type: row.job_type,
        status: row.status,
        assessor_verdict: row.assessor_verdict,
        last_error: row.last_error ? row.last_error.slice(0, 200) : null,
        files: overlap,
      });
    }
  }
  return results;
}

/**
 * Get a brief summary of recent work items (for planner/researcher context).
 * @param {{ limit?: number }} opts
 */
export function getRecentWorkItemSummaries({ limit = 5 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT id, title, status, governance_tier, completed_at
    FROM work_items
    WHERE status IN ('complete', 'failed')
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(limit);
}
