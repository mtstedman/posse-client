// Direct Anthropic Messages API provider.
//
// This is intentionally separate from the `claude` provider, which owns the
// Claude Code CLI/OAuth runtime. The adapter mirrors Posse's other API-backed
// providers: lazy credentials, shared retry/circuit-breaker policy, embedded
// deterministic tools, ATLAS issuance, bounded tool turns, usage accounting,
// cancellation, and stall detection.

import Anthropic from "@anthropic-ai/sdk";

import { MCP_TOOL_DEADLINE_MODES } from "../../../../catalog/provider.js";
import { TOOL_GENERATE_IMAGE } from "../../../../catalog/native-tools.js";
import { getSetting } from "../../../queue/functions/index.js";
import { composeRemoteAssessorPromptForProvider } from "../shared/remote-assessor-prompt.js";
import {
  appendExecutionTools,
  buildExecutionContract,
  renderExecutionContractBlock,
} from "../../../../shared/tools/functions/contract.js";
import { projectFunctionToolSurface } from "../../../../shared/tools/functions/provider-surface.js";
import { formatAtlasToolUseDisplayName } from "../../../../shared/tools/functions/mcp-surface.js";
import {
  issuedToolSurfaceForProviderPolicy,
  narrowProviderOptionsToRemoteIssuance,
} from "../../../../shared/tools/functions/issued-tool-policy.js";
import {
  buildDisabledAtlasAttachment,
  logAtlasAttachment,
  resolveAtlasAssignmentUnit,
  resolveAtlasExecutionAttachment,
  withAtlasExecutionPolicySnapshot,
} from "../../../integrations/functions/atlas.js";
import {
  buildAtlasGateScopeKey,
  configureGate,
  isFallbackAtlasPrefetchStatus,
  releaseGate,
  unlockForAtlasUnavailable,
} from "../../../integrations/functions/deterministic-mcp/gate.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import {
  classifyProviderError,
  createCircuitBreaker,
  createRetryWrapper,
} from "../shared/api-resilience.js";
import { createAbortableMessagesCaller } from "../shared/abortable-messages.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { normalizeProviderUsage } from "../shared/usage-normalization.js";
import {
  escalateModelTier,
  getMaxOutputTokensForProvider,
  getMaxTurnsForProvider,
} from "../shared/turns.js";
import {
  buildOutputLimitError,
  normalizeMaxOutputTokens,
  responseOutputLimitReason,
} from "../shared/output-limits.js";
import { resolveProviderStallTimeout } from "../shared/stall-timeout.js";
import { DEFAULT_FALLBACK_READS, createOpenAiCompatibleTooling } from "../shared/response-tooling.js";
import { truncateToolResultPreservingFeedback } from "../shared/tool-runtime.js";
import { roleBrandColor, roleBrandIcon } from "../../../ui/functions/display/helpers/brand.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { signalAbortError } from "../../../runtime/functions/yield.js";
import { LIVE_CHANNEL_TOOL_NAMES } from "../../../../shared/tools/functions/tool-suites.js";
import { createAssessorToolLoopBudget } from "../shared/assessor-tool-loop-budget.js";
import { ASSESSOR_READ_ALLOWANCE_ADVISORY_TEXT } from "../../../../shared/tools/functions/assessor-tool-budget.js";

export { extractJson };

const PROVIDER_NAME = "anthropic";
const PROVIDER_LABEL = "Anthropic";
const LIVE_CHANNEL_TURN_LIMIT = 12;
const THROTTLE_MS = 200;

function abortableThrottle(ms, signal = null) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) throw signalAbortError(signal, "Anthropic throttle aborted");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalAbortError(signal, "Anthropic throttle aborted"));
    };
    signal.addEventListener?.("abort", onAbort, { once: true });
  });
}

let _client = null;

function buildAnthropicClientOptions(apiKey) {
  return { apiKey, maxRetries: 0 };
}

export function __testBuildAnthropicClientOptions(apiKey = "test-key") {
  return buildAnthropicClientOptions(apiKey);
}

export function __testSetAnthropicClient(client = null) {
  _client = client;
}

function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required when using the Anthropic provider.\n" +
        "Set it in your environment or Posse provider credentials file.",
      );
    }
    _client = new Anthropic(buildAnthropicClientOptions(apiKey));
  }
  return _client;
}

