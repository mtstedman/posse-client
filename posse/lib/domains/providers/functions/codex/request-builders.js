// lib/domains/providers/functions/codex/request-builders.js

import { buildMcpSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { LIVE_CHANNEL_TOOL_NAMES } from "../../../../shared/tools/functions/tool-suites.js";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfig, buildDeterministicReadMcpServerConfigAsync, roleUsesDeterministicReadMcp } from "../../../integrations/functions/deterministic-mcp.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../integrations/functions/mcp-gateway.js";
import { _toCodexConfigKey, _toTomlLiteral, appendCodexMcpEnvOverrides } from "./config-format.js";

const CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT = 24000;
const CODEX_COORDINATION_MCP_SERVER_SUFFIX = "coordination";
const CODEX_EAGER_COORDINATION_TOOL_NAMES = new Set([
  "agent_handoff",
  ...LIVE_CHANNEL_TOOL_NAMES,
]);

function rawToolsMcpName(toolName = "") {
  const name = String(toolName || "").trim();
  if (!name) return "";
  return name.startsWith("tools.") ? name : `tools.${name}`;
}

function appendCodexMcpServerLaunchOverrides(configOverrides, serverKey, serverConfig, {
  toolNames = [],
} = {}) {
  configOverrides.push(
    `mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`,
    `mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`,
  );
  if (serverConfig.cwd) {
    configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
  }
  appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env, {
    extraAllowedKeys: toolNames.includes("generate_image")
      ? ["OPENAI_API_KEY", "XAI_API_KEY"]
      : [],
  });
}

function buildCodexDeterministicMcpAttachment(serverConfig) {
  const serverKey = _toCodexConfigKey(serverConfig.name || POSSE_MCP_GATEWAY_SERVER_NAME);
  const toolNames = Array.isArray(serverConfig.tools) ? serverConfig.tools : [];
  const eagerTools = toolNames.filter((name) => CODEX_EAGER_COORDINATION_TOOL_NAMES.has(name));
  const eagerServerKey = eagerTools.length > 0
    ? _toCodexConfigKey(`${serverKey}_${CODEX_COORDINATION_MCP_SERVER_SUFFIX}`)
    : null;
  const configOverrides = [];

  appendCodexMcpServerLaunchOverrides(configOverrides, serverKey, serverConfig, { toolNames });
  if (eagerServerKey) {
    const rawEagerTools = eagerTools.map(rawToolsMcpName);
    // Codex 0.145+ defers every ordinary MCP namespace when tool_search is
    // available. Partition the required coordination tools into a second,
    // filtered namespace and mark that namespace direct-only. This guarantees
    // startup visibility without eagerly loading the rest of the gateway.
    configOverrides.push(
      `mcp_servers.${serverKey}.disabled_tools=${_toTomlLiteral(rawEagerTools)}`,
    );
    appendCodexMcpServerLaunchOverrides(configOverrides, eagerServerKey, serverConfig, {
      toolNames: eagerTools,
    });
    configOverrides.push(
      `mcp_servers.${eagerServerKey}.enabled_tools=${_toTomlLiteral(rawEagerTools)}`,
      `mcp_servers.${eagerServerKey}.required=true`,
      `features.code_mode.direct_only_tool_namespaces=${_toTomlLiteral([`mcp__${eagerServerKey}`])}`,
    );
  }

  const contractTools = toolNames.flatMap((toolName) => buildMcpSurfaceToolDescriptors(
    [toolName],
    {
      providerName: "codex",
      serverName: CODEX_EAGER_COORDINATION_TOOL_NAMES.has(toolName) && eagerServerKey
        ? eagerServerKey
        : serverKey,
    },
  ));

  return {
    active: true,
    tools: toolNames,
    eagerTools,
    atlasTools: Array.isArray(serverConfig.atlasTools) ? serverConfig.atlasTools : [],
    contractTools,
    configOverrides,
    serverConfig,
    serverKey,
    eagerServerKey,
    providerHomeEnv: serverConfig.providerHomeEnv || null,
  };
}

