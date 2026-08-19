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
