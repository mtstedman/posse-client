import { EXPERIMENT_LIMITS, EXPERIMENT_PROGRESS_SCHEMA } from "../../../catalog/experiments.js";
import { validateExperimentPlan } from "../functions/plan.js";

// Host-side progress accumulator, not a scorer or execution authorization.
// The authenticated owner binds its scorer to this object for a reserved run.
// Incoming values remain provisional regardless of threshold crossings.
export class ExperimentProgress {
  constructor({ plan, runId, baseline = {}, total = null, now = Date.now }) {
    if (!validateExperimentPlan(plan).ok) throw new Error("Invalid experiment plan.");
    if (typeof runId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error("Invalid run identity.");
    if (total !== null && (!Number.isSafeInteger(total) || total < 1 || total > EXPERIMENT_LIMITS.observations)) throw new Error("Invalid work total.");
    if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) throw new Error("Invalid baseline.");
    if (Object.keys(baseline).some(id => !plan.metrics.some(metric => metric.id === id))) throw new Error("Unknown baseline metric.");
    if (Object.values(baseline).some(value => !Number.isFinite(value))) throw new Error("Baseline values must be finite.");
    this.metrics = structuredClone(plan.metrics); this.baseline = Object.freeze({ ...baseline });
    this.runId = runId; this.total = total; this.now = now; this.started = now(); this.lastObservation = null;
    this.intervalMs = plan.progress.interval_seconds * 1000; this.staleMs = plan.progress.stale_after_seconds * 1000;
    this.records = new Map(); this.timer = null;
    this.values = new Map(this.metrics.map(metric => [metric.id, []]));
    this.sums = new Map(this.metrics.map(metric => [metric.id, 0]));
  }

  observe({ run_id, case_id, values } = {}) {
    if (run_id !== this.runId) throw new Error("Progress belongs to another run.");
    if (typeof case_id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(case_id)) throw new Error("Invalid case identity.");
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length !== this.metrics.length
      || this.metrics.some(metric => !Object.hasOwn(values, metric.id) || !Number.isFinite(values[metric.id]))) throw new Error("Observation must contain exactly the declared finite metrics.");
    const ordered = this.metrics.map(metric => values[metric.id]);
    const fingerprint = JSON.stringify(ordered);
    if (this.records.has(case_id)) {
      if (this.records.get(case_id) !== fingerprint) throw new Error("Conflicting duplicate observation.");
      return false;
    }
    if (this.records.size >= (this.total ?? EXPERIMENT_LIMITS.observations)) throw new Error("Observation count exceeds the work limit.");
    // Validate all aggregate changes before mutating any metric.
    if (this.metrics.some(metric => !Number.isFinite(this.sums.get(metric.id) + values[metric.id]))) throw new Error("Metric aggregate overflow.");
    this.records.set(case_id, fingerprint);
    for (const metric of this.metrics) {
      this.values.get(metric.id).push(values[metric.id]);
      this.sums.set(metric.id, this.sums.get(metric.id) + values[metric.id]);
    }
    this.lastObservation = this.now();
    return true;
  }

  snapshot() {
    const now = this.now(); const completed = this.records.size;
    return {
      schema: EXPERIMENT_PROGRESS_SCHEMA, run_id: this.runId, observed_at: now,
      last_observation_at: this.lastObservation, elapsed_ms: Math.max(0, now - this.started),
      measurements_stale: now - (this.lastObservation ?? this.started) >= this.staleMs,
      completed, total: this.total, percent_complete: this.total === null ? null : 100 * completed / this.total,
      provisional: true, goal_met: false,
      metrics: this.metrics.map(metric => {
        const values = this.values.get(metric.id);
        let current = null;
        if (completed) {
          if (metric.aggregation === "mean") current = this.sums.get(metric.id) / completed;
          else if (metric.aggregation === "min") current = values.reduce((a, b) => Math.min(a, b), Infinity);
          else if (metric.aggregation === "max") current = values.reduce((a, b) => Math.max(a, b), -Infinity);
          else current = values.toSorted((a, b) => a - b)[Math.ceil(completed * 0.95) - 1];
        }
        const baseline = Object.hasOwn(this.baseline, metric.id) ? this.baseline[metric.id] : null;
        const rawDelta = current !== null && baseline !== null ? current - baseline : null;
        const delta = Number.isFinite(rawDelta) ? rawDelta : null;
        const improvement = delta === null ? null : metric.direction === "higher" ? delta : -delta;
        return { ...metric, baseline, current, samples: completed, delta, improvement,
          threshold_met: metric.role === "tracking" || current === null ? null : metric.direction === "higher" ? current >= metric.target : current <= metric.target };
      }),
    };
  }

  // Publishing does not advance observations or refresh measurement age.
  // One callback at a time; a slow consumer cannot accumulate queued pings.
  start(publish, onError = () => {}) {
    if (this.timer) throw new Error("Progress publisher already started.");
    let pending = false;
    const tick = async () => {
      if (pending) return;
      pending = true;
      try { await publish(this.snapshot()); } catch (error) {
        try { onError(error); } catch { /* A telemetry consumer cannot crash the run owner. */ }
      } finally { pending = false; }
    };
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
    void tick();
    return () => this.stop();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
