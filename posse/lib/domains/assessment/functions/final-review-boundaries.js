// Reuse assessment's conservative ownership guards before asking a developer
// to repair a reviewer report, and when consuming already persisted reports.
import { FINAL_REVIEW_OUTCOMES } from "../../../catalog/final-review.js";
import { buildAssessmentTaskBoundary, classifySiblingOnlyAssessmentFailure } from "../../worker/functions/helpers/assessment-task-boundary.js";
import { citedAssessmentPaths, classifyIgnoredPathOnlyAssessmentFailure, renderIgnoredPathCorrection } from "../../worker/functions/helpers/assessment-ignored-paths.js";

export async function finalReviewFindingCorrection(result, { job, payload, cwd }) {
  if (result?.outcome !== FINAL_REVIEW_OUTCOMES.FINDINGS) return null;
  const verdict = {
    verdict: "fail",
    reasons: (result.findings || []).map((finding) => [finding.criterion,
      ...(finding.paths || []).map((file) => `\`${file}\``), finding.evidence].filter(Boolean).join(" — ")),
    spawn_jobs: result.repair ? [{ payload: { instructions: result.repair } }] : [],
  };
  const sibling = classifySiblingOnlyAssessmentFailure(verdict, buildAssessmentTaskBoundary(job));
  if (sibling) return `TASK-BOUNDARY CORRECTION: The report cites only pending sibling-owned paths: ${sibling.cited_paths.join(", ")}. Reassess this task only; do not require repairing those sibling tasks. Report a corrected verdict.`;
  const ignored = await classifyIgnoredPathOnlyAssessmentFailure(verdict, { cwd, payload });
  if (!ignored) return null;
  // A separate, unlocated defect is not disproved by another finding naming
  // an ignored file. Correct only reports whose every finding is located.
  for (const reason of verdict.reasons) {
    if ((await citedAssessmentPaths({ reasons: [reason] }, { cwd, payload })).length === 0) return null;
  }
  return `${renderIgnoredPathCorrection(ignored)}\nReport a corrected verdict for the current workspace change.`;
}
