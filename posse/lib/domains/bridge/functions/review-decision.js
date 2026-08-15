import {
  appendReviewRejectionDescription,
  canCompleteWorkItem,
  finalizeApprovedWorkItemMerge,
  getJob,
  getWorkItem,
  holdWorkItemForPendingMerge,
  listJobsByWorkItem,
  logEvent,
  markWorkItemMergeFailed,
  requeueWorkItemAfterRejection,
  reviewRejectionReadiness,
  updateWorkItemStatus,
} from "../../queue/functions/index.js";
import { withMergeLock } from "../../queue/functions/locks.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { shouldIncludeWorkItemInApprovalQueue } from "../../queue/functions/reviewable.js";
import { createGitWorkflowHelpers } from "../../git/functions/workflows.js";
import { resolveTargetBranchForAdmin } from "../../git/functions/target-branch.js";
import { redactBridgeValue } from "./redaction.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import {
  isHumanInputCoordinationPayload,
  isHumanInputReviewPayload,
} from "../../../catalog/human-input.js";

const OPEN_REVIEW_GATE_STATUSES = new Set(["queued", "waiting_on_human", "waiting_on_review"]);
const MAX_BRIDGE_MERGE_ERROR_CHARS = 2000;

function bridgeMergeError(value) {
  const text = String(value || "").slice(0, MAX_BRIDGE_MERGE_ERROR_CHARS);
  const redacted = redactBridgeValue(text);
  return typeof redacted === "string" ? redacted : text;
}

function rejectionDescription(wi, reason) {
  return appendReviewRejectionDescription(wi.description, reason);
}

export function isReviewGateJob(job, payload = null) {
  if (!job || job.job_type !== "human_input") return false;
  const parsed = payload || parseJobPayload(job);
  if (parsed?.subtype === "plan_approval") return false;
  if (isHumanInputCoordinationPayload(parsed)) return false;
  if (isHumanInputReviewPayload(parsed)) return true;
  return job.status === "waiting_on_review";
}

export function findPendingReviewGate(wiId, jobs = null) {
  const rows = Array.isArray(jobs) ? jobs : listJobsByWorkItem(wiId);
  for (const job of rows) {
    if (!OPEN_REVIEW_GATE_STATUSES.has(job?.status)) continue;
    const payload = parseJobPayload(job);
    if (isReviewGateJob(job, payload)) return job;
  }
  return null;
}

export function resolveReviewGateJob(jobId) {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "no_such_job" };
  if (job.job_type !== "human_input") return { ok: false, reason: "not_gate_job" };
  const payload = parseJobPayload(job);
  if (!isReviewGateJob(job, payload)) return { ok: false, reason: "wrong_gate_kind" };
  return { ok: true, job, payload, workItemId: Number(job.work_item_id) || null };
}

function requireReviewableWorkItem(wi) {
  const jobs = listJobsByWorkItem(wi.id);
  const pendingGate = findPendingReviewGate(wi.id, jobs);
  if (pendingGate) return { ok: true, jobs, pendingGate };
  if (wi.status === "waiting_on_review") return { ok: true, jobs, pendingGate: null };
  if (shouldIncludeWorkItemInApprovalQueue(wi, jobs)) return { ok: true, jobs, pendingGate: null };
  return { ok: false, reason: "no_pending_review" };
}

