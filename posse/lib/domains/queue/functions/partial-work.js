// Partial work: a branch-backed work item whose implementation jobs did not all
// land. Completion readiness deliberately waives terminal failures
// (allowTerminalFailureBlockers) so an operator can still ship what did land,
// but approving then merges only part of the planned change. Every approval
// surface (TUI, text review, bridge, `posse merge`) uses this one predicate to
// require an explicit "merge partial work" confirmation first.

import { FAILED_JOB_STATUSES, MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { buildJobsByParent, isSuggestionJob } from "./failure-actionability.js";

const FAILURE_STATUSES = new Set(FAILED_JOB_STATUSES);

function hasSucceededDescendant(jobId, byParent) {
  const stack = [...(byParent.get(jobId) || [])];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.status === "succeeded" && current.job_type !== "human_input") return true;
    stack.push(...(byParent.get(current.id) || []));
  }
  return false;
}

/**
 * Implementation jobs (dev, fix, artificer, promote) that failed, dead-lettered
 * or were canceled and were not replaced. A failure repaired by a succeeded
 * descendant is recovered, matching the review screen. A job canceled or
 * failed before a later plan wave succeeded was superseded by that replan
 * (replans and superseding plans cancel the stale wave and plan its
 * replacement). Follow-up suggestion jobs are not the WI's planned work.
 */
export function listPartialWorkJobs(jobs = []) {
  const rows = (Array.isArray(jobs) ? jobs : []).filter(Boolean);
  const byParent = buildJobsByParent(rows);
  const latestSucceededPlanId = rows.reduce((latest, job) => (
    job.job_type === "plan" && job.status === "succeeded"
      ? Math.max(latest, Number(job.id) || 0)
      : latest
  ), 0);
  return rows.filter((job) => {
    if (!MUTATING_JOB_TYPES.has(job.job_type)) return false;
    if (job.status !== "canceled" && !FAILURE_STATUSES.has(job.status)) return false;
    if (isSuggestionJob(job)) return false;
    if (hasSucceededDescendant(job.id, byParent)) return false;
    return !(Number(job.id) < latestSucceededPlanId);
  });
}

/**
 * Partial work that an approval of `wi` would merge. Only a branch that is not
 * yet merged carries anything to merge; settlement retries of a merged WI and
 * branchless completions need no confirmation.
 */
export function partialWorkToMerge(wi, jobs = []) {
  if (!wi?.branch_name || wi.merge_state === "merged") return [];
  return listPartialWorkJobs(jobs);
}

export function describePartialWorkJobs(jobs = [], { limit = 4 } = {}) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const shown = rows.slice(0, limit).map((job) => `#${job.id} ${job.job_type} ${job.status}`);
  const more = rows.length > limit ? `, +${rows.length - limit} more` : "";
  const noun = rows.length === 1 ? "implementation job" : "implementation jobs";
  return `${rows.length} ${noun} did not land (${shown.join(", ")}${more})`;
}
