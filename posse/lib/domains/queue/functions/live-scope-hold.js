import { awaitJobScopeExpansionDecision, getJob, runInTransaction, updateJobPayload } from "./index.js";
import { parseJobPayload } from "./payload.js";
import { awaitComputeSlotForResume } from "../../system/functions/environment-approval.js";

// Scope uses the scheduler's attempt-bound live-human parking protocol too.
export async function runLiveScopeHold(request, context, options = {}) {
  const { resume = awaitComputeSlotForResume, ...waitOptions } = options;
  try {
    const decision = await awaitJobScopeExpansionDecision({ jobId: context.jobId,
      attemptId: context.attemptId, requestId: request.request_id, ...waitOptions });
    const computeResume = await resume(request, context, { signal: options.signal });
    return { ...decision, compute_resume: computeResume };
  } finally {
    runInTransaction(() => {
      const job = getJob(context.jobId);
      const payload = parseJobPayload(job);
      if (Number(payload._environment_setup_live?.approval_job_id) !== Number(request.approval_job_id)) return;
      delete payload._environment_setup_live;
      updateJobPayload(job.id, JSON.stringify(payload));
    });
  }
}
