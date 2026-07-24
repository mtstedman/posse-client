import { McpServerConfig } from "../../../shared/tools/classes/McpServerConfig.js";
import { prepareIsolatedProviderHome } from "./isolated-provider-home.js";
import {
  getDeterministicMcpToolNames,
  roleUsesDeterministicImageHelpers,
  roleUsesDeterministicImageMcp,
  roleUsesDeterministicReadMcp,
  roleUsesDeterministicWriteMcp,
} from "./deterministic-mcp/tool-descriptors.js";
export {
  getDeterministicMcpToolNames,
  roleUsesDeterministicImageHelpers,
  roleUsesDeterministicImageMcp,
  roleUsesDeterministicReadMcp,
  roleUsesDeterministicWriteMcp,
} from "./deterministic-mcp/tool-descriptors.js";
export { McpServerConfig } from "../../../shared/tools/classes/McpServerConfig.js";
export { McpServer } from "../../../shared/tools/classes/McpServer.js";
export {
  bootConfigFromMcpOAuthClaims,
  buildMcpOAuthClaimsFromBootConfig,
  ensureMcpOAuthSigningKey,
  getMcpOAuthSigningKey,
  mintMcpOAuthToken,
  mintMcpOAuthTokenForBootConfig,
  verifyMcpOAuthToken,
} from "./deterministic-mcp/oauth-token.js";

export function buildDeterministicReadMcpServerConfig(role, {
  cwd = process.cwd(),
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  allowWrite = null,
  projectDbWrite = false,
  projectDbCapability = "none",
  needsImageGeneration = false,
  providerName = null,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = true,
  atlasConfig = null,
  mcpGate = null,
  disableAgentTools = false,
} = {}) {
  return McpServerConfig.forDeterministicRead(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    allowWrite,
    projectDbWrite,
    projectDbCapability,
    needsImageGeneration,
    providerName,
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    agentCallId,
    promptChars,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
    mcpGate,
    disableAgentTools,
  }).toSpawnArgs();
}

export async function buildDeterministicReadMcpServerConfigAsync(role, {
  cwd = process.cwd(),
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  allowWrite = null,
  projectDbWrite = false,
  projectDbCapability = "none",
  needsImageGeneration = false,
  providerName = null,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = true,
  atlasConfig = null,
  remoteToolSurfaceOptions = null,
  remoteToolSurface = null,
  remoteMcpOAuthToken = "",
  mcpGate = null,
  disableAgentTools = false,
} = {}) {
  const spawnArgs = (await McpServerConfig.forDeterministicReadAsync(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    allowWrite,
    projectDbWrite,
    projectDbCapability,
    needsImageGeneration,
    providerName,
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    agentCallId,
    promptChars,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
    remoteToolSurfaceOptions,
    remoteToolSurface,
    remoteMcpOAuthToken,
    mcpGate,
    disableAgentTools,
  })).toSpawnArgs();
  // Running MCP-only means Posse is the sole source of context, so isolate the
  // provider CLI's home from its global memory/config. Generic + provider-keyed:
  // unprofiled providers are a no-op.
  spawnArgs.providerHomeEnv = prepareIsolatedProviderHome(providerName);
  return spawnArgs;
}

export function releaseDeterministicMcpServerSession(serverConfig = null, opts = {}) {
  return McpServerConfig.releaseOwnerSession(serverConfig?.ownerSession || null, opts);
}
