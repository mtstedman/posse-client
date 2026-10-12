// @ts-check
// Shared feedback delivery for MCP owners and compatibility tool execution.
import { OPERATOR_FEEDBACK_DELIVERY_MARKER, OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS } from "../../../../catalog/operator-feedback.js";
export { OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS } from "../../../../catalog/operator-feedback.js";
import { takeOperatorFeedbackDeliveryForToolResult } from "../../../queue/functions/index.js";

/**
 * Claim a direct feedback envelope for a specific job. Shared with owner-side
 * result paths
 * (PersistentMcpOwner ATLAS results) that carry an explicit session job id
 * instead of ambient observation context.
 *
 * @param {number | string | null} jobId
 * @param {{attemptId?: number|null, agentCallId?: number|null, toolName?: string}} [options]
 * @returns {object|null}
 */
export function operatorFeedbackDeliveryForJob(jobId, {
  attemptId = null,
  agentCallId = null,
  toolName = "",
} = {}) {
  if (toolName && OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS.has(toolName)) return null;
  const normalized = Number(jobId);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return takeOperatorFeedbackDeliveryForToolResult({
    job_id: normalized,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    // Keep the trusted control envelope comfortably below provider result
    // clipping thresholds. Further pending items attach to a later result.
    limit: 8,
  });
}

export function operatorFeedbackDeliveryText(delivery) {
  if (!delivery) return "";
  return [
    `${OPERATOR_FEEDBACK_DELIVERY_MARKER}:`,
    JSON.stringify(delivery),
    "Apply these operator instructions now. Acknowledge every item with ack_operator_feedback before normal work continues.",
  ].join("\n");
}
