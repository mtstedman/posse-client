import { buildMcpSurfaceToolDescriptors } from "../../../../functions/tools/mcp-surface.js";
import {
  buildDisabledAtlasAttachment,
  buildAtlasMcpServerConfig,
  getAtlasIntegrationConfig,
  resolveAtlasExecutionAttachment,
} from "../../../integrations/functions/atlas.js";
import {
  buildDeterministicReadMcpServerConfig,
  buildDeterministicReadMcpServerConfigAsync,
  roleUsesDeterministicReadMcp,
} from "../../../integrations/functions/deterministic-mcp.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../integrations/functions/mcp-gateway.js";

export async function buildClaudeAtlasMcpConfigPayloadAsync(role, cwd, { assignmentUnit = null, workItemId = null, disableAtlas = false, atlasConfig = null } = {}) {
  const resolvedAtlasConfig = atlasConfig || getAtlasIntegrationConfig();
  const attachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "claude", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({
      role,
      providerName: "claude",
      cwd,
      assignmentUnit,
      workItemId,
      config: resolvedAtlasConfig,
    });
  if (!attachment.active || attachment.transport !== "mcp") {
    return { attachment, payload: null };
  }
  const server = buildAtlasMcpServerConfig(role, { cwd, config: resolvedAtlasConfig });
  if (!server?.ready) {
    return { attachment: { ...attachment, active: false, tools: [] }, payload: null };
  }
  const serverConfig = server.transport === "http"
    ? { type: "http", url: server.url }
    : {
      command: server.command,
      args: server.args || [],
      cwd: server.cwd || undefined,
      env: server.env || undefined,
    };
  const serverName = server.name || "atlas-v2";
  return {
    attachment,
    serverName,
    payload: {
      mcpServers: {
        [serverName]: serverConfig,
      },
    },
  };
}

export function __testBuildClaudeAtlasMcpConfigPayload(role, cwd, options = {}) {
  return buildClaudeAtlasMcpConfigPayloadAsync(role, cwd, options);
}

export function buildClaudeDeterministicReadMcpConfigPayload(role, cwd, {
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  needsImageGeneration = false,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = false,
  atlasConfig = null,
} = {}) {
  const enabled = roleUsesDeterministicReadMcp(role);
  if (!enabled) {
    return { active: false, tools: [], payload: null };
  }
  const server = buildDeterministicReadMcpServerConfig(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName: "claude",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
  });
  if (!server?.ready) {
    return { active: false, tools: [], payload: null };
  }
  const serverName = server.name || POSSE_MCP_GATEWAY_SERVER_NAME;
  const toolNames = Array.isArray(server.tools) ? server.tools : [];
  return {
    active: true,
    tools: toolNames,
    atlasTools: Array.isArray(server.atlasTools) ? server.atlasTools : [],
    serverName,
    serverConfig: server,
    ownerSession: server.ownerSession || null,
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "claude",
      serverName,
    }),
    payload: {
      mcpServers: {
        [serverName]: {
          command: server.command,
          args: server.args || [],
          cwd: server.cwd || undefined,
          env: server.env || undefined,
        },
      },
    },
  };
}

export function __testBuildClaudeDeterministicReadMcpConfigPayload(role, cwd, options = {}) {
  return buildClaudeDeterministicReadMcpConfigPayloadAsync(role, cwd, options);
}

export async function buildClaudeDeterministicReadMcpConfigPayloadAsync(role, cwd, {
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  createRoots = [],
  readRoots = [],
  needsImageGeneration = false,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = false,
  atlasConfig = null,
  remoteToolSurfaceOptions = null,
} = {}) {
  const enabled = roleUsesDeterministicReadMcp(role);
  if (!enabled) {
    return { active: false, tools: [], payload: null };
  }
  const server = await buildDeterministicReadMcpServerConfigAsync(role, {
    cwd,
    scopedFiles,
    createFiles,
    deleteFiles,
    createRoots,
    readRoots,
    needsImageGeneration,
    providerName: "claude",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
    remoteToolSurfaceOptions,
  });
  if (!server?.ready) {
    return { active: false, tools: [], payload: null };
  }
  const serverName = server.name || POSSE_MCP_GATEWAY_SERVER_NAME;
  const toolNames = Array.isArray(server.tools) ? server.tools : [];
  return {
    active: true,
    tools: toolNames,
    atlasTools: Array.isArray(server.atlasTools) ? server.atlasTools : [],
    serverName,
    serverConfig: server,
    ownerSession: server.ownerSession || null,
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "claude",
      serverName,
    }),
    payload: {
      mcpServers: {
        [serverName]: {
          command: server.command,
          args: server.args || [],
          cwd: server.cwd || undefined,
          env: server.env || undefined,
        },
      },
    },
  };
}
