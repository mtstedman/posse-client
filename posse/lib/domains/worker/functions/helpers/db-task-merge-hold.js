// Execution gate for database (task_mode "db") dev jobs.
//
// A db job has no worktree of its own (its write surface is the project
// database), but it reads repository files to decide what to write. Before the
// work item merges, those files must come from the work item's worktree, where
// sibling jobs committed their changes; the main checkout still has the old
// content. And when the job depends on such unmerged changes, its write is
// held until the work item merges and the operator confirms the merged change
// is deployed (see queue/functions/post-merge-db-tasks.js).
//
// The plan compiler already moved the dependents of a task it expected to be
// held onto the task's upstream. The runtime decision can still differ (the
// upstream committed nothing, the repository runs database tasks before the
// merge, the work item has no branch): a task that runs now after all gives
// the compiler-rewired dependents that have not started their wait on it
// back, so they still see the database change the planner ordered them
// after. A held task that duplicates a newer plan's task for the same change
// is canceled instead of held.

import fs from "fs";
import { C } from "../../../../shared/format/functions/colors.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import { worktreePathAsync as defaultWorktreePathAsync } from "../../../git/functions/worktree-path.js";
import { isAbortError } from "../../../runtime/functions/yield.js";
import {
  POST_MERGE_DB_HOLD_KEY,
  addDependency,
  canceledDependentSummary,
  canceledDependentsNotice,
  compiledRewiredDependents,
  forceUpdateJobStatus,
  getDependencies,
  getDependents,
  getJob,
  getSetting,
  getWorkItem,
  heldPostMergeDbPayload,
  isDbTaskJob,
  logEvent,
  postMergeDbHoldDecision,
  rewireDependentAroundDbTask,
  rewiredDependentSummary,
  rewiredDependentsNotice,
  supersededPostMergeDbMessage,
  supersededPostMergeDbPayload,
  supersedingPostMergeDbTask,
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

function logDependentRewired(job, dependent, dbTask, result) {
  logEvent({
    work_item_id: job.work_item_id,
    job_id: dependent.id,
    event_type: EVENT_TYPES.JOB_DEPENDENCY_REWIRED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Dependency rewired: #${dependent.id} no longer waits on post-merge database task #${dbTask.id}; it now depends on ${result.inserted.map((id) => `#${id}`).join(", ")}`,
    event_json: JSON.stringify({
      reason: "post_merge_db_task",
      source: "post_merge_hold",
      db_job_id: Number(dbTask.id),
      held_job_id: Number(job.id),
      replacements: result.inserted,
      skipped: result.skipped,
    }),
  });
}

// Hard dependents in the same work item wait on this task, which now runs
// only after the merge; left waiting they would keep the work item from ever
// merging. Plans compiled since the compiler rewires these edges have none;
// for older plans (and anything added since) the same rewire runs here: a
// dependent that is not itself a database task needs the committed files, not
// the applied database, so it moves onto the task's upstream (typically the
// migration-file job) and stays queued.
//
// Canceled instead, as before, and listed for the operator to re-queue after
// the task runs: a dependent database task (it must not write before this
// one, and it cannot run before the merge either), and a dependent whose
// rewire is refused because the task has no upstream or the new edge would
// close a cycle. A database task's own non-db dependents are rewired before it
// is canceled, so deadlock cancellation has nothing left to cascade into.
function detachSameWorkItemDependents(job) {
  const rewired = [];
  const canceled = [];
  const dbChain = [job];
  const chained = new Set([Number(job.id)]);
  for (let index = 0; index < dbChain.length; index++) {
    const dbTask = dbChain[index];
    for (const dependency of getDependents(dbTask.id)) {
      if ((dependency.dependency_kind || "hard") !== "hard") continue;
      const dependent = getJob(dependency.job_id);
      if (!dependent || Number(dependent.work_item_id) !== Number(job.work_item_id)) continue;
      if (TERMINAL_JOB_STATUS_SET.has(dependent.status)) continue;
      if (isDbTaskJob(dependent)) {
        if (!chained.has(Number(dependent.id))) {
          chained.add(Number(dependent.id));
          dbChain.push(dependent);
        }
        continue;
      }
      const result = rewireDependentAroundDbTask(dependent.id, dbTask);
      if (result.rewired) {
        rewired.push(rewiredDependentSummary(dependent, { dbJobId: dbTask.id, upstreamJobIds: result.inserted }));
        logDependentRewired(job, dependent, dbTask, result);
      } else if (forceUpdateJobStatus(dependent.id, "canceled", { expectedStatuses: [dependent.status] })) {
        canceled.push(canceledDependentSummary(dependent));
      }
    }
  }
  for (const dependent of dbChain.slice(1)) {
    if (forceUpdateJobStatus(dependent.id, "canceled", { expectedStatuses: [dependent.status] })) {
      canceled.push(canceledDependentSummary(dependent));
    }
  }
  return { rewired, canceled };
}

function holdDbTaskUntilMerge(worker, job, leaseToken, decision) {
  const { rewired: rewiredDependents, canceled: canceledDependents } = detachSameWorkItemDependents(job);
  const heldPayload = heldPostMergeDbPayload(job, {
    dependencyJobIds: decision.dependencyJobIds,
    canceledDependents,
    rewiredDependents,
  });
  const payloadJson = JSON.stringify(heldPayload);
  // Record the hold before parking: the work-item status refresh inside the
  // lease release must already see this job as held, not as a waiting blocker.
  updateJobPayload(job.id, payloadJson);
  job.payload_json = payloadJson;
  const parked = worker._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
  if (!parked) return false;
  const dependencyList = decision.dependencyJobIds.map((id) => `#${id}`).join(", ");
  const holdRecord = heldPayload[POST_MERGE_DB_HOLD_KEY];
  const dependentsNotice = canceledDependentsNotice(holdRecord);
  const rewiredNotice = rewiredDependentsNotice(holdRecord);
  const emitNotices = [
    rewiredDependents.length > 0 ? rewiredNotice : null,
    canceledDependents.length > 0 ? dependentsNotice : null,
  ].filter(Boolean).map((notice) => `. ${notice}`).join("");
  worker.emit(
    job.id,
    `${C.yellow}[db-task]${C.reset} WI#${job.work_item_id} job #${job.id}: depends on unmerged changes from job(s) ${dependencyList}; held until the work item merges, then the operator is asked before it writes the project database${emitNotices}`,
  );
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_POST_MERGE_DB_HELD,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Database task held until WI#${job.work_item_id} merges: it depends on unmerged file changes from job(s) ${dependencyList}. ${[rewiredNotice, dependentsNotice].filter(Boolean).join(" ")}`,
    event_json: JSON.stringify({
      dependency_job_ids: decision.dependencyJobIds,
      branch_name: decision.workItem?.branch_name || null,
      canceled_dependents: canceledDependents,
      rewired_dependents: rewiredDependents,
    }),
  });
  return true;
}

