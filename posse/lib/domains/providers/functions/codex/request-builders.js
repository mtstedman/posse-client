// lib/domains/providers/functions/codex/request-builders.js

import { buildMcpSurfaceToolDescriptors } from "../../../../functions/tools/mcp-surface.js";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfig, buildDeterministicReadMcpServerConfigAsync, roleUsesDeterministicReadMcp } from "../../../integrations/functions/deterministic-mcp.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../integrations/functions/mcp-gateway.js";
import { _toCodexConfigKey, _toTomlLiteral, appendCodexMcpEnvOverrides } from "./config-format.js";

const CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT = 24000;

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
    needsImageGeneration,
    providerName: "codex",
    disableSystemTools,
    jobId,
    workItemId,
    attemptId,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
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

  const serverKey = _toCodexConfigKey(serverConfig.name || POSSE_MCP_GATEWAY_SERVER_NAME);
  const configOverrides = [
    `mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`,
    `mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`,
  ];
  const toolNames = Array.isArray(serverConfig.tools) ? serverConfig.tools : [];
  if (serverConfig.cwd) {
    configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
  }
  appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env, {
    extraAllowedKeys: toolNames.includes("generate_image")
      ? ["OPENAI_API_KEY", "XAI_API_KEY"]
      : [],
  });

  return {
    active: true,
    tools: toolNames,
    atlasTools: Array.isArray(serverConfig.atlasTools) ? serverConfig.atlasTools : [],
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "codex",
      serverName: serverKey,
    }),
    configOverrides,
    serverConfig,
    serverKey,
    providerHomeEnv: serverConfig.providerHomeEnv || null,
  };
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
    needsImageGeneration,
    providerName: "codex",
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
  if (!serverConfig?.ready) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  const serverKey = _toCodexConfigKey(serverConfig.name || POSSE_MCP_GATEWAY_SERVER_NAME);
  const configOverrides = [
    `mcp_servers.${serverKey}.command=${_toTomlLiteral(serverConfig.command)}`,
    `mcp_servers.${serverKey}.args=${_toTomlLiteral(serverConfig.args || [])}`,
  ];
  const toolNames = Array.isArray(serverConfig.tools) ? serverConfig.tools : [];
  if (serverConfig.cwd) {
    configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
  }
  appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env, {
    extraAllowedKeys: toolNames.includes("generate_image")
      ? ["OPENAI_API_KEY", "XAI_API_KEY"]
      : [],
  });

  return {
    active: true,
    tools: toolNames,
    atlasTools: Array.isArray(serverConfig.atlasTools) ? serverConfig.atlasTools : [],
    contractTools: buildMcpSurfaceToolDescriptors(toolNames, {
      providerName: "codex",
      serverName: serverKey,
    }),
    configOverrides,
    serverConfig,
    serverKey,
    providerHomeEnv: serverConfig.providerHomeEnv || null,
  };
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
