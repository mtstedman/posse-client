// lib/domains/worker/functions/helpers/attempt-errors.js
//
// Execute-attempt error taxonomy extracted from worker.js:
// deterministic interruptions, retryable interruptions, and catastrophic errors.

import {
  completeAttempt,
  decrementAttemptCount,
  flagStallResume,
  getAttempts,
  getJob,
  getWorkItem,
  incrementAttemptCount,
  logEvent,
  setJobError,
  storeArtifact,
} from "../../../queue/functions/index.js";
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
  resetDirtyWorktreeFallbackAsync,
  snapshotAndResetDirtyWorktreeAsync,
  stashDirtyWorktreeAsync,
} from "../../../git/functions/worktree.js";
import {
  activeSiblingWriteLocks,
  siblingLockSummary,
} from "../../../queue/functions/sibling-locks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

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
    } catch {
      try {
        await resetDirtyWorktreeFallbackAsync(wtPath, mainCwd);
      } catch {
        // best effort cleanup
      }
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
      await snapshotAndResetDirtyWorktreeAsync(wtPath, projectDir || wtPath, {
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
        onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir = null }) => {
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Failed-attempt reset left ${remainingPaths.length} path(s)`,
            event_json: JSON.stringify({
              remaining_paths: remainingPaths,
              porcelain: postResetPorcelain,
              snapshot_dir: snapshotDir,
            }),
          });
        },
      });
    } catch {
      try {
        await resetDirtyWorktreeFallbackAsync(wtPath, projectDir || wtPath);
      } catch {
        // ignore
      }
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

  if (killReason === "user_nudge") {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: null,
      event_type: EVENT_TYPES.JOB_NUDGE_REQUEUED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: "Human nudged job during setup - requeuing immediately",
    });
    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id} nudged by user during setup - requeuing${C.reset}`);
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
  if (err._killReason === "user_nudge") {
    completeAttempt(attempt.id, {
      status: "interrupted",
      duration_ms: Date.now() - startTime,
      error_text: "Nudged by user",
    });

    const hasStash = await stashInterruptedWork(job, wtPath, "nudged", worker?.projectDir);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attempt.id,
      event_type: EVENT_TYPES.JOB_NUDGE_REQUEUED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Human nudged job - requeuing immediately${hasStash ? " (partial work stashed for resume)" : ""}`,
    });

    worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    worker.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id} nudged by user - requeuing${hasStash ? " (will resume from stash)" : ""}${C.reset}`);
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
  if (typeof isProviderError === "function" && isProviderError(err) && !isPermanentProviderConfigError(err)) {
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
