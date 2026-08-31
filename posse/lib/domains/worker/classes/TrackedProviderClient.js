// lib/domains/worker/classes/TrackedProviderClient.js
//
// Tracked provider-call orchestration extracted from Worker. The Worker still
// owns lease and attempt lifecycle; this client owns model dispatch, call
// logging, prompt/output capture, observation wrapping, and provider fallback.

import crypto from "crypto";
import path from "path";
import { AGENT_HANDOFF_PROTOCOL } from "../../../catalog/handoff.js";
import {
  completeAgentCall,
  createAgentCall,
  getJob,
  getSetting,
  getWorkItem,
  logAgentActivity,
  setAttemptSession,
  updateJobProvider,
} from "../../queue/functions/index.js";
import {
  getAvailableProviders,
  getProvider,
  getProviderRateLimitState,
  selectProviderName,
} from "../../providers/functions/provider.js";
import { getDefaultTierModel } from "../../providers/functions/model-catalog.js";
import { resolveEffectiveTierModel } from "../../providers/functions/model-catalog-validate.js";
import { C } from "../../../shared/format/functions/colors.js";
import { filterProviderToolUseReplay, getObservationContext, recordObservation, recordProviderToolBatchObservations, recordToolUseObservations, runWithObservationContext } from "../../observability/functions/observations.js";
import { recordPrompt } from "../../../shared/telemetry/functions/logging/prompt-log.js";
import { recordOutput } from "../../../shared/telemetry/functions/logging/output-log.js";
import { resolveAtlasExecutionAttachment, withAtlasExecutionPolicySnapshot } from "../../integrations/functions/atlas.js";
import { provisionAgentLoader, provisionAgentLoaderAsync, provisionSessionLaneLoader, provisionSessionLaneLoaderAsync, assertLoaderClean, assertLoaderCleanAsync } from "../functions/helpers/agent-loader.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import {
  resolvePrimaryExecutionModelName,
  sanitizeExecutionHintsForRole,
} from "../../providers/functions/execution-routing.js";
import { getMaxOutputTokensForProvider } from "../../providers/functions/shared/turns.js";
import { selectFallbackProvider } from "../../providers/functions/delegation-routing.js";
import { buildResumeHandoff } from "../../handoff/functions/index.js";
import { bindAutoExpandedDevBriefEvidenceToAgentCall } from "../../handoff/functions/helpers/hash-ref-packet.js";
import { getReplayMemoryStats, recordRecoveryCheckpoint, retainReplayOutput, retainReplayPrompt, retainReplayToolUses } from "../../observability/functions/recovery/job-replay.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { isAbortError, signalAbortError } from "../../runtime/functions/yield.js";
import { recordMemorySample } from "../../../shared/telemetry/functions/memory.js";
import {
  getSessionManager,
  resolveSessionRecycleModeForWorkItem,
} from "../../session/functions/manager-singleton.js";
import { isRecyclableLane } from "../../session/functions/keys.js";
import {
  estimateTokensFromChars,
  resolveContextCompactionConfig,
} from "../../settings/functions/context-compaction.js";
import { ContextMeter } from "../../../shared/classes/ContextMeter.js";
import {
  issuedToolSurfaceForProviderPolicy,
  narrowProviderOptionsToRemoteIssuance,
} from "../../../shared/tools/functions/issued-tool-policy.js";
import { finalizeAgentHandoffForProvider } from "../../handoff/functions/agent-handoff.js";
import { agentHandoffTerminator } from "../../handoff/classes/AgentHandoffTerminator.js";
import {
  getAgentHandoffToolSchemaForRole,
} from "../../../catalog/native-tools.js";
import { toolSchemaTelemetry } from "../../../shared/tools/functions/tool-schema-telemetry.js";
import {
  resolveAtlasResearcherDispatcher,
  resolveAtlasResearcherSchemaDiet,
  resolveAtlasResearcherTypedDispatcher,
  resolveAtlasResearcherWorkflow,
} from "../../integrations/functions/deterministic-mcp/gate-settings.js";
import { AGENT_ACTIVITY_LIMITS } from "../../../catalog/event.js";
import {
  buildCitationChildPrompt,
  subAgentRuntime,
} from "../../sub-agent/classes/SubAgentRuntime.js";
import { McpServerConfig } from "../../../shared/tools/classes/McpServerConfig.js";
import { publishContextBudgetCheckpoint } from "../../billing/functions/context-budget.js";
import {
  markUsageSegmentsIncomplete,
  recordUsageSegment,
  summarizeUsageSegments,
} from "../../billing/functions/usage-segments.js";

function agentHandoffToolSchemaTelemetry(
  role,
  compactCompletion = false,
  compactV3 = false,
  compactV4 = false,
) {
  const schema = getAgentHandoffToolSchemaForRole(role, {
    compactCompletion,
    compactV3,
    compactV4,
  });
  return toolSchemaTelemetry(schema);
}

function sortedUniqueStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  )].sort();
}

function agentGateSurfaceFingerprint(options = {}, providerName = "") {
  const issued = options?._remoteIssuedPolicy;
  if (issued?.valid !== true) return "unissued";
  const researcherWorkflow = String(options?.role || "").trim().toLowerCase() === "researcher"
    && String(providerName || "").trim().toLowerCase() === "codex"
    && resolveAtlasResearcherWorkflow();
  const researcherTypedDispatcher = String(options?.role || "").trim().toLowerCase() === "researcher"
    && String(providerName || "").trim().toLowerCase() === "codex"
    && resolveAtlasResearcherTypedDispatcher();
  const researcherDispatcher = String(options?.role || "").trim().toLowerCase() === "researcher"
    && String(providerName || "").trim().toLowerCase() === "codex"
    && (resolveAtlasResearcherDispatcher() || researcherTypedDispatcher || researcherWorkflow);
  return crypto.createHash("sha256").update(JSON.stringify({
    tools: sortedUniqueStrings(issued.toolAllowlist?.tools),
    atlas: sortedUniqueStrings(issued.toolAllowlist?.atlas),
    projectDbCapability: String(issued.projectDbCapability || "none"),
    toolPolicy: {
      allowRead: issued.toolPolicy?.allow_read === true,
      allowWrite: issued.toolPolicy?.allow_write === true,
      allowShell: issued.toolPolicy?.allow_shell === true,
      allowTests: issued.toolPolicy?.allow_tests === true,
      fallbackReads: Number(issued.toolPolicy?.fallback_reads) || 0,
    },
    coordination: {
      agentHandoffV1: issued.coordination?.agentHandoffV1 === true,
      agentHandoffCompactV1: issued.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV2: issued.coordination?.agentHandoffCompactV2 === true,
      agentHandoffCompactV3: issued.coordination?.agentHandoffCompactV3 === true,
      subAgentV1: issued.coordination?.subAgentV1 === true,
      subAgentNextInputV1: issued.coordination?.subAgentNextInputV1 === true,
    },
    researcherSchemaDiet: String(options?.role || "").trim().toLowerCase() === "researcher"
      && resolveAtlasResearcherSchemaDiet(),
    ...(researcherDispatcher ? { researcherDispatcher: true } : {}),
    ...(researcherTypedDispatcher ? { researcherTypedDispatcher: true } : {}),
    ...(researcherWorkflow ? { researcherWorkflow: true } : {}),
  })).digest("hex");
}

function issuedAtlasAvailable(options = {}) {
  if (options?._subAgentChild === true) return false;
  const issued = options?._remoteIssuedPolicy;
  if (issued?.valid === true) return (issued.toolAllowlist?.atlas || []).length > 0;
  return options.disableAtlas !== true && options.atlasConfig?.enabled !== false;
}

export function sessionContractFingerprint(options = {}, providerName = "") {
  const effective = narrowProviderOptionsToRemoteIssuance(options);
  const coordination = effective?._remoteIssuedPolicy?.coordination || {};
  const researcherSchemaDiet = String(effective.role || "").trim().toLowerCase() === "researcher"
    && coordination.agentHandoffCompactV3 === true
    && resolveAtlasResearcherSchemaDiet();
  const researcherWorkflow = String(effective.role || "").trim().toLowerCase() === "researcher"
    && String(providerName || "").trim().toLowerCase() === "codex"
    && coordination.agentHandoffCompactV3 === true
    && resolveAtlasResearcherWorkflow();
  const researcherTypedDispatcher = String(effective.role || "").trim().toLowerCase() === "researcher"
    && String(providerName || "").trim().toLowerCase() === "codex"
    && coordination.agentHandoffCompactV3 === true
    && resolveAtlasResearcherTypedDispatcher();
  const researcherDispatcher = String(effective.role || "").trim().toLowerCase() === "researcher"
    && String(providerName || "").trim().toLowerCase() === "codex"
    && coordination.agentHandoffCompactV3 === true
    && (resolveAtlasResearcherDispatcher() || researcherTypedDispatcher || researcherWorkflow);
  const schema = agentHandoffToolSchemaTelemetry(
    effective.role,
    coordination.agentHandoffCompactV1 === true,
    coordination.agentHandoffCompactV3 === true,
    researcherSchemaDiet || researcherDispatcher,
  );
  const packet = effective.sessionPacket || {};
  const remoteSystemPrompt = String(effective.remoteSystemPrompt || "");
  const promptVersion = String(
    packet?.remote_prompt_metadata?.prompt_version
    || packet?.remote_prompt_response?.prompt_version
    || packet?.posse_remote?.metadata?.prompt_version
    || "",
  );
  return crypto.createHash("sha256").update(JSON.stringify({
    provider: String(providerName || "").trim().toLowerCase(),
    role: String(effective.role || "").trim().toLowerCase(),
    promptVersion,
    remoteSystemPromptSha256: remoteSystemPrompt
      ? crypto.createHash("sha256").update(remoteSystemPrompt).digest("hex")
      : "",
    agentHandoffSchemaSha256: schema.sha256,
    compactV1: coordination.agentHandoffCompactV1 === true,
    compactV2: coordination.agentHandoffCompactV2 === true,
    compactV3: coordination.agentHandoffCompactV3 === true,
    researcherSchemaDiet,
    ...(researcherDispatcher ? { researcherDispatcher: true } : {}),
    ...(researcherTypedDispatcher ? { researcherTypedDispatcher: true } : {}),
    ...(researcherWorkflow ? { researcherWorkflow: true } : {}),
    agentGateSurfaceSha256: agentGateSurfaceFingerprint(effective, providerName),
  })).digest("hex");
}

function terminalHandoffContractChars(options = {}) {
  const systemPrompt = String(options.remoteSystemPrompt || options.systemPrompt || "");
  const contract = systemPrompt
    .split(/\r?\n/)
    .find((line) => line.startsWith("EXPERIMENTAL TERMINAL HANDOFF CONTRACT:"));
  return contract?.length || 0;
}

const DEFAULT_PROVIDER_ERROR_PATTERNS = [
  /overloaded_error/i,
  /API Error:\s*5\d\d/i,
  /api_error.*internal server error/i,
  /rate.?limit|429|too many requests/i,
  /out of.*usage|usage.*reset|usage limit|usage cap|usage exhausted|over usage|quota exceeded|credit balance is too low|session limit|hit your.*limit/i,
  /configuration.*corrupted/i,
  /Failed to spawn claude/i,
  /claude exited null/i,
  /claude exited with unknown status/i,
  /claude exited via signal/i,
  /socket connection was closed unexpectedly/i,
  /^Codex CLI exited with code 1\s*$/i,
  /MCP_ATTACH_PROOF_MISSING|MCP_ATTACH_PROJECTION_MISMATCH|MCP attach proof missing|deterministic MCP attach proof missing|deterministic MCP projection mismatch/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,
  /connection error/i,
  /circuit breaker open/i,
];
const RUNTIME_MODEL_ERROR_PATTERNS = [
  /\b(?:model|deployment)\b[^\n]{0,160}\b(?:does\s+not\s+exist|unsupported|is\s+not\s+supported|not\s+supported|does\s+not\s+support)\b/i,
  /\b(?:unknown|unsupported|invalid)\s+model\b/i,
  /\bnot\s+supported\s+when\s+using\s+codex\b/i,
  /\b(?:do\s+not|don't|does\s+not)\s+have\s+access\b[^\n]{0,100}\bmodel\b/i,
];
const SLOW_PROVIDER_SETUP_PHASE_MS = 1000;
const SUB_AGENT_CALLER_ROLES = new Set(["researcher", "dev", "artificer"]);

function providerCallAbortedError(abortSignal, worker, jobId) {
  const err = signalAbortError(abortSignal, "Provider call aborted");
  const killReason = jobId != null ? worker?._killReasons?.get?.(jobId) : null;
  if (killReason) err._killReason = killReason;
  return err;
}

function terminalHandoffAbortReason(event = {}) {
  const error = new Error("Terminal agent_handoff receipt acknowledged; stopping provider generation");
  error.name = "AbortError";
  error.code = "POSSE_AGENT_HANDOFF_TERMINAL";
  error.agentCallId = event.agentCallId ?? null;
  error.digest = event.digest || null;
  return error;
}

function expectedCoordinationMode(options = {}) {
  return String(
    options._expectedAgentCoordinationMode
    || process.env.TASK_AB_EXPECT_COORDINATION_MODE
    || "",
  ).trim().toLowerCase();
}

function assertExpectedCoordination(options, { localHandoff, remoteHandoff } = {}) {
  const expected = expectedCoordinationMode(options);
  if (!expected) return;
  const coordinationChild = options?._subAgentChild === true;
  const role = String(options?._agentCallRole || options?.role || "").trim().toLowerCase();
  const effectiveExpected = coordinationChild && expected === "subagents" ? "handoff" : expected;
  const localSubAgent = options?.sessionPacket?.agent_coordination?.sub_agent_v1 === true;
  const remoteSubAgent = options?._remoteIssuedPolicy?.coordination?.subAgentV1 === true;
  const localChildCursor = options?.sessionPacket?.agent_coordination?.sub_agent_next_input_v1 === true;
  const remoteChildCursor = options?._remoteIssuedPolicy?.coordination?.subAgentNextInputV1 === true;
  const toolFreePreflight = role === "preflight";
  if (toolFreePreflight && (expected === "handoff" || expected === "subagents")) {
    if (!localHandoff && !remoteHandoff && !localSubAgent && !remoteSubAgent && !localChildCursor && !remoteChildCursor) {
      return;
    }
    const error = new Error(
      `Task A/B coordination preflight mismatch: tool-free preflight unexpectedly received coordination capabilities, `
      + `local_handoff=${localHandoff} remote_handoff=${remoteHandoff} `
      + `local_subagent=${localSubAgent} remote_subagent=${remoteSubAgent} `
      + `local_child_cursor=${localChildCursor} remote_child_cursor=${remoteChildCursor}`,
    );
    error.code = "TASK_AB_COORDINATION_PREFLIGHT_FAILED";
    throw error;
  }
  const handoffExpected = effectiveExpected === "handoff" || effectiveExpected === "subagents";
  const subAgentExpected = effectiveExpected === "subagents"
    && SUB_AGENT_CALLER_ROLES.has(role)
    && options?.sessionPacket?.job_type !== "fix";
  const childCursorExpected = coordinationChild && expected === "subagents";
  if (!["off", "handoff", "subagents"].includes(expected)
    || localHandoff !== handoffExpected
    || remoteHandoff !== handoffExpected
    || localSubAgent !== subAgentExpected
    || remoteSubAgent !== subAgentExpected
    || (childCursorExpected && (!localChildCursor || !remoteChildCursor))) {
    const error = new Error(
      `Task A/B coordination preflight mismatch: expected ${expected || "<invalid>"}`
      + `${coordinationChild ? " (citation child: handoff-only)" : ""}, `
      + `local_handoff=${localHandoff} remote_handoff=${remoteHandoff} `
      + `local_subagent=${localSubAgent} remote_subagent=${remoteSubAgent} `
      + `local_child_cursor=${localChildCursor} remote_child_cursor=${remoteChildCursor}`,
    );
    error.code = "TASK_AB_COORDINATION_PREFLIGHT_FAILED";
    throw error;
  }
}

async function timeProviderSetupPhase(label, meta, fn, { warnMs = SLOW_PROVIDER_SETUP_PHASE_MS } = {}) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= warnMs) {
      log.warn("worker", "Provider setup phase was slow", {
        label,
        durationMs,
        role: meta?.role ?? null,
        provider: meta?.provider ?? null,
        job_id: meta?.job_id ?? null,
        work_item_id: meta?.work_item_id ?? null,
      });
    }
  }
}

