import { buildMcpSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { mcpClientToolDeadlineMs } from "../../../../catalog/mcp.js";
import { readPlannerDispatchPolicy } from "../../../planning/functions/planner-dispatch-policy.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../../catalog/mcp.js";
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

function mcpServerEnvWithProviderReferences(server = {}) {
  const env = { ...(server.env || {}) };
  for (const key of Object.keys(server.providerChildEnv || {}).sort()) {
    if (/^[A-Z_][A-Z0-9_]*$/u.test(key)) env[key] = `\${${key}}`;
  }
  return env;
}

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
    ? { type: "http", url: server.url, timeout: mcpClientToolDeadlineMs(server.atlasTools || []) }
    : {
      command: server.command,
      args: server.args || [],
      cwd: server.cwd || undefined,
      env: server.env || undefined,
      timeout: mcpClientToolDeadlineMs(server.atlasTools || []),
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
  allowWrite = null,
  projectDbWrite = false,
  projectDbCapability = "none",
  needsImageGeneration = false,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  fallbackReads = null,
  assessorMaxToolCalls = null,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = false,
  atlasConfig = null,
  mcpGate = null,
  disableAgentTools = false,
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
    allowWrite,
    projectDbWrite,
    projectDbCapability,
    needsImageGeneration,
    providerName: "claude",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    agentCallId,
    promptChars,
    fallbackReads,
    assessorMaxToolCalls,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
    mcpGate,
    disableAgentTools,
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
    providerHomeEnv: server.providerHomeEnv || null,
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
          env: mcpServerEnvWithProviderReferences(server),
          timeout: claudeMcpServerTimeoutMs(toolNames, server, cwd),
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
  allowWrite = null,
  projectDbWrite = false,
  projectDbCapability = "none",
  needsImageGeneration = false,
  disableSystemTools = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  atlasPrefetchStatus = null,
  atlasAvailable = null,
  atlasGateEnabled = false,
  atlasConfig = null,
  remoteToolSurfaceOptions = null,
  remoteToolSurface = null,
  remoteMcpOAuthToken = "",
  mcpGate = null,
  disableAgentTools = false,
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
    allowWrite,
    projectDbWrite,
    projectDbCapability,
    needsImageGeneration,
    providerName: "claude",
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
    providerHomeEnv: server.providerHomeEnv || null,
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
          env: mcpServerEnvWithProviderReferences(server),
          timeout: claudeMcpServerTimeoutMs(toolNames, server, cwd),
        },
      },
    },
  };
}


// Claude Code bounds each MCP tool call per server (`timeout`, ms) and also
// aborts a stdio call that shows no progress for 30 minutes by default. Both
// bounds come from the catalog deadline for the tools this server exposes, so
// composed checks, live scope waits, and agent dispatch are never abandoned by
// the client while the owner is still running them.
export function claudeMcpServerTimeoutMs(toolNames = [], server = {}, cwd = null) {
  const names = [
    ...(Array.isArray(toolNames) ? toolNames : []),
    ...(Array.isArray(server?.atlasTools) ? server.atlasTools : []),
  ];
  const dispatchIssued = names.some((name) => /^(tools[._])?dispatch_agent$/u.test(String(name || "")));
  let agentDispatchTimeoutMs = null;
  if (dispatchIssued) {
    try {
      agentDispatchTimeoutMs = readPlannerDispatchPolicy({ projectDir: server?.cwd || cwd || null }).toolTimeoutSec * 1000;
    } catch {
      agentDispatchTimeoutMs = null;
    }
  }
  return mcpClientToolDeadlineMs(names, { agentDispatchTimeoutMs });
}

/**
 * Environment the Claude child needs so its global MCP timeouts never undercut
 * the per-server deadlines above. Explicit operator values are respected.
 */
export function claudeMcpDeadlineEnv(mcpServers = {}, env = {}) {
  const timeouts = Object.values(mcpServers || {})
    .map((server) => Number(server?.timeout))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (timeouts.length === 0) return env;
  const ceiling = String(Math.max(...timeouts));
  if (env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT === undefined) env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = ceiling;
  if (env.MCP_TOOL_TIMEOUT === undefined) env.MCP_TOOL_TIMEOUT = ceiling;
  return env;
}
