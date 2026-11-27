// Targets end the campaign; improvement determines whether an iteration passes.
// Only the execution owner may call this with completed, independently scored
// evidence. Provisional progress never reaches this decision boundary.
export function assessExperimentImprovement(plan, baseline, current, startingBaseline = baseline) {
  const required = plan.metrics.filter(metric => metric.role !== "tracking");
  if (plan.metrics.some(metric => !Number.isFinite(current?.[metric.id]) || !Number.isFinite(baseline?.[metric.id]))) throw new Error("Complete finite evidence is required.");
  const meets = metric => metric.direction === "higher" ? current[metric.id] >= metric.target : current[metric.id] <= metric.target;
  const improvement = metric => metric.direction === "higher" ? current[metric.id] - baseline[metric.id] : baseline[metric.id] - current[metric.id];
  const primary = plan.metrics.find(metric => metric.id === plan.acceptance?.primary_metric) || plan.metrics.find(metric => metric.role === "goal");
  const minimum = plan.acceptance?.min_improvement ?? 0;
  const change = improvement(primary);
  const guardrailsPassed = required.filter(metric => metric.role === "guardrail").every(meets);
  if (plan.acceptance?.tradeoff) {
    const policy = plan.acceptance.tradeoff;
    const metrics = policy.metrics.map(entry => {
      const metric = plan.metrics.find(metric => metric.id === entry.id);
      const start = startingBaseline?.[entry.id];
      const scale = entry.normalization === "relative" ? start : 1;
      const valid = Number.isFinite(start) && Number.isFinite(scale) && scale > 0;
      const delta = valid ? improvement(metric) / scale : NaN;
      const fromStart = valid ? (metric.direction === "higher" ? current[entry.id] - start : start - current[entry.id]) / scale : NaN;
      const contribution = entry.weight * delta;
      // Compare the original values to avoid rejecting an exact decimal cap
      // merely because subtracting two nearby values rounds its loss upward.
      const limit = valid ? start + (metric.direction === "higher" ? -1 : 1) * entry.max_regression * scale : NaN;
      const withinLimit = Number.isFinite(limit) && (metric.direction === "higher" ? current[entry.id] >= limit : current[entry.id] <= limit);
      return { ...entry, scale: valid ? scale : null,
        delta: Number.isFinite(delta) ? delta : null,
        contribution: Number.isFinite(contribution) ? contribution : null,
        regression: Number.isFinite(fromStart) ? Math.max(0, -fromStart) : null,
        regression_limit_passed: withinLimit };
    });
    const validBaseline = metrics.every(metric => metric.scale !== null);
    const utility = metrics.reduce((sum, metric) => sum + (metric.contribution ?? NaN), 0);
    const valid = validBaseline && Number.isFinite(utility) && metrics.every(metric => metric.regression !== null);
    const withinLimits = valid && metrics.every(metric => metric.regression_limit_passed);
    const improved = valid && utility > 0 && utility >= policy.min_gain;
    return {
      iteration_passed: guardrailsPassed && withinLimits && improved,
      goal_reached: required.every(meets), guardrails_passed: guardrailsPassed,
      primary_improvement: Number.isFinite(change) ? change : null,
      reason: !validBaseline ? "invalid_tradeoff_baseline" : !valid ? "invalid_tradeoff_arithmetic"
        : !guardrailsPassed ? "guardrail_failed" : !withinLimits ? "tradeoff_regression_limit" : !improved ? "no_sufficient_improvement" : "improved",
      tradeoff: { valid, utility_gain: valid ? utility : null, min_gain: policy.min_gain, regression_limits_passed: withinLimits, metrics },
    };
  }
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
