export const AGENT_DEFINITION_SCHEMA = "bossy.agent.v1";
export const AGENT_TURN_PROTOCOL = "bossy.agent_turn.v1";
export const AGENT_DEFINITION_MAX_BYTES = 256 * 1024;
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const AGENT_SESSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
// `general` is accepted as a legacy on-disk value. New definitions default to
// sandbox and make broader host reach explicit.
export const AGENT_SCOPE_KINDS = Object.freeze(["sandbox", "folder", "repository", "global", "general"]);
export const AGENT_WRITE_MODES = Object.freeze(["confirm", "allow", "deny"]);
export const AGENT_LIMITS = Object.freeze({
  turns: 64,
  calls: 256,
  spend_usd: 100,
  wall_seconds: 3600,
});

export const AGENT_DEFINITION_FIELDS = Object.freeze([
  "schema", "name", "description", "prompt", "model", "scope", "tools",
  "skills", "autonomy", "limits",
]);

export const AGENT_DEFAULTS = Object.freeze({
  model: "sonnet",
  scope: Object.freeze({ kind: "sandbox" }),
  autonomy: Object.freeze({ write_tools: "confirm" }),
  limits: Object.freeze({ turns: 16, calls: 32, spend_usd: 2, wall_seconds: 600 }),
});