function defaultIsProviderError(err) {
  const msg = err?.message || "";
  return DEFAULT_PROVIDER_ERROR_PATTERNS.some((re) => re.test(msg));
}

function errorSearchText(err) {
  // Model-rejection errors surface in the error message or on stderr. Never
  // scan stdout/output: CLI providers attach the failed run's full agent
  // transcript there, and agent prose that merely mentions "unknown model"
  // must not trigger a silent model fallback.
  return [
    err?.message,
    err?.stderr,
    err?.stats?.stderr,
  ].filter(Boolean).join("\n");
}

function isRuntimeModelError(err) {
  const text = errorSearchText(err);
  return RUNTIME_MODEL_ERROR_PATTERNS.some((re) => re.test(text));
}

function normalizeModelName(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveCatalogSafeTierModel(providerName, tier, candidate) {
  const providerKey = String(providerName || "").trim().toLowerCase();
  const tierKey = String(tier || "standard").trim().toLowerCase();
  const selected = String(candidate || "").trim();
  if (!selected) return selected || null;
  return resolveEffectiveTierModel(providerKey, tierKey, selected).model || selected || null;
}

function resolveProviderExecutionModelName(provider, modelName, options = {}) {
  if (!modelName || typeof provider?.resolveExecutionModelName !== "function") return modelName || null;
  const resolved = String(provider.resolveExecutionModelName(modelName, options) || "").trim();
  return resolved || modelName;
}

function resolveRuntimeModelFallback(providerName, tier, attemptedModel) {
  const providerKey = String(providerName || "").trim().toLowerCase();
  const tierKey = String(tier || "standard").trim().toLowerCase();
  const fallback = getDefaultTierModel(providerKey, tierKey);
  const effectiveFallback = resolveEffectiveTierModel(providerKey, tierKey, fallback).model || fallback || null;
  if (!effectiveFallback) return null;
  if (normalizeModelName(effectiveFallback) === normalizeModelName(attemptedModel)) return null;
  return effectiveFallback;
}

function defaultResolveCallCostEstimate(stats) {
  const candidates = [
    stats?.costUsd,
    stats?.cost_usd,
    stats?.estimatedCostUsd,
    stats?.totalCostUsd,
    stats?.total_cost_usd,
  ];
  for (const value of candidates) {
    if (value == null || String(value).trim() === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function positiveIntegerOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

// Production defaults are captured at module import time. Tests should pass
// explicit deps into TrackedProviderClient instead of monkey-patching modules.
const DEFAULT_DEPS = {
  completeAgentCall,
  createAgentCall,
  getJob,
  getSetting,
  getWorkItem,
  logAgentActivity,
  updateJobProvider,
  setAttemptSession,
  getAvailableProviders,
  getProvider,
  getProviderRateLimitState,
  selectProviderName,
  filterProviderToolUseReplay,
  getObservationContext,
  recordObservation,
  recordProviderToolBatchObservations,
  recordToolUseObservations,
  runWithObservationContext,
  recordPrompt,
  recordOutput,
  resolveAtlasExecutionAttachment,
  provisionAgentLoader,
  provisionAgentLoaderAsync,
  provisionSessionLaneLoader,
  provisionSessionLaneLoaderAsync,
  assertLoaderClean,
  assertLoaderCleanAsync,
  resolvePrimaryExecutionModelName,
  sanitizeExecutionHintsForRole,
  selectFallbackProvider,
  recordRecoveryCheckpoint,
  retainReplayOutput,
  retainReplayPrompt,
  retainReplayToolUses,
  agentHandoffTerminator,
  finalizeAgentHandoffForProvider,
  publishContextBudgetCheckpoint,
  markUsageSegmentsIncomplete,
  recordUsageSegment,
  summarizeUsageSegments,
};

function nonNegativeTokenCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function providerUsageStatus(stats, { measured, unavailable } = {}) {
  if (unavailable) return "unavailable_after_terminal_stop";
  if (!measured) return "unavailable";
  return stats.tokenUsageSource === "codex_rollout"
    ? "measured_codex_rollout"
    : "measured";
}

function buildAccountingStats(stats, {
  inputTokens,
  outputTokens,
  outputChars,
  durationMs = stats.durationMs,
  exitCode,
  providerUsageStatus: usageStatus,
  providerName,
  modelTier,
  modelName,
  resolvedMaxOutputTokens,
  outputTruncated = stats.outputTruncated === true,
  outputLimitReason = stats.outputLimitReason || null,
  providerStopCode = null,
} = {}) {
  const measured = inputTokens != null && outputTokens != null;
  return {
    ...stats,
    inputTokens,
    outputTokens,
    cachedInputTokens: measured ? (stats.cachedInputTokens ?? null) : null,
    cacheCreationInputTokens: measured ? (stats.cacheCreationInputTokens ?? null) : null,
    reasoningOutputTokens: measured ? (stats.reasoningOutputTokens ?? null) : null,
    outputChars,
    durationMs,
    exitCode,
    providerUsageStatus: usageStatus,
    ...(providerStopCode ? { providerStopCode } : {}),
    provider: providerName,
    modelTier,
    modelName: stats.modelName || modelName,
    maxOutputTokens: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
    outputTruncated,
    outputLimitReason,
  };
}

function completionAccountingFields({
  stats,
  accountingStats,
  segmentSummary,
  providerUsageMeasured,
  providerUsageStatus: usageStatus,
  resolvedMaxTurns,
  resolvedMaxOutputTokens,
  opts,
  resolveCallCostEstimate,
} = {}) {
  const aggregateEstimateAvailable = providerUsageMeasured
    && segmentSummary.precision === "aggregate_only";
  return {
    input_tokens: accountingStats.inputTokens,
    output_tokens: accountingStats.outputTokens,
    reasoning_output_tokens: accountingStats.reasoningOutputTokens,
    cached_input_tokens: accountingStats.cachedInputTokens,
    cache_creation_input_tokens: accountingStats.cacheCreationInputTokens,
    turns_used: stats.numTurns ?? null,
    max_turns_configured: stats.maxTurns ?? resolvedMaxTurns,
    max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
    output_truncated: accountingStats.outputTruncated,
    output_limit_reason: accountingStats.outputLimitReason,
    duration_ms: accountingStats.durationMs,
    exit_code: accountingStats.exitCode,
    atlas_method: opts.disableAtlas ? null : (stats.atlasMethod || opts.atlasMethod || null),
    atlas_prefetch_status: opts.disableAtlas ? null : (opts.atlasPrefetchStatus || null),
    cost_estimate_usd: segmentSummary.exact
      ? segmentSummary.costUsd
      : aggregateEstimateAvailable
        ? resolveCallCostEstimate(accountingStats)
        : null,
    provider_usage_status: usageStatus,
    billing_precision: segmentSummary.precision,
    exact_billable_input_tokens: segmentSummary.exact ? segmentSummary.billableInputTokens : null,
    long_context_tier_input_tokens: segmentSummary.longContextTierInputTokens,
    provider_request_duration_ms: segmentSummary.durationMs,
    usage_segment_count: segmentSummary.requestCount,
    skills: opts.skillsAttached || null,
    session_handle: stats.sessionHandle || stats.responseId || null,
  };
}

function agentCommentaryFields(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const summary = text.slice(0, AGENT_ACTIVITY_LIMITS.SUMMARY_CHARS).trim();
  const detail = text.length > summary.length
    ? text.slice(
        summary.length,
        summary.length + AGENT_ACTIVITY_LIMITS.DETAIL_CHARS,
      ).trim()
    : null;
  return { text, summary, detail: detail || null };
}

function contextPressureMetrics({ stats = {}, promptChars = 0 } = {}) {
  const inputTokens = nonNegativeTokenCount(stats.inputTokens);
  const outputTokens = nonNegativeTokenCount(stats.outputTokens);
  const cachedInputTokens = nonNegativeTokenCount(stats.cachedInputTokens) || 0;
  const cacheCreationInputTokens = nonNegativeTokenCount(stats.cacheCreationInputTokens) || 0;
  const promptEstimateTokens = estimateTokensFromChars(promptChars);
  const observedInputTokens = inputTokens ?? promptEstimateTokens;
  const uncachedInputTokensApprox = Math.max(0, observedInputTokens - cachedInputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    promptEstimateTokens,
    observedInputTokens,
    observedInputTokensEstimated: inputTokens == null,
    uncachedInputTokensApprox,
    cachedInputRatio: observedInputTokens > 0 ? cachedInputTokens / observedInputTokens : null,
  };
}

function codexReuseContractAllowsScope(opts = {}) {
  const root = path.resolve(opts.cwd || opts.projectDir || process.cwd());
  const scopedPaths = [
    ...(Array.isArray(opts.scopedFiles) ? opts.scopedFiles : []),
    ...(Array.isArray(opts.createFiles) ? opts.createFiles : []),
    ...(Array.isArray(opts.createRoots) ? opts.createRoots : []),
    ...(Array.isArray(opts.deleteFiles) ? opts.deleteFiles : []),
  ];
  for (const entry of scopedPaths) {
    if (!entry) continue;
    const target = path.isAbsolute(String(entry))
      ? path.resolve(String(entry))
      : path.resolve(root, String(entry));
    if (!isInsideRoot(target, root)) return false;
  }
  return true;
}

function isSessionReuseCandidate({ providerName, opts, job_id, work_item_id }) {
  const provider = String(providerName || "").toLowerCase();
  if (!provider) return false;
  if (opts?._subAgentChild === true) return false;
  // Provider self-declares session-resume support via the capabilities flag
  // on its module. Replaces a hardcoded ["openai","claude","codex"] whitelist
  // so a new provider that supports resume just sets capabilities.sessionResume.
  let supportsResume = false;
  try {
    const providerInstance = getProvider(null, provider);
    supportsResume = !!providerInstance?.hasCapability?.("sessionResume");
  } catch {
    supportsResume = false;
  }
  if (!supportsResume) return false;
  if (job_id == null || work_item_id == null) return false;
  if (opts?._fallbackAttempted) return false;
  if (provider === "codex" && !codexReuseContractAllowsScope(opts)) return false;
  return isRecyclableLane(opts?.role);
}

function normalizeAttemptedProviders(value) {
  const raw = value instanceof Set
    ? [...value]
    : Array.isArray(value)
      ? value
      : [];
  return new Set(raw.map((name) => String(name || "").trim()).filter(Boolean));
}

function recordAttemptedProvider(attemptedProviders, providerName) {
  if (!providerName) return attemptedProviders;
  attemptedProviders.add(String(providerName));
  return attemptedProviders;
}

function providerAgentIdentity(opts = {}, {
  providerName,
  role,
  workItemId,
  agentCallId,
} = {}) {
  const decision = opts?._sessionRecycle?.decision || null;
  const laneId = decision?.lane?.id || decision?.session?.lane_id || null;
  const lane = String(decision?.key?.lane || role || "agent").trim().toLowerCase();
  const skillKey = String(decision?.key?.skillKey || "");
  const agentHandoff = (issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy) || [])
    .includes("tools.agent_handoff");
  const subAgent = (issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy) || [])
    .includes("tools.sub_agent");
  const coordinationChild = opts._subAgentChild === true;
  const coordinationKey = coordinationChild ? "child" : (subAgent ? "subagents" : (agentHandoff ? "handoff" : "off"));
  const surfaceFingerprint = agentGateSurfaceFingerprint(opts);
  const surfaceKey = surfaceFingerprint === "unissued" ? surfaceFingerprint : surfaceFingerprint.slice(0, 16);
  const atlasAvailable = issuedAtlasAvailable(opts);
  const remoteToolSurface = coordinationChild
    ? opts._coordinationChildRemoteToolSurface
    : opts._remoteToolSurface;
  if (laneId != null) {
    return {
      key: `session-lane:${laneId}:${lane}:coord-${coordinationKey}:surface-${surfaceKey}`,
      logicalKey: `wi:${workItemId ?? "none"}:${lane}:${skillKey}`,
      reusable: true,
      agentHandoff,
      subAgent,
      coordinationChild,
      atlasAvailable,
      ...(coordinationChild && opts._coordinationChildPermitId
        ? { coordinationChildPermitId: opts._coordinationChildPermitId }
        : {}),
      ...(remoteToolSurface
        ? { remoteToolSurface }
        : {}),
    };
  }
  return {
    key: `agent-call:${agentCallId}:${lane}`,
    logicalKey: `agent-call:${agentCallId}:${lane}`,
    reusable: false,
    agentHandoff,
    subAgent,
    coordinationChild,
    atlasAvailable,
    ...(coordinationChild && opts._coordinationChildPermitId
      ? { coordinationChildPermitId: opts._coordinationChildPermitId }
      : {}),
    ...(remoteToolSurface
      ? { remoteToolSurface }
      : {}),
  };
}

function agentJobAttachment(opts = {}, context = {}) {
  const atlasConfig = opts.atlasConfig && typeof opts.atlasConfig === "object"
    ? opts.atlasConfig
    : {};
  const agentHandoff = (issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy) || [])
    .includes("tools.agent_handoff");
  const subAgent = (issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy) || [])
    .includes("tools.sub_agent");
  const issuedToolAllowlist = opts?._remoteIssuedPolicy?.valid === true
    && opts._remoteIssuedPolicy?.toolAllowlist
    && typeof opts._remoteIssuedPolicy.toolAllowlist === "object"
    ? opts._remoteIssuedPolicy.toolAllowlist
    : null;
  return {
    role: opts.role,
    agentCallRole: opts._agentCallRole || null,
    providerName: context.providerName,
    cwd: opts.mcpCwd || opts.cwd || context.cwd || context.projectDir || process.cwd(),
    jobId: context.jobId ?? opts.jobId ?? null,
    workItemId: context.workItemId ?? opts.workItemId ?? null,
    attemptId: context.attemptId ?? opts.attemptId ?? null,
    agentCallId: context.agentCallId ?? opts.agentCallId ?? null,
    promptChars: opts.promptChars || 0,
    modelName: context.modelName || opts.modelName || null,
    providerSessionId: `agent-call:${context.agentCallId ?? opts.agentCallId ?? "unknown"}`,
    allowWrite: opts.allowWrite === true,
    allowShell: opts.allowShell !== false,
    allowTests: opts.allowTests !== false,
    projectDbWrite: opts.projectDbWrite === true,
    projectDbCapability: opts.projectDbCapability || (opts.projectDbWrite === true ? "write" : "none"),
    allowImageHelpers: opts.allowImageHelpers !== false,
    allowImageGeneration: opts.needsImageGeneration === true,
    agentHandoff,
    subAgent,
    ...(issuedToolAllowlist ? { toolAllowlist: issuedToolAllowlist } : {}),
    coordinationChild: opts._subAgentChild === true,
    atlasAvailable: issuedToolAllowlist
      ? issuedToolAllowlist.atlas.length > 0
      : opts.disableAtlas !== true && atlasConfig.enabled !== false,
    atlasGateEnabled: opts.atlasGateEnabled !== false,
    atlasPrefetchStatus: opts.atlasPrefetchStatus || "",
    atlas: {
      repoPath: atlasConfig.requestedRepoPath || atlasConfig.repoPath || "",
      repoId: atlasConfig.requestedRepoId || atlasConfig.repoId || "",
      graphDbPath: atlasConfig.requestedGraphDbPath || atlasConfig.graphDbPath || "",
      ledgerDbPath: atlasConfig.atlasV2LedgerDbPath || atlasConfig.ledgerDbPath || "",
      storageRepoPath: atlasConfig.storageRepoPath || "",
      liveBuffers: atlasConfig.liveBuffersEnabled === false ? "off" : "deterministic-writes",
      viewWaitMs: atlasConfig.viewWaitMs ?? null,
      jobCacheEnabled: atlasConfig.jobCacheEnabled === true,
      jobCacheTtlMs: atlasConfig.jobCacheTtlMs ?? null,
      autoRefreshStale: atlasConfig.autoRefreshStale ?? null,
      codeWindowPolicy: atlasConfig.codeWindowPolicy
        ? { ...atlasConfig.codeWindowPolicy }
        : null,
    },
    disableSystemTools: opts.disableSystemTools === true,
  };
}

