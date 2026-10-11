// Node prepares prompt metadata and the signed gateway surface. Rust owns Codex launch.
import { fileURLToPath } from "node:url";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfigAsync, roleUsesDeterministicReadMcp, releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { prepareCodexNativeAttachment } from "./native-dispatch.js";

export const CODEX_RESEARCH_BASE_INSTRUCTIONS_PATH = fileURLToPath(
  new URL("./research-base-instructions.md", import.meta.url),
);

export function buildCodexDeveloperInstructionRoute({
  promptPrelude = "",
  contractBlock = "",
  stableContext = "",
} = {}) {
  const developerInstructions = [promptPrelude, contractBlock, stableContext]
    .filter(Boolean).join("\n\n").trim();
  return { developerInstructions: developerInstructions || null };
}

export async function buildCodexAtlasAttachmentAsync(role, cwd, { assignmentUnit = null, workItemId = null, disableAtlas = false, atlasConfig = null } = {}) {
  const config = atlasConfig || getAtlasIntegrationConfig();
  const attachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "codex", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({ role, providerName: "codex", cwd, assignmentUnit, workItemId, config });
  if (!attachment.active || attachment.transport !== "mcp") return { attachment };
  const server = buildAtlasMcpServerConfig(role, { cwd, config });
  return { attachment: server?.ready ? attachment : { ...attachment, active: false, tools: [] } };
}

export async function buildCodexNativeMcpAttachmentAsync(role, cwd, {
  scopedFiles = [], createFiles = [], deleteFiles = [], createRoots = [], readRoots = [],
  allowWrite = null, projectDbWrite = false, projectDbCapability = "none",
  needsImageGeneration = false, jobId = null, workItemId = null, attemptId = null,
  agentCallId = null, promptChars = 0, fallbackReads = null, assessorMaxToolCalls = null,
  atlasPrefetchStatus = null, atlasAvailable = null, atlasGateEnabled = false,
  atlasConfig = null, remoteToolSurface = null, mcpGate = null, disableAgentTools = false,
} = {}) {
  if (disableAgentTools) {
    if (allowWrite) throw new Error("A tool-free native turn cannot have write access");
    return { active: false, tools: [], issuedToolIds: [], atlasTools: [], contractTools: [], serverConfig: null, serverKey: null };
  }
  if (!roleUsesDeterministicReadMcp(role)) {
    return { active: false, tools: [], issuedToolIds: [], atlasTools: [], contractTools: [], serverConfig: null, serverKey: null };
  }
  const serverConfig = await buildDeterministicReadMcpServerConfigAsync(role, {
    cwd, scopedFiles, createFiles, deleteFiles, createRoots, readRoots, allowWrite,
    projectDbWrite, projectDbCapability, needsImageGeneration, providerName: "codex",
    disableSystemTools: true, jobId, workItemId, attemptId, agentCallId, promptChars,
    fallbackReads, assessorMaxToolCalls, atlasPrefetchStatus, atlasAvailable,
    atlasGateEnabled, atlasConfig, remoteToolSurface, mcpGate, disableAgentTools,
    isolateProviderHome: false,
  });
  if (!serverConfig?.ready) throw new Error("Native Codex requires a ready scoped MCP gateway");
  try {
    return await prepareCodexNativeAttachment(serverConfig, { mcpGate });
  } catch (error) {
    releaseDeterministicMcpServerSession(serverConfig, { reason: "native_surface_failed" });
    throw error;
  }
}
