import { getDb } from "../../../shared/storage/functions/index.js";
import { recordObservation } from "../../observability/functions/observations.js";

const EXACT_PRECISIONS = new Set(["exact", "recovered_exact"]);

function integer(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function publishContextBudgetCheckpoint(checkpoint = {}, { db = getDb() } = {}) {
  const agentCallId = integer(checkpoint.agentCallId ?? checkpoint.agent_call_id);
  const attemptId = integer(checkpoint.attemptId ?? checkpoint.attempt_id);
  const sequenceId = integer(checkpoint.sequenceId ?? checkpoint.sequence_id);
  const providerSessionId = String(checkpoint.providerSessionId ?? checkpoint.provider_session_id ?? "").trim();
  const provider = String(checkpoint.provider || "").trim().toLowerCase();
  const modelName = String(checkpoint.modelName ?? checkpoint.model_name ?? "").trim();
  const precision = String(checkpoint.precision || "exact");
  if (!agentCallId || !attemptId || !providerSessionId || !provider || !modelName || !sequenceId) {
    throw new Error("context checkpoint requires call, attempt, session, provider, model, and positive sequence");
  }
  db.prepare(`
    INSERT INTO context_budget_checkpoints (
      agent_call_id, attempt_id, provider_session_id, sequence_id,
      provider, model_name, request_context_input_tokens,
      output_tokens_since_request, precision, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_call_id) DO UPDATE SET
      attempt_id = excluded.attempt_id,
      provider_session_id = excluded.provider_session_id,
      sequence_id = excluded.sequence_id,
      provider = excluded.provider,
      model_name = excluded.model_name,
      request_context_input_tokens = excluded.request_context_input_tokens,
      output_tokens_since_request = excluded.output_tokens_since_request,
      precision = excluded.precision,
      observed_at = excluded.observed_at
    WHERE excluded.sequence_id > context_budget_checkpoints.sequence_id
  `).run(
    agentCallId, attemptId, providerSessionId, sequenceId,
    provider, modelName,
    integer(checkpoint.requestContextInputTokens ?? checkpoint.request_context_input_tokens) ?? 0,
    integer(checkpoint.outputTokensSinceRequest ?? checkpoint.output_tokens_since_request) ?? 0,
    precision,
    checkpoint.observedAt ?? checkpoint.observed_at ?? new Date().toISOString(),
  );
  const stored = db.prepare(`SELECT * FROM context_budget_checkpoints WHERE agent_call_id = ?`).get(agentCallId);
  try {
    const decision = db.prepare(`
      SELECT id, work_item_id, job_id, attempt_id, detail_json
      FROM job_observations
      WHERE attempt_id = ? AND observation_type = 'context.headroom_decision'
        AND json_extract(detail_json, '$.agent_call_id') = ?
        AND json_extract(detail_json, '$.expected_next_sequence_id') = ?
        AND NOT EXISTS (
          SELECT 1 FROM job_observations actual
          WHERE actual.observation_type = 'context.headroom_actual'
            AND json_extract(actual.detail_json, '$.decision_observation_id') = job_observations.id
        )
      ORDER BY id DESC LIMIT 1
    `).get(attemptId, agentCallId, sequenceId);
    if (decision) {
      const detail = JSON.parse(String(decision.detail_json || "{}"));
      const predicted = Number(detail.predicted_next_request_tokens);
      const actual = integer(checkpoint.requestContextInputTokens ?? checkpoint.request_context_input_tokens) ?? 0;
      recordObservation({
        work_item_id: decision.work_item_id,
        job_id: decision.job_id,
        attempt_id: decision.attempt_id,
        observation_type: "context.headroom_actual",
        summary: `Context prediction error ${Number.isFinite(predicted) ? actual - predicted : "unavailable"} tokens`,
        detail: {
          decision_observation_id: decision.id,
          agent_call_id: agentCallId,
          sequence_id: sequenceId,
          predicted_next_request_tokens: Number.isFinite(predicted) ? predicted : null,
          actual_request_context_tokens: actual,
          prediction_error_tokens: Number.isFinite(predicted) ? actual - predicted : null,
        },
      });
    }
  } catch { /* prediction telemetry must not block checkpoint publication */ }
  return stored;
}

export function readContextBudgetCheckpoint(expected = {}, {
  db = getDb(),
  nowMs = Date.now(),
  maxAgeMs = 60_000,
} = {}) {
  const agentCallId = integer(expected.agentCallId ?? expected.agent_call_id);
  const row = agentCallId
    ? db.prepare(`SELECT * FROM context_budget_checkpoints WHERE agent_call_id = ?`).get(agentCallId)
    : null;
  if (!row) return { usable: false, reason: "missing", checkpoint: null };
  const checks = [
    [expected.attemptId ?? expected.attempt_id, row.attempt_id, "attempt_mismatch"],
    [expected.providerSessionId ?? expected.provider_session_id, row.provider_session_id, "session_mismatch"],
    [expected.provider, row.provider, "provider_mismatch"],
    [expected.modelName ?? expected.model_name, row.model_name, "model_mismatch"],
  ];
  for (const [wanted, actual, reason] of checks) {
    if (wanted != null && String(wanted) !== String(actual)) return { usable: false, reason, checkpoint: row };
  }
  const expectedSequence = integer(expected.expectedSequenceId ?? expected.expected_sequence_id);
  if (expectedSequence != null && row.sequence_id !== expectedSequence) {
    return { usable: false, reason: "sequence_mismatch", checkpoint: row };
  }
  if (!EXACT_PRECISIONS.has(row.precision)) return { usable: false, reason: "imprecise", checkpoint: row };
  const observedMs = Date.parse(row.observed_at);
  if (!Number.isFinite(observedMs) || nowMs - observedMs > maxAgeMs) {
    return { usable: false, reason: "stale", checkpoint: row };
  }
  return { usable: true, reason: "fresh", checkpoint: row };
}
