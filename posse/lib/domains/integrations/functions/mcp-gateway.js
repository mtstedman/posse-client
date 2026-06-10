export const POSSE_MCP_GATEWAY_SERVER_NAME = "posse-gateway";
export const POSSE_MCP_GATEWAY_SERVER_INFO_NAME = "posse-gateway-mcp";
export const POSSE_MCP_GATEWAY_TRANSPORT = "mcp-gateway";

const POSSE_MCP_GATEWAY_SURFACE_PREFIXES = Object.freeze([
  "mcp__posse-gateway__",
  "mcp__posse_gateway__",
  // Backward compatibility for observations and prompt logs emitted before the
  // neutral gateway name was introduced.
  "mcp__posse-deterministic__",
  "mcp__posse_deterministic__",
]);

export function stripPosseMcpGatewayPrefix(toolName = "") {
  const raw = String(toolName || "").trim();
  const lower = raw.toLowerCase();
  for (const prefix of POSSE_MCP_GATEWAY_SURFACE_PREFIXES) {
    if (lower.startsWith(prefix)) return stripGatewaySuitePrefix(raw.slice(prefix.length));
  }
  return stripGatewaySuitePrefix(raw);
}

export function isPosseMcpGatewaySurfaceName(toolName = "") {
  const lower = String(toolName || "").trim().toLowerCase();
  return POSSE_MCP_GATEWAY_SURFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function stripGatewaySuitePrefix(toolName = "") {
  const raw = String(toolName || "").trim();
  if (raw.startsWith("tools.")) return raw.slice("tools.".length);
  if (raw.startsWith("tools_")) return raw.slice("tools_".length);
  return raw;
}
