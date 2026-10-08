import { atlasResultFailures } from "./atlas-result-status.js";
import { randomUUID } from "node:crypto";
import { ATLAS_REQUEST_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { recordObservation } from "../../../domains/observability/functions/observations.js";

// Recursive recovery and batch fan-out inherit one context. Only the outer
// provider request records elapsed time; child durations are never summed here.
export async function observeAtlasRequest(args, execute, {
  record = recordObservation, now = () => performance.now(),
} = {}) {
  if (args.physicalRequest) return execute(args);
  const started = now();
  const physicalRequest = { id: randomUUID(), expandedCalls: 0, physicalStep: null, failedExecutions: 0, recoveredExecutions: 0, executionErrors: Object.create(null) };
  const boot = args.binding?.bootConfig || args.session?.bootConfig || {};
  let response;
  let failed = false;
  try {
    response = await execute({ ...args, physicalRequest });
    return response;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      const unresolved = atlasResultFailures(response?.result);
      record({
        work_item_id: boot.workItemId ?? null,
        job_id: boot.jobId ?? null,
        attempt_id: boot.attemptId ?? null,
        observation_type: ATLAS_REQUEST_OBSERVATION_TYPE,
        summary: `Atlas request: ${args.toolName}`,
        detail: {
          measurement_version: 1,
          measurement_unit: "physical_request",
          measurement_scope: "atlas_owner_dispatch",
          physical_request: 1,
          physical_request_id: physicalRequest.id,
          physical_call_step: physicalRequest.physicalStep,
          agent_call_id: boot.agentCallId ?? null,
          session_id: args.session?.id || null,
          tool_name: args.toolName,
          duration_ms: Math.max(0, now() - started),
          expanded_call_scope: "includes_recovery_children",
          expanded_calls: physicalRequest.expandedCalls,
          failed_executions: physicalRequest.failedExecutions,
          recovered_executions: physicalRequest.recoveredExecutions,
          execution_errors_by_code: physicalRequest.executionErrors,
          unresolved_item_failures: unresolved.count,
          unresolved_errors_by_code: unresolved.byCode,
          outcome: failed || response?.result?.isError ? "failed" : unresolved.count > 0 ? "partial" : "succeeded",
        },
      });
    } catch { /* Observation delivery cannot fail a tool request. */ }
  }
}
