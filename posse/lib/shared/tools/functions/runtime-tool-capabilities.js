import { TOOLS_SUITE } from "../../../catalog/tool-surface/transport-metadata.js";
import { withToolExecutionAliases } from "../../../catalog/tool-surface/compatibility.js";

// Implementation inventory, not authorization. Remote chooses which of these
// handlers a role receives; merely installing a handler never grants access.
export function supportedMcpToolNames() {
  return TOOLS_SUITE.filter((tool) => tool.advertise.includes("mcp")).map((tool) => tool.name);
}

export function assertSupportedMcpTools(names) {
  // Compatibility execution aliases are implemented but not advertised. They
  // remain callable only when explicitly present in the Remote grant.
  const supported = new Set(withToolExecutionAliases(supportedMcpToolNames()));
  const missing = names.filter((name) => !supported.has(name));
  if (missing.length) {
    const error = new Error(`Remote issued tools unsupported by this client: ${missing.join(", ")}`);
    error.code = "POSSE_AGENT_MCP_UNSUPPORTED_TOOLS";
    throw error;
  }
}
