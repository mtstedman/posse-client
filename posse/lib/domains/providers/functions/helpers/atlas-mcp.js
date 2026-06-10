import { isFallbackAtlasPrefetchStatus } from "../../../integrations/functions/deterministic-mcp/gate.js";
import { POSSE_MCP_GATEWAY_TRANSPORT } from "../../../integrations/functions/mcp-gateway.js";

const PROVIDER_VISIBLE_ATLAS_MCP_TRANSPORTS = new Set([
  "mcp",
  POSSE_MCP_GATEWAY_TRANSPORT,
  "posse-gateway",
  // Backward compatibility for packets/logs emitted before the neutral gateway
  // label existed.
  "deterministic-mcp",
]);

export function hasProviderVisibleAtlasMcpTools({
  disableAtlas = false,
  atlasPrefetchStatus = null,
  atlasAttachment = null,
} = {}) {
  const transport = String(atlasAttachment?.transport || "").trim().toLowerCase();
  return !disableAtlas
    && !isFallbackAtlasPrefetchStatus(atlasPrefetchStatus)
    && !!(atlasAttachment?.active && PROVIDER_VISIBLE_ATLAS_MCP_TRANSPORTS.has(transport));
}
