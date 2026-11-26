import { EXPERIMENT_REPORT_SCHEMA, EXPERIMENT_REPORT_STATUSES } from "../../../catalog/experiments.js";
import { validateExperimentPlan } from "./plan.js";

// A presentation contract, not proof of execution or an authorized campaign
// store. Never upgrade imported measurements to trusted goal completion.
export function createExperimentReport({ campaign_id, plan, baseline = {}, iterations = [] } = {}) {
  if (!validateExperimentPlan(plan).ok) throw new Error("Invalid experiment plan.");
  if (typeof campaign_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(campaign_id)) throw new Error("Invalid campaign identity.");
  if (!Array.isArray(iterations) || iterations.length > plan.max_iterations) throw new Error("Invalid iteration count.");
  const checkValues = values => {
    if (!values || typeof values !== "object" || Array.isArray(values)
      || Object.keys(values).some(id => !plan.metrics.some(metric => metric.id === id))
      || Object.values(values).some(value => value !== null && !Number.isFinite(value))) throw new Error("Invalid report metrics.");
    return Object.fromEntries(plan.metrics.map(metric => [metric.id, Object.hasOwn(values, metric.id) ? values[metric.id] : null]));
  };
  const starting = checkValues(baseline);
  const rows = iterations.map((iteration, index) => {
    if (!iteration || iteration.number !== index + 1 || !EXPERIMENT_REPORT_STATUSES.includes(iteration.status)) throw new Error("Iteration sequence or status is invalid.");
    if (iteration.status === "running" && index !== iterations.length - 1) throw new Error("Only the last iteration may be running.");
    const percent = iteration.percent_complete ?? null;
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new Error("Invalid iteration progress.");
    return { number: iteration.number, status: iteration.status, percent_complete: percent, values: checkValues(iteration.values ?? {}) };
  });
  return {
    schema: EXPERIMENT_REPORT_SCHEMA, campaign_id, max_iterations: plan.max_iterations,
    provisional: true,
    metrics: plan.metrics.map(metric => ({ ...metric, baseline: starting[metric.id] })),
    iterations: rows,
  };
}
