// Provider commentary (the visible text between tool calls) as a durable,
// bounded conversation note (decision D2). It is recorded as a job
// observation beside the job's tool rows so the conversation orders, retains
// and snapshots both alike; the agent.activity event copy is unchanged.
import { AGENT_CONVERSATION_BOUNDS } from "../../../catalog/agent-conversation.js";
import { AGENT_COMMENTARY_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { boundedText } from "./tool-call-tiers.js";

export function agentCommentaryNoteText(text) {
  return boundedText(scrubSecretText(String(text ?? "")), AGENT_CONVERSATION_BOUNDS.NOTE_CHARS);
}

/** recordObservation arguments for one commentary note, or null. */
export function agentCommentaryNoteObservation({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  agent_call_id = null,
  text = "",
} = {}) {
  const note = agentCommentaryNoteText(text);
  if (!note || job_id == null) return null;
  return {
    work_item_id,
    job_id,
    attempt_id,
    observation_type: AGENT_COMMENTARY_OBSERVATION_TYPE,
    summary: note,
    detail: { agent_call_id: agent_call_id ?? null, text: note },
  };
}
