// lib/domains/worker/functions/helpers/attempt-errors.js
//
// Execute-attempt error taxonomy extracted from worker.js:
// deterministic interruptions, retryable interruptions, and catastrophic errors.

import {
  abandonJobScopeExpansionRequest,
  completeAttempt,
  decrementAttemptCount,
  flagStallResume,
  getAttempts,
  getJob,
  getWorkItem,
  incrementAttemptCount,
  jobHasLivePendingScopeRequest,
  logEvent,
  listJobsByWorkItem,
  setJobError,
  settleJobScopeExpansionAttempt,
  storeArtifact,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { getProviderBackoff, getProviderName } from "../../../providers/functions/provider.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { isAbortError } from "../../../runtime/functions/yield.js";
import {
  buildFailureDiagnosticsArtifact,
  getErrorDetails,
  isPermanentProviderConfigError,
  retryingAttemptWording,
} from "./diagnostics.js";
import { refreshAndExtractInsights } from "./insights.js";
import { gitHasChangesAsync } from "../../../git/functions/utils.js";
import {
  snapshotAndResetDirtyWorktreeAsync,
  stashDirtyWorktreeAsync,
} from "../../../git/functions/worktree.js";
import {
  activeSiblingWriteLocks,
  siblingLockSummary,
} from "../../../queue/functions/sibling-locks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { processVerdict } from "./process-verdict.js";
import { linkSiblingDirtyRecoverySnapshot } from "./sibling-dirty-recovery.js";

export const MAX_LIVE_SCOPE_WAIT_INTERRUPTIONS = 3;

export function liveScopeWaitInterruptionDisposition(payload = {}) {
  const count = Math.max(0, Number.parseInt(payload?._scope_wait_interruptions, 10) || 0) + 1;
  return {
    count,
    exhausted: count >= MAX_LIVE_SCOPE_WAIT_INTERRUPTIONS,
    backoffMs: 30_000 * count,
  };
}

function deferInterruptedCleanupIfSiblingLocks(job, label) {
  const siblingLocks = activeSiblingWriteLocks(job);
  if (siblingLocks.length === 0) return false;
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Deferred ${label} dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
    event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
  });
  log.info("worker", `Deferred dirty cleanup for job #${job.id}; active sibling locks: ${siblingLockSummary(siblingLocks)}`);
  return true;
}