export function preflightReviewApproval(workItemId, {
  projectDir = process.cwd(),
  reviewWorkflow = null,
} = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const completionReady = canCompleteWorkItem(wi.id, {
    allowTerminalFailureBlockers: true,
    resolvePendingReviews: true,
  });
  if (!completionReady) {
    return {
      ok: false,
      reason: "completion_blocked",
      message: "Approval blocked because unresolved required jobs remain.",
      work_item_id: wi.id,
      review_approved: false,
    };
  }
  if (!wi.branch_name || wi.merge_state === "merged") {
    return { ok: true, work_item_id: wi.id };
  }

  const workflow = reviewWorkflow || createBridgeReviewWorkflow(projectDir);
  if (typeof workflow?.sourceWorktreeDirtyState !== "function") {
    return { ok: true, work_item_id: wi.id };
  }

  let dirtyState;
  try {
    dirtyState = workflow.sourceWorktreeDirtyState(wi.id);
  } catch (err) {
    return {
      ok: false,
      reason: "worktree_check_failed",
      message: bridgeMergeError(
        `Approval blocked because the live WI worktree state could not be verified: ${err?.message || String(err)}`,
      ),
      work_item_id: wi.id,
      review_approved: false,
    };
  }
  if (dirtyState?.verificationFailed) {
    return {
      ok: false,
      reason: "worktree_check_failed",
      message: bridgeMergeError(
        `Approval blocked because the live WI worktree state could not be verified: ${dirtyState.error || "unknown Git error"}`,
      ),
      work_item_id: wi.id,
      review_approved: false,
    };
  }

  const trackedFiles = Array.isArray(dirtyState?.trackedFiles)
    ? dirtyState.trackedFiles
    : [];
  if (trackedFiles.length === 0) {
    return { ok: true, work_item_id: wi.id };
  }

  const count = trackedFiles.length;
  return {
    ok: false,
    reason: "worktree_dirty",
    message: `Approval blocked: WI#${wi.id} has ${count} uncommitted tracked worktree file${count === 1 ? "" : "s"}; commit or discard ${count === 1 ? "it" : "them"} before approval and merge.`,
    work_item_id: wi.id,
    review_approved: false,
    worktree: dirtyState.wtDir || null,
    dirty_files: trackedFiles,
  };
}

export function approveReview(workItemId, {
  actor = "bridge",
  projectDir = process.cwd(),
  reviewWorkflow = null,
} = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const reviewable = requireReviewableWorkItem(wi);
  if (!reviewable.ok) return reviewable;
  const preflight = preflightReviewApproval(wi.id, { projectDir, reviewWorkflow });
  if (!preflight.ok) return preflight;

  if (wi.branch_name) {
    return {
      ok: true,
      work_item_id: wi.id,
      status: wi.status,
      merge_required: true,
      merge_state: wi.merge_state,
      branch_name: wi.branch_name,
      approval_logged: false,
    };
  }

  const completionOk = updateWorkItemStatus(wi.id, "complete", {
    allowTerminalFailureBlockers: true,
    resolvePendingReviews: true,
  });
  if (completionOk === false) return { ok: false, reason: "completion_blocked" };

  const fresh = getWorkItem(wi.id) || wi;
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: "Approved via bridge",
    event_json: JSON.stringify({ approval_type: "bridge", merge_required: !!fresh.branch_name }),
  });

  return {
    ok: true,
    work_item_id: wi.id,
    status: fresh.status,
    merge_required: !!fresh.branch_name,
    merge_state: fresh.merge_state,
    branch_name: fresh.branch_name || null,
    approval_logged: true,
  };
}

function createBridgeReviewWorkflow(projectDir) {
  const targetBranch = resolveTargetBranchForAdmin(projectDir);
  return createGitWorkflowHelpers({
    projectDir,
    targetBranch,
    nonInteractive: true,
  });
}

function logDeferredCleanupFailure(wi, error) {
  try {
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.GIT_BRANCH_CLEANUP_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Approved merge cleanup will be retried by startup GC: ${bridgeMergeError(error)}`,
      event_json: JSON.stringify({
        branch: wi.branch_name || null,
        error: bridgeMergeError(error),
      }),
    });
  } catch {
    // Merge state is already durable. Cleanup telemetry must not affect it.
  }
}

/**
 * A bridge approval that merges leaves fresh unpushed commits, but until now
 * only run boot/wrap-up sweeps created the push-offer gate — so in phone-only
 * operation approved work could never surface a deploy gate until the next
 * run happened to boot. Refresh the singleton offer after every successful
 * bridge merge. Best-effort like branch cleanup: the approval ACK never
 * waits on it, and the next run sweep supersedes it anyway.
 */
function scheduleBridgeReviewPushOffer(workflow, wiId) {
  if (!workflow || typeof workflow.refreshPushOfferGate !== "function") return false;
  void Promise.resolve()
    .then(() => workflow.refreshPushOfferGate(1, { createdBy: "bridge_review_approve" }))
    .catch((err) => {
      try {
        console.warn(
          `[posse][bridge] push-offer refresh after WI#${wiId} approval failed: ${err?.message || err}`,
        );
      } catch { /* observability only */ }
    });
  return true;
}

