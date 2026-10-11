// A capped developer session may hand off a repaired candidate. The existing
// awaiting_assessment/assess-only lifecycle is its durable execution phase;
// this ledger reserves the separate work-item continuation budget once.

import { FINAL_REVIEW_CONTINUATION_NEXT_ACTION, FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT } from "../../../catalog/final-review.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { runImmediateTransaction } from "../../queue/functions/common.js";
import { getWiFailureThreshold } from "../../settings/functions/tunables.js";
import { finalReviewIdentity, latestFinalReview } from "./final-review-authority.js";
import { finalReviewResultsForAttempt, semanticFinalReviewResults } from "./final-review-result.js";

export async function reserveFinalReviewContinuation(job, payload, cwd) {
  const review = latestFinalReview(job?.id);
  const attemptId = Number(review?.attempt_id);
  if (!review?.review_identity || !Number.isSafeInteger(attemptId) || attemptId <= 0) {
    return { status: "not_needed" };
  }
  const semanticCount = semanticFinalReviewResults(finalReviewResultsForAttempt({ jobId: job.id, attemptId })).length;
  if (semanticCount < FINAL_REVIEW_MAX_CALLS_PER_ATTEMPT) return { status: "not_needed" };

  let candidateIdentity;
  try {
    candidateIdentity = await finalReviewIdentity(cwd, payload, { jobId: job.id });
  } catch {
    return { status: "identity_unavailable" };
  }
  if (candidateIdentity === review.review_identity) return { status: "not_needed" };

  const ceiling = Math.max(1, getWiFailureThreshold());
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const currentJob = db.prepare("SELECT status, work_item_id FROM jobs WHERE id = ?").get(job.id);
    if (!currentJob || currentJob.status === "canceled" || currentJob.status === "dead_letter") {
      return { status: "canceled" };
    }
    const existing = db.prepare(`
      SELECT candidate_identity FROM final_review_continuations
      WHERE job_id = ? AND attempt_id = ?
    `).get(job.id, attemptId);
    const count = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM final_review_continuations WHERE work_item_id = ?
    `).get(currentJob.work_item_id)?.count || 0);
    if (existing) return existing.candidate_identity === candidateIdentity
      ? { status: "reused", count, ceiling, candidate_identity: candidateIdentity }
      : { status: "candidate_changed", count, ceiling };
    if (count >= ceiling) return { status: "exhausted", count, ceiling };
    const checkpoint = {
      schema_version: 1,
      root_job_id: Number(payload?.root_job_id) || Number(job.id),
      reviewer_attempt_id: attemptId,
      source_review_identity: review.review_identity,
      candidate_identity: candidateIdentity,
      verification_plan: payload?._repository_verification_plan_snapshot || null,
      previous_outcome: review.outcome || null,
      findings: review.findings || [],
      declared_tests: review.declared_tests || null,
      changed_tests: review.changed_tests || null,
      continuation_budget: { used: count + 1, ceiling },
      next_action: FINAL_REVIEW_CONTINUATION_NEXT_ACTION,
    };
    db.prepare(`
      INSERT INTO final_review_continuations
        (work_item_id, job_id, attempt_id, candidate_identity, source_review_identity, checkpoint_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(currentJob.work_item_id, job.id, attemptId, candidateIdentity,
      review.review_identity, JSON.stringify(checkpoint));
    return { status: "reserved", count: count + 1, ceiling, candidate_identity: candidateIdentity };
  });
}
