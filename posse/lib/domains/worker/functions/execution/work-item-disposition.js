// Answers to the work-item disposition gates (see
// queue/functions/work-item-dispositions.js): a failed work item's
// retry | accept | abandon, and a merge deferred on a failed or canceled
// upstream's wait | rebuild | abandon.
//
// Validation and branch deletion run before the gate claims the answer. An
// answer that cannot apply yet (accept with an execution failure, a branch a
// merge holds, a worktree that refuses cleanup) keeps the gate open with the
// reason instead of retiring it, so the operator can fix the cause and answer
// again. Once claimed, the queue transition itself is a single transaction.
//
// Branch deletion (abandon, rebuild) cannot be undone by the transaction
// that follows it. If that transition then fails (a database error, an
// active job that appeared meanwhile) while the work item still waits on
// this gate, the gate stays open (keepGateOpen) instead of retiring: a failed
// work item gets one recovery gate per failure, so a retired one would not
// come back, and its branch is already gone. The answers still left are the
// ones that need no branch (rebuild, abandon); retry, accept and wait are
// refused once an earlier answer deleted the branch. A merge-deferred work
// item whose gate goes away anyway gets a rebuild-or-abandon gate from gate
// maintenance, which no longer requires a branch for that question.

import { C } from "../../../../shared/format/functions/colors.js";
import {
  acceptFailedWorkItem,
  canceledCrossWiUpstreamsText,
  crossWiUpstreamWaitAvailable,
  failedWorkItemAcceptancePlan,
  forgetDiscardedWorkItemBranch,
  getWorkItem,
  hasUnresolvedSharedTrunkMergeOperation,
  logEvent,
  rebuildWorkItemOnTarget,
  retryFailedWorkItem,
  reviewRejectionReadiness,
  runInTransaction,
  staleCrossWiUpstreams,
  updateWorkItemStatus,
} from "../../../queue/functions/index.js";
import { withMergeLock } from "../../../queue/functions/locks.js";
import { createGitWorkflowHelpers } from "../../../git/functions/workflows.js";
import { resolveTargetBranchForAdmin } from "../../../git/functions/target-branch.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import {
  CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
} from "../../../../catalog/human-input.js";

let gitWorkflowFactoryForTests = null;

/** Test seam: replace the Git workflow whose cleanupWiBranchAsync deletes branches. */
export function __setWorkItemDispositionGitWorkflowForTests(factory = null) {
  gitWorkflowFactoryForTests = typeof factory === "function" ? factory : null;
}

function gitWorkflow(projectDir) {
  if (gitWorkflowFactoryForTests) return gitWorkflowFactoryForTests(projectDir);
  return createGitWorkflowHelpers({
    projectDir,
    targetBranch: resolveTargetBranchForAdmin(projectDir),
    nonInteractive: true,
  });
}

/** Operator text after "<action>:" (posse gate answer --feedback). */
export function workItemDispositionNote(answer, action) {
  const text = String(answer || "").trim();
  const prefix = `${action}:`;
  return text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length).trim().slice(0, 2000) : "";
}

// Abandon and rebuild drop the branch the way review rejection and deletion
// do: under the merge lock, never while a merge or shared-trunk publication
// holds it. The worktree is snapshotted, not required clean: a failed or
// deferred work item has no reviewed worktree state to protect.
async function deleteWorkItemBranch(worker, workItemId) {
  if (hasUnresolvedSharedTrunkMergeOperation(workItemId)) {
    return { ok: false, message: `WI#${workItemId} has a shared-trunk publication in progress; answer again once it settles` };
  }
  const outcome = await withMergeLock(async () => {
    const workItem = getWorkItem(workItemId);
    if (!workItem) return { ok: false, message: `WI#${workItemId} no longer exists` };
    if (workItem.merge_state === "merged") return { ok: false, message: `WI#${workItemId} is already merged` };
    if (workItem.merge_state === "merge_authorized") {
      return { ok: false, message: `WI#${workItemId} is being merged; answer again once the merge settles` };
    }
    if (!workItem.branch_name) return { ok: true };
    const cleaned = await gitWorkflow(worker.projectDir).cleanupWiBranchAsync(workItem, { clearMergeState: true });
    return cleaned
      ? { ok: true }
      : { ok: false, message: `Could not delete branch ${workItem.branch_name} of WI#${workItemId} (see the git cleanup event); fix it and answer again` };
  });
  if (!outcome.acquired) {
    return { ok: false, message: "Another merge is in progress; answer again once it finishes" };
  }
  return outcome.result;
}

