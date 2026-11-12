import { AGENT_NAME_PATTERN } from "../../../catalog/agent.js";
import { demand, object } from "./policy.js";

export function normalizeAgentInvocation(raw) {
  object(raw, ["name", "digest"], ["name", "digest"]);
  demand(typeof raw.name === "string" && AGENT_NAME_PATTERN.test(raw.name), "Invoke agent needs a valid agent name", "script_invalid");
  demand(typeof raw.digest === "string" && /^[a-f0-9]{64}$/.test(raw.digest), "Invoke agent needs the selected definition digest", "script_invalid");
  return { name: raw.name, digest: raw.digest };
}

export const AGENT_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["message"],
  properties: { message: { type: "string", minLength: 1, description: "The complete task for the selected agent." } },
});

export const AGENT_TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: "object", required: ["status", "agent", "conversation_id", "reply", "usage", "error"],
  properties: {
    status: { type: "string" }, agent: { type: "string" }, conversation_id: { type: "string" },
    reply: { type: "string" }, usage: { type: ["object", "null"] }, error: { type: ["object", "null"] },
  },
});
