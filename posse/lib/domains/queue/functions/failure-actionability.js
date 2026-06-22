import { ASSESSABLE_JOB_TYPES } from "../../../catalog/job.js";
import { FAILED_JOB_STATUSES } from "./common.js";
import { parseJobPayload } from "./payload.js";

const FAILURE_STATUSES = new Set(FAILED_JOB_STATUSES);

export { parseJobPayload };

export function buildJobsByParent(jobs = []) {
  const byParent = new Map();
  for (const job of jobs) {
    if (!job?.parent_job_id) continue;
    if (!byParent.has(job.parent_job_id)) byParent.set(job.parent_job_id, []);
    byParent.get(job.parent_job_id).push(job);
  }
  return byParent;
}

export function isSuggestionJob(job) {
  return !!parseJobPayload(job)?.from_suggestion;
}

export function hasActionableDescendant(jobId, byParent, actionableTypes = ASSESSABLE_JOB_TYPES) {
  const stack = [...(byParent.get(jobId) || [])];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (actionableTypes.has(current.job_type)) return true;
    stack.push(...(byParent.get(current.id) || []));
  }
  return false;
}

export function isUnresolvedActionableFailure(job, byParent) {
  if (!FAILURE_STATUSES.has(job?.status)) return false;
  if (!ASSESSABLE_JOB_TYPES.has(job?.job_type)) return false;
  if (isSuggestionJob(job)) return false;
  if (hasActionableDescendant(job.id, byParent)) return false;
  return true;
}

export function listUnresolvedActionableFailures(jobs = []) {
  const byParent = buildJobsByParent(jobs);
  return jobs.filter((job) => isUnresolvedActionableFailure(job, byParent));
}
