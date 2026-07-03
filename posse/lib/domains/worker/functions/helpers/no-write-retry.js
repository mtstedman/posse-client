import {
  completeAttempt,
  logEvent,
  setJobError,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const SOFT_NO_WRITE_ATTEMPTS = 2;
const NO_WRITE_RETRY_BACKOFF_MS = 30_000;

function pendingFileRequestCount(pendingFileRequests = null) {
  if (!pendingFileRequests) return 0;
  return (pendingFileRequests.autoApproved?.length || 0)
    + (pendingFileRequests.needsApproval?.length || 0);
}

export function shouldSoftRetryNoWriteAttempt(job, attemptCount) {
  const attempt = Math.max(0, Number(attemptCount || job?.attempt_count || 0) || 0);
  const maxAttempts = Math.max(1, Number(job?.max_attempts || 3) || 3);
  return attempt > 0 && attempt <= SOFT_NO_WRITE_ATTEMPTS && attempt < maxAttempts;
}

export function shouldShortCircuitNoWriteAssessment({
  job,
  hasFileChanges,
  pendingFileRequests = null,
  satisfiedNoop = false,
  verifiedNoChange = false,
} = {}) {
  if (!(job?.job_type === "dev" || job?.job_type === "fix")) return false;
  if (hasFileChanges || satisfiedNoop || verifiedNoChange) return false;
  // DB-only jobs never produce file changes; their work lives in the project
  // database and the assessor verifies it via read-lane project_db_query, so
  // a zero-diff outcome must still be assessed rather than failed as a no-op.
  if (parseJobPayload(job)?.task_mode === "db") return false;
  return pendingFileRequestCount(pendingFileRequests) === 0;
}

export function finishNoWriteAttempt(worker, {
  attempt,
  attemptCount,
  job,
  leaseToken,
  message,
  startTime,
} = {}) {
  const softRetry = shouldSoftRetryNoWriteAttempt(job, attemptCount);
  const maxAttempts = Math.max(1, Number(job?.max_attempts || 3) || 3);
  const attemptLabel = `${attemptCount}/${maxAttempts}`;

  completeAttempt(attempt.id, {
    status: softRetry ? "interrupted" : "failed",
    duration_ms: Date.now() - startTime,
    error_text: message,
  });
  setJobError(job.id, message);

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt.id,
    event_type: softRetry ? EVENT_TYPES.JOB_NOOP_RETRY : EVENT_TYPES.JOB_NOOP_FAILURE,
    actor_type: EVENT_ACTORS.WORKER,
    message: softRetry
      ? `No scoped file changes on attempt ${attemptLabel}; requeuing without assessment`
      : message,
  });

  if (!softRetry) {
    worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: Dev produced no file changes - treating as failed${C.reset}`);
    worker._retryOrFail(job, leaseToken, message);
    return true;
  }

  const readyAt = new Date(Date.now() + NO_WRITE_RETRY_BACKOFF_MS).toISOString();
  worker.emit(
    job.id,
    `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: no scoped file changes on attempt ${attemptLabel}; requeuing without assessment${C.reset}`,
  );
  worker._releaseLease(job, leaseToken, "queued", { readyAt });
  return true;
}

export const __testNoWriteRetryBackoffMs = NO_WRITE_RETRY_BACKOFF_MS;
