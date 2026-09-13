// lib/domains/providers/functions/codex/request-builders.js

import { buildMcpSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../../catalog/mcp.js";
import { CODEX_CODE_MODE_ROLES, CODEX_NATIVE_BATCHING_ROLES, CODEX_TERMINAL_MCP_SERVER_SUFFIX, CODEX_DIRECT_RESEARCH_TOOLS, CODEX_RESEARCHER_EXCLUDED_TOOL_NAMESPACES, CODEX_RESEARCHER_TRANSPORT_LIMITS } from "../../../../catalog/tool-surface/provider-attachments.js";
import { buildDisabledAtlasAttachment, buildAtlasMcpServerConfig, getAtlasIntegrationConfig, resolveAtlasExecutionAttachment } from "../../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfig, buildDeterministicReadMcpServerConfigAsync, roleUsesDeterministicReadMcp, releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import {
  resolveAtlasResearcherDispatcher,
  resolveAtlasResearcherTypedDispatcher,
  resolveAtlasResearcherWorkflow,
} from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { _toCodexConfigKey, _toTomlLiteral, appendCodexMcpEnvOverrides } from "./config-format.js";

import { prepareCodexResearchMcpSurface } from "./research-mcp-surface.js";
import { CODEX_AGENTS_MCP_SERVER_SUFFIX, CODEX_AGENT_DISPATCH_TOOLS } from "../../../../catalog/tool-surface/provider-attachments.js";
import { readPlannerDispatchPolicy } from "../../../planning/functions/planner-dispatch-policy.js";

const CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT = 24000;
const CODEX_LAZY_MCP_SERVER_SUFFIX = "lazy";
const CODEX_POSSE_MCP_STARTUP_TIMEOUT_SECONDS = 35;
const INTENTIONALLY_TOOLLESS_ROLES = new Set(["preflight", "delegator"]);
// Remote issuance has already narrowed this surface by role, task mode, and
// operator policy. Keep that issued surface direct by default: a tool belongs
// here only when it is intentionally safe to require tool_search before use.
const CODEX_LAZY_TOOL_NAMES = new Set([
  "custom_tools",
  "project_db_query",
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
    `mcp_servers.${serverKey}.startup_timeout_sec=${CODEX_POSSE_MCP_STARTUP_TIMEOUT_SECONDS}`,
    // Codex's native filesystem sandbox remains read-only. This approval is
    // limited to the Posse-owned MCP gateway, whose owner process enforces the
    // issued tool surface, job scope, protected paths, and write lock.
    `mcp_servers.${serverKey}.default_tools_approval_mode=${_toTomlLiteral("approve")}`,
  );
  if (serverConfig.cwd) {
    configOverrides.push(`mcp_servers.${serverKey}.cwd=${_toTomlLiteral(serverConfig.cwd)}`);
  }
  const inheritedEnvKeys = Object.keys(serverConfig.providerChildEnv || {})
    .filter((key) => /^[A-Z_][A-Z0-9_]*$/u.test(key))
    .sort();
  if (inheritedEnvKeys.length > 0) {
    // Codex intentionally filters the parent environment inherited by stdio
    // MCP servers. Whitelist the variable names so the shim receives the
    // launch-only credentials without serializing their values into the CLI
    // config overrides (and therefore the provider process argv).
    configOverrides.push(
      `mcp_servers.${serverKey}.env_vars=${_toTomlLiteral(inheritedEnvKeys)}`,
    );
  }
  appendCodexMcpEnvOverrides(configOverrides, serverKey, serverConfig.env, {
    extraAllowedKeys: toolNames.includes("generate_image")
      ? ["OPENAI_API_KEY", "XAI_API_KEY"]
      : [],
  });
}

