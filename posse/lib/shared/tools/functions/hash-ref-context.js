import { getObservationContext, recordObservation } from "../../../domains/observability/functions/observations.js";

export function contextForHashRefs(explicitContext = {}) {
  const ambient = getObservationContext() || {};
  const explicitKeys = [
    "work_item_id",
    "workItemId",
    "job_id",
    "jobId",
    "attempt_id",
    "attemptId",
    "agent_call_id",
    "agentCallId",
  ];
  // Scope provenance is one lineage tuple, not four independent defaults. A
  // caller that supplies any scope field owns the whole tuple; the queue layer
  // can safely derive its missing ancestors from SQLite. Field-wise ambient
  // backfill can splice a concurrent job's attempt onto the explicit job.
  const source = explicitKeys.some((key) => Object.hasOwn(explicitContext, key))
    ? explicitContext
    : ambient;
  return {
    work_item_id: source.work_item_id ?? source.workItemId ?? null,
    job_id: source.job_id ?? source.jobId ?? null,
    attempt_id: source.attempt_id ?? source.attemptId ?? null,
    agent_call_id: source.agent_call_id ?? source.agentCallId ?? null,
  };
}

export function hasHashRefScope(context = {}) {
  return context.attempt_id != null || context.job_id != null || context.work_item_id != null || context.agent_call_id != null;
}

export function recordHashSurfaceFailure(context, toolName, sizeChars, reason) {
  try {
    const error = reason && typeof reason === "object"
      ? String(reason.error || reason.message || "surface_failed")
      : String(reason || "surface_failed");
    const errorDetail = reason && typeof reason === "object"
      ? reason.detail ?? reason.error_detail ?? null
      : null;
    recordObservation({
      work_item_id: context.work_item_id ?? null,
      job_id: context.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: "hash_ref.surface_failed",
      summary: `Failed to surface ${toolName || "tool_result"} as hash ref`,
      detail: {
        tool: toolName || null,
        size_chars: sizeChars,
        error: error.slice(0, 500),
        error_detail: errorDetail == null ? null : String(errorDetail).slice(0, 500),
        work_item_id: context.work_item_id ?? null,
        job_id: context.job_id ?? null,
        attempt_id: context.attempt_id ?? null,
        agent_call_id: context.agent_call_id ?? null,
      },
    });
  } catch {
    // Hash-ref telemetry must never break the tool result path.
  }
}