// An older plan's task revived next to the newer plan's task for the same
// change (post-merge-db-tasks.js): cancel it instead of holding a duplicate.
function cancelSupersededDbTask(worker, job, leaseToken, superseding) {
  // Not an execution attempt: nothing ran, so no attempt penalty.
  if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, "canceled")) return false;
  const payloadJson = JSON.stringify(supersededPostMergeDbPayload(getJob(job.id) || job, superseding));
  updateJobPayload(job.id, payloadJson);
  job.payload_json = payloadJson;
  const message = supersededPostMergeDbMessage(job, superseding);
  worker.emit(job.id, `${C.yellow}[db-task]${C.reset} WI#${job.work_item_id}: ${message}`);
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_CANCELED_BY_SUPERSEDING_PLAN,
    actor_type: EVENT_ACTORS.WORKER,
    message,
    event_json: JSON.stringify({
      reason: "duplicate_post_merge_db_task",
      superseded_by_job_id: Number(superseding.id),
      superseding_plan_id: Number(superseding.parent_job_id) || null,
      stale_plan_id: Number(job.parent_job_id) || null,
    }),
  });
  return true;
}

const NOT_STARTED_STATUSES = new Set(["queued", "blocked"]);

// The task runs before the merge although the compiler rewired its
// dependents for a hold. Those that have not started wait on it again.
function restoreCompiledRewires(worker, job, decision) {
  const restored = [];
  const skipped = [];
  for (const entry of compiledRewiredDependents(job)) {
    const dependent = getJob(Number(entry.job_id));
    if (!dependent || Number(dependent.work_item_id) !== Number(job.work_item_id)) continue;
    if (getDependencies(dependent.id).some((dep) => Number(dep.depends_on_job_id) === Number(job.id))) continue;
    if (!NOT_STARTED_STATUSES.has(dependent.status)) {
      skipped.push({ job_id: Number(dependent.id), status: dependent.status });
      continue;
    }
    if (addDependency(dependent.id, job.id, "hard")) restored.push(Number(dependent.id));
    else skipped.push({ job_id: Number(dependent.id), status: dependent.status, reason: "cycle_or_existing" });
  }
  if (restored.length === 0) return { restored, skipped };
  const message = `Database task #${job.id} runs before the merge (${decision.reason}), so ${restored.map((id) => `#${id}`).join(", ")} wait for it again as planned`;
  worker.emit(job.id, `${C.yellow}[db-task]${C.reset} WI#${job.work_item_id}: ${message}`);
  for (const dependentId of restored) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: dependentId,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_REWIRED,
      actor_type: EVENT_ACTORS.WORKER,
      message,
      event_json: JSON.stringify({
        reason: "post_merge_db_task_not_held",
        source: "db_task_runs_before_merge",
        db_job_id: Number(job.id),
        hold_decision: decision.reason,
        restored_dependency_job_id: Number(job.id),
      }),
    });
  }
  return { restored, skipped };
}

