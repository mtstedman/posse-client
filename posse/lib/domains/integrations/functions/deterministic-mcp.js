import { McpServerConfig } from "../../../classes/tools/McpServerConfig.js";
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
export { McpServerConfig } from "../../../classes/tools/McpServerConfig.js";
export { McpServer } from "../../../classes/tools/McpServer.js";
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
  needsImageGeneration = false,
  providerName = null,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = true,
  atlasConfig = null,
} = {}) {
  return McpServerConfig.forDeterministicRead(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName,
    disableSystemTools,
    jobId,
    workItemId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
  }).toSpawnArgs();
}

export async function buildDeterministicReadMcpServerConfigAsync(role, {
  cwd = process.cwd(),
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  needsImageGeneration = false,
  providerName = null,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = true,
  atlasConfig = null,
  remoteToolSurfaceOptions = null,
} = {}) {
  return (await McpServerConfig.forDeterministicReadAsync(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName,
    disableSystemTools,
    jobId,
    workItemId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
    remoteToolSurfaceOptions,
  })).toSpawnArgs();
}