function childOnlyRemoteIssuance(parentOptions = {}, { providerName, role } = {}) {
  const source = parentOptions?.sessionPacket?.remote_issuance
    || parentOptions?._remoteToolSurface
    || {};
  const sourceTools = Array.isArray(source.tools) ? source.tools : [];
  const childTools = Array.isArray(source.child_tools) ? source.child_tools : [];
  const issuedChildCursorTools = childTools.filter((entry) => {
    const name = String(entry?.name || entry?.local_name || entry || "");
    return name === "tools.sub_agent_next_input" || name === "sub_agent_next_input";
  });
  const childCursorIssued = issuedChildCursorTools.length > 0;
  return {
    ...source,
    source: "posse-remote",
    role,
    provider: providerName,
    tools: [...sourceTools.filter((entry) => {
      const name = String(entry?.name || entry?.local_name || entry || "");
      return name === "tools.agent_handoff" || name === "agent_handoff";
    }), ...issuedChildCursorTools],
    child_tools: [],
    tool_surface: [
      ...(childCursorIssued ? ["tools.sub_agent_next_input"] : []),
      "tools.agent_handoff",
    ],
    tool_policy: {
      allow_read: false,
      allow_write: false,
      allow_shell: false,
      allow_tests: false,
      fallback_reads: 0,
    },
    web_access: {
      role,
      mode: "none",
      general_discovery: false,
      live_documentation_verification: false,
      asset_sourcing_or_fetching: false,
      network_access: false,
      image_generation_eligible: false,
    },
    project_db_capability: "none",
    atlas: { available: false, agent_surface: [], internal_surface: [] },
    coordination: {
      agent_handoff_v1: true,
      agent_handoff_compact_v1: source?.coordination?.agent_handoff_compact_v1 === true,
      agent_handoff_compact_v2: source?.coordination?.agent_handoff_compact_v2 === true,
      agent_handoff_compact_v3: source?.coordination?.agent_handoff_compact_v3 === true,
      sub_agent_v1: false,
      sub_agent_next_input_v1: childCursorIssued,
      status: "experimental",
    },
  };
}

