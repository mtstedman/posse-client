import { WORKTREE_LOCK_MAX_REQUEUES, WORKTREE_LOCK_REQUEUE_DELAY_MS } from "../../../../catalog/scheduler-lifecycle.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { completeAttempt, getAttempts, getJob, incrementAndCreateAttempt, isLeaseValid, logEvent, runInTransaction, setJobError } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

// Attempts survive process restarts and distinguish an explicit retry
// generation even when setup never reached a provider call.
export function settleWorktreeLockTimeout(worker, job, leaseToken, { attemptId = null, message, phase }) {
  return runInTransaction(() => {
    if (!isLeaseValid(job.id, leaseToken)) return false;
    const generation = Number(parseJobPayload(getJob(job.id))._retry_generation || 0);
    const attempts = getAttempts(job.id);
    const ownedAttempt = attempts.find(entry => entry.id === attemptId);
    if (attemptId != null && !ownedAttempt) return false;
    const prior = attempts.filter(entry => {
      if (entry.id === attemptId || entry.attempt_number <= generation) return false;
      try { return JSON.parse(entry.notes || "{}").worktree_lock_timeout === true; } catch { return false; }
    }).length;
    const exhausted = prior >= WORKTREE_LOCK_MAX_REQUEUES;
    const ownedAttemptId = attemptId ?? incrementAndCreateAttempt(job.id, leaseToken, "system", "worktree-setup", null, { setupOnly: true })?.attempt?.id;
    if (!ownedAttemptId) return false;
    const diagnostic = `${message}${exhausted ? `; automatic lock recovery exhausted after ${prior} requeues` : ""}`;
    completeAttempt(ownedAttemptId, { ...ownedAttempt, status: "interrupted", error_text: diagnostic,
      notes: JSON.stringify({ worktree_lock_timeout: true, phase }) });
    if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, exhausted ? "failed" : "queued", {
      attemptId: ownedAttemptId,
      readyAt: exhausted ? null : new Date(Date.now() + WORKTREE_LOCK_REQUEUE_DELAY_MS).toISOString(),
    })) return false;
    setJobError(job.id, diagnostic);
    logEvent({ work_item_id: job.work_item_id, job_id: job.id, attempt_id: ownedAttemptId,
      event_type: EVENT_TYPES.JOB_WORKTREE_LOCK_TIMEOUT, actor_type: EVENT_ACTORS.SYSTEM,
      message: diagnostic, event_json: { phase, requeues: prior, exhausted } });
    worker.emit(job.id, exhausted
      ? `${diagnostic}. Stopped automatic retries; worktree contents are preserved.`
      : `${diagnostic}. Retrying lock recovery (${prior + 1}/${WORKTREE_LOCK_MAX_REQUEUES}).`);
    return true;
  });
}
