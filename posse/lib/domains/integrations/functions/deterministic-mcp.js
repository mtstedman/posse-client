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

export function buildDeterministicReadMcpServerConfig(role, {
  cwd = process.cwd(),
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
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