// Hold-decision reasons under which the task runs now, before the merge.
const RUNS_BEFORE_MERGE_REASONS = new Set([
  "no_work_item_branch",
  "no_unmerged_file_dependency",
  "pre_merge_policy_run",
]);

/**
 * Run before any provider spend. Non-db jobs pass through untouched. A db job
 * that must wait for the merge is parked and { ok: false } is returned (a
 * duplicate of a newer plan's task is canceled instead); any other db job
 * gets job._dbReadRoot (the work-item worktree, or null).
 */
export async function gateDbTaskBeforeExecution(worker, job, leaseToken, {
  signal = null,
  worktreePathAsync = defaultWorktreePathAsync,
} = {}) {
  if (!isDbTaskJob(job)) return { ok: true };
  const policy = getSetting(SETTING_KEYS.DB_TASK_PRE_MERGE_POLICY, { projectDir: worker.projectDir });
  const decision = postMergeDbHoldDecision(job, { policy });
  if (decision.hold) {
    const superseding = supersedingPostMergeDbTask(job);
    if (superseding) {
      return {
        ok: false,
        held: false,
        superseded: cancelSupersededDbTask(worker, job, leaseToken, superseding),
        supersededBy: Number(superseding.id),
        decision,
      };
    }
    return { ok: false, held: holdDbTaskUntilMerge(worker, job, leaseToken, decision), decision };
  }
  const restoredDependents = RUNS_BEFORE_MERGE_REASONS.has(decision.reason)
    ? restoreCompiledRewires(worker, job, decision)
    : { restored: [], skipped: [] };
  job._dbReadRoot = await resolveDbTaskReadRootAsync(worker, job, { signal, worktreePathAsync });
  return { ok: true, decision, readRoot: job._dbReadRoot, restoredDependents };
}
