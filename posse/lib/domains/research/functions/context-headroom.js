import { providerContextAdmissionBoundary, providerLongContextThreshold } from "../../../catalog/provider-economics.js";
import { readContextBudgetCheckpoint } from "../../billing/functions/context-budget.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { contextHeadroomReservationOwner } from "../classes/ContextHeadroomReservationOwner.js";

const ESTIMATOR_ERROR_HEADROOM_TOKENS = 4_096;
const DEFAULT_WINDOW_RESULT_TOKENS = 1_200;

function resultCap(args = {}) {
  const items = Array.isArray(args.items) ? args.items : [args];
  return items.reduce((sum, item) => (
    sum + Math.max(64, Number(item?.maxTokens) || DEFAULT_WINDOW_RESULT_TOKENS)
  ), 0);
}

function observation(boot, detail) {
  recordObservation({
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    agent_call_id: boot.agentCallId ?? null,
    observation_type: "context.headroom_decision",
    summary: `Context headroom ${detail.decision}: ${detail.reason}`,
    detail: { agent_call_id: boot.agentCallId ?? null, ...detail },
  });
}

export function admitSourceContextHeadroom({ boot = {}, args = {} } = {}) {
  const threshold = providerLongContextThreshold(boot.providerName, boot.modelName);
  const boundary = providerContextAdmissionBoundary(boot.providerName, boot.modelName);
  if (threshold == null || boundary == null) return { allowed: true, reason: "no_tier_boundary" };
  const checkpoint = readContextBudgetCheckpoint({
    agentCallId: boot.agentCallId,
    attemptId: boot.attemptId,
    providerSessionId: boot.providerSessionId,
    provider: boot.providerName,
    modelName: boot.modelName,
  });
  if (!checkpoint.usable) {
    observation(boot, {
      decision: "fail_open",
      reason: checkpoint.reason,
      predicted_next_request_tokens: null,
      threshold_tokens: threshold,
      reservation_tokens: 0,
      checkpoint_sequence_id: checkpoint.checkpoint?.sequence_id ?? null,
    });
    return { allowed: true, reason: `checkpoint_${checkpoint.reason}` };
  }
  const key = `${boot.attemptId}:${boot.providerSessionId}`;
  const existing = contextHeadroomReservationOwner.reservedTokens(key);
  const reservationTokens = resultCap(args);
  const predicted = Math.ceil(
    Number(checkpoint.checkpoint.request_context_input_tokens || 0)
    + Number(checkpoint.checkpoint.output_tokens_since_request || 0)
    + existing
    + reservationTokens
    + ESTIMATOR_ERROR_HEADROOM_TOKENS,
  );
  const nearTier = predicted >= boundary;
  const batched = Array.isArray(args.items) && args.items.length >= 2;
  const allowed = !nearTier || batched;
  const reason = !nearTier
    ? "below_headroom"
    : (allowed ? "batched_request" : "batch_required");
  if (allowed) contextHeadroomReservationOwner.reserve(key, reservationTokens);
  observation(boot, {
    agent_call_id: boot.agentCallId ?? null,
    decision: allowed ? "allowed" : "blocked",
    reason,
    predicted_next_request_tokens: predicted,
    threshold_tokens: threshold,
    admission_boundary_tokens: boundary,
    previous_pending_reservation_tokens: existing,
    reservation_tokens: allowed ? reservationTokens : 0,
    checkpoint_sequence_id: checkpoint.checkpoint.sequence_id,
    expected_next_sequence_id: Number(checkpoint.checkpoint.sequence_id) + 1,
    precision: checkpoint.checkpoint.precision,
  });
  return {
    allowed,
    reason,
    predicted,
    threshold,
    reservation: allowed ? { key, tokens: reservationTokens } : null,
  };
}

export function releaseSourceContextHeadroomReservation(reservation) {
  if (!reservation?.key || !reservation.tokens) return;
  contextHeadroomReservationOwner.release(reservation.key, reservation.tokens);
}
