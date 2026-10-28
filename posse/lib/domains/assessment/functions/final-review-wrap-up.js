import { latestFinalReview, authoritativeFinalReview, finalReviewedFilesCommitted } from "./final-review-authority.js";
import { finalReviewVerificationIdentity } from "./final-review-verification.js";
import { prepareReviewedFileCompletion } from "./reviewed-file-completion.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { isLeaseValid } from "../../queue/functions/attempts.js";
import { configuredVerificationPlan } from "../../worker/functions/helpers/configured-verification.js";
import { TEST_EXECUTION_RECEIPT_KIND, TEST_EXECUTION_RECEIPT_SCHEMA_VERSION } from "../../../catalog/verification.js";
import { currentCommit } from "../../verification/functions/receipt-fingerprint.js";

// PASS wrap-up keeps the implementation lease. No second worker, whole-WI
// barrier, Atlas warm, verifier process, or assessor call is needed when the
// review's inputs and scoped committed outputs still match. Legacy/mismatched
// evidence follows the existing bounded recovery path.
export async function prepareFinalReviewWrapUp({ job, cwd, committedHash, commitBaseHash,
  filesCommitted, filesCommittedUnknown, verifiedNoChange, leaseToken, projectDir, preAssessAlreadyVerified }) {
  if (!cwd || filesCommittedUnknown || (!committedHash && !verifiedNoChange)
    || !["dev", "fix"].includes(job.job_type) || !isLeaseValid(job.id, leaseToken)
    || configuredVerificationPlan(projectDir, { preAssessAlreadyVerified }).enabled) return null;
  const payload = parseJobPayload(job);
  if (payload.task_mode && payload.task_mode !== "code") return null;
  const review = latestFinalReview(job.id);
  const evidence = review?.verification_evidence;
  if (!evidence?.declared_tests && !evidence?.changed_tests && !evidence?.scoped_checks) return null;
  const revision = committedHash || await currentCommit(cwd);
  const verificationIdentity = () => finalReviewVerificationIdentity(cwd, { payload, commit: revision });
  if (review?.outcome !== "pass" || !evidence?.identity || !Object.hasOwn(evidence, "scoped_checks")
    || evidence.identity !== await verificationIdentity()) return null;
  const verdict = await authoritativeFinalReview(job, payload, cwd);
  if (verdict?.verdict !== "pass" || !await finalReviewedFilesCommitted(job, payload, cwd)) return null;
  const reviewedCompletion = await prepareReviewedFileCompletion(job, cwd, {
    committedHash: revision, commitBaseHash, filesCommitted, verifiedNoChange,
  });
  // Final review already judged these results; preserve failures/debt and
  // unavailable checks verbatim. This is scoped evidence, never a clean-tree
  // cache entry that could claim a sibling's dirty inputs were committed.
  const run = evidence.declared_tests || evidence.changed_tests || {};
  const plan = evidence.declared_plan || evidence.changed_plan || {};
  const receipt = { ...run, kind: TEST_EXECUTION_RECEIPT_KIND,
    schema_version: TEST_EXECUTION_RECEIPT_SCHEMA_VERSION, phase: "post_change",
    source: plan.source || "final_review", plan_id: plan.plan_id || null,
    command: plan.command || run.command || null, execution_command: plan.execution_command || null,
    commit_hash: revision, assessed_commit_hash: revision, execution_root: cwd,
    tree_state: "reviewed_scope", tree_fingerprint: evidence.identity,
    review_identity: review.review_identity, final_review_agent_call_id: review.agent_call_id,
    changed_tests: evidence.changed_tests, scoped_checks: evidence.scoped_checks,
    verification_eligible: plan.verification_eligible !== false,
    reused: true, reuse_source: "final_review", created_at: new Date().toISOString() };
  if (!isLeaseValid(job.id, leaseToken) || evidence.identity !== await verificationIdentity()) return null;
  return { verdict, reviewedCompletion, receipt };
}