/**
 * Checks and Git work that must succeed before the gate claims the answer.
 * Returns { ok } or { ok: false, message } to keep the gate open.
 */
export async function prepareWorkItemDispositionAnswer(worker, job, payload, action) {
  const workItemId = Number(job.work_item_id);
  const workItem = getWorkItem(workItemId);
  // A stale gate is retired by the claimed answer's own state check.
  if (!workItem) return { ok: true };
  const branch = String(workItem.branch_name || "").trim();
  if (payload.review_type === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE) {
    if (workItem.status !== "failed") return { ok: true };
    const gateBranch = String(payload.branch_name || "").trim();
    if ((action === "retry" || action === "accept") && gateBranch && !branch) {
      return {
        ok: false,
        message: `WI#${workItemId}'s branch ${gateBranch} was already deleted by an earlier answer, so there are no commits to ${action}; answer abandon`,
      };
    }
    if (action === "accept") {
      const plan = failedWorkItemAcceptancePlan(workItemId, { gateJobId: job.id });
      if (!plan.ok) return { ok: false, message: plan.message || `Cannot accept WI#${workItemId} (${plan.reason})` };
    }
    if (action === "abandon") return deleteWorkItemBranch(worker, workItemId);
    return { ok: true };
  }
  if (payload.review_type === CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE) {
    if (workItem.status !== "complete" || workItem.merge_state === "merged") return { ok: true };
    if (action === "wait") {
      if (!branch) {
        return { ok: false, message: `WI#${workItemId}'s branch was already deleted by an earlier answer, so there is nothing left to merge; answer rebuild or abandon` };
      }
      // A canceled upstream never merges: waiting on it would strand the
      // work item with its question already answered.
      const upstreams = staleCrossWiUpstreams(workItem);
      if (!crossWiUpstreamWaitAvailable(upstreams)) {
        return { ok: false, message: `Cannot wait: ${canceledCrossWiUpstreamsText(upstreams)}. Answer rebuild or abandon` };
      }
    }
    if (action === "rebuild") {
      const readiness = reviewRejectionReadiness(workItemId, { ignoreJobIds: [job.id] });
      if (!readiness.ok) {
        return { ok: false, message: `Cannot rebuild WI#${workItemId} now (${readiness.reason})` };
      }
      return deleteWorkItemBranch(worker, workItemId);
    }
    if (action === "abandon") return deleteWorkItemBranch(worker, workItemId);
  }
  return { ok: true };
}

function resolvedEvent(job, payload, action, actorType, message, detail = {}) {
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORK_ITEM_DISPOSITION_RESOLVED,
    actor_type: actorType,
    message,
    event_json: JSON.stringify({ gate_job_id: job.id, review_type: payload.review_type, action, ...detail }),
  });
}

