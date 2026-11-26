import { BASELINE_RUNTIME_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { BASELINE_RUNTIME_WALL_MS } from "../../../catalog/verification.js";

// Lease identity prevents an abandoned phase from exempting a later attempt.
// Completed intervals remain visible until the scheduler releases the worker.
export class BaselineRuntimeClock {
  #leases = new Map();

  async run(job, signal, execute) {
    const key = job?._leaseToken;
    const state = key && (this.#leases.get(key) || { completed: 0, since: null });
    if (state?.since != null) return execute(signal);
    const started = Date.now();
    if (state) { state.since = started; this.#leases.set(key, state); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Baseline verification exceeded its wall budget", "TimeoutError")), BASELINE_RUNTIME_WALL_MS);
    timer.unref?.();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try { const result = await execute(combined); combined.throwIfAborted(); return result; }
    finally {
      clearTimeout(timer);
      const durationMs = Math.max(0, Date.now() - started);
      const creditMs = Math.min(BASELINE_RUNTIME_WALL_MS, durationMs);
      if (state) { state.completed += creditMs; state.since = null; }
      if (job?.id && job.work_item_id) recordObservation({
        work_item_id: job.work_item_id, job_id: job.id,
        observation_type: BASELINE_RUNTIME_OBSERVATION_TYPE,
        summary: `Baseline phase: ${durationMs} ms wall time, ${creditMs} ms excluded from agent runtime`,
        detail: { duration_ms: durationMs, agent_runtime_credit_ms: creditMs,
          agent_runtime_ms: durationMs - creditMs, aborted: combined.aborted },
      });
    }
  }

  elapsed(job, nowMs = Date.now()) {
    const state = this.#leases.get(job?._leaseToken);
    return state ? state.completed + (state.since == null ? 0 : Math.min(BASELINE_RUNTIME_WALL_MS, Math.max(0, nowMs - state.since))) : 0;
  }

  release(job) { this.#leases.delete(job?._leaseToken); }
}

export const baselineRuntimeClock = new BaselineRuntimeClock();
