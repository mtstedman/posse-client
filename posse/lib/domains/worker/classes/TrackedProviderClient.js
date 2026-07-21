// lib/domains/worker/classes/TrackedProviderClient.js
//
// Tracked provider-call orchestration extracted from Worker. The Worker still
// owns lease and attempt lifecycle; this client owns model dispatch, call
// logging, prompt/output capture, observation wrapping, and provider fallback.

import path from "path";
import {
  completeAgentCall,
  createAgentCall,
  getJob,
  getSetting,
  getWorkItem,
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
import { filterProviderToolUseReplay, getObservationContext, recordObservation, recordToolUseObservations, runWithObservationContext } from "../../observability/functions/observations.js";
import { recordPrompt } from "../../../shared/telemetry/functions/logging/prompt-log.js";
import { recordOutput } from "../../../shared/telemetry/functions/logging/output-log.js";
import { resolveAtlasExecutionAttachment } from "../../integrations/functions/atlas.js";
import { provisionAgentLoader, provisionAgentLoaderAsync, provisionSessionLaneLoader, provisionSessionLaneLoaderAsync, assertLoaderClean, assertLoaderCleanAsync } from "../functions/helpers/agent-loader.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import {
  resolvePrimaryExecutionModelName,
  sanitizeExecutionHintsForRole,
} from "../../providers/functions/execution-routing.js";
import { getMaxOutputTokensForProvider } from "../../providers/functions/shared/turns.js";
import { selectFallbackProvider } from "../../providers/functions/delegation-routing.js";
import { buildResumeHandoff } from "../../handoff/functions/index.js";
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
  isRegisteredRemoteToolSurface,
  narrowProviderOptionsToRemoteIssuance,
} from "../../../shared/tools/functions/issued-tool-policy.js";
import { finalizeAgentHandoffForProvider } from "../../handoff/functions/agent-handoff.js";
import { agentHandoffTerminator } from "../../handoff/classes/AgentHandoffTerminator.js";
import {
  TOOL_AGENT_HANDOFF,
  TOOL_AGENT_HANDOFF_ARTIFICER,
  TOOL_AGENT_HANDOFF_DEV,
  TOOL_AGENT_HANDOFF_REPORT,
} from "../../../catalog/native-tools.js";
import {
  buildCitationChildPrompt,
  subAgentRuntime,
} from "../../sub-agent/classes/SubAgentRuntime.js";
import { McpServerConfig } from "../../../shared/tools/classes/McpServerConfig.js";

function agentHandoffToolSchemaChars(role, compactCompletion = false) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const schema = !compactCompletion
    ? TOOL_AGENT_HANDOFF
    : normalizedRole === "dev" || normalizedRole === "fix"
    ? TOOL_AGENT_HANDOFF_DEV
    : normalizedRole === "artificer"
      ? TOOL_AGENT_HANDOFF_ARTIFICER
      : ["researcher", "planner", "assessor", "citation_synthesis"].includes(normalizedRole)
        ? TOOL_AGENT_HANDOFF_REPORT
        : TOOL_AGENT_HANDOFF;
  return JSON.stringify(schema).length;
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
  /MCP_ATTACH_PROOF_MISSING|MCP attach proof missing|deterministic MCP attach proof missing/i,
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
  updateJobProvider,
  setAttemptSession,
  getAvailableProviders,
  getProvider,
  getProviderRateLimitState,
  selectProviderName,
  filterProviderToolUseReplay,
  getObservationContext,
  recordObservation,
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
};

function nonNegativeTokenCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
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
  const provider = String(providerName || "").trim().toLowerCase();
  const skillKey = String(decision?.key?.skillKey || "");
  const agentHandoff = (issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy) || [])
    .includes("tools.agent_handoff");
  const subAgent = (issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy) || [])
    .includes("tools.sub_agent");
  const coordinationChild = opts._subAgentChild === true;
  const coordinationKey = coordinationChild ? "child" : (subAgent ? "subagents" : (agentHandoff ? "handoff" : "off"));
  if (laneId != null) {
    return {
      key: `session-lane:${laneId}:${provider}:${lane}:coord-${coordinationKey}`,
      logicalKey: `wi:${workItemId ?? "none"}:${provider}:${lane}:${skillKey}`,
      reusable: true,
      agentHandoff,
      subAgent,
      coordinationChild,
      ...(coordinationChild && opts._coordinationChildPermitId
        ? { coordinationChildPermitId: opts._coordinationChildPermitId }
        : {}),
      ...(coordinationChild && opts._coordinationChildRemoteToolSurface
        ? { remoteToolSurface: opts._coordinationChildRemoteToolSurface }
        : (!coordinationChild && isRegisteredRemoteToolSurface(opts._remoteToolSurface)
          ? { remoteToolSurface: opts._remoteToolSurface }
          : {})),
    };
  }
  return {
    key: `agent-call:${agentCallId}:${provider}:${lane}`,
    logicalKey: `agent-call:${agentCallId}:${provider}:${lane}`,
    reusable: false,
    agentHandoff,
    subAgent,
    coordinationChild,
    ...(coordinationChild && opts._coordinationChildPermitId
      ? { coordinationChildPermitId: opts._coordinationChildPermitId }
      : {}),
    ...(coordinationChild && opts._coordinationChildRemoteToolSurface
      ? { remoteToolSurface: opts._coordinationChildRemoteToolSurface }
      : (!coordinationChild && isRegisteredRemoteToolSurface(opts._remoteToolSurface)
        ? { remoteToolSurface: opts._remoteToolSurface }
        : {})),
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
    allowWrite: opts.allowWrite === true,
    allowShell: opts.allowShell !== false,
    allowTests: opts.allowTests !== false,
    projectDbWrite: opts.projectDbWrite === true,
    projectDbCapability: opts.projectDbCapability || (opts.projectDbWrite === true ? "write" : "none"),
    allowImageHelpers: opts.allowImageHelpers !== false,
    allowImageGeneration: opts.needsImageGeneration === true,
    agentHandoff,
    subAgent,
    coordinationChild: opts._subAgentChild === true,
    atlasAvailable: opts.disableAtlas !== true && atlasConfig.enabled !== false,
    atlasGateEnabled: opts.atlasGateEnabled !== false,
    atlasPrefetchStatus: opts.atlasPrefetchStatus || "",
    atlas: {
      repoPath: atlasConfig.requestedRepoPath || atlasConfig.repoPath || "",
      repoId: atlasConfig.requestedRepoId || atlasConfig.repoId || "",
      graphDbPath: atlasConfig.requestedGraphDbPath || atlasConfig.graphDbPath || "",
      liveBuffers: atlasConfig.liveBuffersEnabled === false ? "off" : "deterministic-writes",
      viewWaitMs: atlasConfig.viewWaitMs ?? null,
      jobCacheEnabled: atlasConfig.jobCacheEnabled === true,
      jobCacheTtlMs: atlasConfig.jobCacheTtlMs ?? null,
      autoRefreshStale: atlasConfig.autoRefreshStale ?? null,
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
    this.deps = { ...DEFAULT_DEPS, ...deps };
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
    const decision = manager.acquireForJob(job, {
      provider: providerName,
      jobId: job_id,
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

    const freshLineageReasons = new Set(["no_available_session", "transition_reset"]);
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
      recordToolUseObservations,
      retainReplayOutput,
      retainReplayPrompt,
      retainReplayToolUses,
      runWithObservationContext,
    } = this.deps;
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
    const effectiveCapabilityOpts = narrowProviderOptionsToRemoteIssuance(opts);
    const handoffRequired = effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.agentHandoffV1 === true
      && effectiveCapabilityOpts?.sessionPacket?.agent_coordination?.agent_handoff_v1 === true;
    const handoffToolSchemaChars = agentHandoffToolSchemaChars(
      opts.role,
      effectiveCapabilityOpts?._remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
    );
    const terminalAbortController = handoffRequired ? new AbortController() : null;
    const providerAbortSignal = combinedAbortSignal(abortSignal, terminalAbortController?.signal);
    let terminalHandoffStop = null;
    let terminalProviderError = null;
    const unregisterAgentHandoffTerminal = handoffRequired
      ? this.deps.agentHandoffTerminator.subscribe(agentCallId, (event) => {
          if (terminalHandoffStop) return;
          terminalHandoffStop = event;
          terminalAbortController.abort(terminalHandoffAbortReason(event));
        })
      : null;
    const attemptOpts = {
      ...effectiveCapabilityOpts,
      maxOutputTokens: resolvedMaxOutputTokens,
      attemptId: observationContext?.attempt_id ?? opts.attemptId ?? null,
      agentCallId,
      promptChars: prompt.length,
      abortSignal: providerAbortSignal,
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
    const identity = providerAgentIdentity(effectiveCapabilityOpts, {
      providerName,
      role: opts.role,
      workItemId: work_item_id,
      agentCallId,
    });
    let agent = null;
    let agentLease = null;
    let retainReusableAgent = false;
    let unregisterSubAgentParent = null;
    let unregisterSubAgentChild = null;

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
      const dispatched = await dispatcher.dispatch({
        ...identity,
        role: opts.role,
        providerName,
        signal: abortSignal,
        attachment: agentJobAttachment(attemptOpts, {
          providerName,
          cwd,
          projectDir: this.worker.projectDir,
          jobId: job_id,
          workItemId: work_item_id,
          attemptId: observationContext?.attempt_id ?? null,
          agentCallId,
        }),
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
            await agent.mcpGate.callTool(tool, inputArguments, { signal })
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
        if (!terminalHandoffStop || abortSignal?.aborted) throw error;
        terminalProviderError = error;
        providerResult = { output: "", stats: error?.stats || {} };
      }
      if (abortSignal?.aborted) {
        throw providerCallAbortedError(abortSignal, this.worker, job_id);
      }
      const providerOutput = typeof providerResult?.output === "string" ? providerResult.output : "";
      const stats = {
        ...(providerResult?.stats || {}),
        ...(terminalHandoffStop ? {
          terminalHandoffStopped: terminalProviderError != null,
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
      if (handoffFinalization.applied) {
        this.deps.recordObservation({
          work_item_id,
          job_id,
          attempt_id: observationContext?.attempt_id ?? null,
          agent_call_id: agentCallId,
          observation_type: "agent_handoff.committed",
          summary: `Committed terminal agent handoff (${handoffFinalization.digest.slice(0, 12)})`,
          detail: {
            protocol: "posse.agent_handoff.v1",
            digest: handoffFinalization.digest,
            report_calls: handoffFinalization.reportCalls,
            evidence_chars: handoffFinalization.evidenceChars,
            materialized_packet_chars: handoffFinalization.materializedPacketChars,
            continuation_prose_chars: handoffFinalization.continuationProseChars,
            tool_schema_chars: handoffToolSchemaChars,
            tool_schema_estimated_tokens: Math.ceil(handoffToolSchemaChars / 4),
            terminal_prompt_contract_chars: terminalHandoffContractChars(effectiveCapabilityOpts),
            provider_input_tokens: stats.inputTokens ?? null,
            provider_output_tokens: stats.outputTokens ?? null,
            provider_usage_status: stats.inputTokens != null && stats.outputTokens != null
              ? "measured"
              : terminalProviderError != null
                ? "unavailable_after_terminal_stop"
                : "unavailable",
            provider_output_discarded: handoffFinalization.continuationProseChars > 0,
            provider_short_circuited: terminalProviderError != null,
            provider_stop_code: terminalProviderError?.code || null,
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
        input_tokens: stats.inputTokens ?? null,
        output_tokens: stats.outputTokens ?? null,
        output_chars: stats.outputChars ?? (typeof providerOutput === "string" ? providerOutput.length : null),
        turns_used: stats.numTurns ?? null,
        max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        output_truncated: stats.outputTruncated === true,
        replay_memory: getReplayMemoryStats(),
      });
      const accountingStats = {
        ...stats,
        provider: providerName,
        modelTier: tier,
        modelName: stats.modelName || modelName,
        maxOutputTokens: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        outputTruncated: stats.outputTruncated === true,
        outputLimitReason: stats.outputLimitReason || null,
      };

      completeAgentCall(agentCallId, {
        status: "succeeded",
        output_chars: stats.outputChars,
        input_tokens: stats.inputTokens ?? null,
        output_tokens: stats.outputTokens ?? null,
        cached_input_tokens: stats.cachedInputTokens ?? null,
        cache_creation_input_tokens: stats.cacheCreationInputTokens ?? null,
        turns_used: stats.numTurns ?? null,
        max_turns_configured: stats.maxTurns ?? resolvedMaxTurns,
        max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        output_truncated: stats.outputTruncated === true,
        output_limit_reason: stats.outputLimitReason || null,
        model_name: stats.modelName || null,
        duration_ms: stats.durationMs,
        exit_code: stats.exitCode,
        atlas_method: opts.disableAtlas ? null : (stats.atlasMethod || opts.atlasMethod || null),
        atlas_prefetch_status: opts.disableAtlas ? null : (opts.atlasPrefetchStatus || null),
        cost_estimate_usd: this.resolveCallCostEstimate(accountingStats),
        skills: opts.skillsAttached || null,
        session_handle: stats.sessionHandle || stats.responseId || null,
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
        inputTokens: stats.inputTokens ?? null,
        outputTokens: stats.outputTokens ?? null,
        durationMs: stats.durationMs,
        exitCode: stats.exitCode,
        output,
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
          output_chars: stats.outputChars ?? (typeof output === "string" ? output.length : null),
          input_tokens: stats.inputTokens ?? null,
          output_tokens: stats.outputTokens ?? null,
          turns_used: stats.numTurns ?? null,
          max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
          output_truncated: stats.outputTruncated === true,
          duration_ms: stats.durationMs ?? null,
          tool_uses: toolUsesForReplay.length,
          agent_handoff: handoffFinalization.applied ? {
            digest: handoffFinalization.digest,
            report_calls: handoffFinalization.reportCalls,
            evidence_chars: handoffFinalization.evidenceChars,
            materialized_packet_chars: handoffFinalization.materializedPacketChars,
            continuation_prose_chars: handoffFinalization.continuationProseChars,
            tool_schema_chars: handoffToolSchemaChars,
            tool_schema_estimated_tokens: Math.ceil(handoffToolSchemaChars / 4),
            terminal_prompt_contract_chars: terminalHandoffContractChars(effectiveCapabilityOpts),
          } : null,
        },
      });

      return { output, stats, agentCallId, opts: attemptOpts };
    } catch (err) {
      if (abortSignal?.aborted && job_id != null && this.worker?._killReasons?.has?.(job_id)) {
        err._killReason = this.worker._killReasons.get(job_id);
      }
      const stats = err.stats || {};
      recordMemorySample("provider.call.after_error", {
        agent_call_id: agentCallId,
        work_item_id,
        job_id,
        role: opts.role,
        provider: providerName,
        model_tier: tier,
        model_name: stats.modelName || modelName,
        duration_ms: stats.durationMs ?? null,
        input_tokens: stats.inputTokens ?? null,
        output_tokens: stats.outputTokens ?? null,
        error_name: err?.name || null,
        error_message: String(err?.message || err).slice(0, 1000),
        turns_used: stats.numTurns ?? null,
        max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        output_truncated: stats.outputTruncated === true || err.outputTruncated === true,
        replay_memory: getReplayMemoryStats(),
      });
      const accountingStats = {
        ...stats,
        provider: providerName,
        modelTier: tier,
        modelName: stats.modelName || modelName,
        maxOutputTokens: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        outputTruncated: stats.outputTruncated === true || err.outputTruncated === true,
        outputLimitReason: stats.outputLimitReason || err.outputLimitReason || null,
      };
      completeAgentCall(agentCallId, {
        status: "failed",
        output_chars: stats.outputChars || 0,
        input_tokens: stats.inputTokens ?? null,
        output_tokens: stats.outputTokens ?? null,
        cached_input_tokens: stats.cachedInputTokens ?? null,
        cache_creation_input_tokens: stats.cacheCreationInputTokens ?? null,
        turns_used: stats.numTurns ?? null,
        max_turns_configured: stats.maxTurns ?? resolvedMaxTurns,
        max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
        output_truncated: stats.outputTruncated === true || err.outputTruncated === true,
        output_limit_reason: stats.outputLimitReason || err.outputLimitReason || null,
        duration_ms: stats.durationMs || 0,
        exit_code: stats.exitCode,
        error_text: err.message?.slice(0, 2000),
        atlas_method: opts.disableAtlas ? null : (stats.atlasMethod || opts.atlasMethod || null),
        atlas_prefetch_status: opts.disableAtlas ? null : (opts.atlasPrefetchStatus || null),
        cost_estimate_usd: this.resolveCallCostEstimate(accountingStats),
        skills: opts.skillsAttached || null,
        session_handle: stats.sessionHandle || stats.responseId || null,
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
        inputTokens: stats.inputTokens ?? null,
        outputTokens: stats.outputTokens ?? null,
        durationMs: stats.durationMs || 0,
        exitCode: stats.exitCode,
        errorText: err.message?.slice(0, 2000) || null,
        output: failureOutput,
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
          output_chars: stats.outputChars || failureOutput.length || 0,
          input_tokens: stats.inputTokens ?? null,
          output_tokens: stats.outputTokens ?? null,
          turns_used: stats.numTurns ?? null,
          max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
          output_truncated: stats.outputTruncated === true || err.outputTruncated === true,
          duration_ms: stats.durationMs || 0,
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
            retain: identity.reusable && retainReusableAgent,
            reason: "provider_attempt_complete",
          });
        } catch {
          // A scope that cannot be cleared makes this lifetime gate unsafe to
          // reuse. Destroying the Agent unregisters the owner session; the next
          // provider attempt must be dispatched with a newly minted gate.
          retainReusableAgent = false;
        }
        if (agent && !agentLease && (!identity.reusable || !retainReusableAgent)) {
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
    let providerName = await timeProviderSetupPhase("provider.select", {
      role: opts.role,
      provider: jobProvider || null,
      job_id,
      work_item_id,
    }, () => jobProvider || selectProviderName(opts.role));
    const initialProviderName = providerName;
    const configuredPool = await timeProviderSetupPhase("provider.pool", {
      role: opts.role,
      provider: providerName,
      job_id,
      work_item_id,
    }, () => Array.isArray(opts.allowedProviders) && opts.allowedProviders.length > 0
      ? [...new Set(opts.allowedProviders.filter(Boolean))]
      : (opts.role === "artificer" && jobProvider ? [jobProvider] : getAvailableProviders(opts.role)));
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
    }, () => getProvider(opts.role, providerName));
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
    // default would run (and bill) a model the job never selected.
    const jobPinnedModel = !!effectiveJobModelName && selectedExecutionModelName === effectiveJobModelName;
    const executionModelName = jobPinnedModel
      ? selectedExecutionModelName
      : resolveCatalogSafeTierModel(providerName, tier, selectedExecutionModelName);

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
        opts = { ...opts, atlasMethod: attachment?.method || null };
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
        attempt_id: ambient.attempt_id ?? null,
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
      const runtimeFallbackModel = opts._modelFallbackAttempted
        ? null
        : (isRuntimeModelError(activeErr) ? resolveRuntimeModelFallback(providerName, tier, executionModelName) : null);
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
            const fbProvider = getProvider(opts.role, fallbackName);
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
            const fbModelName = resolveCatalogSafeTierModel(
              fallbackName,
              tier,
              fbTierConfig.model || getDefaultTierModel(fallbackName, tier),
            );
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
            const fallbackPrompt = buildFallbackPrompt
              ? await buildFallbackPrompt({
                providerName: fallbackName,
                previousProviderName: providerName,
                role: opts.role,
              })
              : prompt;
            const { output: fbOutput, stats: fbStats } = await this._executeOneAttempt(fallbackPrompt, fbOpts, {
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
                attempt_id: ambient.attempt_id ?? null,
                role: opts.role ?? ambient.role ?? null,
              },
              abortSignal: fbAc.signal,
            });

            if (job_id) {
              updateJobProvider(job_id, fallbackName, fbStats.modelName || fbModelName || null);
            }
            this.emitStatus(job_id, `${C.green}[fallback] ${fallbackName} succeeded${C.reset}`);
            return { output: fbOutput, stats: fbStats };
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
