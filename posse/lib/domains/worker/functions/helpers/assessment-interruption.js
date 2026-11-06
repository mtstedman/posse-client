import { BUDGET_PAUSED } from "../../../../catalog/admission-budget.js";
import { isBudgetPaused } from "../../../queue/functions/admission-budget.js";
import { killAbortReason } from "../../../runtime/functions/yield.js";
import { interruptAssessmentAttempt } from "../../../queue/functions/attempts.js";
import { getJob, logEvent, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { persistPendingAssessmentFileRequests } from "./assessment-file-requests.js";
import { refreshAndExtractInsights } from "./insights.js";

// `pendingFileRequests` is passed by the attached route, which holds them only
// in memory; the assess-only retry reads them back from the payload. Callers
// that leave it undefined keep whatever the payload already persists.
export function handleAssessmentInterruption(worker, { job, attemptId, leaseToken, error, startTime, pendingFileRequests }) {
  const signal = worker._abortControllers?.get(job.id)?.signal;
  const budgetPaused = error?.code === BUDGET_PAUSED || isBudgetPaused(job.work_item_id);
  const reason = killAbortReason(error, signal, worker._killReasons?.get(job.id))
    || (budgetPaused ? "budget_paused" : null);
  if (!reason || reason === "runtime_exceeded") return false;
  const fresh = getJob(job.id);
  const canceledByWi = reason === "work_item_canceled" || fresh?.status === "canceled";
  const canceled = reason === "user_canceled" || canceledByWi;
  interruptAssessmentAttempt(job.id, attemptId, leaseToken, { canceled, startTime, reason });
  if (fresh?.lease_token === leaseToken) {
    if (!canceled) {
      const payload = { ...parseJobPayload(fresh), _assess_only: true };
      if (pendingFileRequests !== undefined) persistPendingAssessmentFileRequests(payload, pendingFileRequests);
      updateJobPayload(job.id, JSON.stringify(payload));
      worker._releaseLease(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    } else worker._releaseLease(job, leaseToken, "canceled");
  }
  worker.emit?.(job.id, `Assessment interrupted: ${reason}`);
  if (canceled) {
    // Same settlement as a cancel during implementation (handleExecuteAttemptError).
    const cancelMsg = canceledByWi ? "Canceled with work item" : "Canceled by user";
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId,
      event_type: canceledByWi ? EVENT_TYPES.JOB_CANCELED_WITH_WORK_ITEM : EVENT_TYPES.JOB_CANCELED_BY_USER,
      actor_type: EVENT_ACTORS.HUMAN,
      message: cancelMsg,
    });
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
  }
  return true;
}