async function stashInterruptedWork(job, wtPath, label, projectDir = null) {
  if (!wtPath) return false;
  try {
    if (!(await gitHasChangesAsync(wtPath))) return false;
    const mainCwd = projectDir || wtPath;
    if (deferInterruptedCleanupIfSiblingLocks(job, label)) return false;
    try {
      const stashed = await stashDirtyWorktreeAsync(wtPath, mainCwd, `posse: stash from ${label} job #${job.id}`, {
        shouldDefer: () => deferInterruptedCleanupIfSiblingLocks(job, label),
      });
      if (stashed) flagStallResume(job.id);
      return stashed;
    } catch (stashErr) {
      // Stash failed (lock timeout, index.lock from the killed child) — the
      // dirty tree is the only copy of the interrupted work. Leave it for the
      // next attempt's setup recovery; never answer a failed capture with an
      // unsnapshotted wipe.
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Left ${label} dirty state in place; stash failed: ${stashErr?.message || String(stashErr)}`,
        event_json: JSON.stringify({ label }),
      });
      return false;
    }
  } catch {
    return false;
  }
}

async function stashWorktreeForFailure(job, wtPath, projectDir) {
  if (!wtPath) return;
  try {
    if (!(await gitHasChangesAsync(wtPath))) return;
    const siblingLocks = activeSiblingWriteLocks(job);
    if (siblingLocks.length > 0) {
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Deferred failed-attempt dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
        event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
      });
      log.info("worker", `Deferred failed-attempt cleanup for job #${job.id}; active sibling locks: ${siblingLockSummary(siblingLocks)}`);
      return;
    }
    // Preserve the failed attempt's dirty state to .recovery/ for forensics
    // and reset the worktree clean. Using snapshot-and-reset instead of
    // git stash avoids accumulating orphan stashes across failed jobs.
    try {
      const snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, projectDir || wtPath, {
        reason: `failed-job-${job.id}`,
        branchName: getWorkItem(job.work_item_id)?.branch_name || null,
        wiId: job.work_item_id,
        onMsg: (msg) => {
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_SNAPSHOT_WARNING,
            actor_type: EVENT_ACTORS.WORKER,
            message: msg,
          });
        },
        onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir = null, operationErrors = [] }) => {
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Failed-attempt reset incomplete: ${remainingPaths.length} path(s), ${operationErrors.length} operation error(s)`,
            event_json: JSON.stringify({
              remaining_paths: remainingPaths,
              operation_errors: operationErrors,
              porcelain: postResetPorcelain,
              snapshot_dir: snapshotDir,
            }),
          });
        },
      });
      linkSiblingDirtyRecoverySnapshot({
        workItemId: job.work_item_id,
        snapshotDir,
        jobId: job.id,
        reason: `failed-job-${job.id}`,
        ownerJobIds: [job.id],
      });
    } catch (resetErr) {
      if (resetErr?.snapshotDir) {
        linkSiblingDirtyRecoverySnapshot({
          workItemId: job.work_item_id,
          snapshotDir: resetErr.snapshotDir,
          jobId: job.id,
          reason: `failed-job-${job.id}-reset-incomplete`,
          ownerJobIds: [job.id],
        });
      }
      // Snapshot refused or failed — leave the dirt for the next attempt's
      // setup recovery rather than wiping the only copy.
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Left failed-attempt dirty state in place; snapshot/reset failed: ${resetErr?.message || String(resetErr)}`,
        event_json: JSON.stringify({ reason: `failed-job-${job.id}` }),
      });
    }
  } catch {
    // ignore
  }
}

function killReasonForPreAttemptError(worker, job, err) {
  if (err?._killReason) return err._killReason;
  if (!isAbortError(err) || job?.id == null) return null;
  const killReason = worker._killReasons?.get?.(job.id) || null;
  if (killReason && err) err._killReason = killReason;
  return killReason;
}

function isNudgeKillReason(reason) {
  return reason === "operator_nudge" || reason === "user_nudge";
}