const _circuitBreaker = createCircuitBreaker();

export function isCircuitOpen() {
  return _circuitBreaker.isOpen();
}

const withRetry = createRetryWrapper({
  breaker: _circuitBreaker,
  formatRateLimitMessage: () => `${C.yellow}[circuit-breaker] Anthropic rate-limited - breaker tripped, falling back to alt provider${C.reset}`,
  formatRetryMessage: (status, waitMs, attempt, maxAttempts) => `${C.yellow}[retry] ${status || "transient"} error, retrying in ${(waitMs / 1000).toFixed(1)}s (${attempt}/${maxAttempts})${C.reset}`,
});

export const capabilities = Object.freeze({
  images: false,
  sessionResume: false,
  toolAttachment: "function",
  mcpToolDeadline: MCP_TOOL_DEADLINE_MODES.IN_PROCESS,
});

export function getCredentialEnvVars() {
  return ["ANTHROPIC_API_KEY"];
}

export function hasCredentials() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults(PROVIDER_NAME).cheap.model,
    thinking: false,
    label: "$ CHEAP",
    color: "dim",
    effort: "low",
  },
  standard: {
    model: getProviderTierDefaults(PROVIDER_NAME).standard.model,
    thinking: false,
    label: "STANDARD",
    color: "cyan",
    effort: "medium",
  },
  strong: {
    model: getProviderTierDefaults(PROVIDER_NAME).strong.model,
    thinking: false,
    label: "STRONG",
    color: "magenta",
    effort: "high",
  },
};

function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function getModelOverride() {
  return readModelSetting("anthropic_model") || null;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`anthropic_model_${key}`) || base.model,
  };
}

function getMaxTurns(role, modelTier = "standard", complexity = null, filesToModifyCount = null, deepthink = false) {
  return getMaxTurnsForProvider(PROVIDER_NAME, { role, modelTier, complexity, filesToModifyCount, deepthink });
}

export function getClaudeInfo() {
  return { cmd: "anthropic-messages-api", args: [] };
}

export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

function supportsEffort(modelName) {
  const model = String(modelName || "").trim().toLowerCase();
  return /^claude-(?:fable|mythos)-5(?:-|$)/u.test(model)
    || /^claude-opus-(?:5(?:-|$)|4-(?:5|6|7|8)(?:-|$))/u.test(model)
    || /^claude-sonnet-(?:5(?:-|$)|4-(?:6|7|8)(?:-|$))/u.test(model);
}

export function __testSupportsAnthropicEffort(modelName) {
  return supportsEffort(modelName);
}

function toAnthropicTools(definitions = []) {
  return definitions.map((definition) => {
    const tool = definition?.function || definition || {};
    return {
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.parameters || tool.input_schema || {
        type: "object",
        properties: {},
      },
    };
  }).filter((tool) => tool.name);
}

export function __testToAnthropicTools(definitions = []) {
  return toAnthropicTools(definitions);
}

const {
  getToolsForRole,
  executeTool,
  safePath: sharedSafePath,
  buildScopePredicates: sharedBuildScopePredicates,
  deterministicInspectFile,
  deterministicResizeImage,
} = createOpenAiCompatibleTooling({ buildImageTool: () => TOOL_GENERATE_IMAGE });

