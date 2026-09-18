// Provider-domain catalogue.
//
// Provider identifiers, labels, and the role registry that maps job types to
// the role responsible for spawning, executing, and assessing them.

export const PROVIDER_OPTIONS = Object.freeze(["claude", "openai", "codex", "grok", "copilot", "posse-local"]);

// Artificer chat runtimes can invoke the issued image-generation tool. Codex
// has no such execution route; image model ownership is a separate catalog.
export const IMAGE_TOOL_CHAT_PROVIDERS = Object.freeze(PROVIDER_OPTIONS.filter((provider) => provider !== "codex"));

// How each provider adapter honors the MCP per-call deadline from
// `catalog/mcp.js`: by writing it into its MCP client configuration, by
// carrying it through its environment, by executing tools in-process (no
// client-side timeout exists), or not at all ("unknown"). Roles whose tool
// calls can block for a long time (agent dispatch) are only routed to
// providers with a known mode. Each provider module's `capabilities.
// mcpToolDeadline` must match this table; a test pins the parity.
export const MCP_TOOL_DEADLINE_MODES = Object.freeze({
  SERVER_CONFIG: "server_config",
  ENV: "env",
  IN_PROCESS: "in_process",
  UNKNOWN: "unknown",
});
export const PROVIDER_MCP_TOOL_DEADLINE_MODE = Object.freeze({
  claude: MCP_TOOL_DEADLINE_MODES.SERVER_CONFIG,
  codex: MCP_TOOL_DEADLINE_MODES.SERVER_CONFIG,
  openai: MCP_TOOL_DEADLINE_MODES.IN_PROCESS,
  grok: MCP_TOOL_DEADLINE_MODES.IN_PROCESS,
  "posse-local": MCP_TOOL_DEADLINE_MODES.IN_PROCESS,
  copilot: MCP_TOOL_DEADLINE_MODES.UNKNOWN,
});
export function providerHonorsMcpToolDeadline(providerName) {
  const mode = PROVIDER_MCP_TOOL_DEADLINE_MODE[String(providerName || "").trim().toLowerCase()];
  return mode != null && mode !== MCP_TOOL_DEADLINE_MODES.UNKNOWN;
}

export const PROVIDER_USAGE_PROTOCOL = "posse.provider_usage.v1";
export const PROVIDER_USAGE_MAX_BYTES = 256 * 1024;

export const PROVIDER_LABELS = Object.freeze({
  claude: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  grok: "Grok",
  copilot: "Copilot",
  "posse-local": "Local (Qwen / Gemma)",
});

export const PROVIDER_ROLE_NAMES = Object.freeze([
  "dev",
  "artificer",
  "researcher",
  "planner",
  "preflight",
  "assessor",
  "delegator",
]);

export const DELEGATION_PROVIDER_ROLE_NAMES = Object.freeze(
  PROVIDER_ROLE_NAMES.filter((role) => role !== "preflight"),
);

export const JOB_TYPE_ROLE_REGISTRY = Object.freeze({
  research: Object.freeze({ provider: "researcher", delegation: "researcher", worker: "researcher", spawn: "researcher" }),
  plan: Object.freeze({ provider: "planner", delegation: "planner", worker: "planner", spawn: "planner" }),
  delegate: Object.freeze({ provider: "delegator", delegation: "delegator", worker: "delegator", spawn: "delegator" }),
  dev: Object.freeze({ provider: "dev", delegation: "dev", worker: "dev", spawn: "dev" }),
  fix: Object.freeze({ provider: "dev", delegation: "dev", worker: "dev", spawn: "fix" }),
  artificer: Object.freeze({ provider: "artificer", delegation: "artificer", worker: "artificer", spawn: "artificer" }),
  assess: Object.freeze({ provider: "assessor", delegation: "assessor", worker: "assessor", spawn: "assessor" }),
  summarize: Object.freeze({ provider: "planner", delegation: "planner", worker: "planner", spawn: "summary" }),
  preflight: Object.freeze({ provider: "preflight", delegation: "preflight", worker: "preflight", spawn: "preflight" }),
  human_input: Object.freeze({ provider: "human", delegation: null, worker: "human", spawn: null }),
  promote: Object.freeze({ provider: "promote", delegation: null, worker: "system", spawn: null }),
  atlas_warm: Object.freeze({ provider: "atlas", delegation: null, worker: "atlas-warm", spawn: null }),
});

export const JOB_TYPE_TO_PROVIDER_ROLE = Object.freeze(Object.fromEntries(
  Object.entries(JOB_TYPE_ROLE_REGISTRY).map(([jobType, roles]) => [jobType, roles.provider]),
));
