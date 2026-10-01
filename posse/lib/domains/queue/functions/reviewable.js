// lib/domains/queue/functions/reviewable.js
//
// Shared predicates for human review eligibility. This prevents completed
// work items that are already merged from reappearing in review when branch
// cleanup is intentionally preserved.

import { UNMERGED_WORK_ITEM_MERGE_STATES } from "../../../catalog/work-item.js";

const UNMERGED_WORK_ITEM_MERGE_STATE_SET = new Set(UNMERGED_WORK_ITEM_MERGE_STATES);

export function shouldIncludeWorkItemInApprovalQueue(wi, jobs = [], opts = {}) {
  if (!wi) return false;
  // Approval is a merge/finalization surface, not a recovery surface. Failed
  // work remains visible in status, reports, and retry flows, but must never
  // become mergeable merely because it still owns a branch or merge state.
  if (wi.status !== "complete") return false;
  const iterativeActive = opts?.iterativeActive === true;
  if (iterativeActive) return false;
  const hasMergedEvent = opts?.hasMergedEvent === true;
  if (wi.merge_state === "merged" || hasMergedEvent) return false;

  if (wi.branch_name || UNMERGED_WORK_ITEM_MERGE_STATE_SET.has(wi.merge_state)) return true;

  // A completed item without an unmerged branch has nothing left for the
  // approval surface to merge. It remains available in reports and admin logs.
  return false;
}
