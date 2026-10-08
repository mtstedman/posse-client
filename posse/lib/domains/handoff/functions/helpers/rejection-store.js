import { getDb } from "../../../../shared/storage/functions/index.js";
import { recordObservation } from "../../../observability/functions/observations.js";

export function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}


function boundedHandoffRejection(error) {
  const code = String(error?.code || "AGENT_HANDOFF_REJECTED").slice(0, 120);
  const message = String(error?.message || error || "agent_handoff was rejected").slice(0, 1000);
  const issues = Array.isArray(error?.issues)
    ? error.issues.slice(0, 24).map((issue) => ({
        code: String(issue?.code || "AGENT_HANDOFF_SCHEMA_INVALID").slice(0, 120),
        message: String(issue?.message || "Invalid agent_handoff arguments").slice(0, 500),
        ...(issue?.selector ? { selector: String(issue.selector).slice(0, 500) } : {}),
        ...(issue?.hint ? { hint: String(issue.hint).slice(0, 500) } : {}),
      }))
    : [];
  const failing_selectors = Array.isArray(error?.failing_selectors)
    ? error.failing_selectors.slice(0, 24).map((failure) => ({
        selector: String(failure?.selector || "").slice(0, 500),
        code: String(failure?.code || "AGENT_HANDOFF_SCHEMA_INVALID").slice(0, 120),
        hint: String(failure?.hint || "Correct this selector and retry the handoff.").slice(0, 500),
      })).filter((failure) => failure.selector)
    : issues.filter((issue) => issue.selector).map((issue) => ({
        selector: issue.selector,
        code: issue.code,
        hint: issue.hint || "Correct this selector and retry the handoff.",
      }));
  return { code, message, issues, failing_selectors };
}

export function recordAgentHandoffRejection(agentCallId, error, { db = getDb() } = {}) {
  const id = positiveInt(agentCallId);
  if (!id) return false;
  try {
    const call = db.prepare(`
      SELECT work_item_id, job_id, attempt_id
      FROM agent_calls
      WHERE id = ?
    `).get(id);
    if (!call) return false;
    const rejection = boundedHandoffRejection(error);
    return recordObservation({
      db,
      work_item_id: positiveInt(call.work_item_id),
      job_id: positiveInt(call.job_id),
      attempt_id: positiveInt(call.attempt_id),
      observation_type: "agent_handoff.rejected",
      summary: `Rejected terminal agent handoff (${rejection.code})`,
      detail: {
        agent_call_id: id,
        code: rejection.code,
        message: rejection.message,
        ...(rejection.issues.length > 0 ? { issues: rejection.issues } : {}),
        ...(rejection.failing_selectors.length > 0
          ? { failing_selectors: rejection.failing_selectors }
          : {}),
      },
    });
  } catch {
    return false;
  }
}

export function latestAgentHandoffRejection(agentCallId, db = getDb()) {
  const id = positiveInt(agentCallId);
  if (!id) return null;
  try {
    const row = db.prepare(`
      SELECT detail_json
      FROM job_observations
      WHERE observation_type = 'agent_handoff.rejected'
        AND json_valid(detail_json)
        AND json_extract(detail_json, '$.agent_call_id') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(id);
    if (!row?.detail_json) return null;
    const detail = JSON.parse(row.detail_json);
    return (detail && typeof detail === "object" && !Array.isArray(detail)) ? boundedHandoffRejection({
      code: detail.code,
      message: detail.message,
      issues: detail.issues,
      failing_selectors: detail.failing_selectors,
    }) : null;
  } catch {
    return null;
  }
}

export function getLatestAgentHandoffRejection(agentCallId, { db = getDb() } = {}) {
  return latestAgentHandoffRejection(agentCallId, db);
}

