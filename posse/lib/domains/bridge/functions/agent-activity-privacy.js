import { AGENT_ACTIVITY_PROTOCOL, EVENT_TYPES } from "../../../catalog/event.js";
import { FEEDBACK_PHASES } from "../../../catalog/work-item-interactions.js";

// agent-calls.js reports each provider call's start, finish, interruption and
// orphan timeout with phase and summary taken from agent_calls.activity. For a
// web-research child that text is the delegated question, so it must not
// reach a remote surface. Like run-monitor, remote projections show the call's
// identity and status instead; the durable event row is unchanged for local
// readers.
export const AGENT_CALL_LIFECYCLE_PHASE = "model_call";

const LIFECYCLE_KINDS = new Set(["model", "error", "result"]);
const COMMENTARY_PHASE = "commentary";

export function isAgentCallLifecycleActivity(row, event) {
  if (event?.protocol !== AGENT_ACTIVITY_PROTOCOL || !LIFECYCLE_KINDS.has(event.kind)) return false;
  if (event.kind === "model") return true;
  // Terminal lifecycle frames share kinds with job-phase and agent_feedback
  // results. Only agent-calls.js keys them by the call itself.
  if (event.agent_call_id == null || String(row?.actor_id ?? "") !== String(event.agent_call_id)) return false;
  const phase = String(event.phase ?? "");
  return phase !== COMMENTARY_PHASE && !FEEDBACK_PHASES.has(phase);
}

export function agentCallLifecycleSummary(role, status) {
  const label = String(role ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Agent";
  const state = String(status ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "activity";
  return `${label} model ${state}`;
}

function parsedEventJson(row) {
  if (row?.event_json && typeof row.event_json === "object") return row.event_json;
  try { return JSON.parse(String(row?.event_json || "null")); } catch { return null; }
}

/** Remote-safe message for a raw events row (events.tail fallback). */
export function remoteEventMessage(row) {
  if (String(row?.event_type || "") !== EVENT_TYPES.AGENT_ACTIVITY) return row?.message;
  const event = parsedEventJson(row);
  return isAgentCallLifecycleActivity(row, event)
    ? agentCallLifecycleSummary(row.actor_type, event.status)
    : row?.message;
}
