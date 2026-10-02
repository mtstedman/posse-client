// Which change a verdict gate asks the operator to judge.
//
// The catalog names the gates whose answer is a verdict on code and whether
// that verdict is about one job attempt or the whole work item
// (humanInputReviewDiffPolicyForPayload). This resolves the concrete change
// from queue state so the TUI prompt's [d] view and `posse gate show` show the
// same diff: the original job's latest committed implementation attempt
// (commit_base_hash..commit_hash), or the work-item branch. A change that
// cannot be resolved is still returned, with `unavailable` saying why, so the
// operator sees the reason instead of a missing view.

import {
  HUMAN_INPUT_REVIEW_DIFF_SCOPES,
  humanInputReviewDiffPolicyForPayload,
} from "../../../catalog/human-input.js";
import { getAttempts } from "./attempts.js";
import { parseJobPayload } from "./payload.js";
import { getWorkItem } from "./queue-store.js";

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function latestCommittedAttempt(attempts = []) {
  return (Array.isArray(attempts) ? attempts : [])
    .filter((attempt) => attempt?.attempt_kind !== "assessment" && String(attempt?.commit_hash || "").trim())
    .sort((left, right) => Number(right.attempt_number || 0) - Number(left.attempt_number || 0))[0] || null;
}

/**
 * The change a gate's verdict judges, or null for a gate that judges no code.
 *
 * @returns {null | {
 *   scope: "attempt" | "work_item",
 *   gate_job_id: number | null,
 *   work_item_id: number | null,
 *   job_id?: number | null,
 *   attempt_number?: number | null,
 *   commit_hash?: string | null,
 *   commit_base_hash?: string | null,
 *   branch_name?: string | null,
 *   unavailable: string | null,
 * }}
 */
export function resolveGateReviewDiffTarget(gateJob, {
  payload = null,
  getAttemptsFn = getAttempts,
  getWorkItemFn = getWorkItem,
} = {}) {
  if (!gateJob) return null;
  const gatePayload = payload || parseJobPayload(gateJob);
  const policy = humanInputReviewDiffPolicyForPayload(gatePayload);
  if (!policy) return null;
  const gateJobId = positiveId(gateJob.id);
  const workItemId = positiveId(gateJob.work_item_id);

  if (policy.scope === HUMAN_INPUT_REVIEW_DIFF_SCOPES.WORK_ITEM) {
    const workItem = workItemId ? getWorkItemFn(workItemId) : null;
    const branchName = String(gatePayload.branch_name || workItem?.branch_name || "").trim() || null;
    return {
      scope: policy.scope,
      gate_job_id: gateJobId,
      work_item_id: workItemId,
      branch_name: branchName,
      unavailable: !workItem
        ? `the gate's work item${workItemId ? ` WI#${workItemId}` : ""} no longer exists`
        : (branchName ? null : `WI#${workItemId} has no branch`),
    };
  }

  const jobId = positiveId(gatePayload.original_job_id);
  const attempt = jobId ? latestCommittedAttempt(getAttemptsFn(jobId)) : null;
  if (!attempt && policy.requires_commit) return null;
  return {
    scope: policy.scope,
    gate_job_id: gateJobId,
    work_item_id: workItemId,
    job_id: jobId,
    attempt_number: attempt ? Number(attempt.attempt_number) || null : null,
    commit_hash: attempt ? String(attempt.commit_hash).trim() : null,
    commit_base_hash: attempt ? String(attempt.commit_base_hash || "").trim() || null : null,
    unavailable: attempt
      ? null
      : (jobId ? `job #${jobId} has no committed change recorded` : "the gate names no original job"),
  };
}