export function buildCodexDeveloperInstructionRoute({
  promptPrelude = "",
  contractBlock = "",
  stableContext = "",
  atlasNote = null,
  strictMcpNote = null,
  webToolsNote = null,
  shellDiscipline = "",
  roleGuard = "",
} = {}, {
  softLimit = CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT,
} = {}) {
  const hardBlocks = [
    contractBlock,
    atlasNote,
    strictMcpNote,
    webToolsNote,
    shellDiscipline,
    roleGuard,
  ].filter(Boolean);
  const softBlocks = [
    stableContext,
  ].filter(Boolean);
  const strictBlocks = [
    ...hardBlocks,
    ...softBlocks,
  ];
  const fullDeveloperInstructions = [
    promptPrelude,
    ...strictBlocks,
  ].filter(Boolean).join("\n\n");
  if (!fullDeveloperInstructions.trim()) {
    return { configOverride: null, developerInstructions: null, inlinePromptPrelude: null };
  }
  if (fullDeveloperInstructions.length <= softLimit) {
    return {
      configOverride: `developer_instructions=${_toTomlLiteral(fullDeveloperInstructions)}`,
      developerInstructions: fullDeveloperInstructions,
      inlinePromptPrelude: null,
    };
  }

  const strictDeveloperInstructions = strictBlocks.join("\n\n");
  if (strictDeveloperInstructions.length <= softLimit) {
    return {
      configOverride: `developer_instructions=${_toTomlLiteral(strictDeveloperInstructions)}`,
      developerInstructions: strictDeveloperInstructions,
      inlinePromptPrelude: promptPrelude || null,
    };
  }

  // Last resort for Windows argv pressure: keep hard execution policy in
  // developer_instructions, but move only non-contract stable context inline.
  const hardDeveloperInstructions = hardBlocks.join("\n\n");
  const inlinePromptPrelude = [
    promptPrelude,
    ...softBlocks,
  ].filter(Boolean).join("\n\n");
  return {
    configOverride: hardDeveloperInstructions
      ? `developer_instructions=${_toTomlLiteral(hardDeveloperInstructions)}`
      : null,
    developerInstructions: hardDeveloperInstructions || null,
    inlinePromptPrelude: inlinePromptPrelude || null,
  };
}

export function __testBuildCodexDeveloperInstructionRoute(args, opts) {
  return buildCodexDeveloperInstructionRoute(args, opts);
}

export async function buildCodexAtlasConfigOverridesAsync(role, cwd, { assignmentUnit = null, workItemId = null, disableAtlas = false, atlasConfig = null } = {}) {
  const resolvedAtlasConfig = atlasConfig || getAtlasIntegrationConfig();
  const attachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "codex", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({
      role,
      providerName: "codex",
      cwd,
      assignmentUnit,
      workItemId,
      config: resolvedAtlasConfig,
    });
  if (!attachment.active || attachment.transport !== "mcp") {
    return {
      attachment,
      configOverrides: [],
      serverConfig: null,
      serverKey: null,
    };
  }

  const serverConfig = buildAtlasMcpServerConfig(role, { cwd, config: resolvedAtlasConfig });
  if (!serverConfig?.ready) {
    return {
      attachment: { ...attachment, active: false, tools: [] },
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  const serverKey = _toCodexConfigKey(serverConfig.name || "atlas_mcp");
  const configOverrides = [];
  if (serverConfig.transport === "http") {
    configOverrides.push(`mcp_servers.${serverKey}.url=${_toTomlLiteral(serverConfig.url)}`);
  } else {
    configOverrides.push(`mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`);
    configOverrides.push(`mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`);
    if (serverConfig.cwd) {
      configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
    }
    appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env);
  }

  return {
    attachment,
    configOverrides,
    serverConfig,
    serverKey,
  };
}

export function __testBuildCodexAtlasConfigOverrides(role, cwd, options = {}) {
  return buildCodexAtlasConfigOverridesAsync(role, cwd, options);
}

export function buildCodexDeterministicReadConfigOverrides(role, cwd, {
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
  mcpGate = null,
} = {}) {
  const enabled = roleUsesDeterministicReadMcp(role);
  if (!enabled) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig: null,
      serverKey: null,
    };
  }

  const serverConfig = buildDeterministicReadMcpServerConfig(role, {
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
    providerName: "codex",
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
  });
  if (!serverConfig?.ready) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  return buildCodexDeterministicMcpAttachment(serverConfig);
}

export function __testBuildCodexDeterministicReadConfigOverrides(role, cwd, options = {}) {
  return buildCodexDeterministicReadConfigOverridesAsync(role, cwd, options);
}

export async function buildCodexDeterministicReadConfigOverridesAsync(role, cwd, {
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
} = {}) {
  const enabled = roleUsesDeterministicReadMcp(role);
  if (!enabled) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig: null,
      serverKey: null,
    };
  }

  const serverConfig = await buildDeterministicReadMcpServerConfigAsync(role, {
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
    providerName: "codex",
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
  });
  if (!serverConfig?.ready) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  return buildCodexDeterministicMcpAttachment(serverConfig);
}

export function buildCodexSystemToolLockdownOverrides({ disableSystemTools = false } = {}) {
  if (!disableSystemTools) return [];
  return [
    "features.shell_tool=false",
    "features.unified_exec=false",
  ];
}

export function __testBuildCodexSystemToolLockdownOverrides(options = {}) {
  return buildCodexSystemToolLockdownOverrides(options);
}
