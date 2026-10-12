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
    const report = verdict ? `Reviewer says: ${verdict}${detail ? ` — ${detail}` : ""}` : "Reviewer waits for revisions";
    if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.REVISED) return "Reviewer received developer revision";
    if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.DONE) return "Reviewer session ended";
    if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.WAITING) return "Reviewer waiting for developer revision";
    return lifecycle ? "Reviewer submits report" : report;
  }
  if (!result) return "Developer requests review";
  if (lifecycle) return "Developer received review result";
  const reason = line(result.reason || result.summary || result.findings?.[0]?.criterion);
  if (result.outcome === FINAL_REVIEW_OUTCOMES.PASS) return `Review passed${reason ? `: ${reason}` : ""}`;
  if (result.outcome === FINAL_REVIEW_OUTCOMES.FINDINGS) {
    return `Review needs changes${reason ? `: ${reason}` : ""}`;
  }
  if (result.outcome === FINAL_REVIEW_OUTCOMES.BLOCKED) return `Review blocked${reason ? `: ${reason}` : ""}`;
  return "Developer requests review";
}
