import {
  CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
  MERGE_FAILURE_RECOVERY_REVIEW_TYPE,
  MERGE_VERIFICATION_REVIEW_TYPE,
  POST_MERGE_DB_TASK_REVIEW_TYPE,
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
} from "../../../catalog/human-input.js";

// Reconciliation transition table. A live resolver is excluded by the SQL
// lease predicate before these decisions are used.
export function shouldRetireTerminalWorkItemGate(job, payload) {
  if (payload.review_type === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE
    && job.work_item_status === "failed") return false;
  if (payload.review_type === CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE
    && job.work_item_status === "complete"
    && job.work_item_merge_state !== "merged") return false;
  return payload.subtype !== "push_offer"
    && payload.review_type !== POST_MERGE_DB_TASK_REVIEW_TYPE
    && payload.review_type !== MERGE_VERIFICATION_REVIEW_TYPE
    && payload.review_type !== MERGE_FAILURE_RECOVERY_REVIEW_TYPE;
}

export function abandonedResolverDecision({ referencedId, originalStatus = null, allowedStates = [] }) {
  if (referencedId != null && originalStatus == null) return "retire_missing_original";
  if (originalStatus != null && !allowedStates.includes(originalStatus)) return "retire_source_changed";
  return "reopen";
}

export function terminalGateDecision({ jobStatus, headlessTimedOut = false }) {
  if (jobStatus === "succeeded") return "resolve";
  if (jobStatus === "canceled" || headlessTimedOut) return "supersede";
  return "reopen";
}

export function beginResolutionDecision({ gate, action, canonicalAction, idempotencyKey }) {
  const accepted = new Set([
    ...gate.allowed_actions,
    ...gate.allowed_actions.map((value) => canonicalAction(value)),
  ]);
  const resolvedAction = canonicalAction(action) || "respond";
  if (!accepted.has(action) && !accepted.has(resolvedAction)) {
    return { ok: false, reason: "action_not_allowed", allowed_actions: gate.allowed_actions };
  }
  const key = idempotencyKey(resolvedAction);
  if (gate.gate_state === "resolved") {
    return gate.idempotency_key === key
      ? { ok: true, idempotent: true, gate, action: gate.resolution_action }
      : { ok: false, reason: "gate_already_resolved", gate };
  }
  if (gate.gate_state !== "open") return { ok: false, reason: "gate_not_open", gate };
  return { ok: true, idempotent: false, action: resolvedAction, idempotency_key: key };
}

export function sourceStateDecision({ original, allowedStates }) {
  if (!original) return { ok: false, reason: "original_job_missing" };
  if (!allowedStates.includes(original.status)) {
    return {
      ok: false,
      reason: "original_state_changed",
      expected_states: allowedStates,
      actual_state: original.status,
    };
  }
  return { ok: true };
}
