import { observationContextScope as _observationContextStorage } from "../classes/ObservationContextScope.js";

export function runWithObservationContext(context = {}, fn) {
  return _observationContextStorage.run({
    work_item_id: context.work_item_id ?? null,
    job_id: context.job_id ?? null,
    attempt_id: context.attempt_id ?? null,
    agent_call_id: context.agent_call_id ?? null,
    role: context.role ?? null,
  }, fn);
}

/** Set observation context for all subsequent calls in the current async scope (no callback needed). */
export function enterObservationContext(context = {}) {
  _observationContextStorage.enterWith({
    work_item_id: context.work_item_id ?? null,
    job_id: context.job_id ?? null,
    attempt_id: context.attempt_id ?? null,
    agent_call_id: context.agent_call_id ?? null,
    role: context.role ?? null,
  });
}

export function getObservationContext() {
  return _observationContextStorage.getStore() || null;
}
