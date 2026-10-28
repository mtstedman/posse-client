import { getDb } from "../../../shared/storage/functions/index.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { FINAL_REVIEW_OBSERVATIONS, FINAL_REVIEW_SOURCE_READ_TYPES, FINAL_REVIEW_SOURCE_READ_ACTIONS } from "../../../catalog/final-review.js";

export function countReviewSourceReads(rows) {
  const reads = new Set();
  for (const row of rows) {
    let detail;
    try { detail = JSON.parse(row.detail_json || "{}"); } catch { continue; }
    if (detail.phase === "begin" || row.observation_type?.endsWith(".started")) continue;
    if (FINAL_REVIEW_SOURCE_READ_TYPES.includes(row.observation_type)
      || FINAL_REVIEW_SOURCE_READ_ACTIONS.includes(detail.action)) {
      reads.add(detail.inv || row.id);
    }
  }
  return reads.size;
}

export function recordReviewSourceReads({ agentCallId, jobId, workItemId, attemptId, provider }) {
  if (!Number.isInteger(agentCallId)) return;
  try {
    const rows = getDb().prepare(`SELECT id, observation_type, detail_json FROM job_observations
      WHERE job_id = ? AND json_extract(detail_json, '$.agent_call_id') = ?`).all(jobId, agentCallId);
    const count = countReviewSourceReads(rows);
    recordObservation({ work_item_id: workItemId, job_id: jobId, attempt_id: attemptId,
      observation_type: FINAL_REVIEW_OBSERVATIONS.SOURCE_READS, summary: `Final review: ${count} source read(s)`,
      detail: { agent_call_id: agentCallId, provider, count } });
  } catch { /* Measurement cannot invalidate a reviewer verdict. */ }
}
