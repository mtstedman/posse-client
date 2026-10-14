import { authoritativeFinalReview } from "../../../assessment/functions/final-review-authority.js";
import { prepareReviewedFileCompletion } from "../../../assessment/functions/reviewed-file-completion.js";
import { acquireAssessmentBarrier, completeAttempt, getJob, isLeaseValid, setAssessmentLifecycle } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { inspectAssessmentWorktreeReadiness } from "./assessment-worktree-readiness.js";
import { processVerdict } from "./process-verdict.js";
import { refreshAndExtractInsights } from "./insights.js";
import { ASSESSMENT_LIFECYCLE } from "../../../../catalog/job.js";

// The durable review is the completion signal. Neither a terminal model JSON
// packet nor the legacy assessment pipeline gets another vote on this candidate.
export async function completeReviewedJob(worker, { job, leaseToken, wtPath,
  attempt = null, committedHash = null, commitBaseHash = null, filesCommitted = [],
  filesCommittedUnknown = false, verifiedNoChange = false, startTime = Date.now(),
  onSucceeded = () => {} } = {}) {
  if (!wtPath || worker.dryRun) return false;
  let verdict = await authoritativeFinalReview(job, parseJobPayload(getJob(job.id) || job), wtPath);
  if (verdict?.verdict !== "pass") return false;
  const barrier = acquireAssessmentBarrier(job.id, leaseToken, { preserveStatus: true });
  if (!barrier.ok) {
    if (barrier.reason !== "lease_invalid") {
      worker._releaseLease(job, leaseToken, "queued", { readyAt: new Date(Date.now() + 1000).toISOString() });
    }
    if (attempt) completeAttempt(attempt.id, { status: "interrupted", duration_ms: Date.now() - startTime,
      error_text: "Final-review completion deferred until the workspace is exclusively owned." });
    return true;
  }
  if (!(await inspectAssessmentWorktreeReadiness(wtPath)).ready) return false;
  let reviewedCompletion = null;
  if (committedHash && !filesCommittedUnknown) {
    try {
      reviewedCompletion = await prepareReviewedFileCompletion(getJob(job.id) || job, wtPath, {
        committedHash, commitBaseHash, filesCommitted, verifiedNoChange,
      });
    } catch (error) {
      worker.emit(job.id, `[system] Reviewed handoff unavailable: ${error.message}`);
    }
  }
  // Async filesystem work above cannot extend an expired lease or authorize
  // bytes edited since the saved pass.
  verdict = await authoritativeFinalReview(job, parseJobPayload(getJob(job.id) || job), wtPath);
  if (verdict?.verdict !== "pass") return false;
  if (!isLeaseValid(job.id, leaseToken)) {
    if (attempt) completeAttempt(attempt.id, { status: "interrupted", duration_ms: Date.now() - startTime,
      error_text: "Lease expired before final-review completion." });
    return true;
  }
  processVerdict(job, verdict, { leaseToken, reviewedCompletion, projectDir: worker.projectDir,
    autoApprove: worker.autoApprove, emit: (message) => worker.emit(job.id, message) });
  const fresh = getJob(job.id);
  if (fresh?.status === "succeeded") {
    setAssessmentLifecycle(job.id, ASSESSMENT_LIFECYCLE.PASSED, { error: null, completed: true });
    if (attempt) completeAttempt(attempt.id, { status: "succeeded", duration_ms: Date.now() - startTime });
    await onSucceeded(fresh);
    refreshAndExtractInsights(job.work_item_id);
    worker._cleanupWorktreeIfDone(job.work_item_id);
  }
  return true;
}
