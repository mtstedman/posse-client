import { BUDGET_PAUSED } from "../../../../catalog/admission-budget.js";
import { isBudgetPaused } from "../../../queue/functions/admission-budget.js";
import { isKillAbort } from "../../../runtime/functions/yield.js";
import { interruptAssessmentAttempt } from "../../../queue/functions/attempts.js";
import { getJob, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

export function handleAssessmentInterruption(worker, { job, attemptId, leaseToken, error, startTime }) {
  const signal = worker._abortControllers?.get(job.id)?.signal;
  const budgetPaused = error?.code === BUDGET_PAUSED || isBudgetPaused(job.work_item_id);
  if (!isKillAbort(error, signal) && !budgetPaused) return false;
  const reason = error?._killReason || signal?.reason?._killReason || worker._killReasons?.get(job.id) || (budgetPaused ? "budget_paused" : "shutdown");
  if (reason === "runtime_exceeded") return false;
  const fresh = getJob(job.id);
  const canceled = ["user_canceled", "work_item_canceled"].includes(reason) || fresh?.status === "canceled";
  interruptAssessmentAttempt(job.id, attemptId, leaseToken, { canceled, startTime, reason });
  if (fresh?.lease_token === leaseToken) {
    if (!canceled) {
      const payload = { ...parseJobPayload(fresh), _assess_only: true };
      updateJobPayload(job.id, JSON.stringify(payload));
      worker._releaseLease(job, leaseToken, "queued", { readyAt: new Date().toISOString() });
    } else worker._releaseLease(job, leaseToken, "canceled");
  }
  worker.emit?.(job.id, `Assessment interrupted: ${reason}`);
  return true;
}
