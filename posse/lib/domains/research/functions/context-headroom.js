import { providerContextAdmissionBoundary, providerLongContextThreshold } from "../../../catalog/provider-economics.js";
import { readContextBudgetCheckpoint } from "../../billing/functions/context-budget.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { contextHeadroomReservationOwner } from "../classes/ContextHeadroomReservationOwner.js";

const ESTIMATOR_ERROR_HEADROOM_TOKENS = 4_096;
const DEFAULT_WINDOW_RESULT_TOKENS = 1_200;
// The smallest per-selection cap `resultCap` will honour. Below this a bounded
// re-issue cannot buy any headroom, so no source read is admissible at all.
export const MIN_SOURCE_WINDOW_RESULT_TOKENS = 64;

function resultCap(args = {}) {
  const items = Array.isArray(args.items) ? args.items : [args];
  return items.reduce((sum, item) => (
    sum + Math.max(MIN_SOURCE_WINDOW_RESULT_TOKENS, Number(item?.maxTokens) || DEFAULT_WINDOW_RESULT_TOKENS)
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
  // Everything in the next request that is not this call's own result payload,
  // including every concurrently pending scalar-result reservation.
  const committed = Math.ceil(
    Number(checkpoint.checkpoint.request_context_input_tokens || 0)
    + Number(checkpoint.checkpoint.output_tokens_since_request || 0)
    + existing
    + ESTIMATOR_ERROR_HEADROOM_TOKENS,
  );
  const predicted = committed + reservationTokens;
  const nearTier = predicted >= boundary;
  // D-3: the public contract is scalar-only, so "batch it into items" was never
  // an executable remediation. Near the tier the admissible move is a bounded
  // selection: the result cap the caller declares must keep the whole next
  // request under the long-context threshold. Independent scalar calls issued
  // together are still fine — each draws from the same remaining budget below,
  // because `existing` holds their pending reservations.
  const availableResultTokens = Math.max(0, threshold - committed);
  const allowed = !nearTier || reservationTokens <= availableResultTokens;
  const remediable = availableResultTokens >= MIN_SOURCE_WINDOW_RESULT_TOKENS;
  const reason = !nearTier
    ? "below_headroom"
    : (allowed
      ? "bounded_selection"
      : (remediable ? "result_bound_required" : "source_budget_exhausted"));
  if (allowed) contextHeadroomReservationOwner.reserve(key, reservationTokens);
  observation(boot, {
    agent_call_id: boot.agentCallId ?? null,
    decision: allowed ? "allowed" : "blocked",
    reason,
    predicted_next_request_tokens: predicted,
    threshold_tokens: threshold,
    admission_boundary_tokens: boundary,
    previous_pending_reservation_tokens: existing,
    requested_result_tokens: reservationTokens,
    available_result_tokens: availableResultTokens,
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
    requestedResultTokens: reservationTokens,
    availableResultTokens,
    remediable,
    reservation: allowed ? { key, tokens: reservationTokens, released: false } : null,
  };
}

// Exactly-once by construction: the reservation record carries its own release
// state, so a site that releases and returns cannot be double-charged by the
// enclosing `finally`. Double release would deflate the pending total and
// over-admit the next request at the tier boundary.
export function releaseSourceContextHeadroomReservation(reservation) {
  if (!reservation?.key || !reservation.tokens) return false;
  if (reservation.released === true) return false;
  reservation.released = true;
  contextHeadroomReservationOwner.release(reservation.key, reservation.tokens);
  return true;
}
