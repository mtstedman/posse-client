import { listAttemptCommittedFilesAsync } from "../../../git/functions/attempt-committed-files.js";
import { authoritativeFinalReview, finalReviewedFilesCommitted, latestFinalReview } from "../../../assessment/functions/final-review-authority.js";
import { prepareReviewedFileCompletion } from "../../../assessment/functions/reviewed-file-completion.js";
import { completeAttempt, getAttempts, getJob, isLeaseValid, setAssessmentLifecycle } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
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
  if (!(await finalReviewedFilesCommitted(job, parseJobPayload(getJob(job.id) || job), wtPath))) return false;
  let reviewedCompletion = null;
  if (!filesCommittedUnknown) {
    try {
      // A process may stop after the scoped commit but before success. Recover
      // its recorded commit so closeout still publishes the reviewed receipt.
      if (!committedHash) {
        const reviewedAttempt = getAttempts(job.id).find((entry) => entry.id === latestFinalReview(job.id)?.attempt_id);
        if (reviewedAttempt?.commit_hash) {
          committedHash = reviewedAttempt.commit_hash;
          commitBaseHash = reviewedAttempt.commit_base_hash;
          ({ files: filesCommitted } = await listAttemptCommittedFilesAsync({
            cwd: wtPath, commitHash: committedHash, baseHash: commitBaseHash, projectDir: worker.projectDir,
          }));
        }
      }
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
