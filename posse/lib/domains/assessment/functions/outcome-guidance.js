import { OUTCOME_EXECUTION as E, OUTCOME_VERIFICATION as V, OUTCOME_DESTINATIONS as D } from "../../../catalog/work-item-outcome.js";

/** Bounded, source-safe copy shared by local and relay surfaces. No raw errors,
 * paths, commands, requirement text, or provider output belongs here. */
export function outcomeGuidance(outcome) {
  if (!outcome) return { headline: "Outcome evidence unavailable", next: "Inspect the work item before continuing.", destination: D.STATUS };
  const { execution, verification, acceptance, budget, decisions, delivery } = outcome;
  let headline, next, destination;
  if (decisions.length) {
    headline = `${decisions.length} decision${decisions.length === 1 ? "" : "s"} waiting for you`;
    next = "Open review and answer the pending decision.";
    destination = D.REVIEW;
  } else if (budget?.enabled && budget.paused_reason) {
    headline = "Work paused by its budget";
    next = budget.unknown_costs ? "Inspect unresolved charges before resuming the budget." : "Inspect the spend and deadline before resuming the budget.";
    destination = D.BUDGET;
  } else if (outcome.merge_failed) {
    headline = "Delivery needs attention";
    next = "Open review to inspect the merge failure and retained branch.";
    destination = D.REVIEW;
  } else if (outcome.assessment_recovery) {
    headline = "Implementation recorded; assessment needs attention";
    next = "Open review to inspect assessment recovery before retrying.";
    destination = D.REVIEW;
  } else if (execution.state === E.FAILED || verification.state === V.FAILED) {
    headline = verification.state === V.FAILED ? "Recorded checks failed" : "Work needs attention";
    next = "Open review to inspect the failure and available recovery actions.";
    destination = D.REVIEW;
  } else if (execution.state === E.ACTIVE) {
    headline = "Work is in progress";
    next = "Follow progress in the monitor.";
    destination = D.STATUS;
  } else if (acceptance?.unmet_required?.length) {
    headline = `${acceptance.unmet_required.length} required outcome${acceptance.unmet_required.length === 1 ? "" : "s"} still need evidence`;
    next = "Inspect requirement acceptance and its missing evidence.";
    destination = D.ACCEPTANCE;
  } else if (delivery.local === "merged") {
    headline = "Changes merged locally";
    next = delivery.deployment === "verified" ? "Deployment evidence matches this merge." : "Review delivery evidence before assuming the changes are deployed.";
    destination = D.REVIEW;
  } else if (execution.state === E.COMPLETE) {
    headline = "Execution finished; review the result";
    next = "Inspect the changes, checks, and requirement evidence in review.";
    destination = D.REVIEW;
  } else {
    headline = "Work has no confirmed execution outcome";
    next = "Inspect its status before starting or retrying work.";
    destination = D.STATUS;
  }
  return { headline, next, destination };
}

/** Local commands only navigate to inspection. They never resolve a gate. */
export function outcomeDetailLines(outcome, { workItemId = null } = {}) {
  const guidance = outcomeGuidance(outcome);
  if (!outcome) return [guidance.headline, `Next: ${guidance.next}`];
  const id = Number(workItemId);
  const validId = Number.isSafeInteger(id) && id > 0;
  const command = guidance.destination === D.BUDGET && validId ? `posse budget show ${id}`
    : guidance.destination === D.ACCEPTANCE && validId ? `posse acceptance show ${id}`
      : guidance.destination === D.REVIEW ? "posse review" : "posse status";
  const v = outcome.verification;
  return [
    guidance.headline,
    `Saved work: ${v.commit ? `implementation commit ${v.commit}` : "no implementation commit recorded"}.`,
    `Evidence: ${v.state}; ${v.passed} checks passed; ${v.waivers.length} checks waived. Review: ${outcome.review.verdict}.`,
    `Requirements: ${outcome.acceptance?.state || "untracked"}; ${outcome.acceptance?.unmet_required?.length || 0} required outcomes unresolved.`,
    ...(outcome.budget?.enabled ? [`Budget: $${Number(outcome.budget.spent_usd || 0).toFixed(2)} recorded; $${Number(outcome.budget.reserved_usd || 0).toFixed(2)} reserved; ${outcome.budget.unknown_costs || 0} unknown charges${outcome.budget.spend_is_complete ? "" : "; accounting incomplete"}.`] : []),
    `Delivery: ${outcome.delivery.local}; deployment ${outcome.delivery.deployment}.`,
    `Next: ${guidance.next} (${command})`,
  ];
}
