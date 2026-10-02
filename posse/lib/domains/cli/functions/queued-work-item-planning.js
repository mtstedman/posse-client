// Which queued work items `posse go` and `posse plan` may plan.
//
// Both commands start a fresh research/plan job for every work item in
// status "queued". A work item can be left "queued" while it already has
// work: the review-rejection requeue (queue-store
// requeueWorkItemAfterRejection) requeues its jobs, or adds a replan job, and
// sets the status to "queued" without settling it from those jobs. Planning
// it again ran a second plan alongside the requeued work (run 1250b red team
// 2, finding 2: wowiekowie WI 170 sat "queued" with dev job 2176 queued, and
// the first `posse go` created plan 2249 next to it; plan cleanup does not
// cancel a running 2176).

import {
  getWorkItem,
  isMergeVerificationReviewJob,
  isPostMergeHeldDbJob,
  isPushOfferJob,
  isWorkItemDispositionGateJob,
  listJobsByWorkItem,
  listWorkItems,
  refreshWorkItemStatus,
} from "../../queue/functions/index.js";
import { isShadowFanoutJob } from "../../research/functions/fanout-payload.js";
import { NON_COMPLETION_BLOCKING_JOB_TYPES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);

/**
 * The work item's unfinished jobs that are its own work: the jobs its status
 * is settled from (queue refreshWorkItemStatus leaves out push offers, merge
 * verification reviews, held post-merge database tasks, disposition gates,
 * shadow fan-out jobs and optional accelerators).
 */
export function openWorkJobsForWorkItem(workItemId) {
  return listJobsByWorkItem(workItemId).filter((job) => (
    !TERMINAL_JOB_STATUS_SET.has(job.status)
    && !NON_COMPLETION_BLOCKING_JOB_TYPES.has(job.job_type)
    && !isShadowFanoutJob(job)
    && !isPushOfferJob(job)
    && !isMergeVerificationReviewJob(job)
    && !isPostMergeHeldDbJob(job)
    && !isWorkItemDispositionGateJob(job)
  ));
}

/**
 * Split the queued work items into those to plan now and those that already
 * have unfinished work. The latter are not planned again; their status is
 * refreshed from their jobs first (usually to running or planning), so the
 * run picks their work up and they stop reading as "queued". A queued work
 * item with no unfinished job (a new one, or one whose jobs all ended) is
 * planned as before.
 *
 * @returns {{ toPlan: object[], skipped: Array<{ workItem: object, openJobIds: number[], status: string|null }> }}
 */
export function selectQueuedWorkItemsToPlan() {
  const toPlan = [];
  const skipped = [];
  for (const workItem of listWorkItems("queued")) {
    const open = openWorkJobsForWorkItem(workItem.id);
    if (open.length === 0) {
      toPlan.push(workItem);
      continue;
    }
    try {
      refreshWorkItemStatus(workItem.id);
    } catch { /* still skipped: planning it again would duplicate its work */ }
    skipped.push({
      workItem,
      openJobIds: open.map((job) => Number(job.id)),
      status: getWorkItem(workItem.id)?.status ?? null,
    });
  }
  return { toPlan, skipped };
}

/**
 * `posse go`'s planning step: plan the queued work items only when the run's
 * startup dirty-tree guard will let the run boot. Planning moves each work
 * item to "planning" and creates its plan job; it ran before the guard, so a
 * blocked run exited 2 with the queue already changed (fiscal-wizard run
 * 2026-10-01T16-54-02: WI 2 -> planning, plan job 16, then "Run blocked").
 * A check that fails to run does not block here; the run's own guard reports
 * it.
 *
 * @param {object[]} queued work items selected by selectQueuedWorkItemsToPlan
 * @param {{ checkStartupDirtyTree: () => Promise<object>, plan: (queued: object[]) => (void|Promise<void>) }} steps
 * @returns {Promise<{ blocked: object|null }>} the guard's blocked result when planning was skipped
 */
export async function planQueuedWorkItemsUnlessStartupBlocked(queued, { checkStartupDirtyTree, plan }) {
  if (!Array.isArray(queued) || queued.length === 0) return { blocked: null };
  let check = null;
  try {
    check = await checkStartupDirtyTree();
  } catch { /* infrastructure failure: the run's startup guard reports it */ }
  if (check?.ok === false && check?.blocked === true) return { blocked: check };
  await plan(queued);
  return { blocked: null };
}
