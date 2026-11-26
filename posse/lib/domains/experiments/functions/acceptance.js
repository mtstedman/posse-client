// Targets end the campaign; improvement determines whether an iteration passes.
// Only the execution owner may call this with completed, independently scored
// evidence. Provisional progress never reaches this decision boundary.
export function assessExperimentImprovement(plan, baseline, current) {
  const required = plan.metrics.filter(metric => metric.role !== "tracking");
  if (plan.metrics.some(metric => !Number.isFinite(current?.[metric.id]) || !Number.isFinite(baseline?.[metric.id]))) throw new Error("Complete finite evidence is required.");
  const meets = metric => metric.direction === "higher" ? current[metric.id] >= metric.target : current[metric.id] <= metric.target;
  const improvement = metric => metric.direction === "higher" ? current[metric.id] - baseline[metric.id] : baseline[metric.id] - current[metric.id];
  const primary = plan.metrics.find(metric => metric.id === plan.acceptance?.primary_metric) || plan.metrics.find(metric => metric.role === "goal");
  const minimum = plan.acceptance?.min_improvement ?? 0;
  const change = improvement(primary);
  const guardrailsPassed = required.filter(metric => metric.role === "guardrail").every(meets);
  const noGoalRegressions = required.filter(metric => metric.role === "goal").every(metric => improvement(metric) >= 0);
  const improved = plan.acceptance?.mode === "automatic" ? Number.isFinite(change) && change > 0 && change >= minimum
    : required.some(metric => metric.role === "goal" && improvement(metric) > 0);
  return {
    iteration_passed: guardrailsPassed && noGoalRegressions && improved,
    goal_reached: required.every(meets), guardrails_passed: guardrailsPassed,
    primary_improvement: Number.isFinite(change) ? change : null,
    reason: !guardrailsPassed ? "guardrail_failed" : !noGoalRegressions ? "goal_metric_regressed" : !improved ? "no_sufficient_improvement" : "improved",
  };
}
