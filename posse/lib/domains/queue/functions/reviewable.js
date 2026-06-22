// lib/domains/queue/functions/reviewable.js
//
// Shared predicates for human review eligibility. This prevents completed
// work items that are already merged from reappearing in review when branch
// cleanup is intentionally preserved.

import { QUEUE_LOCKING_JOB_TYPES } from "../../../catalog/job.js";
import { UNMERGED_WORK_ITEM_MERGE_STATES } from "../../../catalog/work-item.js";

const UNMERGED_WORK_ITEM_MERGE_STATE_SET = new Set(UNMERGED_WORK_ITEM_MERGE_STATES);

function hasRepoWriteJob(jobs = []) {
  return Array.isArray(jobs) && jobs.some((job) => QUEUE_LOCKING_JOB_TYPES.has(job?.job_type));
}

export function shouldIncludeWorkItemInApprovalQueue(wi, jobs = [], opts = {}) {
  if (!wi) return false;
  const iterativeActive = opts?.iterativeActive === true;
  if (iterativeActive) return false;
  const hasMergedEvent = opts?.hasMergedEvent === true;
  if (wi.merge_state === "merged" || hasMergedEvent) return false;

  if (wi.branch_name || UNMERGED_WORK_ITEM_MERGE_STATE_SET.has(wi.merge_state)) return true;

  // The approval queue is for repo/file-tree writes. Research, planning,
  // assessment, and background system jobs stay available in the admin log and
  // reports, but they do not need operator approval here.
  if (!hasRepoWriteJob(jobs)) return false;
  return wi.status === "failed";
}
