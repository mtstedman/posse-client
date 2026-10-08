import { buildMcpSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { prepareCodexResearchMcpSurface } from "./research-mcp-surface.js";
import { CODEX_NATIVE_MCP_SERVERS, CODEX_NATIVE_SERIAL_TOOL_IDS } from "../../../../catalog/binary.js";

// Node projects the signed tool contract for prompt assembly. Rust owns the
// provider's MCP launch configuration and imports these same issued schemas.
export async function prepareCodexNativeAttachment(serverConfig, { mcpGate } = {}) {
  if (!mcpGate?.rpc) throw new Error("Native Codex requires the attached MCP gate");
  const attachment = {
    active: true,
    serverConfig,
    serverKey: CODEX_NATIVE_MCP_SERVERS[0],
    tools: [],
    directTools: [],
    lazyTools: [],
    requiredTools: serverConfig.requiredTools || [],
    atlasTools: serverConfig.atlasTools || [],
    codexNativeBatching: true,
    codexCodeMode: false,
    configOverrides: [],
  };
  const surface = await prepareCodexResearchMcpSurface(attachment, { mcpGate });
  const tools = surface.issuedToolIds.filter(name => name.startsWith("tools."));
  if (surface.issuedToolIds.some(name => !name.startsWith("tools.") && !name.startsWith("atlas."))) {
    throw new Error("Native Codex received an unsupported MCP suite");
  }
  return {
    ...attachment,
    tools: tools.map(name => name.slice("tools.".length)),
    contractTools: tools.flatMap(name => buildMcpSurfaceToolDescriptors([name], {
      providerName: "codex",
      serverName: CODEX_NATIVE_MCP_SERVERS[Number(CODEX_NATIVE_SERIAL_TOOL_IDS.includes(name))],
    })),
    atlasTools: surface.atlasTools,
    atlasContractTools: surface.atlasContractTools,
    issuedToolIds: surface.issuedToolIds,
    coreDeclarations: [],
  };
}