export async function handlePendingScopeApprovalPause(worker, {
  attempt,
  job,
  startTime,
  wtPath = null,
} = {}) {
  const currentJob = getJob(job?.id);
  const payload = currentJob ? parseJobPayload(currentJob) : {};
  const pending = payload?._pending_scope_request;
  if (
    currentJob?.status !== "waiting_on_human"
    || !pending
    || (pending.attempt_id && Number(pending.attempt_id) !== Number(attempt?.id))
  ) return false;

  if (wtPath) {
    try {
      if (await gitHasChangesAsync(wtPath) && !deferInterruptedCleanupIfSiblingLocks(job, "scope-request")) {
        await snapshotAndResetDirtyWorktreeAsync(wtPath, worker?.projectDir || wtPath, {
          reason: `scope-request-job-${job.id}`,
          branchName: getWorkItem(job.work_item_id)?.branch_name || null,
          wiId: job.work_item_id,
        });
      }
    } catch (resetErr) {
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        attempt_id: attempt?.id || null,
        event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Scope-request pause left dirty state for setup recovery: ${resetErr?.message || String(resetErr)}`,
      });
    }
  }

  if (attempt?.id) {
    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: `Paused for scope approval: ${pending.path}`,
    });
  }
  const settled = settleJobScopeExpansionAttempt({
    jobId: job.id,
    attemptId: attempt?.id || null,
  });
  worker?.emit?.(
    job.id,
    `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: provider exited after requesting ${pending.path}${settled.finalized ? `; human decision ${settled.decision}` : "; awaiting human decision"}${C.reset}`,
  );
  refreshAndExtractInsights(job.work_item_id);
  worker?._cleanupWorktreeIfDone?.(job.work_item_id);
  return true;
}

function handlePreAttemptInterruption(worker, { job, leaseToken, outerErr }) {
  const killReason = killReasonForPreAttemptError(worker, job, outerErr);
  if (!killReason) return false;

  if (killReason === "user_canceled" || killReason === "work_item_canceled") {
    const cancelMsg = killReason === "work_item_canceled" ? "Canceled with work item" : "Canceled by user";
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: null,
      event_type: killReason === "work_item_canceled" ? EVENT_TYPES.JOB_CANCELED_WITH_WORK_ITEM : EVENT_TYPES.JOB_CANCELED_BY_USER,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `${cancelMsg} during setup`,
    });
    worker._releaseLease(job, leaseToken, "canceled");
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${cancelMsg.toLowerCase()} during setup${C.reset}`);
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
    return true;
  }

  if (killReason === "shutdown" || killReason === "lease_expired") {
    const reason = killReason === "shutdown" ? "Graceful shutdown" : "Lease expired";
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: null,
      event_type: killReason === "shutdown" ? EVENT_TYPES.JOB_SHUTDOWN_INTERRUPTED : EVENT_TYPES.JOB_LEASE_EXPIRED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `${reason} during setup - requeuing`,
    });
    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${reason.toLowerCase()} during setup - requeuing${C.reset}`);
    return true;
  }

  if (isNudgeKillReason(killReason)) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: null,
      event_type: EVENT_TYPES.OPERATOR_NUDGE_REQUEUED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: "Operator nudged job during setup - requeuing immediately",
    });
    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id} nudged by operator during setup - requeuing${C.reset}`);
    return true;
  }

  return false;
}