function scheduleBridgeReviewCleanup(workflow, wi) {
  if (!workflow || typeof workflow.cleanupWiBranchAsync !== "function") return false;
  let cleanup;
  try {
    cleanup = workflow.cleanupWiBranchAsync(wi);
  } catch (err) {
    logDeferredCleanupFailure(wi, err?.message || String(err));
    return false;
  }
  void Promise.resolve(cleanup).then((ok) => {
    if (ok === false) {
      logDeferredCleanupFailure(wi, "branch/worktree cleanup returned false");
    }
  }).catch((err) => {
    logDeferredCleanupFailure(wi, err?.message || String(err));
  });
  return true;
}

/**
 * Finish a bridge approval at the work-item boundary.
 *
 * Answering an assessment gate only resolves that job. Remote-control
 * "approve" promises the stronger operator action: complete the WI, merge its
 * branch, settle every stale review row, and clean up the worktree. Keep this
 * idempotent so a client can safely retry after a timeout or a failed merge.
 */
export async function finalizeApprovedReview(workItemId, {
  actor = "bridge",
  projectDir = process.cwd(),
  approvalLogged = false,
  reviewWorkflow = null,
} = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const workflow = reviewWorkflow || (wi.branch_name
    ? createBridgeReviewWorkflow(projectDir)
    : null);
  const preflight = preflightReviewApproval(wi.id, {
    projectDir,
    reviewWorkflow: workflow,
  });
  if (!preflight.ok) return preflight;

  let fresh = getWorkItem(wi.id) || wi;
  if (
    fresh.branch_name
    && fresh.merge_state !== "merged"
    && fresh.status === "complete"
  ) {
    if (!holdWorkItemForPendingMerge(wi.id)) {
      return {
        ok: false,
        reason: "queue_settlement_failed",
        message: "Posse could not keep the approved work item reviewable while its merge was pending.",
        work_item_id: wi.id,
        review_approved: true,
      };
    }
    fresh = getWorkItem(wi.id) || fresh;
  }
  if (!fresh.branch_name) {
    const completionOk = updateWorkItemStatus(wi.id, "complete", {
      allowTerminalFailureBlockers: true,
      resolvePendingReviews: true,
    });
    if (completionOk === false) return { ok: false, reason: "completion_blocked" };
    fresh = getWorkItem(wi.id) || fresh;
    if (!approvalLogged) {
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
        actor_type: EVENT_ACTORS.HUMAN,
        actor_id: actor,
        message: "Approved via bridge review gate",
        event_json: JSON.stringify({
          approval_type: "bridge",
          merge_required: false,
        }),
      });
    }
    return {
      ok: true,
      work_item_id: wi.id,
      status: fresh.status,
      merge_required: false,
      merged: false,
      merge_state: fresh.merge_state,
      branch_name: null,
    };
  }

  if (fresh.merge_state === "merged") {
    // Re-run the queue settlement for installations that were interrupted
    // after persisting merge_state but before retiring every review row. Retry
    // cleanup too: the prior process may have died between those two writes.
    const settlement = finalizeApprovedWorkItemMerge(wi.id);
    if (!settlement.ok) {
      return {
        ok: false,
        reason: "queue_settlement_failed",
        message: "The branch is merged, but Posse could not resolve the WI and review rows.",
        work_item_id: wi.id,
        review_approved: true,
        merged: true,
      };
    }
    const cleanupPending = scheduleBridgeReviewCleanup(workflow, fresh);
    scheduleBridgeReviewPushOffer(workflow, wi.id);
    fresh = getWorkItem(wi.id) || fresh;
    return {
      ok: true,
      work_item_id: wi.id,
      status: fresh.status,
      merge_required: true,
      merged: true,
      already_merged: true,
      merge_state: fresh.merge_state,
      branch_name: fresh.branch_name,
      cleanup_pending: cleanupPending,
    };
  }

  let mergeOutcome;
  let mergeAttempted = false;
  try {
    mergeOutcome = await withMergeLock(async () => {
      const lockedWi = getWorkItem(wi.id);
      if (!lockedWi) {
        return { ok: false, reason: "no_such_wi", message: "The work item no longer exists." };
      }
      if (lockedWi.merge_state === "merged") {
        return {
          ok: true,
          alreadyMerged: true,
          branchName: lockedWi.branch_name || fresh.branch_name,
          settlement: finalizeApprovedWorkItemMerge(wi.id),
        };
      }
      if (!lockedWi.branch_name) {
        markWorkItemMergeFailed(wi.id);
        return {
          ok: false,
          reason: "branch_missing",
          message: "The approved work-item branch is no longer available.",
        };
      }

      mergeAttempted = true;
      const result = await workflow.gitMergeToTargetAsync(
        lockedWi.branch_name,
        projectDir,
        { wiId: wi.id, retryDeterministicConflict: true },
      );
      if (!result?.ok) {
        if (!result?.deferred) markWorkItemMergeFailed(wi.id);
        return { ...result, branchName: lockedWi.branch_name };
      }
      return {
        ...result,
        branchName: lockedWi.branch_name,
        settlement: finalizeApprovedWorkItemMerge(wi.id),
      };
    });
  } catch (err) {
    const current = getWorkItem(wi.id);
    if (current?.merge_state === "merged") {
      return {
        ok: false,
        reason: "queue_settlement_failed",
        message: "The branch is merged, but Posse could not resolve the WI and review rows.",
        work_item_id: wi.id,
        review_approved: true,
        merged: true,
      };
    }
    if (mergeAttempted) markWorkItemMergeFailed(wi.id);
    return {
      ok: false,
      reason: mergeAttempted ? "merge_failed" : "merge_lock_failed",
      message: bridgeMergeError(err?.message || String(err)),
      work_item_id: wi.id,
      review_approved: true,
    };
  }

  if (!mergeOutcome.acquired) {
    return {
      ok: false,
      reason: "merge_in_progress",
      message: "Another merge is already in progress; retry this approval.",
      work_item_id: wi.id,
      review_approved: true,
    };
  }

  const result = mergeOutcome.result || {};
  if (result.alreadyMerged) {
    if (!result.settlement?.ok) {
      return {
        ok: false,
        reason: "queue_settlement_failed",
        message: "The branch is merged, but Posse could not resolve the WI and review rows.",
        work_item_id: wi.id,
        review_approved: true,
        merged: true,
      };
    }
    const mergedWi = getWorkItem(wi.id) || fresh;
    const cleanupPending = scheduleBridgeReviewCleanup(workflow, mergedWi);
    scheduleBridgeReviewPushOffer(workflow, wi.id);
    return {
      ok: true,
      work_item_id: wi.id,
      status: mergedWi.status,
      merge_required: true,
      merged: true,
      already_merged: true,
      merge_state: mergedWi.merge_state,
      branch_name: mergedWi.branch_name,
      cleanup_pending: cleanupPending,
    };
  }
  if (!result.ok) {
    const current = getWorkItem(wi.id);
    if (current?.merge_state === "merged") {
      return {
        ok: true,
        work_item_id: wi.id,
        status: current.status,
        merge_required: true,
        merged: true,
        already_merged: true,
        merge_state: current.merge_state,
        branch_name: current.branch_name,
      };
    }
    return {
      ok: false,
      reason: result.deferred ? "merge_deferred" : "merge_failed",
      message: bridgeMergeError(
        result.message || "The approved work-item branch could not be merged.",
      ),
      work_item_id: wi.id,
      review_approved: true,
    };
  }

  const targetBranch = result.targetBranch || resolveTargetBranchForAdmin(projectDir);
  const mergeHash = result.mergeHash || "(unknown)";
  const settlement = result.settlement;
  if (!settlement.ok) {
    const mergedBranch = result.branchName || fresh.branch_name;
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_MERGED,
      actor_type: EVENT_ACTORS.HUMAN,
      actor_id: actor,
      message: `Merged ${mergedBranch} into ${targetBranch} at ${mergeHash}, but queue settlement failed`,
      event_json: JSON.stringify({
        branch: mergedBranch,
        merge_hash: mergeHash,
        target_branch: targetBranch,
        approval_type: "bridge",
      }),
    });
    return {
      ok: false,
      reason: "queue_settlement_failed",
      message: "The branch was merged, but Posse could not resolve the WI and review rows; cleanup was deferred.",
      work_item_id: wi.id,
      review_approved: true,
      merged: true,
      merge_hash: mergeHash,
      target_branch: targetBranch,
    };
  }
  const mergedBranch = result.branchName || fresh.branch_name;
  if (!approvalLogged) {
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
      actor_type: EVENT_ACTORS.HUMAN,
      actor_id: actor,
      message: "Approved via bridge review gate",
      event_json: JSON.stringify({
        approval_type: "bridge",
        merge_required: true,
      }),
    });
  }
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORK_ITEM_MERGED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: `Merged ${mergedBranch} into ${targetBranch} at ${mergeHash}`,
    event_json: JSON.stringify({
      branch: mergedBranch,
      merge_hash: mergeHash,
      target_branch: targetBranch,
      approval_type: "bridge",
    }),
  });

  // The merge and durable queue settlement are authoritative. Branch cleanup
  // is best-effort and can take minutes on Windows when an editor or scanner
  // briefly holds a worktree file. Do not withhold the approval ACK while it
  // runs; startup GC can retry it without reopening human review.
  const cleanupPending = scheduleBridgeReviewCleanup(workflow, fresh);
  scheduleBridgeReviewPushOffer(workflow, wi.id);
  fresh = getWorkItem(wi.id) || fresh;
  return {
    ok: true,
    work_item_id: wi.id,
    status: fresh.status,
    merge_required: true,
    merged: true,
    merge_state: fresh.merge_state,
    branch_name: fresh.branch_name,
    target_branch: targetBranch,
    merge_hash: mergeHash,
    cleanup_pending: cleanupPending,
  };
}

