// Execution gate for database (task_mode "db") dev jobs.
//
// A db job has no worktree of its own (its write surface is the project
// database), but it reads repository files to decide what to write. Before the
// work item merges, those files must come from the work item's worktree, where
// sibling jobs committed their changes; the main checkout still has the old
// content. And when the job depends on such unmerged changes, its write is
// held until the work item merges and the operator confirms the merged change
// is deployed (see queue/functions/post-merge-db-tasks.js).

import fs from "fs";
import { C } from "../../../../shared/format/functions/colors.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import { worktreePathAsync as defaultWorktreePathAsync } from "../../../git/functions/worktree-path.js";
import { isAbortError } from "../../../runtime/functions/yield.js";
import {
  POST_MERGE_DB_HOLD_KEY,
  canceledDependentSummary,
  canceledDependentsNotice,
  forceUpdateJobStatus,
  getDependents,
  getJob,
  getSetting,
  getWorkItem,
  heldPostMergeDbPayload,
  isDbTaskJob,
  logEvent,
  postMergeDbHoldDecision,
  updateJobPayload,
} from "../../../queue/functions/index.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);

/**
 * The work item's worktree while its branch is unmerged and checked out;
 * null means read the project checkout (no branch yet, merged, or absent).
 */
export async function resolveDbTaskReadRootAsync(worker, job, {
  signal = null,
  worktreePathAsync = defaultWorktreePathAsync,
} = {}) {
  const workItem = getWorkItem(job.work_item_id);
  if (!workItem?.branch_name || workItem.merge_state === "merged") return null;
  try {
    const wtPath = await worktreePathAsync(worker.projectDir, workItem.id, workItem.title, { signal });
    return wtPath && fs.existsSync(wtPath) ? wtPath : null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    worker.emit(job.id, `${C.yellow}[db-task] WI#${job.work_item_id} job #${job.id}: could not resolve the work-item worktree (${String(err?.message || err).split("\n")[0]}); reading the project checkout${C.reset}`);
    return null;
  }
}

// Hard dependents in the same work item can only run after this task, which
// now runs after the merge; left queued they would keep the work item from
// ever merging. Cancel them (deeper chains follow via deadlock cancellation)
// and return what the operator needs to re-queue them.
function cancelSameWorkItemDependents(job) {
  const canceled = [];
  for (const dependency of getDependents(job.id)) {
    if ((dependency.dependency_kind || "hard") !== "hard") continue;
    const dependent = getJob(dependency.job_id);
    if (!dependent || Number(dependent.work_item_id) !== Number(job.work_item_id)) continue;
    if (TERMINAL_JOB_STATUS_SET.has(dependent.status)) continue;
    if (forceUpdateJobStatus(dependent.id, "canceled", { expectedStatuses: [dependent.status] })) {
      canceled.push(canceledDependentSummary(dependent));
    }
  }
  return canceled;
}

function holdDbTaskUntilMerge(worker, job, leaseToken, decision) {
  const canceledDependents = cancelSameWorkItemDependents(job);
  const heldPayload = heldPostMergeDbPayload(job, {
    dependencyJobIds: decision.dependencyJobIds,
    canceledDependents,
  });
  const payloadJson = JSON.stringify(heldPayload);
  // Record the hold before parking: the work-item status refresh inside the
  // lease release must already see this job as held, not as a waiting blocker.
  updateJobPayload(job.id, payloadJson);
  job.payload_json = payloadJson;
  const parked = worker._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
  if (!parked) return false;
  const dependencyList = decision.dependencyJobIds.map((id) => `#${id}`).join(", ");
  const dependentsNotice = canceledDependentsNotice(heldPayload[POST_MERGE_DB_HOLD_KEY]);
  worker.emit(
    job.id,
    `${C.yellow}[db-task]${C.reset} WI#${job.work_item_id} job #${job.id}: depends on unmerged changes from job(s) ${dependencyList}; held until the work item merges, then the operator is asked before it writes the project database${canceledDependents.length > 0 ? `. ${dependentsNotice}` : ""}`,
  );
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_POST_MERGE_DB_HELD,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Database task held until WI#${job.work_item_id} merges: it depends on unmerged file changes from job(s) ${dependencyList}. ${dependentsNotice}`,
    event_json: JSON.stringify({
      dependency_job_ids: decision.dependencyJobIds,
      branch_name: decision.workItem?.branch_name || null,
      canceled_dependents: canceledDependents,
    }),
  });
  return true;
}

/**
 * Run before any provider spend. Non-db jobs pass through untouched. A db job
 * that must wait for the merge is parked and { ok: false } is returned; any
 * other db job gets job._dbReadRoot (the work-item worktree, or null).
 */
export async function gateDbTaskBeforeExecution(worker, job, leaseToken, {
  signal = null,
  worktreePathAsync = defaultWorktreePathAsync,
} = {}) {
  if (!isDbTaskJob(job)) return { ok: true };
  const policy = getSetting(SETTING_KEYS.DB_TASK_PRE_MERGE_POLICY, { projectDir: worker.projectDir });
  const decision = postMergeDbHoldDecision(job, { policy });
  if (decision.hold) {
    return { ok: false, held: holdDbTaskUntilMerge(worker, job, leaseToken, decision), decision };
  }
  job._dbReadRoot = await resolveDbTaskReadRootAsync(worker, job, { signal, worktreePathAsync });
  return { ok: true, decision, readRoot: job._dbReadRoot };
}