export function handleDeterministicInterruption(worker, job, attemptId, startTime, leaseToken, err) {
  if (!err?._killReason) return false;

  if (err._killReason === "shutdown" || err._killReason === "lease_expired") {
    const reason = err._killReason === "shutdown" ? "Graceful shutdown" : "Lease expired";
    completeAttempt(attemptId, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: reason,
    });
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId,
      event_type: err._killReason === "shutdown" ? EVENT_TYPES.JOB_SHUTDOWN_INTERRUPTED : EVENT_TYPES.JOB_LEASE_EXPIRED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `${reason} — requeuing`,
    });
    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${reason.toLowerCase()} — requeuing${C.reset}`);
    return true;
  }

  if (err._killReason === "post_merge_closeout_budget") {
    // The closeout drain's budget expired mid-warm. The warm itself is fine —
    // requeue it (slightly deferred so this closeout does not re-pick it) for
    // the next scheduler run instead of burning the single warm attempt.
    completeAttempt(attemptId, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: "Post-merge closeout budget exhausted",
    });
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId,
      event_type: EVENT_TYPES.JOB_RUNTIME_EXCEEDED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: "Post-merge closeout budget exhausted — requeuing",
    });
    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
      readyAt: new Date(Date.now() + 60_000).toISOString(),
    });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} closeout budget exhausted — requeuing${C.reset}`);
    return true;
  }

  if (err._killReason === "user_canceled" || err._killReason === "work_item_canceled") {
    const cancelMsg = err._killReason === "work_item_canceled" ? "Canceled with work item" : "Canceled by user";
    completeAttempt(attemptId, {
      status: "canceled",
      duration_ms: Date.now() - startTime,
      error_text: cancelMsg,
    });
    worker._releaseLease(job, leaseToken, "canceled");
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${cancelMsg.toLowerCase()}${C.reset}`);
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
    return true;
  }

  return false;
}

export async function handleExecuteAttemptError(worker, {
  attempt,
  attemptCount,
  err,
  job,
  leaseToken,
  startTime,
  wtPath,
}, {
  isProviderError,
} = {}) {
  const currentJob = getJob(job.id);

  if (err._killReason === "user_canceled" || err._killReason === "work_item_canceled" || currentJob?.status === "canceled") {
    const canceledByWi = err._killReason === "work_item_canceled" || currentJob?.status === "canceled";
    const cancelMsg = canceledByWi ? "Canceled with work item" : "Canceled by user";

    completeAttempt(attempt.id, {
      status: "canceled",
      duration_ms: Date.now() - startTime,
      error_text: cancelMsg,
    });

    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: canceledByWi ? EVENT_TYPES.JOB_CANCELED_WITH_WORK_ITEM : EVENT_TYPES.JOB_CANCELED_BY_USER,
      actor_type: EVENT_ACTORS.HUMAN,
      message: cancelMsg,
    });

    worker._releaseLease(job, leaseToken, "canceled");
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${cancelMsg.toLowerCase()}${C.reset}`);
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
    return;
  }

  if (await handlePendingScopeApprovalPause(worker, {
    attempt,
    job,
    startTime,
    wtPath,
  })) return;

  let scopeWaitInterruptionExhausted = false;

  // A live scope wait has no provider process left to receive its decision
  // once execution unwinds here. Retire the gate and refund a bounded number
  // of attempts so a late approval cannot mutate a future run, while a
  // deterministically crashing provider still reaches normal failure policy.
  // Entry checks the raw pending rather than jobHasLivePendingScopeRequest:
  // that helper reports false once a decision is recorded, which previously
  // skipped this whole block when the human answered during the provider
  // unwind — leaving a decided pending permanently stuck in the payload.
  const scopeWaitPayload = parseJobPayload(currentJob);
  const scopeWaitPending = scopeWaitPayload?._pending_scope_request;
  if (scopeWaitPending?.live_wait === true && scopeWaitPending.abandoned !== true) {
    const currentPayload = scopeWaitPayload;
    const pending = scopeWaitPending;
    const interruption = liveScopeWaitInterruptionDisposition(currentPayload);
    // A recorded decision must be settled, never abandoned; skip straight to
    // the settle branch instead of asking abandon to reject it.
    const abandoned = pending.decision
      ? { ok: false, code: "scope_request_decided" }
      : abandonJobScopeExpansionRequest({
        jobId: job.id,
        requestId: pending?.id || null,
        attemptId: attempt?.id || null,
        // This attempt is dead: clear the request and gate even when the
        // pending belongs to an older attempt, so no gate is orphaned.
        force: true,
        code: "scope_wait_interrupted",
        message: interruption.exhausted
          ? `The active provider repeatedly exited while waiting for scope approval; job #${job.id} will continue through normal failure accounting.`
          : `The active provider exited while waiting for scope approval; job #${job.id} will retry without an attempt penalty.`,
      });
    if (abandoned?.code === "scope_request_decided") {
      const settled = settleJobScopeExpansionAttempt({
        jobId: job.id,
        attemptId: attempt?.id || null,
      });
      // Whatever the settle outcome, a decided pending must not survive this
      // attempt: nothing later can clear it (abandon refuses decided
      // requests) and every future scope request would bounce off it.
      const residual = parseJobPayload(getJob(job.id));
      if (residual?._pending_scope_request?.decision) {
        const cleared = { ...residual };
        delete cleared._pending_scope_request;
        cleared._scope_request_abandonments = [
          ...(Array.isArray(residual._scope_request_abandonments) ? residual._scope_request_abandonments : []),
          {
            ...residual._pending_scope_request,
            abandoned: true,
            abandon_code: "scope_decided_orphaned",
          },
        ].slice(-20);
        updateJobPayload(job.id, JSON.stringify(cleared));
      }
      if (settled?.decision === "approved" || residual?._pending_scope_request?.decision === "approved") {
        completeAttempt(attempt.id, {
          status: "interrupted",
          duration_ms: Date.now() - startTime,
          error_text: "Provider exited as live scope approval arrived",
        });
        worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
          readyAt: new Date().toISOString(),
        });
        worker.emit(
          job.id,
          `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: scope approval arrived as the provider exited; requeuing with the approved grant${C.reset}`,
        );
        return;
      }
      scopeWaitInterruptionExhausted = true;
    } else if (!abandoned?.ok && !["scope_request_stale", "scope_request_job_missing"].includes(abandoned?.code)) {
      scopeWaitInterruptionExhausted = true;
    } else {
      const latest = getJob(job.id);
      updateJobPayload(job.id, JSON.stringify({
        ...parseJobPayload(latest),
        _scope_wait_interruptions: interruption.count,
      }));
    }
    if (scopeWaitInterruptionExhausted || interruption.exhausted) {
      scopeWaitInterruptionExhausted = true;
      worker.emit(
        job.id,
        `${C.red}[scope] WI#${job.work_item_id} job #${job.id}: active scope wait was interrupted ${interruption.count} times; applying normal failure accounting${C.reset}`,
      );
    } else {
      if (attempt?.id) {
        completeAttempt(attempt.id, {
          status: "interrupted",
          duration_ms: Date.now() - startTime,
          error_text: "Active scope approval wait interrupted",
        });
      }
      const hasStash = await stashInterruptedWork(job, wtPath, "scope-wait-interrupted", worker?.projectDir);
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + interruption.backoffMs).toISOString(),
      });
      worker.emit(
        job.id,
        `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: active scope wait ended before a decision; gate canceled and attempt refunded with ${Math.ceil(interruption.backoffMs / 1000)}s backoff${hasStash ? " (partial work stashed for resume)" : ""}${C.reset}`,
      );
      return;
    }
  }

  if (err?.handoffNeedsReplan === true || err?.code === "HANDOFF_FILE_MATERIALIZATION_FAILED") {
    const message = String(err?.message || "Writing scope could not be materialized");
    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: message,
    });
    setJobError(job.id, message);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: EVENT_TYPES.JOB_ATTEMPT_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Writing handoff rejected before provider start: ${message}`,
      event_json: JSON.stringify({
        code: err.code,
        path: err.path || null,
        create_roots: err.create_roots || null,
      }),
    });
    processVerdict(currentJob || job, {
      verdict: "needs_replan",
      confidence: "high",
      reasons: [
        `The writing scope is not executable and must be corrected before another provider starts: ${message}`,
      ],
      spawn_jobs: [],
      human_questions: [],
      suggestions: [],
    }, {
      emit: (line) => worker.emit(job.id, line),
      autoApprove: worker.autoApprove,
      leaseToken,
    });
    decrementAttemptCount(job.id);
    worker.emit(
      job.id,
      `${C.yellow}[handoff] WI#${job.work_item_id} job #${job.id}: rejected unsatisfiable scope before provider execution; routed to deterministic replan${C.reset}`,
    );
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
    return;
  }

  // Worker was killed because the user hit Ctrl+C or the lease expired.
  // Stash any partial work, requeue without consuming an attempt.
  if (err._killReason === "shutdown" || err._killReason === "lease_expired") {
    const reason = err._killReason === "shutdown" ? "Graceful shutdown" : "Lease expired";

    if (attempt?.id) {
      completeAttempt(attempt.id, {
        status: "interrupted",
        duration_ms: Date.now() - startTime,
        error_text: reason,
      });
    }

    const hasStash = await stashInterruptedWork(job, wtPath, err._killReason, worker?.projectDir);

    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt?.id || null,
      event_type: err._killReason === "shutdown" ? EVENT_TYPES.JOB_SHUTDOWN_INTERRUPTED : EVENT_TYPES.JOB_LEASE_EXPIRED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `${reason} — requeuing${hasStash ? " (partial work stashed for resume)" : ""}`,
    });

    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${reason.toLowerCase()} — requeuing${hasStash ? " (will resume from stash)" : ""}${C.reset}`);
    return;
  }

  // When the stall detector kills a healthy process (no output != no progress),
  // treat it as an interruption, not a failure.
  if (isNudgeKillReason(err._killReason)) {
    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: "Nudged by operator",
    });

    const hasStash = await stashInterruptedWork(job, wtPath, "nudged", worker?.projectDir);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: EVENT_TYPES.OPERATOR_NUDGE_REQUEUED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Operator nudged job - requeuing immediately${hasStash ? " (partial work stashed for resume)" : ""}`,
    });

    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id} nudged by operator - requeuing${hasStash ? " (will resume from stash)" : ""}${C.reset}`);
    return;
  }

  if (err.stallKill) {
    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: err.message,
    });

    // Cap stall retries — if this job keeps stalling, stop burning tokens.
    const MAX_STALL_RETRIES = 3;
    const allAttempts = getAttempts(job.id);
    const stallCount = allAttempts.filter((a) => a.status === "interrupted" && a.error_text && a.error_text.includes("stall")).length;
    if (stallCount >= MAX_STALL_RETRIES) {
      worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id} stalled ${stallCount} times — treating as failure${C.reset}`);
      setJobError(job.id, `Stalled ${stallCount} times — task may be too complex for the current timeout`);
      worker._retryOrFail(job, leaseToken, `Stalled ${stallCount} times`, { stallExhausted: true });
      return;
    }

    const hasStash = await stashInterruptedWork(job, wtPath, "stall-killed", worker?.projectDir);

    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: EVENT_TYPES.JOB_STALL_KILLED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Stall detector killed process (${stallCount}/${MAX_STALL_RETRIES}) — requeuing${hasStash ? " (partial work stashed for resume)" : ""}`,
    });

    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} stalled (${stallCount}/${MAX_STALL_RETRIES}) — requeuing${hasStash ? " (will resume from stash)" : ""}${C.reset}`);
    return;
  }

  // Runtime exceeded: consume attempt so next run escalates tier.
  if (err._killReason === "runtime_exceeded") {
    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: `Runtime exceeded — killed by scheduler for model escalation`,
    });

    const hasStash = await stashInterruptedWork(job, wtPath, "runtime-exceeded", worker?.projectDir);

    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: EVENT_TYPES.JOB_RUNTIME_EXCEEDED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Runtime exceeded — requeuing with escalated model${hasStash ? " (partial work stashed for resume)" : ""}`,
    });

    if (job.job_type === "preflight") {
      const researchJob = worker._spawnResearchAfterPreflight(job, null, { fallbackReason: "preflight runtime exceeded" });
      worker.emit(job.id, `${C.yellow}[preflight]${C.reset} WI#${job.work_item_id}: runtime exceeded; fallback research job #${researchJob.id} queued`);
      worker._releaseLease(job, leaseToken, "dead_letter");
      refreshAndExtractInsights(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
      return;
    }

    worker._releaseLease(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} runtime exceeded — requeuing with model escalation${hasStash ? " (will resume from stash)" : ""}${C.reset}`);
    return;
  }

  // Rate limit / transient provider error. Permanent provider/config errors
  // (invalid key, unknown model, missing binary) are excluded here — they never
  // recover on retry, so they fall through to the handler-error path below which
  // consumes an attempt and eventually dead-letters instead of looping with no
  // penalty. (B7)
  if (
    !scopeWaitInterruptionExhausted
    && typeof isProviderError === "function"
    && isProviderError(err)
    && !isPermanentProviderConfigError(err)
  ) {
    // Cap consecutive penalty-free provider-error requeues. Without an attempt
    // penalty, a persistently failing provider (common with a single configured
    // provider and no working fallback) loops forever — no scheduler/queue-side
    // bound exists. Past the cap, force the normal fail path. (B7)
    const MAX_PROVIDER_ERROR_REQUEUES = 8;
    const priorProviderErrorRequeues = getAttempts(job.id).filter(
      (a) => a.status === "interrupted"
        && typeof a.error_text === "string"
        && a.error_text.startsWith("Provider error:"),
    ).length;
    if (priorProviderErrorRequeues >= MAX_PROVIDER_ERROR_REQUEUES) {
      completeAttempt(attempt.id, {
        status: "failed",
        duration_ms: Date.now() - startTime,
        error_text: `Persistent provider error after ${priorProviderErrorRequeues} penalty-free retries: ${err.message}`,
      });
      setJobError(job.id, `Persistent provider error after ${priorProviderErrorRequeues} retries`);
      worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id} provider error persisted ${priorProviderErrorRequeues}x — failing instead of looping${C.reset}`);
      worker._retryOrFail(job, leaseToken, `Persistent provider error: ${err.message}`, { providerErrorExhausted: true });
      return;
    }

    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      // "Provider error:" prefix is load-bearing — the cap above counts these. (B7)
      error_text: `Provider error: ${err.message}`,
    });

    if (await stashInterruptedWork(job, wtPath, "rate-limited", worker?.projectDir)) {
      // already flagged for resume in helper
    }

    const jobProvider = job.provider || getProviderName(worker._roleFor(job.job_type));
    const { backoffSec, isRateLimit, source } = getProviderBackoff(jobProvider, err);
    const transientSummary = getErrorDetails(err).summary;
    const firstErrorLine = String(err?.message || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "no error details";
    log.warn("worker", `Provider error: ${source}`, {
      backoffSec,
      error: transientSummary.slice(0, 200),
      isRateLimit,
      jobId: job.id,
      provider: jobProvider,
      wiId: job.work_item_id,
    });

    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: isRateLimit ? EVENT_TYPES.JOB_RATE_LIMITED : EVENT_TYPES.JOB_PROVIDER_ERROR,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `${jobProvider} ${source} — requeuing in ${backoffSec}s (attempt not consumed): ${firstErrorLine.slice(0, 200)}`,
    });

    const readyAt = new Date(Date.now() + backoffSec * 1000).toISOString();
    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id} ${jobProvider} ${source} — requeuing in ${backoffSec}s (attempt not consumed): ${firstErrorLine.slice(0, 160)}${C.reset}`);
    return;
  }

  // Handler error.
  const failureDetails = getErrorDetails(err);
  const retryWording = retryingAttemptWording(failureDetails);
  const softBudgetExhausted = retryWording?.kind === "turn_budget"
    && failureDetails
    && attemptCount > 0
    && attemptCount <= 2
    && attemptCount < (Number(job?.max_attempts || 3) || 3);
  completeAttempt(attempt.id, {
    status: softBudgetExhausted ? "interrupted" : "failed",
    duration_ms: Date.now() - startTime,
    error_text: err.message,
  });
  setJobError(job.id, err.message);

  await stashWorktreeForFailure(job, wtPath, worker?.projectDir);

  const attemptMessage = retryWording
    ? `Attempt ${attemptCount} ${retryWording.eventVerb}: ${err.message}`
    : `Attempt ${attemptCount} failed: ${err.message}`;

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt.id,
    event_type: EVENT_TYPES.JOB_ATTEMPT_FAILED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: attemptMessage,
  });

  if (failureDetails.stderr || failureDetails.partialOutput || failureDetails.toolUses.length > 0 || failureDetails.stats) {
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      artifact_type: "log",
      content_long: buildFailureDiagnosticsArtifact(err, attemptCount),
    });
  }
  if (failureDetails.partialOutput) {
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      artifact_type: "response",
      content_long: failureDetails.partialOutput,
    });
  }

  worker._retryOrFail(job, leaseToken, err);
}

const SQLITE_CONTENTION_MAX_REQUEUES = 4;
const SQLITE_CONTENTION_BACKOFF_BASE_MS = 20_000;

function isSqliteContentionError(err) {
  const code = String(err?.code || err?.errno || "").toUpperCase();
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  return /database is (?:busy|locked)|sqlite_(?:busy|locked)/i.test(String(err?.message || err || ""));
}

export function handleCatastrophicExecuteError(worker, { job, leaseToken, outerErr }) {
  if (handlePreAttemptInterruption(worker, { job, leaseToken, outerErr })) {
    return;
  }

  worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} catastrophic error on job #${job.id}: ${outerErr.message}${C.reset}`);
  try {
    setJobError(job.id, outerErr.message);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_CATASTROPHIC_ERROR,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Catastrophic error: ${outerErr.message}`,
    });
  } catch {
    // best effort
  }
  // Planner compilation happens before the generic post-execution success
  // settlement. If that settlement loses a transient SQLite lock after the
  // attempt and child jobs are already durable, replaying the provider creates
  // a second plan wave. Treat those durable side effects as the commit point
  // and settle the existing lease instead.
  const sqliteContention = isSqliteContentionError(outerErr);
  if (job.job_type === "plan") {
    try {
      const attempts = getAttempts(job.id);
      const latestAttempt = attempts.at(-1);
      const hasChildren = listJobsByWorkItem(job.work_item_id)
        .some((candidate) => (
          Number(candidate.parent_job_id) === Number(job.id)
          && String(candidate.created_at || "") >= String(latestAttempt?.started_at || "~")
        ));
      if (latestAttempt?.status === "succeeded" && hasChildren) {
        let released = false;
        try {
          released = worker._releaseLease(job, leaseToken, "succeeded");
        } catch {
          // The lease-expiry reconciler applies the same durable-side-effect
          // rule, so leaving this lease in place is safer than provider replay.
        }
        worker.emit(
          job.id,
          `${C.yellow}[worker] WI#${job.work_item_id} planner post-success error ${released ? "recovered" : "deferred to lease recovery"}; existing child jobs will not be replayed${C.reset}`,
        );
        return;
      }
    } catch {
      if (sqliteContention) {
        worker.emit(
          job.id,
          `${C.yellow}[worker] WI#${job.work_item_id} planner recovery proof deferred after SQLite contention; lease expiry will reconcile before any replay${C.reset}`,
        );
        return;
      }
      // Non-SQLite proof failures retain ordinary catastrophic handling.
    }
  }
  // SQLite contention is environmental, not a property of this job: the
  // orchestrator DB writer was busy (tree compression, checkpoint, another
  // worker). Burning attempt counts on it dead-letters healthy jobs (run
  // 2026-08-13 plan #237 died 3/3 on "database is locked"). Requeue with a
  // growing delay and no attempt penalty, bounded so a genuinely wedged
  // database still surfaces through the normal retry/dead-letter path.
  if (sqliteContention && !worker.shuttingDown) {
    try {
      const payload = parseJobPayload(job) || {};
      const priorRequeues = Number(payload._sqlite_contention_requeues || 0) || 0;
      if (priorRequeues < SQLITE_CONTENTION_MAX_REQUEUES) {
        payload._sqlite_contention_requeues = priorRequeues + 1;
        updateJobPayload(job.id, JSON.stringify(payload));
        const delayMs = SQLITE_CONTENTION_BACKOFF_BASE_MS * (priorRequeues + 1);
        const readyAt = new Date(Date.now() + delayMs).toISOString();
        if (worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt })) {
          worker.emit(
            job.id,
            `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: transient SQLite contention (${priorRequeues + 1}/${SQLITE_CONTENTION_MAX_REQUEUES}) — requeued without attempt penalty, retrying in ${Math.round(delayMs / 1000)}s${C.reset}`,
          );
          return;
        }
      }
    } catch {
      // Fall through to the standard catastrophic path below.
    }
  }
  try {
    if (worker.shuttingDown) {
      if (worker._releaseLease(job, leaseToken, "queued", { readyAt: new Date().toISOString() })) {
        decrementAttemptCount(job.id);
      }
    } else {
      // Cap catastrophic retries so persistent failures dead-letter eventually.
      incrementAttemptCount(job.id);
      worker._retryOrFail(job, leaseToken, `Catastrophic error: ${outerErr.message}`);
    }
  } catch {
    // lease will expire naturally
  }
}
