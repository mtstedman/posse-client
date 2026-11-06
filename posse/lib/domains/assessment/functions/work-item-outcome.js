import { OUTCOME_EXECUTION as E, OUTCOME_VERIFICATION as V, OUTCOME_VERIFIED_COVERAGE, WORK_ITEM_OUTCOME_VERSION } from "../../../catalog/work-item-outcome.js";
import { reviewVisibleJobs, jobIsDisplayFailure, jobIsWriteStep } from "../../ui/functions/display/helpers/job-status.js";

// Read-side only: this projection never authorizes a merge or supplies a verdict.
export function projectWorkItemOutcome({ workItem = {}, jobs = [], receipts = [], candidateCommit = null,
  publication = {}, mergeCommit = null, acceptance = null, budget = null, waivers = [], gates = [], evidenceAvailable = true } = {}) {
  const visible = reviewVisibleJobs(jobs);
  const failed = visible.some(job => jobIsDisplayFailure(job, visible));
  const visibleIds = new Set(visible.map(job => job.id));
  const pending = gates.filter(gate => visibleIds.has(gate.id)).map(gate => ({ gate_id: gate.id, kind: gate.question_kind || gate.review_type || "unknown" }));
  const execution = failed ? E.FAILED : pending.length || (budget?.enabled && budget.paused_reason) ? E.BLOCKED
    : workItem.status === "complete" ? E.COMPLETE : visible.length ? E.ACTIVE : E.UNKNOWN;
  const implemented = visible.filter(jobIsWriteStep).filter(job => job.status === "succeeded");
  const reviewed = implemented.length > 0 && implemented.every(job => job.assessor_verdict === "pass");
  const current = candidateCommit ? receipts.filter(receipt => receipt.commit_hash === candidateCommit) : [];
  const passed = current.filter(receipt => receipt.status === "passed" && OUTCOME_VERIFIED_COVERAGE.includes(receipt.coverage_status));
  const verification = !evidenceAvailable ? V.UNKNOWN : current.some(receipt => receipt.status === "failed") ? V.FAILED
    : current.length && passed.length === current.length && execution === E.COMPLETE && waivers.length === 0 ? V.CHECKS_PASSED
      : current.length || waivers.length ? V.INCOMPLETE : reviewed ? V.REVIEW_ONLY : V.UNKNOWN;
  // Repo-wide publication telemetry is not evidence for this WI unless its
  // exact merge commit is named. Later descendants require ancestry evidence.
  const boundPublication = !!mergeCommit && publication.head === mergeCommit;
  const deployed = boundPublication && publication.deployment_state === "verified" && publication.deployment_head === mergeCommit;
  return {
    schema_version: WORK_ITEM_OUTCOME_VERSION,
    execution: { state: execution },
    review: { verdict: reviewed ? "pass" : implemented.some(job => job.assessor_verdict === "fail") ? "fail" : "unknown" },
    verification: { state: verification, commit: candidateCommit, checks: current, passed: passed.length, waivers },
    acceptance,
    budget: budget ? { enabled: !!budget.enabled, paused_reason: budget.paused_reason, limit_usd: budget.limit_usd, spent_usd: budget.spent_usd, spend_is_complete: budget.spend_is_complete, reserved_usd: budget.reserved_usd, unknown_costs: budget.unknown_costs, deadline_at: budget.deadline_at } : null,
    decisions: pending,
    delivery: { local: workItem.merge_state === "merged" ? "merged" : workItem.branch_name ? "unmerged_branch" : "no_branch",
      merge_commit: mergeCommit, publication: boundPublication ? publication.publication_state : "unknown",
      deployment: deployed ? "verified" : "unverified" },
  };
}

export function outcomeSummary(outcome) {
  if (!outcome) return "Outcome evidence unavailable";
  return `Execution: ${outcome.execution.state}; review: ${outcome.review.verdict}; verification: ${outcome.verification.state} (${outcome.verification.passed} checks); acceptance: ${outcome.acceptance?.state || "untracked"}; budget: ${outcome.budget?.enabled ? outcome.budget.paused_reason || "active" : "off"}; waivers: ${outcome.verification.waivers.length}; decisions: ${outcome.decisions.length}; delivery: ${outcome.delivery.local}, deployment ${outcome.delivery.deployment}`;
}

// Phone/relay projection intentionally excludes commands, titles and raw evidence.
export function safeOutcomeBrief(outcome) {
  return { execution: outcome.execution.state, review: outcome.review.verdict, verification: outcome.verification.state,
    budget_paused: !!(outcome.budget?.enabled && outcome.budget.paused_reason),
    acceptance: outcome.acceptance?.state || "untracked", unmet_required: outcome.acceptance?.unmet_required.length || 0,
    passed_checks: outcome.verification.passed, waived_checks: outcome.verification.waivers.length,
    pending_decisions: outcome.decisions.length, local_delivery: outcome.delivery.local, deployment: outcome.delivery.deployment };
}