export function buildCodexDeterministicMcpAttachment(serverConfig, {
  role = "",
  disableSystemTools = false,
  plannerDispatchPolicy = null,
  nativeBatchingCatalog = String(role || "").trim().toLowerCase() === "researcher"
    ? process.env.POSSE_CODEX_RESEARCH_MODEL_CATALOG || null : null,
  nativeBatching = true,
  atlasResearcherDispatcher = String(role || "").trim().toLowerCase() === "researcher"
    && (resolveAtlasResearcherDispatcher()
      || resolveAtlasResearcherTypedDispatcher()
      || resolveAtlasResearcherWorkflow()),
} = {}) {
  const serverKey = _toCodexConfigKey(serverConfig.name || POSSE_MCP_GATEWAY_SERVER_NAME);
  const toolNames = Array.isArray(serverConfig.tools) ? serverConfig.tools : [];
  const atlasTools = Array.isArray(serverConfig.atlasTools) ? serverConfig.atlasTools : [];
  const normalizedRole = String(role || "").trim().toLowerCase();
  const codexNativeBatching = disableSystemTools === true
    && CODEX_NATIVE_BATCHING_ROLES.includes(normalizedRole)
    && nativeBatching !== false;
  const codexCodeMode = !codexNativeBatching && disableSystemTools === true
    && CODEX_CODE_MODE_ROLES.includes(String(role || "").trim().toLowerCase());
  const lazyTools = toolNames.filter((name) => CODEX_LAZY_TOOL_NAMES.has(name));
  const eagerTools = toolNames.filter((name) => !CODEX_LAZY_TOOL_NAMES.has(name));
  // The experimental gate only relocates already-issued tools. It cannot mint
  // planner/research capabilities or enable dispatch through the master switch.
  const issuedAgentTools = eagerTools.filter((name) => CODEX_AGENT_DISPATCH_TOOLS.includes(name));
  const dispatchPolicy = issuedAgentTools.length > 0
    ? plannerDispatchPolicy || readPlannerDispatchPolicy({ projectDir: serverConfig.cwd })
    : null;
  const agentTools = dispatchPolicy?.enabled === true ? issuedAgentTools : [];
  const agentsServerKey = agentTools.length > 0
    ? _toCodexConfigKey(`${serverKey}_${CODEX_AGENTS_MCP_SERVER_SUFFIX}`)
    : null;
  const directTools = codexCodeMode || codexNativeBatching
    ? eagerTools.filter((name) => CODEX_DIRECT_RESEARCH_TOOLS.includes(name) || agentTools.includes(name))
    : eagerTools;
  const terminalTools = directTools.filter((name) => !agentTools.includes(name));
  const nestedTools = codexCodeMode ? eagerTools.filter((name) => !directTools.includes(name)) : [];
  const terminalServerKey = (codexCodeMode || codexNativeBatching) && terminalTools.length > 0
    ? _toCodexConfigKey(`${serverKey}_${CODEX_TERMINAL_MCP_SERVER_SUFFIX}`)
    : null;
  const lazyServerKey = lazyTools.length > 0
    ? _toCodexConfigKey(`${serverKey}_${CODEX_LAZY_MCP_SERVER_SUFFIX}`)
    : null;
  const directServerKeys = [];
  const configOverrides = [];
  const totalToolCount = toolNames.length + atlasTools.length;

  if (totalToolCount === 0) {
    if (INTENTIONALLY_TOOLLESS_ROLES.has(String(role || "").trim().toLowerCase())) {
      return {
        active: false,
        tools: [],
        directTools: [],
        lazyTools: [],
        lazyDiscoveryEnabled: false,
        atlasTools: [],
        atlasResearcherDispatcher: false,
        requiredTools: [],
        contractTools: [],
        configOverrides: [],
        serverConfig,
        serverKey: null,
        lazyServerKey: null,
        directServerKeys: [],
        providerHomeEnv: serverConfig.providerHomeEnv || null,
        reason: "intentional_toolless_role",
      };
    }
    const error = new Error(
      `Codex operational MCP projection is empty for ${role || "unknown-role"}`,
    );
    error.code = "POSSE_CODEX_MCP_SURFACE_INCOMPLETE";
    throw error;
  }

  appendCodexMcpServerLaunchOverrides(configOverrides, serverKey, serverConfig, { toolNames });
  const baseDisabledTools = [...lazyTools, ...(terminalServerKey ? terminalTools : []), ...agentTools].map(rawToolsMcpName);
  if (baseDisabledTools.length > 0) {
    configOverrides.push(
      `mcp_servers.${serverKey}.disabled_tools=${_toTomlLiteral(baseDisabledTools)}`,
    );
  }
  // The base gateway carries scoped repository tools plus every role-issued
  // ATLAS action. Those are prerequisites for the execution contract and the
  // ATLAS-first gate, so they must never depend on model-initiated discovery.
  configOverrides.push(`mcp_servers.${serverKey}.required=true`);
  if (!codexCodeMode && (eagerTools.some((name) => !agentTools.includes(name)) || atlasTools.length > 0)) {
    directServerKeys.push(serverKey);
  }
  if (terminalServerKey) {
    // Reuse the same shim credentials/owner session, preserving source custody.
    appendCodexMcpServerLaunchOverrides(configOverrides, terminalServerKey, serverConfig, { toolNames: terminalTools });
    configOverrides.push(
      `mcp_servers.${terminalServerKey}.enabled_tools=${_toTomlLiteral(terminalTools.map(rawToolsMcpName))}`,
      `mcp_servers.${terminalServerKey}.required=true`,
    );
    if (codexNativeBatching) configOverrides.push(`mcp_servers.${terminalServerKey}.supports_parallel_tool_calls=false`);
    directServerKeys.push(terminalServerKey);
  }
  if (agentsServerKey) {
    appendCodexMcpServerLaunchOverrides(configOverrides, agentsServerKey, serverConfig, { toolNames: agentTools });
    configOverrides.push(
      `mcp_servers.${agentsServerKey}.enabled_tools=${_toTomlLiteral(agentTools.map(rawToolsMcpName))}`,
      `mcp_servers.${agentsServerKey}.tool_timeout_sec=${dispatchPolicy.toolTimeoutSec}`,
      `mcp_servers.${agentsServerKey}.supports_parallel_tool_calls=false`,
      `mcp_servers.${agentsServerKey}.required=true`,
    );
    directServerKeys.push(agentsServerKey);
  }
  if (lazyServerKey) {
    const rawLazyTools = lazyTools.map(rawToolsMcpName);
    appendCodexMcpServerLaunchOverrides(configOverrides, lazyServerKey, serverConfig, {
      toolNames: lazyTools,
    });
    configOverrides.push(
      `mcp_servers.${lazyServerKey}.enabled_tools=${_toTomlLiteral(rawLazyTools)}`,
      `mcp_servers.${lazyServerKey}.required=true`,
    );
    if (codexNativeBatching) configOverrides.push(`mcp_servers.${lazyServerKey}.supports_parallel_tool_calls=false`);
  }
  if (codexCodeMode) configOverrides.push("features.code_mode.enabled=true");
  if (codexNativeBatching) configOverrides.push(
    "features.code_mode.enabled=false",
    "features.code_mode_host=false",
    ...(nativeBatchingCatalog ? [`model_catalog_json=${_toTomlLiteral(nativeBatchingCatalog)}`] : []),
    // Native batching controls model-turn emission separately from execution.
    // Planner/assessor/dev calls share mutable scope/protocol state: execute
    // their emitted batch in order, including writes and verification steps.
    `mcp_servers.${serverKey}.supports_parallel_tool_calls=${normalizedRole === "researcher"}`,
  );
  if (codexCodeMode || directServerKeys.length > 0) {
    configOverrides.push(
      `features.code_mode.direct_only_tool_namespaces=${_toTomlLiteral(
        directServerKeys.map((key) => `mcp__${key}`),
      )}`,
    );
  }

  const contractTools = toolNames.flatMap((toolName) => buildMcpSurfaceToolDescriptors(
    [toolName],
    {
      providerName: "codex",
      codexNestedMcp: codexCodeMode && !directTools.includes(toolName),
      serverName: agentTools.includes(toolName) && agentsServerKey
        ? agentsServerKey
        : CODEX_LAZY_TOOL_NAMES.has(toolName) && lazyServerKey
        ? lazyServerKey
        : terminalServerKey && directTools.includes(toolName) ? terminalServerKey : serverKey,
    },
  ));

  return {
    active: true,
    tools: toolNames,
    directTools,
    nestedTools,
    agentTools,
    agentsServerKey,
    terminalServerKey,
    codexCodeMode,
    codexNativeBatching,
    nativeBatchingCatalog: codexNativeBatching ? nativeBatchingCatalog : null,
    lazyTools,
    // Codex creates its deferred tool-search surface only when this catalog
    // contains at least one tool. Keep the state explicit for launch audits:
    // ordinary repository/Atlas runs must not advertise an empty discovery
    // call, while DB and future optional services may opt into it here.
    lazyDiscoveryEnabled: lazyTools.length > 0,
    atlasTools,
    atlasResearcherDispatcher: atlasResearcherDispatcher === true,
    requiredTools: Array.isArray(serverConfig.requiredTools) ? serverConfig.requiredTools : [],
    contractTools,
    configOverrides,
    serverConfig,
    serverKey,
    lazyServerKey,
    directServerKeys,
    providerHomeEnv: serverConfig.providerHomeEnv || null,
  };
}