export async function rejectReview(workItemId, { actor = "bridge", reason = null, allowBranchWithoutCleanup = false } = {}) {
  const outcome = await withMergeLock(() => {
    const wi = getWorkItem(workItemId);
    if (!wi) return { ok: false, reason: "no_such_wi" };
    const readiness = reviewRejectionReadiness(wi.id);
    if (!readiness.ok) return { ok: false, reason: readiness.reason };
    const reviewable = requireReviewableWorkItem(wi);
    if (!reviewable.ok) return reviewable;
    if (wi.branch_name && !allowBranchWithoutCleanup) {
      return {
        ok: false,
        reason: "branch_cleanup_required",
        branch_name: wi.branch_name,
      };
    }

    const updated = requeueWorkItemAfterRejection(wi.id, {
      description: rejectionDescription(wi, reason),
      feedback: reason,
    });
    if (!updated) return { ok: false, reason: "requeue_failed" };

    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_REJECTED,
      actor_type: EVENT_ACTORS.HUMAN,
      actor_id: actor,
      message: reason || "Rejected via bridge",
      event_json: JSON.stringify({ approval_type: "bridge" }),
    });

    return {
      ok: true,
      work_item_id: wi.id,
      status: "queued",
    };
  });
  if (!outcome.acquired) return { ok: false, reason: "merge_in_progress" };
  return outcome.result;
}