function responseText(response) {
  return (Array.isArray(response?.content) ? response.content : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function responseToolUses(response) {
  return (Array.isArray(response?.content) ? response.content : [])
    .filter((block) => block?.type === "tool_use");
}

function toolResultBlock(toolUseId, content, { isError = false } = {}) {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: String(content ?? ""),
    ...(isError ? { is_error: true } : {}),
  };
}

function agentToolAliases(tools) {
  const used = new Set(), names = new Map();
  for (const tool of tools) {
    const name = String(tool?.name || "");
    const safe = name.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
    let alias = safe.slice(0, 64), suffix = 2;
    while (used.has(alias)) {
      const end = `_${suffix++}`;
      alias = safe.slice(0, 64 - end.length) + end;
    }
    used.add(alias);
    names.set(name, alias);
  }
  return names;
}

function replaceAgentToolNames(value, names) {
  const originals = [...names.keys()].filter(name => name !== names.get(name));
  if (!originals.length) return String(value || "");
  const pattern = new RegExp(originals
    .sort((left, right) => right.length - left.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"), "g");
  return String(value || "").replace(pattern, name => names.get(name));
}

/** One native tool decision for a Posse user agent; the agent runtime executes it. */
export async function callAgentTurn(promptText, {
  modelName = null, systemPrompt = null, tools = [], promptCache = false,
  maxOutputTokens = 2048, signal = null,
} = {}) {
  const client = getClient();
  const modelToUse = selectExecutionModel({
    jobModelName: modelName,
    globalModelOverride: getModelOverride(),
    tierModel: getModelTierConfig("standard").model,
  });
  const aliases = agentToolAliases(tools);
  const originals = new Map([...aliases].map(([original, alias]) => [alias, original]));
  const issuedTools = toAnthropicTools(tools.map(tool => ({
    ...tool,
    name: aliases.get(tool.name),
    description: replaceAgentToolNames(tool.description, aliases),
  })));
  const outputTokenLimit = normalizeMaxOutputTokens(maxOutputTokens) || 2048;
  const request = {
    model: modelToUse,
    max_tokens: outputTokenLimit,
    messages: [{ role: "user", content: String(promptText || "") }],
    ...(systemPrompt ? { system: replaceAgentToolNames(systemPrompt, aliases) } : {}),
    ...(promptCache ? { cache_control: { type: "ephemeral" } } : {}),
    ...(issuedTools.length ? {
      tools: issuedTools,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    } : {}),
    ...(supportsEffort(modelToUse) ? { output_config: { effort: "medium" } } : {}),
  };
  const startedAt = Date.now();
  const response = await createAbortableMessagesCaller({
    client, providerLabel: PROVIDER_LABEL, externalSignal: signal,
    withRetry, stallMs: resolveProviderStallTimeout() * 1000,
  })(request, "agent turn");
  const limitReason = responseOutputLimitReason(response);
  if (limitReason) throw buildOutputLimitError(PROVIDER_LABEL, "agent turn", limitReason, outputTokenLimit);
  const uses = responseToolUses(response);
  if (uses.length > 1) {
    throw Object.assign(new Error("Anthropic returned more than one agent tool call"), { code: "agent_protocol_error" });
  }
  const normalized = normalizeProviderUsage(PROVIDER_NAME, response?.usage);
  const use = uses[0];
  return {
    output: responseText(response),
    ...(use ? { toolCall: { name: originals.get(use.name) || use.name, arguments: use.input } } : {}),
    stats: {
      modelName: response?.model || modelToUse,
      durationMs: Date.now() - startedAt,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheCreationInputTokens: normalized.cacheCreationInputTokens,
    },
  };
}

export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  allowWrite = false,
  allowTests = true,
  projectDbWrite = false,
  projectDbCapability = "none",
  scopedFiles = null,
  createFiles = null,
  createRoots = null,
  readRoots = null,
  deleteFiles = null,
  stableContext = null,
  remoteSystemPrompt = null,
  modelTier = "standard",
  modelName = null,
  reasoningEffort = "medium",
  activity = "",
  silent = false,
  maxTurns = null,
  maxOutputTokens = null,
  promptCache = false,
  complexity = null,
  filesToModifyCount = null,
  deepthink = false,
  jobDir = null,
  onLine = null,
  cwd = null,
  abortSignal = null,
  stallTimeout = null,
  fallbackReads = null,
  assessorMaxToolCalls = null,
  needsImageGeneration = false,
  skipRolePrompt = false,
  recyclingMode = "fresh",
  recordFinalPrompt = null,
  onUsageSegment = null,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  atlasPrefetchStatus = null,
  disableAtlas = false,
  atlasConfig = null,
  _remoteIssuedPolicy = null,
  _subAgentChild = false,
  mcpGate = null,
} = {}) {
  if (isCircuitOpen()) {
    const err = new Error("Anthropic circuit breaker open - rate-limited, falling back");
    err.circuitBreaker = true;
    throw err;
  }

  const client = getClient();
  const tierConfig = getModelTierConfig(modelTier);
  const modelToUse = selectExecutionModel({
    jobModelName: modelName,
    globalModelOverride: getModelOverride(),
    tierModel: tierConfig.model,
  });
  const effort = reasoningEffort || tierConfig.effort || "medium";
  const turnLimit = maxTurns || getMaxTurns(role, modelTier, complexity, filesToModifyCount, deepthink);
  const outputTokenLimit = normalizeMaxOutputTokens(maxOutputTokens)
    || getMaxOutputTokensForProvider(PROVIDER_NAME, { role });
  const workingDir = cwd || process.cwd();
  const assignmentUnit = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const atlasAttachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: PROVIDER_NAME, reason: "artifact route" })
    : resolveAtlasExecutionAttachment({
      role,
      providerName: PROVIDER_NAME,
      cwd: workingDir,
      assignmentUnit,
      workItemId,
      config: atlasConfig || undefined,
    });
  const executionAtlasConfig = withAtlasExecutionPolicySnapshot(atlasConfig, atlasAttachment);
  const atlasMethodForStats = disableAtlas ? null : (atlasAttachment?.method || "baseline");
  logAtlasAttachment({
    attachment: atlasAttachment,
    jobId,
    workItemId,
    providerName: PROVIDER_NAME,
    role,
  });
  if (atlasAttachment.failClosed) {
    const err = new Error(
      `ATLAS required mode blocks ${role} on ${PROVIDER_NAME} (${atlasAttachment.requiredFailureReason || "unavailable"}).`,
    );
    err.code = "ATLAS_REQUIRED_BLOCKED";
    err.atlas = atlasAttachment;
    throw err;
  }

  const atlasToolGateEnabled = resolveAtlasToolGateEnabled();
  const remoteAssessorPrompt = (!skipRolePrompt && !remoteSystemPrompt)
    ? await composeRemoteAssessorPromptForProvider(promptText, {
      role,
      providerName: PROVIDER_NAME,
      workingDir,
      activity,
      scopedFiles,
      atlasAttachment,
      atlasConfig,
    })
    : null;
  if (remoteAssessorPrompt) {
    promptText = remoteAssessorPrompt.promptText;
    stableContext = remoteAssessorPrompt.stableContext || stableContext;
    remoteSystemPrompt = remoteAssessorPrompt.remoteSystemPrompt || remoteSystemPrompt;
    skipRolePrompt = true;
    const narrowed = narrowProviderOptionsToRemoteIssuance({
      role,
      allowWrite,
      allowTests,
      projectDbWrite,
      projectDbCapability,
      needsImageGeneration,
      disableAtlas,
      fallbackReads,
      sessionPacket: remoteAssessorPrompt.packet,
    });
    allowWrite = narrowed.allowWrite;
    allowTests = narrowed.allowTests;
    projectDbWrite = narrowed.projectDbWrite;
    projectDbCapability = narrowed.projectDbCapability;
    needsImageGeneration = narrowed.needsImageGeneration;
    disableAtlas = narrowed.disableAtlas;
    fallbackReads = narrowed.fallbackReads;
    _remoteIssuedPolicy = narrowed._remoteIssuedPolicy || null;
  }

  const executionRole = _subAgentChild === true ? "subagent" : role;
  let executionContract = buildExecutionContract({
    provider: PROVIDER_NAME,
    role: executionRole,
    roleMode,
    allowWrite,
    allowTests,
    projectDbWrite,
    projectDbCapability,
    issuedToolSurface: issuedToolSurfaceForProviderPolicy(_remoteIssuedPolicy),
    agentHandoffCompactV1: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
    agentHandoffCompactV3: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
    researchInvestigation: _remoteIssuedPolicy?.coordination?.researchInvestigationV1 === true,
    atlasCodeWindowPolicy: atlasAttachment?.codeWindowPolicy || null,
    needsImageGeneration,
    scopedFiles,
    createFiles,
    createRoots,
    readRoots,
    deleteFiles,
    fallbackReads,
    platform: process.platform,
    projectDir: workingDir,
  });
  executionContract = appendExecutionTools(executionContract, atlasAttachment.tools);
  const openAiTools = getToolsForRole(executionContract);
  executionContract = projectFunctionToolSurface(executionContract, openAiTools);
  const tools = toAnthropicTools(openAiTools);
  const contractBlock = renderExecutionContractBlock(executionContract, {
    remoteComposed: skipRolePrompt,
  });
  const omitSessionPreamble = recyclingMode === "resume";
  const remoteSystemPromptText = omitSessionPreamble ? null : (String(remoteSystemPrompt || "").trim() || null);
  const systemPrompt = [
    remoteSystemPromptText,
    omitSessionPreamble ? null : contractBlock,
    omitSessionPreamble ? null : stableContext,
  ].filter(Boolean).join("\n\n") || null;
  const directOutput = !onLine && !silent;

  const declaredScope = {
    modifyFiles: scopedFiles || [],
    createFiles: createFiles || [],
    deleteFiles: deleteFiles || [],
    createRoots: createRoots || [],
    readRoots: readRoots || [],
    projectDbWrite: !!projectDbWrite,
    projectDbCapability: _remoteIssuedPolicy
      ? projectDbCapability
      : (projectDbCapability !== "none"
          ? projectDbCapability
          : ((allowWrite || projectDbWrite) ? "write" : "read")),
  };
  const scopePredicates = sharedBuildScopePredicates(workingDir, declaredScope);

  const userText = [
    activity ? `ACTIVITY: ${activity}` : null,
    tools.length > 0 ? `MAX TOOL TURNS: ${turnLimit}` : null,
    `WORKING DIRECTORY: ${workingDir}`,
    jobDir ? `JOB DIR: ${jobDir}` : null,
    "",
    promptText,
  ].filter(Boolean).join("\n");
  const messages = [{ role: "user", content: userText }];

  if (typeof recordFinalPrompt === "function") {
    recordFinalPrompt(userText, { systemPrompt });
  }

  const color = roleBrandColor(role, C.cyan);
  const icon = roleBrandIcon(role);
  if (directOutput && role !== "assessor") {
    const tierLabel = ` ${C[tierConfig.color] || ""}[${tierConfig.label}]${C.reset}`;
    const modelLabel = ` ${C.dim}model:${modelToUse}${C.reset}`;
    const actLabel = activity ? `  ${C.dim}-- ${activity}${C.reset}` : "";
    console.log(`\n${color}+${"---".repeat(20)}+${C.reset}`);
    console.log(`${color}|${C.reset} [${icon}] ${color}${C.bold}${role.toUpperCase()}${C.reset}${tierLabel}${modelLabel} ${C.dim}(anthropic)${C.reset}${actLabel}`);
    console.log(`${color}+${"---".repeat(20)}+${C.reset}`);
  }

  const emit = (line) => {
    if (directOutput) process.stdout.write(`${color}|${C.reset} ${line}\n`);
    else if (onLine) onLine(line);
  };

  const start = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let maxSingleTurnInputTokens = 0;
  let turnCount = 0;
  let liveChannelTurnCount = 0;
  let readCount = 0;
  const maxReads = fallbackReads ?? DEFAULT_FALLBACK_READS;
  const assessorToolBudget = createAssessorToolLoopBudget({ role, maxToolCalls: assessorMaxToolCalls });
  let allText = "";
  const toolUses = [];
  let providerToolTurnIndex = 0;
  let latestResponseId = null;
  let outputTruncated = false;
  let outputLimitReason = null;
  let usageRequestOrdinal = 0;
  const responseDurations = new WeakMap();

  const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
  const baseStallSec = resolveProviderStallTimeout(stallTimeout);
  const stallMs = baseStallSec * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;
  const createMessage = createAbortableMessagesCaller({
    client,
    providerLabel: PROVIDER_LABEL,
    externalSignal: abortSignal,
    stallMs,
    baseStallSec,
    withRetry,
    emit,
  });
  const createMeasuredMessage = async (...args) => {
    const requestStartedAt = Date.now();
    const response = await createMessage(...args);
    if (response && typeof response === "object") {
      responseDurations.set(response, Date.now() - requestStartedAt);
    }
    return response;
  };

  const addUsage = (usage, response = null) => {
    if (!usage) return;
    const normalized = normalizeProviderUsage(PROVIDER_NAME, usage);
    const inputTokens = normalized.inputTokens ?? 0;
    totalInputTokens += inputTokens;
    totalOutputTokens += normalized.outputTokens ?? 0;
    totalCachedInputTokens += normalized.cachedInputTokens ?? 0;
    totalCacheCreationInputTokens += normalized.cacheCreationInputTokens ?? 0;
    maxSingleTurnInputTokens = Math.max(maxSingleTurnInputTokens, inputTokens);
    try {
      onUsageSegment?.({
        requestOrdinal: ++usageRequestOrdinal,
        provider: PROVIDER_NAME,
        modelName: modelToUse,
        inputTokens,
        cachedInputTokens: normalized.cachedInputTokens ?? 0,
        cacheCreationInputTokens: normalized.cacheCreationInputTokens ?? 0,
        outputTokens: normalized.outputTokens ?? 0,
        requestContextInputTokens: inputTokens,
        durationMs: response ? responseDurations.get(response) ?? null : null,
        usageSource: "live",
        precision: "exact",
      });
    } catch { /* accounting persistence cannot break provider execution */ }
  };

  const throwIfOutputLimited = (response, phase) => {
    const reason = responseOutputLimitReason(response);
    if (!reason) return;
    outputTruncated = true;
    outputLimitReason = reason;
    throw buildOutputLimitError(PROVIDER_LABEL, phase, reason, outputTokenLimit);
  };

  const requestFor = (conversation, { includeTools = true } = {}) => ({
    model: modelToUse,
    max_tokens: outputTokenLimit,
    messages: conversation,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(promptCache ? { cache_control: { type: "ephemeral" } } : {}),
    ...(includeTools && tools.length > 0 ? { tools } : {}),
    ...(supportsEffort(modelToUse) ? { output_config: { effort } } : {}),
  });

  const gateScopeKey = configureGate({
    role,
    atlasAvailable: !disableAtlas && !!atlasAttachment?.active,
    enabled: atlasToolGateEnabled,
    scopeKey: buildAtlasGateScopeKey({ jobId, attemptId, agentCallId }),
  });
  const normalizedAtlasPrefetchStatus = String(atlasPrefetchStatus || "").trim().toLowerCase();
  if (atlasAttachment?.active && isFallbackAtlasPrefetchStatus(normalizedAtlasPrefetchStatus)) {
    unlockForAtlasUnavailable({ reason: `prefetch_${normalizedAtlasPrefetchStatus}`, scopeKey: gateScopeKey });
  }

  try {
    emit(`${C.dim}calling ${modelToUse}...${C.reset}`);
    let response = await createMeasuredMessage(requestFor(messages), "initial call");
    latestResponseId = response.id || latestResponseId;
    addUsage(response.usage, response);

    while (true) {
      if (abortSignal?.aborted) {
        emit(`${C.red}[aborted] Signal received, stopping.${C.reset}`);
        throw signalAbortError(abortSignal, "Anthropic provider aborted");
      }

      const turnText = responseText(response);
      if (turnText) allText += (allText ? "\n" : "") + turnText;
      throwIfOutputLimited(response, turnCount > 0 ? `turn ${turnCount}` : "initial call");

      const functionCalls = responseToolUses(response);
      if (functionCalls.length === 0) break;

      const countsAgainstTurnBudget = functionCalls.some((call) => !LIVE_CHANNEL_TOOL_NAMES.has(call.name));
      if (!countsAgainstTurnBudget) liveChannelTurnCount++;
      else liveChannelTurnCount = 0;

      const liveLimitReached = !countsAgainstTurnBudget && liveChannelTurnCount > LIVE_CHANNEL_TURN_LIMIT;
      const turnLimitReached = countsAgainstTurnBudget && turnCount >= turnLimit;
      if (liveLimitReached || turnLimitReached) {
        const limit = liveLimitReached ? LIVE_CHANNEL_TURN_LIMIT : turnLimit;
        const label = liveLimitReached ? "live-channel" : "tool turn";
        emit(`${C.yellow}[cap] Reached ${limit} ${label} limit - forcing final answer${C.reset}`);
        messages.push({ role: "assistant", content: response.content || [] });
        messages.push({
          role: "user",
          content: [
            ...functionCalls.map((call) => toolResultBlock(
              call.id,
              `(${label} limit reached - tool call skipped)`,
              { isError: true },
            )),
            { type: "text", text: "SYSTEM: Tool limit reached. Do not call more tools. Produce your final answer from the current state." },
          ],
        });
        await abortableThrottle(THROTTLE_MS, abortSignal);
        const finalResponse = await createMeasuredMessage(
          requestFor(messages, { includeTools: false }),
          "final answer",
        );
        latestResponseId = finalResponse.id || latestResponseId;
        addUsage(finalResponse.usage, finalResponse);
        const finalText = responseText(finalResponse);
        if (finalText) allText += (allText ? "\n" : "") + finalText;
        throwIfOutputLimited(finalResponse, "forced final answer");
        break;
      }

      if (countsAgainstTurnBudget) turnCount++;
      emit(
        `${C.dim}-- ${countsAgainstTurnBudget ? `turn ${turnCount}/${turnLimit}` : `live channel ${liveChannelTurnCount}/${LIVE_CHANNEL_TURN_LIMIT}`}: ` +
        `${functionCalls.length} tool call(s) --${C.reset}`,
      );

      const toolResults = [];
      const providerTurnIndex = ++providerToolTurnIndex;
      const providerTurnId = String(response.id || `anthropic-tool-turn-${providerTurnIndex}`);
      for (const [providerBatchIndex, call] of functionCalls.entries()) {
        const callInput = call.input && typeof call.input === "object" ? call.input : {};
        const argsText = JSON.stringify(callInput);
        const recordedToolUse = {
          id: call.id || null,
          tool: call.name,
          input: callInput,
          providerTurnId,
          providerTurnIndex,
          providerBatchIndex,
          providerBatchSize: functionCalls.length,
        };
        toolUses.push(recordedToolUse);

        const assessorCeiling = assessorToolBudget.evaluate(call.name);
        if (assessorCeiling) {
          emit(`${C.yellow}  [budget] ${call.name} denied - assessor tool-call ceiling ${assessorCeiling.cap} reached${C.reset}`);
          recordedToolUse.blockedReason = assessorCeiling.reason;
          recordedToolUse.status = "rejected";
          recordedToolUse.rejection = assessorCeiling.text;
          recordedToolUse.observation_detail = {
            assessment_budget_exhausted: true,
            assessment_budget_reason: assessorCeiling.reason,
            assessment_budget_used: assessorCeiling.used,
            assessment_budget_cap: assessorCeiling.cap,
            tool_name: call.name,
            transport: "embedded_provider",
          };
          toolResults.push(toolResultBlock(call.id, assessorCeiling.text, { isError: true }));
          continue;
        }

        let readAllowanceAdvisory = false;
        if (call.name === "read_file") {
          readCount++;
          if (readCount > maxReads) {
            emit(`${C.yellow}  [budget] read_file past allowance (${readCount}/${maxReads}) - executing with advisory${C.reset}`);
            readAllowanceAdvisory = true;
            recordedToolUse.observation_detail = {
              assessment_budget_advisory: true,
              assessment_budget_reason: "fallback_read_ceiling",
              assessment_budget_used: readCount,
              assessment_budget_cap: maxReads,
              tool_name: call.name,
              transport: "embedded_provider",
            };
          } else {
            emit(`${C.yellow}  [fallback read ${readCount}/${maxReads}]${C.reset}`);
          }
        }

        const toolStart = Date.now();
        const shortArgs = argsText.slice(0, 100);
        const displayToolName = formatAtlasToolUseDisplayName(call.name, callInput) || call.name;
        emit(`${C.dim}  [tool] ${displayToolName}(${shortArgs}${shortArgs.length >= 100 ? "..." : ""})${C.reset}`);
        const rawResult = await executeTool(
          call.name,
          argsText,
          workingDir,
          allowWrite,
          scopePredicates,
          executionAtlasConfig,
          gateScopeKey,
          declaredScope,
          executionContract,
          mcpGate,
          abortSignal,
        );
        const toolMs = Date.now() - toolStart;
        const result = typeof rawResult === "string" ? rawResult : String(rawResult ?? "");
        const truncated = truncateToolResultPreservingFeedback(result, 100000);
        recordedToolUse.resultChars = result.length;
        recordedToolUse.resultTruncated = truncated.length < result.length;
        const resultWithAdvisory = readAllowanceAdvisory
          ? `${truncated}\n\n${ASSESSOR_READ_ALLOWANCE_ADVISORY_TEXT}`
          : truncated;
        toolResults.push(toolResultBlock(call.id, resultWithAdvisory, {
          isError: /^Error:/i.test(resultWithAdvisory),
        }));
        emit(`${C.dim}  [done] ${displayToolName} (${toolMs}ms, ${result.length} chars)${C.reset}`);
      }

      messages.push({ role: "assistant", content: response.content || [] });
      messages.push({ role: "user", content: toolResults });
      await abortableThrottle(THROTTLE_MS, abortSignal);
      response = await createMeasuredMessage(requestFor(messages), `turn ${turnCount}`);
      latestResponseId = response.id || latestResponseId;
      addUsage(response.usage, response);
    }
    if (abortSignal?.aborted) throw signalAbortError(abortSignal, "Anthropic provider aborted");
  } catch (err) {
    const durationMs = Date.now() - start;
    emit(`${C.red}[error] Anthropic API call failed: ${err.message}${C.reset}`);
    const wrapped = new Error(`Anthropic API error: ${err.message}`);
    wrapped.cause = err;
    if (err?.code) wrapped.code = err.code;
    if (err?.status) wrapped.status = err.status;
    if (err?.headers) wrapped.headers = err.headers;
    if (err.outputTruncated) wrapped.outputTruncated = true;
    if (err.outputLimitReason) wrapped.outputLimitReason = err.outputLimitReason;
    if (err?.code === "ASYNC_GATE_BUSY" || err?.code === "ASYNC_GATE_TIMEOUT") wrapped.gateContention = true;
    wrapped.stats = {
      durationMs,
      outputChars: allText.length,
      promptChars: promptText.length,
      exitCode: 1,
      modelName: modelToUse,
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
      cachedInputTokens: totalCachedInputTokens || null,
      cacheCreationInputTokens: totalCacheCreationInputTokens || null,
      longContextInputTokens: maxSingleTurnInputTokens || null,
      role,
      modelTier,
      reasoningEffort: effort,
      maxTurns: turnLimit,
      maxOutputTokens: outputTokenLimit,
      outputTruncated: outputTruncated || err.outputTruncated === true,
      outputLimitReason: err.outputLimitReason || outputLimitReason || null,
      toolUses: toolUses.length > 0 ? toolUses : null,
      toolUsesLoggedByToolkit: true,
      atlasMethod: atlasMethodForStats,
    };
    wrapped.toolUses = toolUses.length > 0 ? toolUses : null;
    if (err.stallKill) wrapped.stallKill = true;
    if (err._killReason) wrapped._killReason = err._killReason;
    if (err.name === "AbortError" || err.aborted) {
      wrapped.name = "AbortError";
      wrapped.aborted = true;
    }
    throw wrapped;
  } finally {
    releaseGate({ scopeKey: gateScopeKey });
  }

  const durationMs = Date.now() - start;
  const elapsed = (durationMs / 1000).toFixed(1);
  const totalTokens = totalInputTokens + totalOutputTokens;
  emit(`${C.dim}completed: ${elapsed}s | ${turnCount} tool turn(s) | ${totalTokens} tokens${C.reset}`);

  return {
    output: allText.trim(),
    stats: {
      durationMs,
      outputChars: allText.length,
      promptChars: promptText.length,
      exitCode: 0,
      modelName: modelToUse,
      responseId: latestResponseId,
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
      cachedInputTokens: totalCachedInputTokens || null,
      cacheCreationInputTokens: totalCacheCreationInputTokens || null,
      longContextInputTokens: maxSingleTurnInputTokens || null,
      role,
      modelTier,
      reasoningEffort: effort,
      maxTurns: turnLimit,
      maxOutputTokens: outputTokenLimit,
      outputTruncated,
      outputLimitReason,
      numTurns: turnCount,
      toolUses: toolUses.length > 0 ? toolUses : null,
      toolUsesLoggedByToolkit: true,
      atlasMethod: atlasMethodForStats,
    },
  };
}

export function tripRateLimit(backoffSec) {
  _circuitBreaker.trip(backoffSec);
}

export function getRateLimitState() {
  if (!isCircuitOpen()) return { blocked: false, retryInSec: 0, reason: "" };
  const resetAt = _circuitBreaker.getResetAt();
  const remaining = Math.max(0, resetAt - Date.now());
  return { blocked: true, retryInSec: Math.ceil(remaining / 1000), reason: "circuit_breaker" };
}

export function parseErrorBackoff(err) {
  return classifyProviderError(err, {
    defaultBackoffSec: 15,
    circuitBreakerBackoffSec: () => getRateLimitState().retryInSec || 15,
  });
}

export const __testSafePath = sharedSafePath;
export const __testBuildScopePredicates = sharedBuildScopePredicates;
export const __testInspectFile = deterministicInspectFile;
export const __testResizeImage = deterministicResizeImage;
export const __testGetToolsForRole = getToolsForRole;
