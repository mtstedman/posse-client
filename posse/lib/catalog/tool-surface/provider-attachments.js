// Provider transport declarations used while provider modules initialize.
// Keep this catalog independent of the provider registry: descriptor loading
// occurs from provider module initialization, so querying getProvider() here
// would introduce an ESM initialization cycle.
export const TOOL_ATTACHMENT_BY_PROVIDER = Object.freeze({
  claude: "mcp",
  openai: "function",
  grok: "function",
  codex: "deterministic-bridge",
  copilot: "mcp",
  "posse-local": "function",
});

// Research reads compose inside the executor; terminal submission stays direct.
// Core declarations are delivered during setup, independently of this routing.
export const CODEX_TERMINAL_MCP_SERVER_SUFFIX = "terminal";
export const CODEX_AGENTS_MCP_SERVER_SUFFIX = "agents";
export const CODEX_AGENT_DISPATCH_TOOLS = Object.freeze(["sub_agent", "dispatch_agent"]);
export const CODEX_DIRECT_RESEARCH_TOOLS = Object.freeze(["agent_handoff"]);

export const CODEX_CODE_MODE_ROLES = Object.freeze(["researcher"]);
export const CODEX_NATIVE_BATCHING_ROLES = Object.freeze(["researcher", "planner", "assessor", "dev"]);

// Composed reads need matching executor and history ceilings. The ceiling does
// not change the gateway's physical read or source-window budgets.
export const CODEX_RESEARCHER_TRANSPORT_LIMITS = Object.freeze({
  maxReadBatch: 4,
  outputTokens: 131072,
});

// Nested execution must not reopen provider utilities or ambient account apps
// that Posse did not issue. Explicitly issued web access is handled separately.
export const CODEX_RESEARCHER_EXCLUDED_TOOL_NAMESPACES = Object.freeze([
  "functions", "clock", "collaboration", "image_gen", "mcp__codex_apps",
]);
