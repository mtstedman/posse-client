import {
  getJob,
  getWorkItem,
  listJobsByWorkItem,
  logEvent,
  requeueWorkItemAfterRejection,
  setMergeState,
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
  const text = String(reason || "").trim();
  if (!text) return wi.description;
  return `${wi.description}\n\n---\nPREVIOUS ATTEMPT REJECTED: ${text}`;
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

export function approveReview(workItemId, { actor = "bridge" } = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
  const reviewable = requireReviewableWorkItem(wi);
  if (!reviewable.ok) return reviewable;

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

  const completionOk = updateWorkItemStatus(wi.id, "complete", {
    allowTerminalFailureBlockers: true,
    resolvePendingReviews: true,
  });
  if (completionOk === false) return { ok: false, reason: "completion_blocked" };

  let fresh = getWorkItem(wi.id) || wi;
  if (!approvalLogged) {
    logEvent({
      work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_APPROVED,
      actor_type: EVENT_ACTORS.HUMAN,
      actor_id: actor,
      message: "Approved via bridge review gate",
      event_json: JSON.stringify({
        approval_type: "bridge",
        merge_required: !!fresh.branch_name,
      }),
    });
  }

  if (!fresh.branch_name) {
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

  const workflow = reviewWorkflow || createBridgeReviewWorkflow(projectDir);
  if (fresh.merge_state === "merged") {
    // Re-run the queue settlement for installations that were interrupted
    // after persisting merge_state but before retiring every review row. Retry
    // cleanup too: the prior process may have died between those two writes.
    setMergeState(wi.id, "merged");
    const cleanupPending = scheduleBridgeReviewCleanup(workflow, fresh);
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
  try {
    mergeOutcome = await withMergeLock(() => workflow.gitMergeToTargetAsync(
      fresh.branch_name,
      projectDir,
      { wiId: wi.id },
    ));
  } catch (err) {
    setMergeState(wi.id, "merge_failed");
    return {
      ok: false,
      reason: "merge_failed",
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
  if (!result.ok) {
    if (!result.deferred) setMergeState(wi.id, "merge_failed");
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
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORK_ITEM_MERGED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: actor,
    message: `Merged ${fresh.branch_name} into ${targetBranch} at ${mergeHash}`,
    event_json: JSON.stringify({
      branch: fresh.branch_name,
      merge_hash: mergeHash,
      target_branch: targetBranch,
      approval_type: "bridge",
    }),
  });
  setMergeState(wi.id, "merged");

  // The merge and durable queue settlement are authoritative. Branch cleanup
  // is best-effort and can take minutes on Windows when an editor or scanner
  // briefly holds a worktree file. Do not withhold the approval ACK while it
  // runs; startup GC can retry it without reopening human review.
  const cleanupPending = scheduleBridgeReviewCleanup(workflow, fresh);
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

export function rejectReview(workItemId, { actor = "bridge", reason = null, allowBranchWithoutCleanup = false } = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return { ok: false, reason: "no_such_wi" };
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
}
