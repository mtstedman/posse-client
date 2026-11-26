import { EXPERIMENT_CAMPAIGN_REPORT_SCHEMA } from "../../../catalog/experiments.js";

export function campaignReport(c) {
  return {
    schema: EXPERIMENT_CAMPAIGN_REPORT_SCHEMA, campaign_id: c.id, max_iterations: c.plan.max_iterations, provisional: !!c.active_run || !c.starting_baseline.metrics,
    state: c.state, revision: c.revision, acceptance_mode: c.plan.acceptance?.mode || "human",
    objective: c.plan.objective,
    active_run: c.active_run ? { id: c.active_run.id, baseline: c.active_run.baseline,
      percent_complete: c.active_run.progress?.percent_complete ?? null, measurements_stale: c.active_run.progress?.measurements_stale ?? false,
      observed_at: c.active_run.progress?.observed_at ?? null,
      values: Object.fromEntries(c.plan.metrics.map(metric => [metric.id, c.active_run.progress?.metrics.find(item => item.id === metric.id)?.current ?? null])) } : null,
    current_baseline_snapshot: c.current_baseline.snapshot_digest,
    metrics: c.plan.metrics.map(metric => ({ ...metric, baseline: c.starting_baseline.metrics?.[metric.id] ?? null, current_baseline: c.current_baseline.metrics?.[metric.id] ?? null })),
    iterations: c.iterations.map(row => {
      const live = c.active_run && !c.active_run.baseline && row.status === "running" ? c.active_run.progress : null;
      return { number: row.number, status: row.status, snapshot_digest: row.snapshot_digest,
        decision: row.decision?.value ?? (row.status === "completed" ? "pending" : "none"), iteration_passed: row.assessment?.iteration_passed ?? null, goal_reached: row.assessment?.goal_reached ?? null,
        percent_complete: live?.percent_complete ?? (row.status === "completed" ? 100 : null),
        values: Object.fromEntries(c.plan.metrics.map(metric => [metric.id, row.metrics?.[metric.id] ?? live?.metrics.find(item => item.id === metric.id)?.current ?? null])) };
    }),
  };
}

// Compact polling response: no file contents, history or raw process output.
export function campaignProgress(c) {
  const live = c.active_run?.progress;
  const latest = c.iterations.at(-1);
  return { campaign_id: c.id, revision: c.revision, state: c.state, iterations_used: c.iterations.length, max_iterations: c.plan.max_iterations,
    run_id: c.active_run?.id ?? null, baseline_run: c.active_run?.baseline ?? false,
    percent_complete: live?.percent_complete ?? null, measurements_stale: live?.measurements_stale ?? false,
    observed_at: live?.observed_at ?? null, last_decision: latest?.decision?.value ?? null,
    latest_iteration: latest ? { number: latest.number, status: latest.status, hypothesis: latest.hypothesis,
      assessment: latest.assessment ?? null, decision: latest.decision?.value ?? null, failure_reason: latest.failure_reason ?? null } : null,
    metrics: c.plan.metrics.map(metric => ({ id: metric.id, direction: metric.direction, target: metric.target ?? null,
      starting_baseline: c.starting_baseline.metrics?.[metric.id] ?? null, current_baseline: c.current_baseline.metrics?.[metric.id] ?? null,
      current: live?.metrics.find(item => item.id === metric.id)?.current ?? (c.active_run ? null : latest?.metrics?.[metric.id] ?? null) })) };
}
