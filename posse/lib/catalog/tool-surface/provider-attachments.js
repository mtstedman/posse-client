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

// Read-only research can compose issued MCP reads in the provider executor.
// Mutation roles retain the direct transport and its established stop path.
export const CODEX_NESTED_MCP_ROLES = Object.freeze(["researcher"]);

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
