// Node prepares prompt metadata and the signed gateway surface. Rust owns Claude launch.
import { CLAUDE_NATIVE_MCP_SERVER } from "../../../../catalog/binary.js";
import { nativeIssuedToolIds } from "../shared/native-tool-catalog.js";
import { buildMcpSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfigAsync, roleUsesDeterministicReadMcp, releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";

export async function buildClaudeAtlasAttachmentAsync(role, cwd, { assignmentUnit = null, workItemId = null, disableAtlas = false, atlasConfig = null } = {}) {
  const config = atlasConfig || getAtlasIntegrationConfig();
  const attachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "claude", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({ role, providerName: "claude", cwd, assignmentUnit, workItemId, config });
  if (!attachment.active || attachment.transport !== "mcp") return { attachment };
  const server = buildAtlasMcpServerConfig(role, { cwd, config });
  return { attachment: server?.ready ? attachment : { ...attachment, active: false, tools: [] } };
}

export async function buildClaudeNativeMcpAttachmentAsync(role, cwd, {
  scopedFiles = [], createFiles = [], deleteFiles = [], createRoots = [], readRoots = [],
  allowWrite = null, projectDbWrite = false, projectDbCapability = "none",
  needsImageGeneration = false, jobId = null, workItemId = null, attemptId = null,
  agentCallId = null, promptChars = 0, fallbackReads = null, assessorMaxToolCalls = null,
  atlasPrefetchStatus = null, atlasAvailable = null, atlasGateEnabled = false,
  atlasConfig = null, remoteToolSurface = null, mcpGate = null, disableAgentTools = false,
} = {}) {
  if (disableAgentTools) {
    if (allowWrite) throw new Error("A tool-free native turn cannot have write access");
    return { active: false, tools: [], issuedToolIds: [], atlasTools: [], contractTools: [], serverConfig: null };
  }
  if (!roleUsesDeterministicReadMcp(role)) {
    return { active: false, tools: [], issuedToolIds: [], atlasTools: [], contractTools: [], serverConfig: null };
  }
  const serverConfig = await buildDeterministicReadMcpServerConfigAsync(role, {
    cwd, scopedFiles, createFiles, deleteFiles, createRoots, readRoots, allowWrite,
    projectDbWrite, projectDbCapability, needsImageGeneration, providerName: "claude",
    disableSystemTools: true, jobId, workItemId, attemptId, agentCallId, promptChars,
    fallbackReads, assessorMaxToolCalls, atlasPrefetchStatus, atlasAvailable,
    atlasGateEnabled, atlasConfig, remoteToolSurface, mcpGate, disableAgentTools,
    isolateProviderHome: false,
  });
  if (!serverConfig?.ready) throw new Error("Native Claude requires a ready MCP gateway");
  let issuedToolIds;
  try {
    issuedToolIds = await nativeIssuedToolIds(mcpGate);
  } catch (error) {
    releaseDeterministicMcpServerSession(serverConfig, { reason: "provider_setup_failed" });
    throw error;
  }
  const tools = issuedToolIds.filter(name => name.startsWith("tools."));
  return {
    active: true,
    tools,
    atlasTools: issuedToolIds.filter(name => name.startsWith("atlas.")),
    issuedToolIds,
    serverName: CLAUDE_NATIVE_MCP_SERVER,
    serverConfig,
    contractTools: buildMcpSurfaceToolDescriptors(tools, { providerName: "claude", serverName: CLAUDE_NATIVE_MCP_SERVER }),
  };
}