function abandonWorkItem(job, payload, { actorType, actorLabel }) {
  const workItemId = Number(job.work_item_id);
  const workItem = getWorkItem(workItemId);
  if (!workItem || workItem.status === "canceled") {
    return { ok: false, message: `WI#${workItemId} is already ${workItem ? "canceled" : "gone"}` };
  }
  const canceled = runInTransaction(() => {
    if (!updateWorkItemStatus(workItemId, "canceled", { preserveJobIds: [job.id] })) return false;
    // The branch went with its content (prepare deleted it).
    if (!String(workItem.branch_name || "").trim()) {
      forgetDiscardedWorkItemBranch(workItemId, { reason: "abandoned", branch: payload.branch_name || null });
    }
    return true;
  });
  if (!canceled) {
    return { ok: false, message: `WI#${workItemId} could not be canceled from ${workItem.status}` };
  }
  logEvent({
    work_item_id: workItemId,
    event_type: EVENT_TYPES.WORK_ITEM_CANCELED,
    actor_type: actorType,
    message: `${actorLabel} abandoned WI#${workItemId} via gate #${job.id}`,
  });
  resolvedEvent(job, payload, "abandon", actorType, `${actorLabel} abandoned WI#${workItemId}; its branch was deleted`, {
    prior_status: workItem.status,
  });
  return { ok: true, message: `Abandoned WI#${workItemId}; its branch was deleted` };
}

function rebuildFeedback(upstreams, note) {
  const ids = upstreams.map((upstream) => `WI#${upstream.source_work_item_id}`).join(", ") || "the upstream work item";
  return [
    `REBUILD ON THE TARGET BRANCH: ${ids} failed or was canceled and will not merge, so this work item's branch was deleted together with every earlier task's commits and the cross-WI edits it inherited from ${ids}.`,
    "Plan and re-implement this work item's own changes from the current target branch. Do not depend on, or re-create, the inherited edits.",
    note ? `Operator note: ${note}` : null,
  ].filter(Boolean).join(" ");
}

// The work item still waits on a gate of this kind: failed for a recovery
// gate, complete and unmerged for an upstream gate.
function workItemStillAwaitsGate(workItemId, payload) {
  const workItem = getWorkItem(workItemId);
  if (!workItem) return false;
  if (payload.review_type === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE) return workItem.status === "failed";
  if (payload.review_type === CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE) {
    return workItem.status === "complete" && workItem.merge_state !== "merged";
  }
  return false;
}

/**
 * Apply a claimed answer. Returns { ok, message, keepGateOpen? }. ok false
 * retires the gate as not applicable when the work item left the state the
 * gate decided; when it still waits on this gate (the transition failed or
 * threw, possibly after prepare already deleted the branch), keepGateOpen
 * asks the caller to reopen the gate for another answer instead.
 */
export function applyWorkItemDispositionAnswer(args = {}) {
  const { job, payload } = args;
  const workItemId = Number(job.work_item_id);
  let result;
  try {
    result = applyWorkItemDispositionTransition(args);
  } catch (error) {
    result = { ok: false, message: `WI#${workItemId}: ${args.action} could not be applied (${error?.message || String(error)})` };
  }
  if (!result.ok && workItemStillAwaitsGate(workItemId, payload)) return { ...result, keepGateOpen: true };
  return result;
}

