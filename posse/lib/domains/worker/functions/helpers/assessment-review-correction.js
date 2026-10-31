export function canClarifyAssessmentReview(verdict) {
  const questions = Array.isArray(verdict?.human_questions) ? verdict.human_questions : [];
  return verdict?.verdict === "needs_review"
    && !questions.some((question) => String(question || "").trim())
    && !verdict._disable_internal_retry
    && !verdict._assessment_infrastructure_review
    && !verdict._assessment_confidence_review
    && !verdict._assessment_visual_review
    && !verdict._assessment_unsupported_claim_review
    && !verdict._verification_blocked;
}

export function assessmentReviewCorrection(payload) {
  if (payload?._assess_review_correction !== true) return "";
  return [
    "ASSESSMENT REVIEW CORRECTION:",
    "The prior needs_review verdict did not identify a question requiring an operator decision. Reconcile its findings with the assigned task and approved scope before returning another review verdict.",
    "If an explicitly requested behavior change makes an existing assertion stale, identify the exact assertion and propose a narrow test repair through the normal fail/fix path. Preserve meaningful coverage; do not skip tests, waive failures, or restore behavior the task explicitly removes.",
    "An existing test outside writable scope still requires the normal file-scope request or approval; identify the exact path in the proposed repair. Do not widen scope or take work owned by pending sibling tasks.",
    "If the requirement is actually ambiguous, name the conflicting requirements and ask the precise human question. Missing required evidence remains blocked testing. Do not pass without evidence.",
  ].join("\n");
}
