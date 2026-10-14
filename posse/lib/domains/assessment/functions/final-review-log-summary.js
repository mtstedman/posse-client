import { FINAL_REVIEW_OUTCOMES, FINAL_REVIEW_REVIEWER_STATUS } from "../../../catalog/final-review.js";

const line = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);

// Describe the two sides of the protocol without making every request look
// like another independent review. Keep the canonical tool identity intact.
export function finalReviewLogSummary({ input = {}, result = null, reviewer = false, lifecycle = false } = {}) {
  const verdict = line(input.verdict);
  reviewer ||= Boolean(verdict);
  if (reviewer) {
    if (result?.status === "invalid_report") return `Reviewer report rejected: ${line(result.error)}`;
    const detail = line(input.summary || input.findings?.[0]?.criterion);
    const reportVerdict = verdict === "pass" ? "PASS" : `FAILED: ${detail || "No passing verdict"}`;
    const report = verdict ? `Reviewer says: ${reportVerdict}` : "Reviewer waits for revisions";
    if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.REVISED) return "Reviewer received developer revision";
    // Ending the child session is transport cleanup, not a review verdict.
    // Keep its report identifiable; the developer's result is authoritative.
    if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.DONE) return result.error
      ? `Reviewer report rejected: ${line(result.error)}` : lifecycle ? "Reviewer session closed" : report;
    if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.WAITING) return "Reviewer waiting for developer revision";
    return lifecycle ? "Reviewer submits report" : report;
  }
  if (!result) return "Developer requests review";
  const reason = line(result.reason || result.summary || result.findings?.[0]?.criterion);
  if (result.outcome === FINAL_REVIEW_OUTCOMES.PASS) return lifecycle ? "Developer session closed" : "PASS";
  if (result.outcome === FINAL_REVIEW_OUTCOMES.FINDINGS) {
    return `FAILED: ${reason || "Changes are required"}`;
  }
  if (result.outcome === FINAL_REVIEW_OUTCOMES.BLOCKED) return `FAILED: ${reason || "Review could not complete"}`;
  if (lifecycle) return "Developer received review result";
  return "Developer requests review";
}