export function buildCodexDeveloperInstructionRoute({
  promptPrelude = "",
  contractBlock = "",
  stableContext = "",
} = {}, {
  softLimit = CODEX_DEVELOPER_INSTRUCTIONS_SOFT_LIMIT,
} = {}) {
  const hardBlocks = [
    contractBlock,
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
  nativeBatching = true,
  nativeBatchingCatalog = undefined,
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
    fallbackReads,
    assessorMaxToolCalls,
    atlasPrefetchStatus,
    atlasAvailable,
    atlasGateEnabled,
    atlasConfig,
    mcpGate,
    disableAgentTools,
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

  return buildCodexDeterministicMcpAttachment(serverConfig, { role, disableSystemTools, nativeBatching, nativeBatchingCatalog });
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
  nativeBatching = true,
  nativeBatchingCatalog = undefined,
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
  remoteToolSurfaceOptions = null,
  remoteToolSurface = null,
  remoteMcpOAuthToken = "",
  mcpGate = null,
  disableAgentTools = false,
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
    fallbackReads,
    assessorMaxToolCalls,
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
  if (!serverConfig?.ready) {
    return {
      active: false,
      tools: [],
      configOverrides: [],
      serverConfig,
      serverKey: null,
    };
  }

  const attachment = buildCodexDeterministicMcpAttachment(serverConfig, { role, disableSystemTools, nativeBatching, nativeBatchingCatalog });
  // Codex imports direct schemas during its own MCP initialization. The
  // research-only preflight below resolves folded researcher action aliases;
  // other roles retain their existing contract and startup lifecycle.
  if (attachment.codexNativeBatching && String(role || "").trim().toLowerCase() !== "researcher") return attachment;
  try {
    const surface = await prepareCodexResearchMcpSurface(attachment, { mcpGate });
    attachment.coreDeclarations = surface.declarations;
    attachment.atlasTools = surface.atlasTools;
    attachment.atlasContractTools = surface.atlasContractTools;
    return attachment;
  } catch (error) {
    releaseDeterministicMcpServerSession(serverConfig, { reason: "core_declarations_failed" });
    throw error;
  }
}

export function __testBuildCodexDeterministicMcpAttachment(serverConfig, options = {}) {
  return buildCodexDeterministicMcpAttachment(serverConfig, options);
}

export function buildCodexSystemToolLockdownOverrides({
  disableSystemTools = false,
  disableNativeImageGeneration = false,
  disableResearcherUtilities = false,
  codexCodeMode = false,
  codexNativeBatching = false,
  webToolsActive = false,
  role = null,
} = {}) {
  const overrides = [];
  const disableUtilities = disableSystemTools
    && (disableResearcherUtilities || codexCodeMode || codexNativeBatching);
  if (codexCodeMode || codexNativeBatching) {
    const excluded = [...CODEX_RESEARCHER_EXCLUDED_TOOL_NAMESPACES];
    if (!webToolsActive) excluded.push("web");
    overrides.push(
      "features.apps=false",
      `features.code_mode.excluded_tool_namespaces=${_toTomlLiteral(excluded)}`,
    );
    if (codexCodeMode || role === "researcher" || disableResearcherUtilities) {
      overrides.push(`tool_output_token_limit=${CODEX_RESEARCHER_TRANSPORT_LIMITS.outputTokens}`);
    }
  }
  if (disableSystemTools) {
    overrides.push(
      "features.shell_tool=false",
      "features.unified_exec=false",
    );
  }
  if (disableUtilities) {
    overrides.push(
      "features.goals=false",
      "features.view_image=false",
      "tools.view_image=false",
      "features.multi_agent=false",
      "features.multi_agent_v2=false",
      // The host collaboration namespace uses this setting independently of
      // the legacy feature flags and nested code-mode namespace exclusions.
      "agents.enabled=false",
      "features.sleep_tool=false",
      "tools.update_plan.enabled=false",
      "tools.experimental_request_user_input.enabled=false",
    );
  }
  if (disableNativeImageGeneration || disableUtilities) {
    overrides.push("features.image_generation=false");
  }
  return overrides;
}

export function __testBuildCodexSystemToolLockdownOverrides(options = {}) {
  return buildCodexSystemToolLockdownOverrides(options);
}
