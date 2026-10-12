// @ts-check
import { PROVIDER_MCP_TOOL_DEADLINE_MODE } from "./provider.js";

// Static support only; credentials, negotiation and availability stay adapter-owned.
export const PROVIDER_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    images: false,
    sessionResume: true,
    toolAttachment: "mcp",
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE.claude,
  }),
  anthropic: Object.freeze({
    images: false,
    sessionResume: false,
    toolAttachment: "function",
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE.anthropic,
  }),
  codex: Object.freeze({
    images: false,
    sessionResume: true,
    toolAttachment: "deterministic-bridge",
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE.codex,
  }),
  openai: Object.freeze({
    images: true,
    sessionResume: true,
    toolAttachment: "function",
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE.openai,
  }),
  grok: Object.freeze({
    images: true,
    sessionResume: false,
    toolAttachment: "function",
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE.grok,
  }),
  copilot: Object.freeze({
    images: false,
    sessionResume: false,
    toolAttachment: "mcp",
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE.copilot,
  }),
  "posse-local": Object.freeze({
    images: false,
    sessionResume: false,
    toolAttachment: "function",
    localGeneration: true,
    mcpToolDeadline: PROVIDER_MCP_TOOL_DEADLINE_MODE["posse-local"],
  }),
});