function applyWorkItemDispositionTransition({
  job,
  payload,
  action,
  answer = "",
  actorType = EVENT_ACTORS.HUMAN,
  actorLabel = "Human",
} = {}) {
  const workItemId = Number(job.work_item_id);
  const workItem = getWorkItem(workItemId);
  if (!workItem) return { ok: false, message: `WI#${workItemId} no longer exists` };
  const note = workItemDispositionNote(answer, action);

  if (payload.review_type === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE) {
    if (workItem.status !== "failed") {
      return { ok: false, message: `WI#${workItemId} is ${workItem.status}, not failed; the recovery gate no longer applies` };
    }
    if (action === "retry") {
      const retried = retryFailedWorkItem(workItemId, { gateJobId: job.id, note, actorType, actorLabel });
      if (!retried.ok) return { ok: false, message: `Retry of WI#${workItemId} was not applied (${retried.reason})` };
      const ids = (list) => list.map((id) => `#${id}`).join(", ");
      return {
        ok: true,
        message: [
          retried.requeued_job_ids.length > 0
            ? `Requeued ${ids(retried.requeued_job_ids)} on WI#${workItemId}'s branch`
            : `Retried WI#${workItemId}`,
          retried.restored_job_ids.length > 0 ? `restored ${ids(retried.restored_job_ids)}` : null,
          retried.retired_gate_job_ids.length > 0 ? `retired timed-out gate(s) ${ids(retried.retired_gate_job_ids)}` : null,
          retried.reheld_db_task_ids.length > 0 ? `database task(s) ${ids(retried.reheld_db_task_ids)} held for the merge again` : null,
        ].filter(Boolean).join("; "),
      };
    }
    if (action === "accept") {
      const accepted = acceptFailedWorkItem(workItemId, { gateJobId: job.id, actorType, actorLabel });
      if (!accepted.ok) return { ok: false, message: accepted.message || `Accept of WI#${workItemId} was not applied (${accepted.reason})` };
      return {
        ok: true,
        message: `Accepted ${accepted.accepted_job_ids.map((id) => `#${id}`).join(", ")}; WI#${workItemId} is ${accepted.status}${accepted.merge_state ? `/${accepted.merge_state}` : ""}`,
      };
    }
    if (action === "abandon") return abandonWorkItem(job, payload, { actorType, actorLabel });
    return { ok: false, message: `Unknown recovery action ${action}` };
  }

  if (payload.review_type === CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE) {
    if (workItem.status !== "complete" || workItem.merge_state === "merged") {
      return { ok: false, message: `WI#${workItemId} is ${workItem.status}; the merge question no longer applies` };
    }
    const upstreams = staleCrossWiUpstreams(workItem);
    if (action === "wait") {
      resolvedEvent(
        job,
        payload,
        "wait",
        actorType,
        `${actorLabel} kept WI#${workItemId} waiting for ${upstreams.map((upstream) => `WI#${upstream.source_work_item_id}`).join(", ") || "its upstream"} to be recovered and merged`,
        { upstream_work_item_ids: upstreams.map((upstream) => upstream.source_work_item_id) },
      );
      return { ok: true, message: `WI#${workItemId} keeps waiting for its upstream to merge` };
    }
    if (action === "rebuild") {
      const rebuilt = rebuildWorkItemOnTarget(workItemId, {
        gateJobId: job.id,
        feedback: rebuildFeedback(upstreams, note),
      });
      if (!rebuilt.ok) return { ok: false, message: `WI#${workItemId} could not be requeued for a rebuild (${rebuilt.reason})` };
      resolvedEvent(job, payload, "rebuild", actorType, `${actorLabel} rebuilt WI#${workItemId} on the target branch without the edits inherited from its failed upstream: replan #${rebuilt.plan_job_id}`, {
        upstream_work_item_ids: upstreams.map((upstream) => upstream.source_work_item_id),
        plan_job_id: rebuilt.plan_job_id,
        superseded_db_task_ids: rebuilt.superseded_db_task_ids,
        dropped_sync_records: rebuilt.dropped_sync_records,
      });
      return {
        ok: true,
        message: `Replanning WI#${workItemId} from the target branch without the inherited edits (plan #${rebuilt.plan_job_id})${rebuilt.superseded_db_task_ids.length > 0 ? `; held database task(s) ${rebuilt.superseded_db_task_ids.map((id) => `#${id}`).join(", ")} superseded by the new plan` : ""}`,
      };
    }
    if (action === "abandon") return abandonWorkItem(job, payload, { actorType, actorLabel });
    return { ok: false, message: `Unknown merge disposition ${action}` };
  }
  return { ok: false, message: `Not a work-item disposition gate: ${payload.review_type}` };
}

export function emitWorkItemDispositionResult(worker, job, result) {
  worker.emit(
    job.id,
    result.ok
      ? `${C.cyan}[human] ${result.message}${C.reset}`
      : `${C.yellow}[human] ${result.message}${C.reset}`,
  );
}