function combinedAbortSignal(...signals) {
  const active = signals.filter((signal) => signal && typeof signal.addEventListener === "function");
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export class TrackedProviderClient {
  constructor({
    worker,
    isProviderError = defaultIsProviderError,
    isProviderCircuitOpen = null,
    emit = null,
    resolveCallCostEstimate = defaultResolveCallCostEstimate,
    deps = {},
  } = {}) {
    if (!worker) throw new Error("TrackedProviderClient requires a worker");
    this.worker = worker;
    this.isProviderError = isProviderError;
    this.isProviderCircuitOpen = isProviderCircuitOpen || ((providerName) => (
      typeof worker._isProviderCircuitOpen === "function"
        ? worker._isProviderCircuitOpen(providerName)
        : false
    ));
    this.emit = emit || (typeof worker.emit === "function" ? worker.emit.bind(worker) : () => {});
    this.resolveCallCostEstimate = resolveCallCostEstimate;
    // A substituted agent-call store owns its accounting side tables too.
    // Keep test/in-memory adapters isolated unless they explicitly provide
    // the new segment/checkpoint hooks alongside createAgentCall.
    const isolatedAccountingDeps = Object.prototype.hasOwnProperty.call(deps, "createAgentCall")
      ? {
          recordUsageSegment: () => null,
          markUsageSegmentsIncomplete: () => {},
          publishContextBudgetCheckpoint: () => null,
          summarizeUsageSegments: (agentCallId) => ({
            agentCallId: Number(agentCallId),
            requestCount: 0,
            exact: false,
            precision: "aggregate_only",
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            longContextTierInputTokens: 0,
            durationMs: 0,
            billableInputTokens: null,
            costUsd: null,
          }),
        }
      : {};
    this.deps = { ...DEFAULT_DEPS, ...isolatedAccountingDeps, ...deps };
    if (Object.prototype.hasOwnProperty.call(deps, "provisionAgentLoader")
      && !Object.prototype.hasOwnProperty.call(deps, "provisionAgentLoaderAsync")) {
      this.deps.provisionAgentLoaderAsync = null;
    }
    if (Object.prototype.hasOwnProperty.call(deps, "provisionSessionLaneLoader")
      && !Object.prototype.hasOwnProperty.call(deps, "provisionSessionLaneLoaderAsync")) {
      this.deps.provisionSessionLaneLoaderAsync = null;
    }
    if (Object.prototype.hasOwnProperty.call(deps, "assertLoaderClean")
      && !Object.prototype.hasOwnProperty.call(deps, "assertLoaderCleanAsync")) {
      this.deps.assertLoaderCleanAsync = null;
    }
    this.call = this.call.bind(this);
    this.trackedCall = this.trackedCall.bind(this);
  }

  async trackedCall(prompt, opts, meta = {}) {
    return await this.call(prompt, opts, meta);
  }

  _resolveProviderAccounting({
    agentCallId,
    providerName,
    modelTier,
    modelName,
    stats,
    terminalUsageUnavailable = false,
    missingUsagePrecision = "unknown",
  }) {
    const providerUsageMeasured = !terminalUsageUnavailable
      && stats.inputTokens != null
      && stats.outputTokens != null;
    const captureIncomplete = terminalUsageUnavailable
      || stats.usageCapturePrecision === "incomplete"
      || (!providerUsageMeasured && missingUsagePrecision === "incomplete");
    const usageStatus = providerUsageStatus(stats, {
      measured: providerUsageMeasured,
      unavailable: terminalUsageUnavailable,
    });
    if (captureIncomplete) this.deps.markUsageSegmentsIncomplete(agentCallId);
    const expectedTotals = providerUsageMeasured ? {
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cachedInputTokens: stats.cachedInputTokens,
      cacheCreationInputTokens: stats.cacheCreationInputTokens,
    } : null;
    let segmentSummary = this.deps.summarizeUsageSegments(agentCallId, {
      modelTier,
      expectedTotals,
    });
    if (!providerUsageMeasured && segmentSummary.requestCount === 0) {
      segmentSummary = {
        ...segmentSummary,
        exact: false,
        precision: captureIncomplete ? "incomplete" : missingUsagePrecision,
        costUsd: null,
        billableInputTokens: null,
      };
    }
    if (providerUsageMeasured && segmentSummary.requestCount === 0) {
      this.deps.recordUsageSegment({
        agentCallId,
        requestOrdinal: 1,
        provider: providerName,
        modelName: stats.modelName || modelName,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cachedInputTokens: stats.cachedInputTokens,
        cacheCreationInputTokens: stats.cacheCreationInputTokens,
        requestContextInputTokens: stats.longContextInputTokens ?? stats.inputTokens,
        durationMs: stats.durationMs,
        usageSource: "aggregate_only",
        precision: captureIncomplete ? "incomplete" : "aggregate_only",
      });
      segmentSummary = this.deps.summarizeUsageSegments(agentCallId, {
        modelTier,
        expectedTotals,
      });
    }
    if (captureIncomplete && !segmentSummary.exact) {
      segmentSummary = {
        ...segmentSummary,
        precision: "incomplete",
        costUsd: null,
        billableInputTokens: null,
      };
    }
    return {
      providerUsageMeasured,
      providerUsageStatus: usageStatus,
      segmentSummary,
      accountingInputTokens: providerUsageMeasured ? stats.inputTokens : null,
      accountingOutputTokens: providerUsageMeasured ? stats.outputTokens : null,
    };
  }

  _isProviderCircuitOpen(providerName) {
    return this.isProviderCircuitOpen(providerName);
  }

  emitStatus(jobId, message) {
    this.emit(jobId, message);
  }

  _selectFallbackCandidate({
    configuredPool = [],
    currentProvider = null,
    attemptedProviders = new Set(),
    needsImageGeneration = false,
    selectFallbackProvider,
    getProviderRateLimitState,
  } = {}) {
    const current = String(currentProvider || "");
    const fallbackPool = configuredPool.filter((name) => {
      const provider = String(name || "");
      if (!provider) return false;
      if (attemptedProviders.has(provider) && provider !== current) return false;
      if (provider !== current && this._isProviderCircuitOpen(provider)) return false;
      if (provider !== current) {
        try {
          if (getProviderRateLimitState(provider)?.blocked) return false;
        } catch {
          // If the provider does not expose backoff state, keep previous best-effort behavior.
        }
      }
      return true;
    });
    const fallbackName = selectFallbackProvider(fallbackPool, currentProvider, needsImageGeneration);
    if (!fallbackName || fallbackName === currentProvider) return null;
    if (attemptedProviders.has(String(fallbackName))) return null;
    if (this._isProviderCircuitOpen(fallbackName)) return null;
    try {
      if (getProviderRateLimitState(fallbackName)?.blocked) return null;
    } catch {
      // Best-effort only; provider call will surface any real failure.
    }
    return fallbackName;
  }

  _releaseSessionDecision(decision) {
    if (!decision?.session?.id || !decision.session?.leaseToken) return;
    try {
      const manager = getSessionManager();
      manager.releaseSession(decision.session.id, decision.session.leaseToken);
    } catch {
      // Lease TTL recovery is the durable fallback.
    }
  }

  _recordSessionRecycleDecision({
    job_id,
    work_item_id,
    attempt_id,
    providerName,
    role,
    recycleMode,
    decision,
  } = {}) {
    try {
      const mode = decision?.recyclingMode || "fresh";
      const reason = decision?.reason || (mode === "resume" ? "resumed" : "unknown");
      const deniedSkills = Array.isArray(decision?.skillPolicy?.deniedSkills)
        ? decision.skillPolicy.deniedSkills
        : [];
      recordObservation({
        work_item_id: work_item_id ?? null,
        job_id: job_id ?? null,
        attempt_id: attempt_id ?? null,
        observation_type: "session.recycle_decision",
        summary: mode === "resume"
          ? `session recycle: resume (role=${role || "?"} provider=${providerName || "?"})`
          : `session recycle: fresh (${reason}${deniedSkills.length ? `: ${deniedSkills.join(",")}` : ""}) role=${role || "?"} provider=${providerName || "?"}`,
        detail: {
          mode,
          reason,
          recycle_mode_setting: recycleMode || null,
          provider: providerName || null,
          role: role || null,
          lane_id: decision?.lane?.id ?? null,
          session_id: decision?.session?.id ?? null,
          ...(decision?.coverage?.missingRoles?.length ? { missing_roles: decision.coverage.missingRoles } : {}),
          ...(deniedSkills.length ? { denied_skills: deniedSkills } : {}),
        },
      });
    } catch { /* observability only — never block the call path */ }
  }

  _recordContextPressureTelemetry({
    agentCallId,
    work_item_id,
    job_id,
    attempt_id,
    providerName,
    role,
    modelTier,
    modelName,
    promptChars,
    stats,
    status,
    opts,
  } = {}) {
    try {
      const config = resolveContextCompactionConfig({
        readSetting: this.deps.getSetting,
        readWorkItem: this.deps.getWorkItem,
        workItemId: work_item_id,
      });
      if (config.mode === "off") return;
      const metrics = contextPressureMetrics({ stats, promptChars });
      const meterSnapshot = ContextMeter.forContext(
        { agent_call_id: agentCallId },
        { promptChars },
      )?.snapshot() || null;
      const sessionRecycle = opts?._sessionRecycle || null;
      const recycleDecision = sessionRecycle?.decision || null;
      const baseDetail = {
        mode: config.mode,
        provider: providerName || null,
        role: role || null,
        model_tier: modelTier || null,
        model_name: modelName || null,
        status: status || null,
        agent_call_id: agentCallId ?? null,
        prompt_chars: promptChars ?? null,
        prompt_estimate_tokens: metrics.promptEstimateTokens,
        input_tokens: metrics.inputTokens,
        output_tokens: metrics.outputTokens,
        cached_input_tokens: metrics.cachedInputTokens,
        cache_creation_input_tokens: metrics.cacheCreationInputTokens,
        observed_input_tokens: metrics.observedInputTokens,
        observed_input_tokens_estimated: metrics.observedInputTokensEstimated,
        uncached_input_tokens_approx: metrics.uncachedInputTokensApprox,
        cached_input_ratio: metrics.cachedInputRatio,
        context_meter: meterSnapshot ? {
          ...meterSnapshot,
          observed_input_tokens: metrics.observedInputTokens,
          estimate_delta_tokens: meterSnapshot.estimate_tokens - metrics.observedInputTokens,
        } : null,
        thresholds: {
          pressure_input_tokens: config.triggerInputTokens,
          session_reset_input_tokens: config.sessionResetInputTokens,
          recent_target_tokens: config.recentTargetTokens,
        },
        config_source: config.source || null,
        session: sessionRecycle ? {
          recycling_mode: opts?.recyclingMode || recycleDecision?.recyclingMode || null,
          lane_id: recycleDecision?.lane?.id ?? null,
          session_id: recycleDecision?.session?.id ?? null,
          hop_count: recycleDecision?.session?.hop_count ?? null,
          full_prompt_estimate_tokens: sessionRecycle.fullPromptEstimateTokens ?? null,
          resume_prompt_estimate_tokens: sessionRecycle.resumePromptEstimateTokens ?? null,
        } : null,
      };

      if (metrics.observedInputTokens >= config.triggerInputTokens) {
        this.deps.recordObservation?.({
          work_item_id: work_item_id ?? null,
          job_id: job_id ?? null,
          attempt_id: attempt_id ?? null,
          observation_type: "context.pressure.observed",
          summary: `Context pressure observed: ${metrics.observedInputTokens} input token(s) (${providerName || "unknown provider"})`,
          detail: baseDetail,
        });
      }

      if (opts?.recyclingMode === "resume" && metrics.observedInputTokens >= config.sessionResetInputTokens) {
        this.deps.recordObservation?.({
          work_item_id: work_item_id ?? null,
          job_id: job_id ?? null,
          attempt_id: attempt_id ?? null,
          observation_type: "context.session.would_reset",
          summary: `Resumed session would reset after ${metrics.observedInputTokens} input token(s)`,
          detail: {
            ...baseDetail,
            reset_reason: "context_compaction_session_reset_threshold",
            estimate_method: metrics.observedInputTokensEstimated ? "prompt_chars_div4" : "provider_usage_input_tokens",
          },
        });
      }
    } catch { /* context telemetry must never affect provider calls */ }
  }

  _prepareSessionReuse(prompt, opts, {
    providerName,
    job_id,
    work_item_id,
    attempt_id = null,
  } = {}) {
    if (!isSessionReuseCandidate({ providerName, opts, job_id, work_item_id })) {
      return { prompt, opts, decision: null };
    }

    const job = this.deps.getJob?.(job_id);
    if (!job) return { prompt, opts, decision: null };

    const recycleMode = resolveSessionRecycleModeForWorkItem(job.work_item_id);
    const manager = getSessionManager({ recycleMode });
    const contractFingerprint = sessionContractFingerprint(opts, providerName);
    const decision = manager.acquireForJob(job, {
      provider: providerName,
      jobId: job_id,
      contractFingerprint,
    });
    // The decision and its reason are otherwise invisible: a session_recycle
    // setting that never engages (skill gate, coverage gap) looks identical
    // to one that was never read. One observation per acquire makes it
    // diagnosable from the run logs.
    this._recordSessionRecycleDecision({
      job_id,
      work_item_id,
      attempt_id,
      providerName,
      role: opts.role,
      recycleMode,
      decision,
    });

    const freshLineageReasons = new Set(["no_available_session", "transition_reset", "contract_changed"]);
    if (decision?.recyclingMode !== "resume" && !freshLineageReasons.has(decision?.reason)) {
      return { prompt, opts, decision: null };
    }

    if (decision?.provider && decision.provider !== String(providerName || "").toLowerCase()) {
      this._releaseSessionDecision(decision);
      return { prompt, opts, decision: null };
    }

    const sessionMeta = {
      manager,
      decision,
      jobId: job_id,
      workItemId: work_item_id,
      attemptId: attempt_id,
      providerName,
      role: opts.role,
      fullPromptEstimateTokens: estimateTokensFromChars(prompt),
      contractFingerprint,
    };

    if (decision?.session?.id && attempt_id != null) {
      this.deps.setAttemptSession?.(attempt_id, {
        sessionId: decision.session.id,
        leaseToken: decision.session.leaseToken,
        hopCount: decision.session.hop_count,
      });
    }

    if (decision.recyclingMode !== "resume") {
      return {
        prompt,
        opts: {
          ...opts,
          recyclingMode: "fresh",
          _sessionRecycle: sessionMeta,
        },
        decision,
      };
    }

    const resumePrompt = buildResumeHandoff({
      packet: opts.sessionPacket || null,
      instructions: opts.sessionInstructions || prompt,
      priorSession: decision.session,
      role: opts.role,
    });

    return {
      prompt: resumePrompt,
      opts: {
        ...opts,
        stableContext: null,
        remoteSystemPrompt: null,
        skipRolePrompt: true,
        priorSessionHandle: decision.sessionHandle,
        recyclingMode: "resume",
        _sessionRecycle: {
          ...sessionMeta,
          resumePromptEstimateTokens: estimateTokensFromChars(resumePrompt),
        },
      },
      decision,
    };
  }

  async _executeOneAttempt(prompt, opts, {
    providerName,
    provider,
    tier,
    modelName,
    work_item_id,
    job_id,
    cwd,
    observationContext,
    abortSignal,
  }) {
    const {
      completeAgentCall,
      createAgentCall,
      filterProviderToolUseReplay,
      recordOutput,
      recordPrompt,
      recordRecoveryCheckpoint,
      logAgentActivity,
      recordProviderToolBatchObservations,
      recordToolUseObservations,
      retainReplayOutput,
      retainReplayPrompt,
      retainReplayToolUses,
      runWithObservationContext,
    } = this.deps;
    const effectiveCapabilityOpts = narrowProviderOptionsToRemoteIssuance(opts);
    const localHandoffCapability = effectiveCapabilityOpts?.sessionPacket?.agent_coordination?.agent_handoff_v1 === true;
    const remoteHandoffCapability = effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.agentHandoffV1 === true;
    assertExpectedCoordination(effectiveCapabilityOpts, {
      localHandoff: localHandoffCapability,
      remoteHandoff: remoteHandoffCapability,
    });
    const resolvedMaxTurns = positiveIntegerOrNull(opts.maxTurns);
    const resolvedMaxOutputTokens = positiveIntegerOrNull(opts.maxOutputTokens)
      || getMaxOutputTokensForProvider(providerName, { role: opts.role });
    const call = await timeProviderSetupPhase("provider.agent_call_create", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => createAgentCall({
      work_item_id,
      job_id,
      attempt_id: observationContext?.attempt_id ?? null,
      role: opts._agentCallRole || opts.role,
      model_tier: tier,
      model_name: modelName,
      activity: opts.activity,
      prompt_chars: prompt.length,
      max_turns_configured: resolvedMaxTurns,
      max_output_tokens_configured: resolvedMaxOutputTokens,
      reasoning_effort: opts.reasoningEffort || "medium",
      provider: providerName,
      atlas_method: opts.disableAtlas ? null : (opts.atlasMethod || null),
      atlas_prefetch_status: opts.disableAtlas ? null : (opts.atlasPrefetchStatus || null),
      skills: opts.skillsAttached || null,
      prior_session_handle: opts.priorSessionHandle || null,
    }));
    const agentCallId = call.id;
    if (agentCallId == null) {
      throw new Error("createAgentCall must return an object with an id");
    }
    ContextMeter.forContext({ agent_call_id: agentCallId }, { promptChars: prompt.length });
    const callObservationContext = {
      ...(observationContext || {}),
      work_item_id: work_item_id ?? observationContext?.work_item_id ?? null,
      job_id: job_id ?? observationContext?.job_id ?? null,
      agent_call_id: agentCallId,
    };
    try {
      bindAutoExpandedDevBriefEvidenceToAgentCall(effectiveCapabilityOpts?.sessionPacket, {
        context: callObservationContext,
        deliveredPrompt: prompt,
      });
    } catch {
      // Planner evidence acceleration is optional. A bookkeeping failure must
      // not prevent the provider call; normal exact-source tools remain usable.
    }
    recordRecoveryCheckpoint?.({
      work_item_id,
      job_id,
      attempt_id: observationContext?.attempt_id ?? null,
      agent_call_id: agentCallId,
      phase: "agent_call_created",
      reason: "provider_attempt_started",
      status: "running",
      extra: {
        role: opts.role,
        provider: providerName,
        model_tier: tier,
        model_name: modelName,
        activity: opts.activity,
        prompt_chars: prompt.length,
        max_turns_configured: resolvedMaxTurns,
        max_output_tokens_configured: resolvedMaxOutputTokens,
      },
    });
    const handoffRequired = remoteHandoffCapability && localHandoffCapability;
    const handoffToolSchema = agentHandoffToolSchemaTelemetry(
      opts.role,
      effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
      effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
      String(opts.role || "").trim().toLowerCase() === "researcher"
        && effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true
        && (resolveAtlasResearcherSchemaDiet()
          || (providerName === "codex"
            && (resolveAtlasResearcherDispatcher()
              || resolveAtlasResearcherTypedDispatcher()
              || resolveAtlasResearcherWorkflow()))),
    );
    const terminalAbortController = handoffRequired ? new AbortController() : null;
    const providerAbortSignal = combinedAbortSignal(abortSignal, terminalAbortController?.signal);
    let terminalHandoffStop = null;
    let terminalProviderError = null;
    let terminalAbortIssuedAt = null;
    let providerReturnedAt = null;
    const unregisterAgentHandoffTerminal = handoffRequired
      ? this.deps.agentHandoffTerminator.subscribe(agentCallId, (event) => {
          if (terminalHandoffStop) return;
          terminalHandoffStop = {
            ...event,
            acknowledgedAt: Number(event?.acknowledgedAt) || Date.now(),
          };
          terminalAbortIssuedAt = Date.now();
          terminalAbortController.abort(terminalHandoffAbortReason(event));
        })
      : null;
    const upstreamAgentCommentary = typeof effectiveCapabilityOpts.onAgentCommentary === "function"
      ? effectiveCapabilityOpts.onAgentCommentary
      : null;
    const upstreamUsageProgress = typeof effectiveCapabilityOpts.onUsageProgress === "function"
      ? effectiveCapabilityOpts.onUsageProgress
      : null;
    const seenAgentCommentary = new Set();
    const attemptOpts = {
      ...effectiveCapabilityOpts,
      maxOutputTokens: resolvedMaxOutputTokens,
      attemptId: observationContext?.attempt_id ?? opts.attemptId ?? null,
      agentCallId,
      promptChars: prompt.length,
      abortSignal: providerAbortSignal,
      onUsageSegment: (segment) => {
        const persisted = this.deps.recordUsageSegment({
          ...segment,
          agentCallId,
          provider: segment?.provider || providerName,
          modelName: segment?.modelName || modelName,
        });
        const attemptId = observationContext?.attempt_id ?? opts.attemptId ?? null;
        if (attemptId != null && persisted?.request_ordinal != null) {
          this.deps.publishContextBudgetCheckpoint({
            agentCallId,
            attemptId,
            providerSessionId: `agent-call:${agentCallId}`,
            sequenceId: persisted.request_ordinal,
            provider: persisted.provider,
            modelName: persisted.model_name,
            requestContextInputTokens: persisted.request_context_input_tokens,
            outputTokensSinceRequest: persisted.output_tokens,
            precision: persisted.precision,
          });
        }
      },
      onUsageProgress: (progress) => {
        try { upstreamUsageProgress?.(progress); } catch { /* caller telemetry is best effort */ }
        const precision = String(progress?.precision || "").trim();
        const sequenceId = positiveIntegerOrNull(progress?.sequenceId ?? progress?.sequence_id);
        const attemptId = observationContext?.attempt_id ?? opts.attemptId ?? null;
        const requestContextInputTokens = nonNegativeTokenCount(
          progress?.requestContextInputTokens ?? progress?.request_context_input_tokens,
        );
        if (
          !["exact", "recovered_exact"].includes(precision)
          || sequenceId == null
          || attemptId == null
          || requestContextInputTokens == null
        ) {
          if (process.env.POSSE_DEBUG_CTX_CHECKPOINT) {
            console.error(`[ctx-debug] progress SKIP precision=${precision} seq=${sequenceId} attempt=${attemptId} reqCtx=${requestContextInputTokens}`);
          }
          return;
        }
        try {
          if (process.env.POSSE_DEBUG_CTX_CHECKPOINT) {
            console.error(`[ctx-debug] publish checkpoint call=${agentCallId} seq=${sequenceId} reqCtx=${requestContextInputTokens}`);
          }
          this.deps.publishContextBudgetCheckpoint({
            agentCallId,
            attemptId,
            providerSessionId: `agent-call:${agentCallId}`,
            sequenceId,
            provider: progress?.provider || providerName,
            modelName: progress?.modelName || progress?.model_name || modelName,
            requestContextInputTokens,
            outputTokensSinceRequest: nonNegativeTokenCount(
              progress?.outputTokensSinceRequest ?? progress?.output_tokens_since_request,
            ) ?? 0,
            precision,
          });
        } catch (checkpointErr) {
          /* a live checkpoint must not interrupt provider execution */
          if (process.env.POSSE_DEBUG_CTX_CHECKPOINT) {
            console.error(`[ctx-debug] publish FAILED: ${checkpointErr?.message || checkpointErr}`);
          }
        }
      },
      onAgentCommentary: (value) => {
        try { upstreamAgentCommentary?.(value); } catch { /* caller telemetry is best effort */ }
        const commentary = agentCommentaryFields(value);
        if (!commentary || seenAgentCommentary.has(commentary.text)) return;
        seenAgentCommentary.add(commentary.text);
        try {
          logAgentActivity({
            work_item_id,
            job_id,
            attempt_id: observationContext?.attempt_id ?? null,
            role: opts.role,
            actor_id: String(agentCallId),
            kind: "progress",
            status: "running",
            phase: "commentary",
            summary: commentary.summary,
            detail: commentary.detail,
            agent_call_id: agentCallId,
            provider: providerName,
            model: modelName,
          });
        } catch {
          // Commentary is observational; persistence failure must not fail work.
        }
      },
      recordFinalPrompt: (finalPrompt, { systemPrompt = null, systemPromptFiles = null } = {}) => {
        const promptText = typeof finalPrompt === "string" ? finalPrompt : String(finalPrompt ?? "");
        retainReplayPrompt?.(agentCallId, {
          prompt: promptText,
          systemPrompt,
          systemPromptFiles,
          meta: {
            work_item_id,
            job_id,
            attempt_id: observationContext?.attempt_id ?? null,
            role: opts.role,
            provider: providerName,
            model: modelName,
            activity: opts.activity,
            model_tier: tier,
          },
        });
        // Existing injected/test recorders may be void-returning; only an
        // explicit false from the real recorder means both local sinks failed.
        const promptMetadataPersisted = recordPrompt({
          agent_call_id: agentCallId,
          job_id,
          work_item_id,
          role: opts.role,
          provider: providerName,
          model: modelName,
          attempt: opts.attemptCount || 1,
          activity: opts.activity,
          reasoningEffort: opts.reasoningEffort || "medium",
          modelTier: tier,
          prompt: promptText,
          systemPrompt,
          systemPromptFiles,
        }) !== false;
        if (!promptMetadataPersisted) {
          log.warn("worker", "Prompt metadata could not be persisted locally", {
            workItemId: work_item_id,
            jobId: job_id,
            agentCallId,
            role: opts.role,
            provider: providerName,
          });
        }
        recordRecoveryCheckpoint?.({
          work_item_id,
          job_id,
          attempt_id: observationContext?.attempt_id ?? null,
          agent_call_id: agentCallId,
          phase: "prompt_captured",
          reason: "final_prompt_recorded",
          status: "running",
          extra: {
            prompt_chars: promptText.length,
            system_prompt_chars: typeof systemPrompt === "string" ? systemPrompt.length : null,
            prompt_body_storage: "remote_owned",
            prompt_metadata_persisted: promptMetadataPersisted,
          },
        });
      },
    };

    const dispatcher = this.worker?.agentDispatcher;
    const preparedAgent = effectiveCapabilityOpts?._preparedAgent || null;
    const identity = preparedAgent
      ? {
          key: preparedAgent.key,
          logicalKey: preparedAgent.key,
          reusable: true,
          agentHandoff: preparedAgent.mcpGate?.contractBootConfig?.agentHandoff === true,
          subAgent: preparedAgent.mcpGate?.contractBootConfig?.subAgent === true,
          coordinationChild: false,
        }
      : providerAgentIdentity(effectiveCapabilityOpts, {
          providerName,
          role: opts.role,
          workItemId: work_item_id,
          agentCallId,
          modelName,
        });
    let agent = null;
    let agentLease = null;
    let retainReusableAgent = false;
    let unregisterSubAgentParent = null;
    let unregisterSubAgentChild = null;
    const agentCallStartedAt = Date.now();

    try {
      if (effectiveCapabilityOpts?._subAgentCursor) {
        unregisterSubAgentChild = subAgentRuntime.bindChild({
          agentCallId,
          batchId: effectiveCapabilityOpts._subAgentCursor.batchId,
          dispatchId: effectiveCapabilityOpts._subAgentCursor.dispatchId,
        });
      }
      if (!dispatcher || typeof dispatcher.dispatch !== "function") {
        const error = new Error("Provider dispatch requires an AgentDispatcher with MCP gate minting");
        error.code = "POSSE_AGENT_DISPATCHER_REQUIRED";
        throw error;
      }
      const attachment = agentJobAttachment(attemptOpts, {
          providerName,
          cwd,
          projectDir: this.worker.projectDir,
          jobId: job_id,
          workItemId: work_item_id,
          attemptId: observationContext?.attempt_id ?? null,
          agentCallId,
          modelName,
        });
      const dispatched = preparedAgent
        ? await dispatcher.dispatchAgent({
            agent: preparedAgent,
            signal: abortSignal,
            attachment,
          })
        : await dispatcher.dispatch({
            ...identity,
            role: opts.role,
            providerName,
            handoffRequest: effectiveCapabilityOpts?.sessionPacket || prompt,
            signal: abortSignal,
            attachment,
          });
      agent = dispatched.agent;
      agentLease = dispatched.lease;
      Object.defineProperties(attemptOpts, {
        agent: {
          value: agent,
          enumerable: false,
          configurable: false,
          writable: false,
        },
        mcpGate: {
          value: agent.mcpGate,
          enumerable: false,
          configurable: false,
          writable: false,
        },
      });
      const subAgentEnabled = effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.subAgentV1 === true
        && effectiveCapabilityOpts?.sessionPacket?.agent_coordination?.sub_agent_v1 === true
        && opts._subAgentChild !== true;
      if (subAgentEnabled) {
        unregisterSubAgentParent = subAgentRuntime.registerParent({
          agentCallId,
          authorizedToolSurface: effectiveCapabilityOpts?._remoteToolSurface?.tools
            || effectiveCapabilityOpts?.sessionPacket?.remote_issuance?.tools
            || [],
          executeInput: async ({ tool, arguments: inputArguments, signal }) => (
            await agent.mcpGate.callToolResult(tool, inputArguments, {
              signal,
              delegatedEvidence: true,
            })
          ),
          runChild: async ({ batchId, dispatchId, intent, manifest, maxInputs, signal, requestId }) => {
            const childRole = String(opts.role || "researcher");
            const childIssuance = childOnlyRemoteIssuance(effectiveCapabilityOpts, {
              providerName,
              role: childRole,
            });
            const childPermitId = `${batchId}:${dispatchId}:${requestId}`;
            const childGateSurface = McpServerConfig.issueCitationChildRemoteSurface(agent.mcpGate, {
              permitId: childPermitId,
              role: childRole,
              providerName,
            });
            const childSessionPacket = {
              remote_prompt_composed: true,
              remote_issuance: childIssuance,
              remote_tool_surface: childIssuance.tool_surface.slice(),
              agent_coordination: {
                mode: "handoff",
                agent_handoff_v1: true,
                agent_handoff_compact_v1: childIssuance.coordination.agent_handoff_compact_v1 === true,
                agent_handoff_compact_v2: childIssuance.coordination.agent_handoff_compact_v2 === true,
                agent_handoff_compact_v3: childIssuance.coordination.agent_handoff_compact_v3 === true,
                sub_agent_v1: false,
                sub_agent_next_input_v1: childIssuance.coordination.sub_agent_next_input_v1 === true,
                remote_acknowledged: true,
              },
            };
            const childSignal = combinedAbortSignal(abortSignal, signal);
            return await this.call(
              buildCitationChildPrompt({ intent, manifest, maxInputs }),
              {
                role: childRole,
                modelTier: tier,
                modelName,
                reasoningEffort: "low",
                activity: `citation child ${requestId}`,
                allowWrite: false,
                allowShell: false,
                allowTests: false,
                projectDbCapability: "none",
                projectDbWrite: false,
                needsImageGeneration: false,
                disableAtlas: true,
                disableSystemTools: true,
                fallbackReads: 0,
                maxTurns: Math.min(6, maxInputs + 3),
                maxOutputTokens: 4096,
                skipRolePrompt: true,
                recyclingMode: "fresh",
                sessionPacket: childSessionPacket,
                remoteSystemPrompt: "POSSE CITATION CHILD: use only sub_agent_next_input to consume the backend-owned ordered inputs, then make terminal agent_handoff your sole final action. Do not browse, mutate, dispatch, or add prose after the receipt.",
                allowedProviders: [providerName],
                abortSignal: childSignal,
                _subAgentChild: true,
                _coordinationChildPermitId: childPermitId,
                _coordinationChildRemoteToolSurface: childGateSurface,
                _agentCallRole: "subagent",
                _subAgentCursor: { batchId, dispatchId },
              },
              {
                job_id,
                work_item_id,
                attempt_id: observationContext?.attempt_id ?? null,
                cwd,
                jobProvider: providerName,
                jobModelName: modelName,
                complexity: "low",
              },
            );
          },
        });
      }
      this.worker._startSessionRecycleLeaseRenewal?.(opts._sessionRecycle);
      recordMemorySample("provider.call.before", {
        agent_call_id: agentCallId,
        work_item_id,
        job_id,
        role: opts.role,
        provider: providerName,
        model_tier: tier,
        model_name: modelName,
        prompt_chars: prompt.length,
        atlas_method: opts.disableAtlas ? null : (opts.atlasMethod || null),
      });
      let providerResult;
      try {
        providerResult = await runWithObservationContext(
          callObservationContext,
          () => provider.call(prompt, attemptOpts),
        );
      } catch (error) {
        providerReturnedAt = Date.now();
        if (
          !terminalHandoffStop
          || abortSignal?.aborted
          || error?.terminalHandoffStopCompatible === false
        ) throw error;
        terminalProviderError = error;
        providerResult = { output: "", stats: error?.stats || {} };
      }
      providerReturnedAt ??= Date.now();
      if (abortSignal?.aborted) {
        throw providerCallAbortedError(abortSignal, this.worker, job_id);
      }
      const providerOutput = typeof providerResult?.output === "string" ? providerResult.output : "";
      const stats = {
        ...(providerResult?.stats || {}),
        ...(terminalHandoffStop ? {
          terminalHandoffStopped: true,
          terminalHandoffProviderError: terminalProviderError != null,
          terminalHandoffAcknowledged: true,
        } : {}),
      };
      let handoffFinalization;
      try {
        handoffFinalization = this.deps.finalizeAgentHandoffForProvider({
          agentCallId,
          output: providerOutput,
          required: handoffRequired,
        });
      } catch (error) {
        error.output ??= providerOutput;
        error.stats = {
          ...stats,
          output: stats.output ?? providerOutput,
          outputChars: stats.outputChars ?? providerOutput.length,
        };
        throw error;
      }
      const output = handoffFinalization.output;
      // Usage survives a terminal stop only when the provider confirmed its
      // accounting was complete: codex via the terminal usage flush, claude via
      // the parsed final result message (stats.usageFinalized).
      const terminalUsageUnavailable = terminalProviderError != null
        && stats.terminalUsageFlushCompleted !== true
        && stats.usageFinalized !== true;
      const {
        providerUsageMeasured,
        providerUsageStatus,
        segmentSummary,
        accountingInputTokens,
        accountingOutputTokens,
      } = this._resolveProviderAccounting({
        agentCallId,
        providerName,
        modelTier: tier,
        modelName,
        stats,
        terminalUsageUnavailable,
        missingUsagePrecision: "unknown",
      });
      const recordedOutputChars = typeof output === "string" ? output.length : null;
      if (handoffFinalization.applied) {
        const materializedOutput = String(output ?? "");
        const receiptAt = Number(terminalHandoffStop?.acknowledgedAt) || null;
        const providerCloseAt = Number(stats.providerCloseAt) || providerReturnedAt;
        this.deps.recordObservation({
          work_item_id,
          job_id,
          attempt_id: observationContext?.attempt_id ?? null,
          agent_call_id: agentCallId,
          observation_type: "agent_handoff.committed",
          summary: `Committed terminal agent handoff (${handoffFinalization.digest.slice(0, 12)})`,
          detail: {
            agent_call_id: agentCallId,
            protocol: AGENT_HANDOFF_PROTOCOL,
            digest: handoffFinalization.digest,
            packet_profile: handoffFinalization.packet?.profile || null,
            packet_outcome: handoffFinalization.packet?.outcome || null,
            report_calls: handoffFinalization.reportCalls,
            evidence_chars: handoffFinalization.evidenceChars,
            evidence_recommended_chars: handoffFinalization.evidenceRecommendedChars,
            evidence_over_recommended: handoffFinalization.evidenceOverRecommended,
            evidence_selector_count: handoffFinalization.evidenceSelectorCount,
            evidence_selector_lines_max: handoffFinalization.evidenceSelectorLinesMax,
            evidence_selector_chars_max: handoffFinalization.evidenceSelectorCharsMax,
            evidence_selectors_over_recommended_count:
              handoffFinalization.evidenceSelectorsOverRecommendedCount,
            evidence_selector_recommended_lines:
              handoffFinalization.evidenceSelectorRecommendedLines,
            evidence_selector_recommended_chars:
              handoffFinalization.evidenceSelectorRecommendedChars,
            materialized_packet_chars: handoffFinalization.materializedPacketChars,
            planner_task_spec_count: handoffFinalization.plannerTaskSpecCount ?? null,
            planner_task_spec_chars_max: handoffFinalization.plannerTaskSpecCharsMax ?? null,
            planner_task_spec_chars_total: handoffFinalization.plannerTaskSpecCharsTotal ?? null,
            planner_task_spec_over_recommended_count:
              handoffFinalization.plannerTaskSpecOverRecommendedCount ?? null,
            planner_task_spec_recommended_chars:
              handoffFinalization.plannerTaskSpecRecommendedChars ?? null,
            continuation_prose_chars: handoffFinalization.continuationProseChars,
            materialized_output_chars: materializedOutput.length,
            materialized_output_sha256: crypto.createHash("sha256").update(materializedOutput).digest("hex"),
            tool_schema_name: handoffToolSchema.name,
            tool_schema_sha256: handoffToolSchema.sha256,
            tool_schema_chars: handoffToolSchema.chars,
            tool_schema_estimated_tokens: Math.ceil(handoffToolSchema.chars / 4),
            terminal_prompt_contract_chars: terminalHandoffContractChars(effectiveCapabilityOpts),
            expected_coordination_mode: expectedCoordinationMode(effectiveCapabilityOpts) || null,
            local_capability: localHandoffCapability,
            remote_capability: remoteHandoffCapability,
            required: handoffRequired,
            provider_input_tokens: accountingInputTokens,
            provider_output_tokens: accountingOutputTokens,
            provider_usage_status: providerUsageStatus,
            provider_output_discarded: handoffFinalization.continuationProseChars > 0,
            provider_short_circuited: terminalHandoffStop != null,
            provider_stop_code: terminalProviderError?.code || null,
            receipt_acknowledged: terminalHandoffStop != null,
            receipt_acknowledged_at_ms: receiptAt,
            terminal_abort_issued: terminalAbortIssuedAt != null,
            terminal_abort_issued_at_ms: terminalAbortIssuedAt,
            receipt_to_abort_ms: receiptAt != null && terminalAbortIssuedAt != null
              ? Math.max(0, terminalAbortIssuedAt - receiptAt)
              : null,
            provider_returned_at_ms: providerReturnedAt,
            provider_close_at_ms: providerCloseAt,
            provider_close_after_receipt_ms: receiptAt != null && providerCloseAt != null
              ? Math.max(0, providerCloseAt - receiptAt)
              : null,
            provider_abort_observed: stats.abortObserved === true,
            graceful_termination_attempted: stats.gracefulTerminationAttempted === true,
            force_kill_timer_fired: stats.forceKillTimerFired === true,
            force_kill_used: stats.forceKillUsed === true,
            force_kill_fallback_used: stats.forceKillFallbackUsed === true,
            force_kill_by_platform_policy: stats.forceKillByPlatformPolicy === true,
            terminal_usage_flush_attempted: stats.terminalUsageFlushAttempted === true,
            terminal_usage_flush_completed: stats.terminalUsageFlushCompleted === true,
            terminal_usage_flush_timed_out: stats.terminalUsageFlushTimedOut === true,
            terminal_usage_flush_duration_ms: stats.terminalUsageFlushDurationMs ?? null,
            terminal_usage_flush_timeout_ms: stats.terminalUsageFlushTimeoutMs ?? null,
            external_abort_observed: abortSignal?.aborted === true,
            mcp_attach_proof: stats.mcpAttachProof ? {
              initialize_seen_at: stats.mcpAttachProof.initializeSeenAt ?? null,
              tools_list_seen_at: stats.mcpAttachProof.toolsListSeenAt ?? null,
              agent_handoff_schema_name: stats.mcpAttachProof.agentHandoffToolSchemaName || null,
              agent_handoff_schema_sha256: stats.mcpAttachProof.agentHandoffToolSchemaSha256 || null,
              agent_handoff_schema_chars: stats.mcpAttachProof.agentHandoffToolSchemaChars ?? null,
              agent_handoff_schema_matches_expected: stats.mcpAttachProof.agentHandoffToolSchemaSha256
                ? stats.mcpAttachProof.agentHandoffToolSchemaSha256 === handoffToolSchema.sha256
                : null,
              last_method: stats.mcpAttachProof.lastMethod || null,
              last_request_at: stats.mcpAttachProof.lastRequestAt ?? null,
            } : null,
            terminality: terminalHandoffStop
              ? "receipt_acknowledged_provider_stopped"
              : "authoritative_output_only",
          },
        });
      }
      recordMemorySample("provider.call.after_success", {
        agent_call_id: agentCallId,
        work_item_id,
        job_id,
        role: opts.role,
        provider: providerName,
        model_tier: tier,
        model_name: stats.modelName || modelName,
        duration_ms: stats.durationMs ?? null,
        input_tokens: accountingInputTokens,
        output_tokens: accountingOutputTokens,
        output_chars: recordedOutputChars,
        turns_used: stats.numTurns ?? null,
        max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        output_truncated: stats.outputTruncated === true,
        replay_memory: getReplayMemoryStats(),
      });
      const accountingStats = buildAccountingStats(stats, {
        inputTokens: accountingInputTokens,
        outputTokens: accountingOutputTokens,
        outputChars: recordedOutputChars,
        exitCode: terminalProviderError == null ? stats.exitCode : null,
        providerUsageStatus,
        providerName,
        modelTier: tier,
        modelName,
        resolvedMaxOutputTokens,
        providerStopCode: terminalProviderError?.code || null,
      });

      completeAgentCall(agentCallId, {
        status: "succeeded",
        output_chars: recordedOutputChars,
        ...completionAccountingFields({
          stats,
          accountingStats,
          segmentSummary,
          providerUsageMeasured,
          providerUsageStatus,
          resolvedMaxTurns,
          resolvedMaxOutputTokens,
          opts,
          resolveCallCostEstimate: this.resolveCallCostEstimate,
        }),
        model_name: stats.modelName || null,
      });

      this._recordContextPressureTelemetry({
        agentCallId,
        work_item_id,
        job_id,
        attempt_id: observationContext?.attempt_id ?? null,
        providerName,
        role: opts.role,
        modelTier: tier,
        modelName: stats.modelName || modelName,
        promptChars: prompt.length,
        // Raw stats, not accountingStats: the pressure lane detects context
        // overflow and self-labels estimated vs measured. Nulling partially
        // reported tokens here would blind it on exactly the overflow-shaped
        // calls; the no-invented-usage invariant governs cost accounting only.
        stats,
        status: "succeeded",
        opts,
      });

      if (!terminalHandoffStop && opts._sessionRecycle && (stats.sessionHandle || stats.responseId)) {
        this.worker._registerSessionRecycleResult?.({
          ...opts._sessionRecycle,
          mode: opts.recyclingMode || "fresh",
          newHandle: stats.sessionHandle || stats.responseId,
          agentCallId,
          tokensResume: stats.inputTokens ?? opts._sessionRecycle.resumePromptEstimateTokens ?? null,
          tokensFreshEstimate: opts._sessionRecycle.fullPromptEstimateTokens,
        });
      }
      retainReusableAgent = !terminalHandoffStop
        && identity.reusable === true
        && !!(stats.sessionHandle || stats.responseId || opts.priorSessionHandle);

      retainReplayOutput?.(agentCallId, {
        output,
        status: "succeeded",
        stats: accountingStats,
      });
      recordOutput({
        agent_call_id: agentCallId,
        job_id,
        work_item_id,
        role: opts.role,
        provider: providerName,
        model: stats.modelName || modelName,
        attempt: opts.attemptCount || 1,
        activity: opts.activity,
        modelTier: tier,
        status: "succeeded",
        inputTokens: accountingInputTokens,
        outputTokens: accountingOutputTokens,
        providerUsageStatus,
        durationMs: stats.durationMs,
        exitCode: terminalProviderError == null ? stats.exitCode : null,
        output,
      });

      recordProviderToolBatchObservations({
        work_item_id,
        job_id,
        attempt_id: null,
        provider: providerName,
        tool_uses: stats.toolUses || [],
      });
      const toolUsesForReplay = filterProviderToolUseReplay(stats.toolUses || [], {
        skipToolkitDeterministic: !!stats.toolUsesLoggedByToolkit,
      });
      retainReplayToolUses?.(agentCallId, toolUsesForReplay);
      recordToolUseObservations({
        work_item_id,
        job_id,
        attempt_id: null,
        tool_uses: toolUsesForReplay,
        cwd: cwd || this.worker.projectDir,
      });
      recordRecoveryCheckpoint?.({
        work_item_id,
        job_id,
        attempt_id: observationContext?.attempt_id ?? null,
        agent_call_id: agentCallId,
        phase: "agent_call_succeeded",
        reason: "provider_attempt_finished",
        status: "succeeded",
        extra: {
          output_chars: recordedOutputChars,
          input_tokens: accountingInputTokens,
          output_tokens: accountingOutputTokens,
          provider_usage_status: providerUsageStatus,
          turns_used: stats.numTurns ?? null,
          max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
          output_truncated: stats.outputTruncated === true,
          duration_ms: stats.durationMs ?? null,
          exit_code: terminalProviderError == null ? stats.exitCode ?? null : null,
          tool_uses: toolUsesForReplay.length,
          agent_handoff: handoffFinalization.applied ? {
            digest: handoffFinalization.digest,
            report_calls: handoffFinalization.reportCalls,
            evidence_chars: handoffFinalization.evidenceChars,
            materialized_packet_chars: handoffFinalization.materializedPacketChars,
            continuation_prose_chars: handoffFinalization.continuationProseChars,
            tool_schema_chars: handoffToolSchema.chars,
            tool_schema_sha256: handoffToolSchema.sha256,
            tool_schema_estimated_tokens: Math.ceil(handoffToolSchema.chars / 4),
            terminal_prompt_contract_chars: terminalHandoffContractChars(effectiveCapabilityOpts),
          } : null,
        },
      });

      return { output, stats: accountingStats, agentCallId, opts: attemptOpts };
    } catch (err) {
      if (abortSignal?.aborted && job_id != null && this.worker?._killReasons?.has?.(job_id)) {
        err._killReason = this.worker._killReasons.get(job_id);
      }
      const stats = err.stats || {};
      const terminalStopOwnsFailure = stats.terminalHandoffStopped === true
        || (terminalHandoffStop != null && abortSignal?.aborted !== true);
      const terminalUsageUnavailable = terminalStopOwnsFailure
        && stats.terminalUsageFlushCompleted !== true
        && stats.usageFinalized !== true;
      const {
        providerUsageMeasured,
        providerUsageStatus,
        segmentSummary: failureSegmentSummary,
        accountingInputTokens,
        accountingOutputTokens,
      } = this._resolveProviderAccounting({
        agentCallId,
        providerName,
        modelTier: tier,
        modelName,
        stats,
        terminalUsageUnavailable,
        missingUsagePrecision: "incomplete",
      });
      const recordedOutputChars = terminalUsageUnavailable
        ? null
        : Object.prototype.hasOwnProperty.call(stats, "outputChars")
          && Number.isFinite(Number(stats.outputChars))
          ? Number(stats.outputChars)
          : typeof stats.output === "string" && stats.output
            ? stats.output.length
            : typeof err.output === "string"
              ? err.output.length
              : null;
      const recordedExitCode = terminalUsageUnavailable ? null : (stats.exitCode ?? null);
      const recordedDurationMs = Number.isFinite(Number(stats.durationMs))
        ? Number(stats.durationMs)
        : Math.max(0, Date.now() - agentCallStartedAt);
      recordMemorySample("provider.call.after_error", {
        agent_call_id: agentCallId,
        work_item_id,
        job_id,
        role: opts.role,
        provider: providerName,
        model_tier: tier,
        model_name: stats.modelName || modelName,
        duration_ms: recordedDurationMs,
        input_tokens: accountingInputTokens,
        output_tokens: accountingOutputTokens,
        error_name: err?.name || null,
        error_message: String(err?.message || err).slice(0, 1000),
        turns_used: stats.numTurns ?? null,
        max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        output_truncated: stats.outputTruncated === true || err.outputTruncated === true,
        replay_memory: getReplayMemoryStats(),
      });
      const accountingStats = buildAccountingStats(stats, {
        inputTokens: accountingInputTokens,
        outputTokens: accountingOutputTokens,
        outputChars: recordedOutputChars,
        durationMs: recordedDurationMs,
        exitCode: recordedExitCode,
        providerUsageStatus,
        providerName,
        modelTier: tier,
        modelName,
        resolvedMaxOutputTokens,
        outputTruncated: stats.outputTruncated === true || err.outputTruncated === true,
        outputLimitReason: stats.outputLimitReason || err.outputLimitReason || null,
      });
      completeAgentCall(agentCallId, {
        status: "failed",
        output_chars: recordedOutputChars,
        ...completionAccountingFields({
          stats,
          accountingStats,
          segmentSummary: failureSegmentSummary,
          providerUsageMeasured,
          providerUsageStatus,
          resolvedMaxTurns,
          resolvedMaxOutputTokens,
          opts,
          resolveCallCostEstimate: this.resolveCallCostEstimate,
        }),
        error_text: err.message?.slice(0, 2000),
      });

      this._recordContextPressureTelemetry({
        agentCallId,
        work_item_id,
        job_id,
        attempt_id: observationContext?.attempt_id ?? null,
        providerName,
        role: opts.role,
        modelTier: tier,
        modelName: stats.modelName || modelName,
        promptChars: prompt.length,
        // Raw stats for the same reason as the success-path pressure call.
        stats,
        status: "failed",
        opts,
      });

      const recycleDecision = opts._sessionRecycle?.decision || null;
      const recycleSession = recycleDecision?.session || null;
      const recycleLaneId = recycleDecision?.lane?.id || recycleSession?.lane_id || null;
      const mcpAttachMissingProof = err.mcpAttachMissingProof || stats.mcpAttachMissingProof;
      this.worker._stopSessionRecycleLeaseRenewal?.(job_id);
      if (recycleSession?.id || (mcpAttachMissingProof && recycleLaneId)) {
        if (err.sessionExpired || stats.sessionExpired || mcpAttachMissingProof) {
          const recycleInvalidationReason = (err.mcpAttachMissingProof || stats.mcpAttachMissingProof)
            ? "mcp_attach_missing_proof"
            : "provider_session_expired";
          if (recycleSession?.id) {
            opts._sessionRecycle.manager?.markExpired?.(recycleSession.id, recycleInvalidationReason);
          }
          if (recycleLaneId) {
            opts._sessionRecycle.manager?.invalidateLane?.(
              recycleLaneId,
              recycleInvalidationReason,
            );
          }
        } else if (recycleSession?.id) {
          opts._sessionRecycle.manager?.releaseSession?.(
            recycleSession.id,
            recycleSession.leaseToken,
          );
        }
      }

      const failureOutput = stats.output || err.output || "";
      retainReplayOutput?.(agentCallId, {
        output: failureOutput,
        status: "failed",
        stats: accountingStats,
        errorText: err.message?.slice(0, 2000) || null,
      });
      recordOutput({
        agent_call_id: agentCallId,
        job_id,
        work_item_id,
        role: opts.role,
        provider: providerName,
        model: stats.modelName || modelName,
        attempt: opts.attemptCount || 1,
        activity: opts.activity,
        modelTier: tier,
        status: "failed",
        inputTokens: accountingInputTokens,
        outputTokens: accountingOutputTokens,
        providerUsageStatus,
        durationMs: recordedDurationMs,
        exitCode: recordedExitCode,
        errorText: err.message?.slice(0, 2000) || null,
        output: failureOutput,
      });

      recordProviderToolBatchObservations({
        work_item_id,
        job_id,
        attempt_id: null,
        provider: providerName,
        tool_uses: err.toolUses || [],
      });
      const failureToolUsesForReplay = filterProviderToolUseReplay(err.toolUses || [], {
        skipToolkitDeterministic: !!stats.toolUsesLoggedByToolkit,
      });
      retainReplayToolUses?.(agentCallId, failureToolUsesForReplay);
      recordToolUseObservations({
        work_item_id,
        job_id,
        attempt_id: null,
        tool_uses: failureToolUsesForReplay,
        cwd: cwd || this.worker.projectDir,
      });
      recordRecoveryCheckpoint?.({
        work_item_id,
        job_id,
        attempt_id: observationContext?.attempt_id ?? null,
        agent_call_id: agentCallId,
        phase: "agent_call_failed",
        reason: "provider_attempt_failed",
        status: "failed",
        extra: {
          error_text: err.message?.slice(0, 2000) || null,
          output_chars: recordedOutputChars,
          input_tokens: accountingInputTokens,
          output_tokens: accountingOutputTokens,
          provider_usage_status: providerUsageStatus,
          turns_used: stats.numTurns ?? null,
          max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
          output_truncated: stats.outputTruncated === true || err.outputTruncated === true,
          duration_ms: recordedDurationMs,
          exit_code: recordedExitCode,
          tool_uses: failureToolUsesForReplay.length,
        },
      });

      throw err;
    } finally {
      try {
        unregisterAgentHandoffTerminal?.();
        unregisterSubAgentParent?.();
        unregisterSubAgentChild?.();
        try {
          if (agent && agentLease) await dispatcher.release({
            agent,
            lease: agentLease,
            retain: preparedAgent ? true : (identity.reusable && retainReusableAgent),
            reason: "provider_attempt_complete",
          });
        } catch {
          // A scope that cannot be cleared makes this lifetime gate unsafe to
          // reuse. Destroying the Agent unregisters the owner session; the next
          // provider attempt must be dispatched with a newly minted gate.
          retainReusableAgent = false;
        }
        if (agent && !agentLease && !preparedAgent && (!identity.reusable || !retainReusableAgent)) {
          await dispatcher.destroyAgent(agent, { reason: "provider_agent_complete" });
        }
      } finally {
        ContextMeter.release({ agent_call_id: agentCallId });
      }
    }
  }

  async call(prompt, opts, {
    job_id = null,
    work_item_id = null,
    attempt_id = null,
    jobDir = null,
    cwd = null,
    jobProvider = null,
    jobModelName = null,
    complexity = null,
    atlasConfig = null,
  } = {}) {
    const {
      assertLoaderClean: assertLoaderCleanSync,
      assertLoaderCleanAsync: assertLoaderCleanAsyncDep,
      getAvailableProviders,
      getObservationContext,
      getProvider,
      getProviderRateLimitState,
      provisionAgentLoader: provisionAgentLoaderSync,
      provisionAgentLoaderAsync: provisionAgentLoaderAsyncDep,
      provisionSessionLaneLoader: provisionSessionLaneLoaderSync,
      provisionSessionLaneLoaderAsync: provisionSessionLaneLoaderAsyncDep,
      recordObservation,
      resolvePrimaryExecutionModelName,
      resolveAtlasExecutionAttachment,
      sanitizeExecutionHintsForRole,
      selectFallbackProvider,
      selectProviderName,
      updateJobProvider,
    } = this.deps;
    const buildFallbackPrompt = typeof opts.buildFallbackPrompt === "function"
      ? opts.buildFallbackPrompt
      : null;
    if (buildFallbackPrompt) {
      opts = { ...opts };
      delete opts.buildFallbackPrompt;
    }
    opts = await timeProviderSetupPhase("provider.opts_sanitize", {
      role: opts.role,
      provider: jobProvider || null,
      job_id,
      work_item_id,
    }, () => sanitizeExecutionHintsForRole(opts.role, opts));
    const dispatcher = this.worker?.agentDispatcher;
    const preparedAgent = opts?._preparedAgent || null;
    let providerName = await timeProviderSetupPhase("provider.select", {
      role: opts.role,
      provider: jobProvider || null,
      job_id,
      work_item_id,
    }, () => preparedAgent?.providerName || jobProvider || (
      typeof dispatcher?.selectProvider === "function"
        ? dispatcher.selectProvider({ role: opts.role })
        : selectProviderName(opts.role)
    ));
    const initialProviderName = providerName;
    const configuredPool = await timeProviderSetupPhase("provider.pool", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => Array.isArray(opts.allowedProviders) && opts.allowedProviders.length > 0
      ? [...new Set(opts.allowedProviders.filter(Boolean))]
      : (opts.role === "artificer" && jobProvider
          ? [jobProvider]
          : (typeof dispatcher?.providersForRole === "function"
              ? dispatcher.providersForRole(opts.role)
              : getAvailableProviders(opts.role))));
    const attemptedProviders = normalizeAttemptedProviders(opts._fallbackAttemptedProviders);
    if (opts._fallbackAttempted) recordAttemptedProvider(attemptedProviders, providerName);
    let preflightFallback = null;
    const ambient = getObservationContext() || {};

    const rlState = await timeProviderSetupPhase("provider.rate_limit_state", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => getProviderRateLimitState(providerName));
    if (rlState.blocked) {
      recordAttemptedProvider(attemptedProviders, providerName);
      if (buildFallbackPrompt && !opts._fallbackAttempted) {
        const fallbackName = this._selectFallbackCandidate({
          configuredPool,
          currentProvider: providerName,
          attemptedProviders,
          needsImageGeneration: !!opts.needsImageGeneration,
          selectFallbackProvider,
          getProviderRateLimitState,
        });
        if (fallbackName) {
          const previousProviderName = providerName;
          if (preparedAgent && typeof dispatcher?.rebindAgent === "function") {
            await dispatcher.rebindAgent(preparedAgent, {
              providerName: fallbackName,
              reason: "provider_rate_limit_preflight",
              handoffFactory: ({ providerName: reboundProvider }) => buildFallbackPrompt({
                providerName: reboundProvider,
                previousProviderName,
                role: opts.role,
              }),
            });
            prompt = preparedAgent.handoff;
          } else {
            prompt = await timeProviderSetupPhase("provider.fallback_prompt", {
              role: opts.role,
              provider: fallbackName,
              job_id,
              work_item_id,
            }, () => buildFallbackPrompt({
              providerName: fallbackName,
              previousProviderName,
              role: opts.role,
            }));
          }
          providerName = fallbackName;
          preflightFallback = { from: previousProviderName, to: fallbackName };
          opts = {
            ...opts,
            _fallbackAttempted: true,
            _fallbackAttemptedProviders: [...attemptedProviders],
            allowedProviders: configuredPool,
          };
          recordObservation({
            work_item_id,
            job_id,
            attempt_id: ambient.attempt_id ?? null,
            observation_type: "provider.fallback",
            summary: `${previousProviderName} -> ${fallbackName}`,
            detail: {
              role: opts.role,
              from: previousProviderName,
              to: fallbackName,
              provider_pool: configuredPool,
              reason: "rate_limit_preflight",
            },
          });
          this.emitStatus(job_id, `${C.yellow}[fallback] ${previousProviderName} rate-limited (${rlState.reason}) -> trying ${fallbackName}${C.reset}`);
        }
      }
      if (!preflightFallback) {
        const err = new Error(`${providerName} rate-limited (${rlState.reason}) - retry in ${rlState.retryInSec}s`);
        err._rateLimitPreFlight = true;
        throw err;
      }
    }

    const provider = await timeProviderSetupPhase("provider.module", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, async () => {
      if (preparedAgent?.providerName === providerName && preparedAgent?.provider) {
        return preparedAgent.provider;
      }
      if (typeof dispatcher?.providerFor === "function") {
        const binding = await dispatcher.providerFor({ role: opts.role, providerName });
        if (binding?.provider) return binding.provider;
      }
      return getProvider(opts.role, providerName);
    });
    const tier = opts.modelTier || "standard";
    const tierConfig = await timeProviderSetupPhase("provider.tier_config", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => provider.getModelTierConfig?.(tier) || provider.MODEL_TIERS?.[tier] || provider.MODEL_TIERS?.standard || {});
    const providerChangedBeforeExecution = providerName !== initialProviderName;
    const effectiveJobModelName = providerChangedBeforeExecution ? null : jobModelName;
    const selectedExecutionModelName = await timeProviderSetupPhase("provider.model_resolve", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => resolvePrimaryExecutionModelName(effectiveJobModelName, opts, tierConfig));
    // Catalog enforcement keeps tier-config models honest, but an explicit
    // per-job pin is the user's call: the cached catalog snapshot can lag a
    // newly released model, and silently swapping a pinned model for the tier
    // default would run (and bill) a model the job never selected. Provider
    // auth compatibility is applied separately at the concrete execution
    // boundary below because the provider applies that same constraint when
    // it launches the request.
    const jobPinnedModel = !!effectiveJobModelName && selectedExecutionModelName === effectiveJobModelName;
    const catalogModelName = jobPinnedModel
      ? selectedExecutionModelName
      : resolveCatalogSafeTierModel(providerName, tier, selectedExecutionModelName);
    const executionModelName = resolveProviderExecutionModelName(provider, catalogModelName, {
      role: opts.role,
      modelTier: tier,
    });

    if (executionModelName) opts = { ...opts, modelName: executionModelName };

    if (this.worker.display && !opts.onLine) {
      opts = { ...opts, onLine: (line) => this.worker.display.workerLine(job_id, line) };
    }
    if (this.worker.display && job_id) {
      this.worker.display.setWorker(job_id, {
        role: opts.role,
        activity: opts.activity,
        tier,
        effort: opts.reasoningEffort || "medium",
        attempt: opts.attemptCount || 1,
        workItemId: work_item_id,
        provider: providerName,
        modelName: executionModelName,
      });
    }
    if (jobDir) opts = { ...opts, jobDir };
    if (cwd) opts = { ...opts, cwd };
    if (atlasConfig) opts = { ...opts, atlasConfig };
    if (!opts.projectDir) opts = { ...opts, projectDir: this.worker.projectDir };

    if (complexity != null) opts = { ...opts, complexity };
    if (this.worker.stallTimeout) opts = { ...opts, stallTimeout: this.worker.stallTimeout };
    if (job_id != null) opts = { ...opts, jobId: job_id };
    if (work_item_id != null) opts = { ...opts, workItemId: work_item_id };

    if (!opts.disableAtlas && !opts.atlasMethod) {
      try {
        const attachment = resolveAtlasExecutionAttachment({
          role: opts.role,
          providerName,
          cwd: opts.cwd || cwd || this.worker.projectDir,
          assignmentUnit: opts.atlasAssignmentUnit || null,
          workItemId: work_item_id,
          config: opts.atlasConfig || undefined,
        });
        opts = {
          ...opts,
          atlasMethod: attachment?.method || null,
          atlasConfig: withAtlasExecutionPolicySnapshot(opts.atlasConfig, attachment),
        };
      } catch {
        // Provider-specific setup resolves ATLAS again; this early value is
        // only for live agent_call telemetry while the provider is still running.
      }
    }

    const explicitAbortSignal = opts.abortSignal && typeof opts.abortSignal.addEventListener === "function"
      ? opts.abortSignal
      : null;
    const existingAbortController = job_id ? this.worker._abortControllers.get(job_id) : null;
    const ac = explicitAbortSignal ? null : (existingAbortController || new AbortController());
    const createdAbortController = !!job_id && !explicitAbortSignal && !existingAbortController;
    if (createdAbortController) this.worker._abortControllers.set(job_id, ac);
    opts = { ...opts, abortSignal: explicitAbortSignal || ac.signal };

    const sessionPrepared = await timeProviderSetupPhase("provider.session_prepare", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => this._prepareSessionReuse(prompt, opts, {
      providerName,
      job_id,
      work_item_id,
      attempt_id: ambient.attempt_id ?? null,
    }));
    // Session reuse may replace the prompt with a resume-handoff delta and
    // suppress the role/system prompt (skipRolePrompt/stableContext). Retries
    // that open a fresh session must start from these pre-reuse values — a
    // resume delta is incoherent without the prior session behind it.
    const preReusePrompt = prompt;
    const preReuseOpts = opts;
    prompt = sessionPrepared.prompt;
    opts = sessionPrepared.opts;

    if (job_id != null && this.worker.projectDir) {
      await timeProviderSetupPhase("provider.loader_prepare", {
        role: opts.role,
        provider: providerName,
        job_id,
        work_item_id,
      }, async () => {
        const sessionKey = String(providerName || "").toLowerCase() === "claude"
          ? sessionPrepared.opts?._sessionRecycle?.decision?.key
          : null;
        const loaderPath = sessionKey
          ? await (provisionSessionLaneLoaderAsyncDep
            ? provisionSessionLaneLoaderAsyncDep(this.worker.projectDir, sessionKey)
            : provisionSessionLaneLoaderSync(this.worker.projectDir, sessionKey))
          : await (provisionAgentLoaderAsyncDep
            ? provisionAgentLoaderAsyncDep(this.worker.projectDir, job_id)
            : provisionAgentLoaderSync(this.worker.projectDir, job_id));
        if (assertLoaderCleanAsyncDep) await assertLoaderCleanAsyncDep(loaderPath);
        else assertLoaderCleanSync(loaderPath);
        opts = { ...opts, loaderCwd: loaderPath, mcpCwd: opts.cwd || this.worker.projectDir };
      });
    }

    try {
      const observationContext = {
        work_item_id,
        job_id,
        attempt_id: attempt_id ?? ambient.attempt_id ?? null,
        role: opts.role ?? ambient.role ?? null,
      };
      const result = await this._executeOneAttempt(prompt, opts, {
        provider,
        providerName,
        tier,
        modelName: executionModelName,
        work_item_id,
        job_id,
        cwd,
        observationContext,
        abortSignal: opts.abortSignal,
      });
      if (preflightFallback) {
        if (job_id) {
          updateJobProvider(job_id, preflightFallback.to, result.stats?.modelName || executionModelName || null);
        }
        this.emitStatus(job_id, `${C.green}[fallback] ${preflightFallback.to} succeeded${C.reset}`);
      }
      return result;
    } catch (err) {
      let activeErr = err;
      const runtimeFallbackCandidate = opts._modelFallbackAttempted
        ? null
        : (isRuntimeModelError(activeErr) ? resolveRuntimeModelFallback(providerName, tier, executionModelName) : null);
      const resolvedRuntimeFallbackModel = resolveProviderExecutionModelName(provider, runtimeFallbackCandidate, {
        role: opts.role,
        modelTier: tier,
      });
      const runtimeFallbackModel = normalizeModelName(resolvedRuntimeFallbackModel) === normalizeModelName(executionModelName)
        ? null
        : resolvedRuntimeFallbackModel;
      if (runtimeFallbackModel) {
        try {
          recordObservation({
            work_item_id,
            job_id,
            attempt_id: ambient.attempt_id ?? null,
            observation_type: "provider.model_fallback",
            summary: `${providerName} ${executionModelName || "(provider default)"} -> ${runtimeFallbackModel}`,
            detail: {
              role: opts.role,
              provider: providerName,
              from_model: executionModelName || null,
              to_model: runtimeFallbackModel,
              model_tier: tier,
              reason: "runtime_model_error",
            },
          });
          this.emitStatus(job_id, `${C.yellow}[model-fallback] ${providerName} rejected model ${executionModelName || "(provider default)"} -> retrying ${runtimeFallbackModel}${C.reset}`);
          // Retry from the pre-reuse prompt/opts: the retry runs in a fresh
          // session, so a resume-handoff prompt and its skipRolePrompt/
          // stableContext suppressions must not carry over.
          const {
            _sessionRecycle: _discardModelSessionRecycle,
            priorSessionHandle: _discardModelPriorSessionHandle,
            recyclingMode: _discardModelRecyclingMode,
            ...modelRetryBaseOpts
          } = preReuseOpts;
          const retryOpts = {
            ...modelRetryBaseOpts,
            // Loader provisioning ran after the pre-reuse snapshot; keep it.
            ...(opts.loaderCwd ? { loaderCwd: opts.loaderCwd, mcpCwd: opts.mcpCwd } : {}),
            modelName: runtimeFallbackModel,
            _modelFallbackAttempted: true,
          };
          const retry = await this._executeOneAttempt(preReusePrompt, retryOpts, {
            provider,
            providerName,
            tier,
            modelName: runtimeFallbackModel,
            work_item_id,
            job_id,
            cwd,
            observationContext: {
              work_item_id,
              job_id,
              attempt_id: ambient.attempt_id ?? null,
              role: opts.role ?? ambient.role ?? null,
            },
            abortSignal: opts.abortSignal,
          });
          if (job_id) {
            updateJobProvider(job_id, providerName, retry.stats?.modelName || runtimeFallbackModel || null);
          }
          this.emitStatus(job_id, `${C.green}[model-fallback] ${providerName} succeeded on ${retry.stats?.modelName || runtimeFallbackModel}${C.reset}`);
          return retry;
        } catch (modelErr) {
          if (isAbortError(modelErr) || modelErr?._killReason) throw modelErr;
          activeErr = modelErr;
          this.emitStatus(job_id, `${C.red}[model-fallback] ${providerName} fallback model also failed: ${modelErr.message?.split("\n")[0]?.slice(0, 100)}${C.reset}`);
        }
      }

      if (this.isProviderError(activeErr) || isRuntimeModelError(activeErr)) {
        recordAttemptedProvider(attemptedProviders, providerName);
        const fallbackName = this._selectFallbackCandidate({
          configuredPool,
          currentProvider: providerName,
          attemptedProviders,
          needsImageGeneration: !!opts.needsImageGeneration,
          selectFallbackProvider,
          getProviderRateLimitState,
        });

        if (fallbackName) {
          try {
            if (preparedAgent && typeof dispatcher?.rebindAgent === "function") {
              await dispatcher.rebindAgent(preparedAgent, {
                providerName: fallbackName,
                reason: "provider_runtime_fallback",
                handoffFactory: buildFallbackPrompt
                  ? ({ providerName: reboundProvider }) => buildFallbackPrompt({
                      providerName: reboundProvider,
                      previousProviderName: providerName,
                      role: opts.role,
                    })
                  : null,
              });
            }
            let fbProvider = preparedAgent?.providerName === fallbackName
              ? preparedAgent?.provider
              : null;
            if (!fbProvider && typeof dispatcher?.providerFor === "function") {
              fbProvider = (await dispatcher.providerFor({
                role: opts.role,
                providerName: fallbackName,
              })).provider;
            }
            if (!fbProvider) fbProvider = getProvider(opts.role, fallbackName);
            let fbAtlasMethod = null;
            if (!opts.disableAtlas) {
              try {
                const fbAtlas = resolveAtlasExecutionAttachment({
                  role: opts.role,
                  providerName: fallbackName,
                  cwd,
                  assignmentUnit: opts.atlasAssignmentUnit || null,
                  workItemId: work_item_id,
                  config: opts.atlasConfig || undefined,
                });
                fbAtlasMethod = fbAtlas?.method || null;
                if (fbAtlasMethod && fbAtlasMethod !== opts.atlasMethod) {
                  recordObservation({
                    work_item_id,
                    job_id,
                    attempt_id: ambient.attempt_id ?? null,
                    observation_type: "atlas.fallback.rebind",
                    summary: `ATLAS method rebind ${opts.atlasMethod || "null"} -> ${fbAtlasMethod}`,
                    detail: {
                      role: opts.role,
                      from_provider: providerName,
                      from_method: opts.atlasMethod || null,
                      to_provider: fallbackName,
                      to_method: fbAtlasMethod,
                    },
                  });
                }
              } catch {
                // ATLAS rebind is best-effort.
              }
            }

            recordObservation({
              work_item_id,
              job_id,
              attempt_id: ambient.attempt_id ?? null,
              observation_type: "provider.fallback",
              summary: `${providerName} -> ${fallbackName}`,
              detail: { role: opts.role, from: providerName, to: fallbackName, provider_pool: configuredPool },
            });
            this.emitStatus(job_id, `${C.yellow}[fallback] ${providerName} failed (API error) -> trying ${fallbackName}${C.reset}`);

            const fbTierConfig = fbProvider.getModelTierConfig?.(tier) || fbProvider.MODEL_TIERS?.[tier] || fbProvider.MODEL_TIERS?.standard || {};
            const fbCatalogModelName = resolveCatalogSafeTierModel(
              fallbackName,
              tier,
              fbTierConfig.model || getDefaultTierModel(fallbackName, tier),
            );
            const fbModelName = resolveProviderExecutionModelName(fbProvider, fbCatalogModelName, {
              role: opts.role,
              modelTier: tier,
            });
            const fbAc = new AbortController();
            if (job_id) {
              const prevAc = this.worker._abortControllers.get(job_id);
              if (prevAc?.signal?.aborted) fbAc.abort(prevAc.signal.reason);
              this.worker._abortControllers.set(job_id, fbAc);
            }
            const {
              _sessionRecycle: _discardSessionRecycle,
              priorSessionHandle: _discardPriorSessionHandle,
              recyclingMode: _discardRecyclingMode,
              ...sessionlessOpts
            } = opts;
            const fbOpts = {
              ...sessionlessOpts,
              abortSignal: fbAc.signal,
              modelName: fbModelName || undefined,
              _fallbackAttempted: true,
              _fallbackAttemptedProviders: [...attemptedProviders, fallbackName],
              allowedProviders: configuredPool,
              atlasMethod: fbAtlasMethod,
            };
            const fallbackPrompt = preparedAgent
              ? preparedAgent.handoff
              : buildFallbackPrompt
                ? await buildFallbackPrompt({
                    providerName: fallbackName,
                    previousProviderName: providerName,
                    role: opts.role,
                  })
                : prompt;
            const fallbackResult = await this._executeOneAttempt(fallbackPrompt, fbOpts, {
              providerName: fallbackName,
              provider: fbProvider,
              tier,
              modelName: fbModelName || null,
              work_item_id,
              job_id,
              cwd,
              observationContext: {
                work_item_id,
                job_id,
                attempt_id: attempt_id ?? ambient.attempt_id ?? null,
                role: opts.role ?? ambient.role ?? null,
              },
              abortSignal: fbAc.signal,
            });
            const { stats: fbStats } = fallbackResult;

            if (job_id) {
              updateJobProvider(job_id, fallbackName, fbStats.modelName || fbModelName || null);
            }
            this.emitStatus(job_id, `${C.green}[fallback] ${fallbackName} succeeded${C.reset}`);
            return fallbackResult;
          } catch (fbErr) {
            // Propagate abort signals so killJob() during a fallback is honored;
            // otherwise the outer throw replaces the abort with the primary
            // provider's earlier error and the job looks retryable instead of
            // killed.
            if (isAbortError(fbErr) || fbErr?._killReason) throw fbErr;
            this.emitStatus(job_id, `${C.red}[fallback] ${fallbackName} also failed: ${fbErr.message?.split("\n")[0]?.slice(0, 100)}${C.reset}`);
          }
        }
      }

      if (job_id && this.worker._killReasons.has(job_id)) {
        activeErr._killReason = this.worker._killReasons.get(job_id);
      }
      throw activeErr;
    } finally {
      if (createdAbortController && job_id) {
        this.worker._abortControllers.delete(job_id);
        this.worker._killReasons.delete(job_id);
      }
    }
  }
}
