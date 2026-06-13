// ATLAS MCP proxy.
//
// The deterministic MCP server exposes ATLAS tool schemas and forwards calls
// into the in-process ATLAS v2 ledger/view backend. This proxy is now a native
// v2 adapter only.

import fs from "fs";
import path from "path";
import { recordObservation, atlasSummaryHint, getObservationContext } from "../../../observability/functions/observations.js";
import { noteAtlasCall, unlockGateForDeadAtlasResult } from "./gate.js";
import { SURFACED_ATLAS_TOOL_DEFS } from "./tool-descriptors.js";
import { coerceLooseAtlasSymbolArgs, extractAtlasResponseTelemetry, extractAtlasResultArtifacts, validateAtlasPayloadSymbolIds } from "../../../atlas/functions/v2/signal-extraction.js";
import { ATLAS_TOOL_ACTIONS } from "../../../atlas/functions/v2/contracts/tool-params.js";
import { ATLAS_TOOL_PARAM_SCHEMAS, MEMORY_TYPES } from "../../../atlas/functions/v2/contracts/tool-schemas.js";
import { ledgerDbPath, mainViewPath, worktreeViewPath } from "../../../atlas/functions/v2/runtime-paths.js";
import { viewFreshness, waitForCurrentView } from "../../../atlas/functions/v2/view-health.js";
import { AsyncResourceGate } from "../../../../shared/concurrency/functions/async-gate.js";
import { resolveTargetBranch } from "../../../git/functions/target-branch.js";
import { canonicalAtlasActionName, formatAtlasToolDisplayName } from "../../../../functions/tools/mcp-surface.js";

const REQUEST_TIMEOUT_MS = 120_000;
const ATLAS_DEDUPE_WINDOW_MS = 1500;
const ATLAS_READONLY_DEDUPE_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  "action.search",
  "manual",
  "info",
  "symbol.search",
  "symbol.getcard",
  "symbol.getcards",
  "slice.build",
  "context",
  "context.summary",
  "agent.context",
  "repo.status",
  "repo.overview",
  "repo.quality",
  "code.getskeleton",
  "code.gethotpath",
  "code.needwindow",
  "file.read",
  "pr.risk",
  "memory.query",
  "policy.get",
  "runtime.queryoutput",
  "usage.stats",
]);
const ATLAS_V2_VIEW_OPTIONAL_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  "action.search",
  "manual",
  "workflow",
  "info",
  "repo.register",
  "index.refresh",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "agent.feedback.query",
  "memory.store",
  "memory.query",
  "memory.remove",
  "policy.get",
  "policy.set",
  "runtime.execute",
  "runtime.queryOutput",
  "usage.stats",
  "scip.ingest",
]);
const ATLAS_V2_GATEWAY_ACTIONS = new Set(["query", "code", "repo", "agent"]);
const MEMORY_SURFACE_TASK_TYPES = new Set(MEMORY_TYPES);

let _config = null;           // v2 proxy config: cwd, ledger/view paths, role/job metadata, embedding settings
let _initPromise = null;
let _toolSchemas = [];
let _atlasToolNames = new Set();
const _inflightReadOnlyCalls = new Map(); // dedupeKey -> Promise<{ result, ok, empty, resultChars, errorMsg }>
const _v2RefreshQueue = new Map(); // queueKey -> { job: Promise<boolean>, head: number }
const ATLAS_V2_DISPATCH_GATE = new AsyncResourceGate({ name: "ATLAS v2 dispatch" });
let _lastSuccessfulDedupe = null;  // { key, atMs, payload }
let _diagnostics = {          // surfaced on failure so we fail loud, not silent
  initError: null,
};

export function configureAtlasProxy(cfg = {}) {
  if (cfg?.transport !== "v2") {
    _config = null;
    _initPromise = null;
    _toolSchemas = [];
    _atlasToolNames = new Set();
    _v2RefreshQueue.clear();
    return;
  }
  const env = cfg.env || {};
  _initPromise = null;
  _toolSchemas = [];
  _atlasToolNames = new Set();
  _config = {
    transport: "v2",
    cwd: cfg.cwd || undefined,
    repoRoot: cfg.repoRoot || cfg.requestedRepoPath || null,
    viewDbPath: cfg.viewDbPath || null,
    ledgerDbPath: cfg.ledgerDbPath || null,
    env,
    semanticEnabled: cfg.semanticEnabled === true,
    vectorBackend: cfg.vectorBackend || null,
    embeddingProvider: cfg.embeddingProvider || null,
    atlasEmbeddingProvider: cfg.atlasEmbeddingProvider || cfg.embeddingProvider || null,
    embeddingEndpoint: cfg.embeddingEndpoint || null,
    embeddingModel: cfg.embeddingModel || null,
    embeddingDim: cfg.embeddingDim ?? null,
    embeddingApiKey: cfg.embeddingApiKey || env.POSSE_ATLAS_EMBEDDING_API_KEY || null,
    embeddingModelVersion: cfg.embeddingModelVersion || null,
    embeddingTimeoutMs: cfg.embeddingTimeoutMs ?? null,
    embeddingHeaders: cfg.embeddingHeaders || null,
    embeddingSendDimensions: cfg.embeddingSendDimensions ?? null,
    remoteEncoderMode: cfg.remoteEncoderMode || "off",
    remoteEncoderUrl: cfg.remoteEncoderUrl || null,
    remoteEncoderModel: cfg.remoteEncoderModel || null,
    remoteEncoderDim: cfg.remoteEncoderDim ?? null,
    remoteEncoderModelVersion: cfg.remoteEncoderModelVersion || null,
    remoteEncoderTimeoutMs: cfg.remoteEncoderTimeoutMs ?? null,
    viewWaitMs: cfg.viewWaitMs ?? null,
    autoRefreshStale: cfg.autoRefreshStale ?? null,
    atlasV2Mode: cfg.atlasV2Mode || null,
    serverName: cfg.serverName || "atlas-v2",
    jobId: cfg.jobId ?? null,
    workItemId: cfg.workItemId ?? null,
    role: cfg.role || null,
    repoId: cfg.repoId || null,
    gateScopeKey: cfg.gateScopeKey || null,
    logger: typeof cfg.logger === "function" ? cfg.logger : () => {},
  };
}

export function isConfigured() {
  return !!_config;
}

export async function getAtlasToolSchemas() {
  if (!_config) return [];
  try {
    await _ensureInitialized();
  } catch (err) {
    _config?.logger?.({ event: "atlas_proxy_init_failed", error: String(err?.message || err) });
    return [];
  }
  return _toolSchemas.map((schema) => ({ ...schema }));
}

export function isAtlasToolName(toolName) {
  return _atlasToolNames.has(String(toolName || ""));
}

// Forwards a tools/call invocation to ATLAS v2. Returns the raw MCP result
// payload ({ content, isError? }) or a synthesized error payload on failure.
// Side effects: records an observation and notifies the gate.
export async function forwardAtlasCall({ toolName, args = {}, source = null } = {}) {
  if (!_config) {
    return _errorPayload(`ATLAS proxy is not configured`);
  }
  try {
    await _ensureInitialized();
  } catch (err) {
    // Record an observation and unlock native fallback immediately. Init and
    // transport failures mean ATLAS is unavailable, so spending model turns on
    // repeated failing ATLAS calls does not add information.
    const errorMsg = err?.message || String(err);
    const initHint = atlasSummaryHint(args, toolName);
    try {
      const ctx = getObservationContext() || {};
      const obsType = _forwardObservationType(toolName);
      recordObservation({
        work_item_id: _config.workItemId ?? ctx.work_item_id ?? undefined,
        job_id: _config.jobId ?? ctx.job_id ?? undefined,
        attempt_id: ctx.attempt_id ?? undefined,
        observation_type: obsType,
        summary: `ATLAS ${toolName}${initHint ? ` (${initHint})` : ""} failed (init) 0ms`,
        detail: {
          kind: "atlas",
          origin: "agent",
          action: toolName,
          role: _config.role ?? ctx.role ?? null,
          args: _summarizeArgs(args),
          ...(_summarizeSource(source) ? { source: _summarizeSource(source) } : {}),
          ok: false,
          empty: false,
          duration_ms: 0,
          result_chars: 0,
          error: errorMsg,
          transport: "mcp-proxy",
          server: _config.serverName,
          stage: "init",
        },
      });
    } catch { /* observation recording must never break tool execution */ }
    const initMessage = `ATLAS proxy init failed: ${errorMsg}`;
    const initNotice = unlockGateForDeadAtlasResult(initMessage, {
      scopeKey: _config.gateScopeKey,
      reason: "atlas_proxy_init_failed",
    });
    return _errorPayload(initNotice ? `${initMessage}\n\n${initNotice}` : initMessage);
  }

  const normalizedArgs = _normalizeToolArgs(toolName, args);
  const dedupeEligible = _isDedupeEligible(toolName, normalizedArgs);
  const dedupeKey = dedupeEligible ? _buildDedupeKey(toolName, normalizedArgs) : null;
  if (dedupeEligible && dedupeKey && ATLAS_DEDUPE_WINDOW_MS > 0 && _lastSuccessfulDedupe?.key === dedupeKey) {
    const elapsed = Date.now() - Number(_lastSuccessfulDedupe.atMs || 0);
    if (elapsed >= 0 && elapsed <= ATLAS_DEDUPE_WINDOW_MS) {
      const replay = _cloneDedupePayload(_lastSuccessfulDedupe.payload);
      const replayMeta = _analyzeAtlasResultPayload(replay, { toolName, args: normalizedArgs });
      _recordForwardObservation({
        toolName,
        args,
        source,
        ok: replayMeta.ok,
        empty: replayMeta.empty,
        durationMs: 0,
        resultChars: replayMeta.resultChars,
        errorMsg: replayMeta.errorMsg,
        deduped: "cache",
        tokenUsage: replayMeta.tokenUsage,
        artifacts: replayMeta.artifacts,
        responseTelemetry: replayMeta.responseTelemetry,
      });
      noteAtlasCall({
        action: toolName,
        ok: replayMeta.ok,
        empty: replayMeta.empty,
        args: normalizedArgs,
        artifacts: replayMeta.artifacts,
        cwd: _config.cwd,
        scopeKey: _config.gateScopeKey,
      });
      return replay;
    }
  }

  const start = Date.now();
  let result = null;
  let ok = false;
  let empty = true;
  let errorMsg = null;
  let resultChars = 0;
  let tokenUsage = null;
  let dedupedMode = null;

  const executeCall = async () => {
    const v2 = await _executeV2Call(toolName, normalizedArgs);
    if (!v2) {
      return {
        result: _errorPayload("ATLAS v2 backend unavailable"),
        ok: false,
        empty: true,
        resultChars: 0,
        errorMsg: "v2 backend unavailable",
        tokenUsage: null,
        responseTelemetry: null,
      };
    }
    return v2;
  };

  let callMeta = null;
  if (dedupeEligible && dedupeKey) {
    let inflight = _inflightReadOnlyCalls.get(dedupeKey);
    if (!inflight) {
      inflight = executeCall().finally(() => {
        if (_inflightReadOnlyCalls.get(dedupeKey) === inflight) _inflightReadOnlyCalls.delete(dedupeKey);
      });
      _inflightReadOnlyCalls.set(dedupeKey, inflight);
    } else {
      dedupedMode = "inflight";
    }
    callMeta = await inflight;
  } else {
    callMeta = await executeCall();
  }
  result = callMeta.result;
  ok = callMeta.ok;
  empty = callMeta.empty;
  errorMsg = callMeta.errorMsg;
  resultChars = callMeta.resultChars;
  tokenUsage = callMeta.tokenUsage || null;
  const responseTelemetry = callMeta.responseTelemetry || null;

  const durationMs = Date.now() - start;
  if (dedupeEligible && dedupeKey && ok) {
    _lastSuccessfulDedupe = {
      key: dedupeKey,
      atMs: Date.now(),
      payload: _cloneDedupePayload(result),
    };
  } else if (!ok && _lastSuccessfulDedupe?.key === dedupeKey) {
    _lastSuccessfulDedupe = null;
  }

  const artifacts = ok ? extractAtlasResultArtifacts(result, { action: toolName, args: normalizedArgs }) : null;
  _recordForwardObservation({
    toolName,
    args,
    source,
    ok,
    empty,
    durationMs,
    resultChars,
    errorMsg,
    deduped: dedupedMode,
    tokenUsage,
    artifacts,
    responseTelemetry,
  });

  noteAtlasCall({
    action: toolName,
    ok,
    empty,
    args: normalizedArgs,
    artifacts,
    cwd: _config.cwd,
    scopeKey: _config.gateScopeKey,
  });

  if (errorMsg) {
    const message = `ATLAS call ${toolName} failed: ${errorMsg}`;
    const deadNotice = unlockGateForDeadAtlasResult(message, { scopeKey: _config.gateScopeKey });
    return _errorPayload(deadNotice ? `${message}\n\n${deadNotice}` : message);
  }
  return result;
}

export function getDiagnostics() {
  return { ..._diagnostics };
}

export async function shutdown() {
  _initPromise = null;
}

// Test hooks.
export function __resetForTests() {
  _config = null;
  _initPromise = null;
  _toolSchemas = [];
  _atlasToolNames = new Set();
  _inflightReadOnlyCalls.clear();
  _v2RefreshQueue.clear();
  _lastSuccessfulDedupe = null;
  _v2LoadFailureLogged = false;
  _diagnostics = { initError: null };
}

// ── internals ────────────────────────────────────────────────────────────

function _ensureInitialized() {
  if (_initPromise) return _initPromise;
  _initPromise = _doInitialize().catch((err) => {
    _diagnostics.initError = String(err?.message || err);
    // Clear the promise so a later call can retry after transient init failure.
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

async function _doInitialize() {
  _toolSchemas = _buildV2ToolSchemas();
  _atlasToolNames = new Set(_toolSchemas.map((t) => String(t?.name || "")).filter(Boolean));
}

function _buildV2ToolSchemas() {
  const v2Actions = new Set(ATLAS_TOOL_ACTIONS);
  const schemas = Object.entries(SURFACED_ATLAS_TOOL_DEFS)
    .filter(([action]) => v2Actions.has(action))
    .map(([action, def]) => ({
    name: `atlas.${action}`,
    description: def.description,
    inputSchema: def.parameters || { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: `ATLAS ${action}` },
  }));
  return schemas.map((schema) => ({ ...schema }));
}

// Safe wrapper around the user-provided logger.
function _log(entry) {
  const fn = _config?.logger;
  if (typeof fn !== "function") return;
  try { fn(entry); } catch { /* logger must not crash the proxy */ }
}

function _errorPayload(message, error = null) {
  const payload = {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
  const structuredError = _structuredEnvelopeError(error);
  if (structuredError) {
    payload.structuredContent = { error: structuredError };
    payload._meta = { atlasError: structuredError };
  }
  return payload;
}

function _structuredEnvelopeError(error) {
  if (!error || typeof error !== "object") return null;
  const out = {
    code: error.code ? String(error.code) : "error",
    message: error.message ? String(error.message) : (error.code ? String(error.code) : "ATLAS error"),
  };
  if (error.details !== undefined) out.details = error.details;
  return out;
}

function _normalizeActionName(toolName = "") {
  const raw = String(toolName || "");
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length).toLowerCase();
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".").toLowerCase();
  return raw.toLowerCase();
}

function _effectiveToolActionName(toolName = "", args = {}) {
  const action = _normalizeActionName(toolName);
  if (!ATLAS_V2_GATEWAY_ACTIONS.has(action)) return action;
  return _gatewayEffectiveAction(action, args).toLowerCase();
}

function _gatewayEffectiveAction(action, args = {}) {
  const target = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  return target || action;
}

function _isDedupeEligible(toolName = "", args = {}) {
  const effective = _effectiveToolActionName(toolName, args);
  return !!effective && ATLAS_READONLY_DEDUPE_ACTIONS.has(effective);
}

function _stableStringify(value) {
  if (value === undefined) return "null";
  if (value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => _stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${_stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function _buildDedupeKey(toolName, normalizedArgs = {}) {
  return `${String(toolName || "")}|${_stableStringify(normalizedArgs)}`;
}

function _cloneDedupePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  try { return JSON.parse(JSON.stringify(payload)); } catch { return payload; }
}

function _finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _normalizeAtlasTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const atlasTokens = _finiteNumber(usage.atlasTokens ?? usage.atlas_tokens);
  const rawEquivalent = _finiteNumber(usage.rawEquivalent ?? usage.raw_equivalent);
  if (atlasTokens == null || rawEquivalent == null || rawEquivalent <= 0) return null;
  const savedTokens = rawEquivalent - atlasTokens;
  const savingsPercent = _finiteNumber(usage.savingsPercent ?? usage.savings_percent);
  return {
    atlas_tokens: atlasTokens,
    raw_equivalent: rawEquivalent,
    saved_tokens: savedTokens,
    savings_percent: savingsPercent ?? (rawEquivalent > 0 ? Math.round((savedTokens / rawEquivalent) * 100) : 0),
    meter: typeof usage.meter === "string" ? usage.meter.slice(0, 160) : null,
  };
}

function _extractAtlasTokenUsageFromValue(value) {
  if (!value || typeof value !== "object") return null;
  const direct = _normalizeAtlasTokenUsage(value._tokenUsage || value.tokenUsage);
  if (direct) return direct;
  const meta = value._meta && typeof value._meta === "object" ? value._meta : null;
  return _normalizeAtlasTokenUsage(meta?._tokenUsage || meta?.tokenUsage);
}

function _extractAtlasTokenUsageFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return _extractAtlasTokenUsageFromValue(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function _analyzeAtlasResultPayload(result, { toolName = null, args = {} } = {}) {
  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.map((c) => (c && typeof c.text === "string") ? c.text : "").join("");
  const resultChars = text.length;
  const empty = !text || text.trim().length === 0;
  const ok = !result?.isError;
  const errorMsg = (!ok && text) ? (text.length > 500 ? `${text.slice(0, 500)}\u2026` : text) : null;
  const tokenUsage = _extractAtlasTokenUsageFromValue(result) || _extractAtlasTokenUsageFromText(text);
  const artifacts = ok ? extractAtlasResultArtifacts(text, { action: toolName, args }) : null;
  const responseTelemetry = ok ? extractAtlasResponseTelemetry(text) : null;
  return { ok, empty, resultChars, errorMsg, tokenUsage, artifacts, responseTelemetry };
}

function _recordForwardObservation({
  toolName,
  args,
  source = null,
  ok,
  empty,
  durationMs,
  resultChars,
  errorMsg,
  deduped = null,
  tokenUsage = null,
  artifacts = null,
  responseTelemetry = null,
} = {}) {
  const action = canonicalAtlasActionName(toolName) || toolName;
  const hint = atlasSummaryHint(args, action);
  const errorPreview = errorMsg ? String(errorMsg).split(/\r?\n/)[0].slice(0, 80) : "";
  try {
    const ctx = getObservationContext() || {};
    const obsType = _forwardObservationType(action, source);
    const displayName = formatAtlasToolDisplayName(action) || `atlas ${action}`;
    recordObservation({
      work_item_id: _config.workItemId ?? ctx.work_item_id ?? undefined,
      job_id: _config.jobId ?? ctx.job_id ?? undefined,
      attempt_id: ctx.attempt_id ?? undefined,
      observation_type: obsType,
      summary: `${displayName}${hint ? ` (${hint})` : ""}${deduped ? ` deduped:${deduped}` : ""}${ok ? (empty ? " empty" : "") : ` failed${errorPreview ? `: ${errorPreview}` : ""}`} (${durationMs}ms)`,
      detail: {
        kind: "atlas",
        origin: "agent",
        action,
        role: _config.role ?? ctx.role ?? null,
        args: _summarizeArgs(args),
        ...(_summarizeSource(source) ? { source: _summarizeSource(source) } : {}),
        ok: !!ok,
        empty: !!empty,
        duration_ms: Number(durationMs || 0),
        result_chars: Number(resultChars || 0),
        error: errorMsg || null,
        transport: "mcp-proxy",
        server: _config.serverName,
        deduped: deduped || null,
        token_usage: tokenUsage || null,
        atlas_artifacts: artifacts || null,
        response: responseTelemetry ? {
          ...responseTelemetry,
          result_chars: Number(resultChars || 0),
        } : null,
      },
    });
  } catch { /* observation recording must never break tool execution */ }
}

function _normalizeForwardAction(toolName = "") {
  const canonical = canonicalAtlasActionName(toolName);
  if (canonical) return canonical;
  let action = String(toolName || "").trim().toLowerCase();
  if (action.startsWith("atlas.")) action = action.slice("atlas.".length);
  if (action.startsWith("atlas_")) action = action.slice("atlas_".length);
  return action.replace(/_/g, ".");
}

function _forwardObservationType(toolName = "", source = null) {
  const action = _normalizeForwardAction(toolName);
  if (action === "buffer.push") return "atlas.buffer_push";
  if (action === "index.refresh" && source?.kind === "deterministic_write_refresh") return "atlas.index_refresh";
  return "tool.atlas";
}

function _summarizeSource(source = null) {
  if (!source || typeof source !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(source).slice(0, 12)) {
    if (value == null) out[key] = null;
    else if (typeof value === "string") out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map((item) => String(item).slice(0, 120));
    else out[key] = "[object]";
  }
  return Object.keys(out).length > 0 ? out : null;
}

function _summarizeArgs(args = {}) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  const keys = Object.keys(args).slice(0, 8);
  for (const key of keys) {
    const value = args[key];
    if (value == null) out[key] = null;
    else if (typeof value === "string") out[key] = value.length > 160 ? `${value.slice(0, 160)}…` : value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = `[array ${value.length}]`;
    else if (typeof value === "object") out[key] = "[object]";
    else out[key] = String(value).slice(0, 80);
  }
  return out;
}

function _normalizeToolArgs(toolName, args = {}) {
  const input = (args && typeof args === "object") ? { ...args } : {};
  const action = _resolveV2Action(toolName) || _normalizeForwardAction(toolName);

  if (input.repo_id && !input.repoId) input.repoId = String(input.repo_id);
  if (_atlasActionSupportsRepoId(action)) {
    if (!input.repoId && _config?.repoId) input.repoId = _config.repoId;
  } else {
    delete input.repoId;
  }
  delete input.repo_id;

  // Model/tooling drift sometimes uses path/file for ATLAS file tools. Normalize
  // these aliases to filePath so strict schema validation does not reject.
  if (action === "file.read" || action === "file.write") {
    if (!input.filePath && typeof input.path === "string" && input.path.trim()) {
      input.filePath = input.path.trim();
    }
    if (!input.filePath && typeof input.file === "string" && input.file.trim()) {
      input.filePath = input.file.trim();
    }
    delete input.path;
    delete input.file;
  }
  if (action === "code.getSkeleton" || action === "code.getHotPath" || action === "code.needWindow") {
    if (!input.file && typeof input.path === "string" && input.path.trim()) {
      input.file = input.path.trim();
    }
    if (!input.file && typeof input.filePath === "string" && input.filePath.trim()) {
      input.file = input.filePath.trim();
    }
    delete input.path;
    delete input.filePath;
  }
  coerceAtlasArrayParams(action, input);
  sanitizeMemoryArgs(action, input);
  coerceLooseAtlasSymbolArgs(action, input);
  validateAtlasPayloadSymbolIds(action, input);
  return input;
}

function sanitizeMemoryArgs(action, input) {
  if (!input || typeof input !== "object") return;
  if (action === "memory.surface" && input.taskType != null) {
    const taskType = String(input.taskType || "").trim();
    if (MEMORY_SURFACE_TASK_TYPES.has(taskType)) input.taskType = taskType;
    else delete input.taskType;
  }
  if ((action === "memory.surface" || action === "memory.query") && Array.isArray(input.types)) {
    const types = input.types
      .map((value) => String(value || "").trim())
      .filter((value) => MEMORY_SURFACE_TASK_TYPES.has(value));
    if (types.length > 0) input.types = [...new Set(types)];
    else delete input.types;
  }
}

function coerceAtlasArrayParams(action, input) {
  if (!input || typeof input !== "object") return;
  coerceLooseSymbolsAlias(action, input);
  for (const key of ATLAS_ARRAY_PARAM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const parsed = parseStringifiedArray(input[key]);
    if (parsed) input[key] = parsed;
  }
}

const ATLAS_ARRAY_PARAM_KEYS = Object.freeze([
  "actions",
  "cards",
  "editedFiles",
  "entities",
  "fileRelPaths",
  "focusPaths",
  "focusSymbols",
  "identifiersToFind",
  "kind",
  "missingSymbols",
  "paths",
  "symbolIds",
  "symbolRefs",
  "tags",
  "targetFiles",
  "targetSymbols",
  "types",
  "usefulSymbols",
]);

function coerceLooseSymbolsAlias(action, input) {
  if (!Object.prototype.hasOwnProperty.call(input, "symbols")) return;
  const parsed = parseStringifiedArray(input.symbols) || (Array.isArray(input.symbols) ? input.symbols : null);
  if (!parsed) return;
  if ((action === "memory.store" || action === "memory.query" || action === "memory.surface" || action === "symbol.getCards") && !input.symbolIds) {
    input.symbolIds = parsed;
  } else if (action === "slice.build" && !input.entrySymbols) {
    input.entrySymbols = parsed;
  } else if (action === "context" && !input.focusSymbols) {
    input.focusSymbols = parsed;
  } else if (action === "edit.plan" && !input.targetSymbols) {
    input.targetSymbols = parsed;
  }
  delete input.symbols;
}

function parseStringifiedArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  let current = value.trim();
  if (!current) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const parsed = JSON.parse(current);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed !== "string") return null;
      current = parsed.trim();
    } catch {
      return null;
    }
  }
  return null;
}

function _atlasActionSupportsRepoId(action) {
  const schema = ATLAS_TOOL_PARAM_SCHEMAS[action];
  return !!(schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, "repoId"));
}

// ============================================================================
// ATLAS v2 cutover hooks
// ============================================================================

function _resolveV2Action(toolName) {
  const raw = String(toolName || "").trim();
  if (!raw) return null;
  // Strip the "atlas." (mcp) or "atlas_" (provider-flat) prefixes; ATLAS_TOOL_ACTIONS
  // entries are bare action names like "repo.status" / "code.getSkeleton".
  let action = raw;
  if (action.startsWith("atlas.")) action = action.slice("atlas.".length);
  else if (action.startsWith("atlas_")) action = action.slice("atlas_".length).replace(/_/g, ".");
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (action))) return action;
  // Try a lowercase variant for tools that already arrive case-folded by
  // the deterministic-MCP renamer. The full action set is small enough
  // that a linear scan is fine.
  const lowered = action.toLowerCase();
  for (const candidate of ATLAS_TOOL_ACTIONS) {
    if (candidate.toLowerCase() === lowered) return candidate;
  }
  return null;
}

function _v2EnvelopeToMcp(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { result: _errorPayload("v2 dispatch returned no envelope"), ok: false };
  }
  if (envelope.ok === false || envelope.error) {
    const message = envelope.error?.message || envelope.error?.code || "v2 backend error";
    return {
      result: _errorPayload(`ATLAS v2 ${envelope.action || ""}: ${message}`, envelope.error),
      ok: false,
    };
  }
  const data = envelope.data === undefined ? {} : envelope.data;
  const payload = envelope.meta && data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, _meta: envelope.meta }
    : data;
  const text = (() => {
    try { return JSON.stringify(payload, null, 2); }
    catch { return String(payload); }
  })();
  return {
    result: { content: [{ type: "text", text }], isError: false },
    ok: true,
  };
}

let _v2DispatchModule = null;
let _v2ClassesModule = null;
let _v2EmbeddingResourcesModule = null;
let _v2LoadFailureLogged = false;

async function _loadV2Modules() {
  if (_v2DispatchModule && _v2ClassesModule && _v2EmbeddingResourcesModule) {
    return {
      dispatch: _v2DispatchModule.dispatch,
      Ledger: _v2ClassesModule.Ledger,
      View: _v2ClassesModule.View,
      openEmbeddingResources: _v2EmbeddingResourcesModule.openEmbeddingResources,
      semanticDispatchEnabled: _v2EmbeddingResourcesModule.semanticDispatchEnabled,
    };
  }
  try {
    const [dispatchMod, ledgerMod, viewMod, embeddingResourcesMod] = await Promise.all([
      import("../../../atlas/functions/v2/retrieval/dispatch.js"),
      import("../../../atlas/classes/v2/Ledger.js"),
      import("../../../atlas/classes/v2/View.js"),
      import("../../../atlas/functions/v2/embeddings/resources.js"),
    ]);
    _v2DispatchModule = dispatchMod;
    _v2ClassesModule = { Ledger: ledgerMod.Ledger, View: viewMod.View };
    _v2EmbeddingResourcesModule = embeddingResourcesMod;
    return {
      dispatch: dispatchMod.dispatch,
      Ledger: ledgerMod.Ledger,
      View: viewMod.View,
      openEmbeddingResources: embeddingResourcesMod.openEmbeddingResources,
      semanticDispatchEnabled: embeddingResourcesMod.semanticDispatchEnabled,
    };
  } catch (err) {
    if (!_v2LoadFailureLogged) {
      _v2LoadFailureLogged = true;
      // eslint-disable-next-line no-console
      console.warn(`[atlas-v2] failed to load v2 modules: ${err?.message || err}`);
    }
    return null;
  }
}

function _resolveRepoRoot() {
  const candidates = [
    _config?.repoRoot,
    _config?.cwd,
    getObservationContext()?.repo_root,
    process.cwd(),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function _existingFilePath(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return fs.existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

function _candidateV2ViewPaths(repoRoot) {
  const candidates = [
    _config?.viewDbPath,
    _config?.cwd ? worktreeViewPath(_config.cwd) : null,
    repoRoot ? worktreeViewPath(repoRoot) : null,
    repoRoot ? mainViewPath(repoRoot) : null,
  ];
  /** @type {string[]} */
  const paths = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const found = _existingFilePath(candidate);
    if (found && !seen.has(found)) {
      seen.add(found);
      paths.push(found);
    }
  }
  return paths;
}

function _preferredExistingV2ViewPath() {
  const candidates = [
    _config?.viewDbPath,
    _config?.cwd ? worktreeViewPath(_config.cwd) : null,
  ];
  for (const candidate of candidates) {
    const found = _existingFilePath(candidate);
    if (found) return found;
  }
  return null;
}

function _uniqueExistingFilePaths(candidates = []) {
  /** @type {string[]} */
  const paths = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const found = _existingFilePath(candidate);
    if (found && !seen.has(found)) {
      seen.add(found);
      paths.push(found);
    }
  }
  return paths;
}

function _candidateV2LedgerPaths({ configuredRepoRoot, viewMeta }) {
  const candidates = [
    _config?.ledgerDbPath,
    viewMeta?.repo_root ? ledgerDbPath(viewMeta.repo_root) : null,
    configuredRepoRoot ? ledgerDbPath(configuredRepoRoot) : null,
  ];
  return _uniqueExistingFilePaths(candidates);
}

function _resolveV2LedgerPath({ configuredRepoRoot, viewMeta }) {
  return _candidateV2LedgerPaths({ configuredRepoRoot, viewMeta })[0] || null;
}

function _ledgerSupportsViewMeta(ledger, viewMeta) {
  const branch = typeof viewMeta?.branch === "string" && viewMeta.branch ? viewMeta.branch : null;
  if (!ledger || !branch || typeof ledger.getBranch !== "function") return true;
  try {
    return !!ledger.getBranch(branch);
  } catch {
    return false;
  }
}

function _openV2LedgerForView({ Ledger, configuredRepoRoot, viewMeta }) {
  const paths = _candidateV2LedgerPaths({ configuredRepoRoot, viewMeta });
  let fallback = null;
  for (const dbPath of paths) {
    let candidate = null;
    try {
      candidate = Ledger.open({ dbPath });
      if (_ledgerSupportsViewMeta(candidate, viewMeta)) {
        if (fallback) {
          try { fallback.close(); } catch { /* ignore */ }
        }
        return { ledger: candidate, dbPath };
      }
      _log({
        event: "atlas_v2_ledger_branch_missing",
        path: dbPath,
        branch: viewMeta?.branch || null,
      });
      if (!fallback) fallback = candidate;
      else {
        try { candidate.close(); } catch { /* ignore */ }
      }
    } catch (err) {
      _log({
        event: "atlas_v2_ledger_candidate_unreadable",
        path: dbPath,
        error: String(err?.message || err),
      });
      try { candidate?.close?.(); } catch { /* ignore */ }
    }
  }
  return fallback ? { ledger: fallback, dbPath: null } : { ledger: null, dbPath: null };
}

function _resolveV2ReadRoot({ configuredRepoRoot, viewMeta, viewPath }) {
  const cwd = _config?.cwd;
  if (cwd && viewPath && viewPath === worktreeViewPath(cwd)) return cwd;
  return cwd || viewMeta?.repo_root || configuredRepoRoot || process.cwd();
}

function _atlasV2ViewWaitMs() {
  const raw = _config?.viewWaitMs;
  if (raw == null || String(raw).trim() === "") return 2500;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 30000);
  return 2500;
}

function _viewNotReadyOutcome({ toolName, probe, waitMs }) {
  const pathText = probe?.dbPath ? ` (${probe.dbPath})` : "";
  const reason = probe?.error?.message || "view is not ready";
  const message = `ATLAS v2 ${toolName} view is not current after ${waitMs}ms${pathText}: ${reason}`;
  return {
    result: _errorPayload(message),
    ok: false,
    empty: true,
    resultChars: 0,
    errorMsg: message,
    tokenUsage: null,
  };
}

function _mainViewBranchMismatch({ viewPath, meta, configuredRepoRoot }) {
  if (!_isMainViewPath(viewPath, configuredRepoRoot)) return null;
  const baselineBranch = _baselineBranchForRepo(configuredRepoRoot);
  const viewBranch = typeof meta?.branch === "string" && meta.branch ? meta.branch : null;
  if (!baselineBranch || !viewBranch || viewBranch === baselineBranch) return null;
  return {
    ok: false,
    exists: true,
    dbPath: viewPath,
    view: null,
    meta,
    error: new Error(`main view branch '${viewBranch}' does not match target branch '${baselineBranch}'`),
    freshness: {
      current: false,
      branch: viewBranch,
      ledgerSeq: Number.isInteger(Number(meta?.ledger_seq)) ? Number(meta.ledger_seq) : 0,
      headSeq: null,
      reason: `main view branch '${viewBranch}' does not match target branch '${baselineBranch}'`,
    },
    attempts: 1,
  };
}

function _isV2LifecycleAction(action) {
  return action === "repo.register" || action === "index.refresh" || action === "scip.ingest";
}

function _baselineBranchForRepo(repoRoot) {
  try {
    return resolveTargetBranch(repoRoot || process.cwd());
  } catch {
    return "main";
  }
}

function _isV2BlockingAction(action, call = null) {
  const effective = ATLAS_V2_GATEWAY_ACTIONS.has(action)
    ? _gatewayEffectiveAction(action, call)
    : action;
  return _isV2LifecycleAction(effective)
    || action === "workflow"
    || effective === "workflow"
    || action === "buffer.push"
    || effective === "buffer.push"
    || effective === "buffer.checkpoint"
    || effective === "agent.feedback"
    || effective === "memory.store"
    || effective === "memory.remove"
    || effective === "policy.set"
    || effective === "runtime.execute";
}

function _v2DispatchGateKey({ configuredRepoRoot, ledger, viewPath }) {
  if (_config?.gateScopeKey) return `atlas-v2:scope:${String(_config.gateScopeKey)}`;
  let ledgerPath = null;
  try {
    ledgerPath = typeof ledger?._dbPath === "function" ? ledger._dbPath() : null;
  } catch {
    ledgerPath = null;
  }
  const raw = ledgerPath || viewPath || configuredRepoRoot;
  if (raw) {
    const normalized = path.resolve(String(raw)).replace(/\\/g, "/");
    return `atlas-v2:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
  }
  // No path-shaped identifier available. Fall back to identity fields from
  // the proxy config rather than process.cwd() so two unrelated tests
  // sharing a cwd don't collapse into the same gate key. Final sentinel is
  // a stable string ("unscoped") that's obviously not a path if it ever
  // surfaces in telemetry.
  const identityParts = [
    _config?.repoId,
    _config?.workItemId,
    _config?.jobId,
  ].filter((value) => value != null && value !== "").map(String);
  if (identityParts.length > 0) return `atlas-v2:identity:${identityParts.join(":")}`;
  return "atlas-v2:unscoped";
}

async function _dispatchV2ThroughGate({ dispatch, call, context, action, configuredRepoRoot, ledger, viewPath }) {
  const key = _v2DispatchGateKey({ configuredRepoRoot, ledger, viewPath });
  const label = `atlas.v2.${action}`;
  const run = () => Promise.resolve(dispatch(call, context));
  // Gate order invariant: ATLAS proxy dispatch is the outer gate; dispatch may
  // acquire SQLite/ledger gates below it, but lower layers must not call back
  // into this proxy gate.
  return _isV2BlockingAction(action, call)
    ? await ATLAS_V2_DISPATCH_GATE.write(key, run, { label, waitMs: REQUEST_TIMEOUT_MS })
    : await ATLAS_V2_DISPATCH_GATE.read(key, run, { label, waitMs: REQUEST_TIMEOUT_MS });
}

function _atlasV2AutoRefreshStaleEnabled() {
  const raw = _config?.autoRefreshStale;
  const value = String(raw ?? "true").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function _isMainViewPath(candidate, configuredRepoRoot) {
  if (!candidate || !configuredRepoRoot) return false;
  return path.resolve(candidate) === path.resolve(mainViewPath(configuredRepoRoot));
}

function _asyncTurn() {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function _queueV2Refresh({ queueKey, head = 0, target, action, work }) {
  const existing = _v2RefreshQueue.get(queueKey);
  // Coalesce concurrent stale reads that target the same head sequence onto a
  // single refresh. The settled entry is retained until a newer head
  // supersedes it (see below), so a sibling reader joins deterministically
  // even if it arrives *after* the refresh resolves — the coalescing no longer
  // depends on the two readers overlapping in wall-clock time.
  if (existing && existing.head === head) {
    _log({
      event: "atlas_v2_auto_refresh_joined",
      path: target,
      action,
    });
    return existing.job;
  }
  const job = (async () => {
    await _asyncTurn();
    try {
      const ok = await work();
      _log({
        event: "atlas_v2_auto_refresh_completed",
        path: target,
        action,
        ok,
      });
      return !!ok;
    } catch (err) {
      _log({
        event: "atlas_v2_auto_refresh_completed",
        path: target,
        action,
        ok: false,
        error: String(err?.message || err),
      });
      // A failed refresh must not linger as the coalescing target — drop it so
      // the next stale read retries instead of joining a dead result.
      if (_v2RefreshQueue.get(queueKey)?.job === job) _v2RefreshQueue.delete(queueKey);
      return false;
    }
  })();
  // Record the head this refresh targets. A later stale read at a newer head
  // overwrites this entry (forcing a fresh refresh); a successful refresh's
  // entry is intentionally NOT deleted on completion so same-head siblings
  // still coalesce.
  _v2RefreshQueue.set(queueKey, { job, head });
  _log({
    event: "atlas_v2_auto_refresh_queued",
    path: target,
    action,
  });
  return job;
}

async function _awaitQueuedAutoRefreshStaleView({ dispatch, ledger, configuredRepoRoot, probe, viewCandidates, action }) {
  if (!_atlasV2AutoRefreshStaleEnabled()) return false;
  if (!ledger || _isV2LifecycleAction(action)) return false;
  const target = probe?.dbPath
    || (viewCandidates || []).find((candidate) => _isMainViewPath(candidate, configuredRepoRoot))
    || viewCandidates?.[0]
    || null;
  if (!_isMainViewPath(target, configuredRepoRoot)) return false;
  const baselineBranch = _baselineBranchForRepo(configuredRepoRoot);
  const branch = baselineBranch;
  if (!branch) return false;
  const queueKey = `${branch}:${path.resolve(target)}`;
  // Head the refresh is targeting: keys coalescing so concurrent stale reads
  // collapse onto one refresh while new commits still force a fresh one.
  const targetHead = typeof ledger.headSeq === "function" ? ledger.headSeq(branch) : 0;
  return _queueV2Refresh({
    queueKey,
    head: targetHead,
    target,
    action,
    work: async () => {
      const head = typeof ledger.headSeq === "function" ? ledger.headSeq(branch) : 0;
      const call = { action: "index.refresh", mode: "smart", branch };
      const envelope = await _dispatchV2ThroughGate({
        dispatch,
        call,
        context: {
          versionId: `${branch}@${head}`,
          repoRoot: configuredRepoRoot,
          ledger,
        },
        action: "index.refresh",
        configuredRepoRoot,
        ledger,
        viewPath: target,
      });
      const ok = envelope?.ok !== false && !envelope?.error;
      if (!ok) {
        _log({
          event: "atlas_v2_auto_refresh_error",
          path: target,
          action,
          error: envelope?.error?.message || envelope?.error?.code || "index.refresh failed",
        });
      }
      return ok;
    },
  });
}

/**
 * Execute a tool call against the ATLAS v2 backend. Returns the same
 * shape as `executeLegacy` so callers can treat the two branches
 * uniformly. Returns null when the v2 backend isn't reachable for
 * this call (no ledger, no view, unknown tool); the caller decides
 * whether to fall back or surface an error.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ result: any, ok: boolean, empty: boolean, resultChars: number, errorMsg: string | null, tokenUsage: any, responseTelemetry?: any } | null>}
 */
async function _executeV2Call(toolName, args) {
  const start = Date.now();
  if (!_config || _config.transport !== "v2") return null;
  const action = _resolveV2Action(toolName);
  if (!action) return null;
  const configuredRepoRoot = _resolveRepoRoot();
  if (!configuredRepoRoot) return null;
  const modules = await _loadV2Modules();
  if (!modules) return null;
  const { dispatch, Ledger, View, openEmbeddingResources, semanticDispatchEnabled } = modules;
  const optionalView = ATLAS_V2_VIEW_OPTIONAL_ACTIONS.has(action);
  const preferredViewPath = _preferredExistingV2ViewPath();
  const viewCandidates = preferredViewPath
    ? [preferredViewPath]
    : _candidateV2ViewPaths(configuredRepoRoot);
  if (viewCandidates.length === 0 && !optionalView) return null;

  /** @type {any} */
  let ledger = null;
  /** @type {any} */
  let view = null;
  /** @type {string | null} */
  let viewPath = null;
  /** @type {ReturnType<typeof openEmbeddingResources> | null} */
  let embeddingResources = null;
  try {
    let meta = null;
    const initialLedgerPath = _existingFilePath(_config?.ledgerDbPath);
    if (initialLedgerPath) ledger = Ledger.open({ dbPath: initialLedgerPath });
    if (viewCandidates.length > 0) {
      const waitMs = _atlasV2ViewWaitMs();
      const probe = await waitForCurrentView({
        viewPaths: viewCandidates,
        ViewClass: View,
        ledger,
        timeoutMs: waitMs,
      });
      if (probe.ok) {
        view = probe.view;
        meta = probe.meta;
        viewPath = probe.dbPath;
        const mismatch = _mainViewBranchMismatch({ viewPath, meta, configuredRepoRoot });
        if (mismatch) {
          try { view.close(); } catch { /* ignore stale view close */ }
          view = null;
          meta = null;
          viewPath = null;
          _log({
            event: "atlas_v2_view_branch_mismatch",
            path: mismatch.dbPath,
            error: mismatch.error.message,
          });
          if (!ledger) {
            const opened = _openV2LedgerForView({ Ledger, configuredRepoRoot, viewMeta: meta });
            ledger = opened.ledger;
          }
          const refreshed = !optionalView && await _awaitQueuedAutoRefreshStaleView({
            dispatch,
            ledger,
            configuredRepoRoot,
            probe: mismatch,
            viewCandidates,
            action,
          });
          if (refreshed) {
            const retry = await waitForCurrentView({
              viewPaths: viewCandidates,
              ViewClass: View,
              ledger,
              timeoutMs: waitMs,
            });
            if (retry.ok) {
              view = retry.view;
              meta = retry.meta;
              viewPath = retry.dbPath;
            } else {
              return _viewNotReadyOutcome({ toolName, probe: retry, waitMs });
            }
          } else if (!optionalView) {
            return _viewNotReadyOutcome({ toolName, probe: mismatch, waitMs });
          }
        }
      } else {
        _log({
          event: "atlas_v2_view_not_ready",
          path: probe.dbPath,
          error: String(probe.error?.message || probe.error),
          attempts: probe.attempts || 0,
        });
        if (!optionalView) {
          const refreshed = await _awaitQueuedAutoRefreshStaleView({
            dispatch,
            ledger,
            configuredRepoRoot,
            probe,
            viewCandidates,
            action,
          });
          if (refreshed) {
            const retry = await waitForCurrentView({
              viewPaths: viewCandidates,
              ViewClass: View,
              ledger,
              timeoutMs: waitMs,
            });
            if (retry.ok) {
              view = retry.view;
              meta = retry.meta;
              viewPath = retry.dbPath;
            } else {
              return _viewNotReadyOutcome({ toolName, probe: retry, waitMs });
            }
          } else {
            return _viewNotReadyOutcome({ toolName, probe, waitMs });
          }
        }
      }
    }
    if (ledger && meta && !_ledgerSupportsViewMeta(ledger, meta)) {
      _log({
        event: "atlas_v2_ledger_branch_missing",
        path: initialLedgerPath,
        branch: meta?.branch || null,
      });
      try { ledger.close(); } catch { /* ignore */ }
      ledger = null;
    }
    const ledgerPath = ledger ? null : _resolveV2LedgerPath({ configuredRepoRoot, viewMeta: meta });
    if (ledgerPath) {
      const opened = _openV2LedgerForView({ Ledger, configuredRepoRoot, viewMeta: meta });
      ledger = opened.ledger;
    }
    if (!ledger && !ATLAS_V2_VIEW_OPTIONAL_ACTIONS.has(action)) return null;
    if (view && meta && ledger) {
      const freshness = viewFreshness(meta, ledger);
      if (!freshness.current) {
        try { view.close(); } catch { /* ignore stale view close */ }
        view = null;
        const waitMs = _atlasV2ViewWaitMs();
        const probe = await waitForCurrentView({
          viewPaths: viewCandidates,
          ViewClass: View,
          ledger,
          timeoutMs: waitMs,
        });
        if (!probe.ok) {
          const refreshed = await _awaitQueuedAutoRefreshStaleView({
            dispatch,
            ledger,
            configuredRepoRoot,
            probe,
            viewCandidates,
            action,
          });
          if (refreshed) {
            const retry = await waitForCurrentView({
              viewPaths: viewCandidates,
              ViewClass: View,
              ledger,
              timeoutMs: waitMs,
            });
            if (!retry.ok) return _viewNotReadyOutcome({ toolName, probe: retry, waitMs });
            view = retry.view;
            meta = retry.meta;
            viewPath = retry.dbPath;
          } else {
            return _viewNotReadyOutcome({ toolName, probe, waitMs });
          }
        } else {
          view = probe.view;
          meta = probe.meta;
          viewPath = probe.dbPath;
          const mismatch = _mainViewBranchMismatch({ viewPath, meta, configuredRepoRoot });
          if (mismatch) {
            try { view.close(); } catch { /* ignore stale view close */ }
            view = null;
            meta = null;
            viewPath = null;
            const refreshed = await _awaitQueuedAutoRefreshStaleView({
              dispatch,
              ledger,
              configuredRepoRoot,
              probe: mismatch,
              viewCandidates,
              action,
            });
            if (refreshed) {
              const retry = await waitForCurrentView({
                viewPaths: viewCandidates,
                ViewClass: View,
                ledger,
                timeoutMs: waitMs,
              });
              if (!retry.ok) return _viewNotReadyOutcome({ toolName, probe: retry, waitMs });
              view = retry.view;
              meta = retry.meta;
              viewPath = retry.dbPath;
            } else {
              return _viewNotReadyOutcome({ toolName, probe: mismatch, waitMs });
            }
          }
        }
      }
    }
    const baselineBranch = _baselineBranchForRepo(configuredRepoRoot);
    const readRoot = _resolveV2ReadRoot({ configuredRepoRoot, viewMeta: meta, viewPath });
    const dispatchRepoRoot = _isV2LifecycleAction(action) ? configuredRepoRoot : readRoot;
    const versionId = meta ? `${meta.branch}@${meta.ledger_seq}` : `${baselineBranch}@0`;
    const argsObject = args && typeof args === "object" ? args : {};
    const call = {
      ...(ATLAS_V2_GATEWAY_ACTIONS.has(action)
        ? { ...argsObject, action, gatewayAction: typeof argsObject.action === "string" ? argsObject.action : argsObject.gatewayAction }
        : { action, ...argsObject }),
      ...(_isV2LifecycleAction(action) && !(args && typeof args === "object" && typeof args.branch === "string" && args.branch.trim())
        ? { branch: baselineBranch }
        : {}),
    };
    const wantsSemanticDispatch = (action === "symbol.search" && call.semantic)
      || (action === "slice.build" && call.taskText && call.semantic !== false)
      || ((action === "context" || action === "context.summary") && call.taskText);
    if (wantsSemanticDispatch && semanticDispatchEnabled(_config || {})) {
      embeddingResources = openEmbeddingResources({
        repoRoot: readRoot,
        config: _config || {},
      });
    }
    const envelope = await _dispatchV2ThroughGate({
      dispatch,
      call,
      context: {
        view,
        versionId,
        repoRoot: dispatchRepoRoot,
        viewPath: viewPath || null,
        ledger,
        repoId: _config?.repoId || call.repoId,
        config: _config || {},
        embeddingIndex: embeddingResources?.enabled ? embeddingResources.index : undefined,
        encoder: embeddingResources?.enabled ? embeddingResources.encoder : undefined,
      },
      action,
      configuredRepoRoot,
      ledger,
      viewPath: viewPath || null,
    });
    const mapped = _v2EnvelopeToMcp(envelope);
    const analysis = _analyzeAtlasResultPayload(mapped.result, { toolName, args });
    return {
      result: mapped.result,
      ok: mapped.ok && analysis.ok,
      empty: analysis.empty,
      resultChars: analysis.resultChars,
      errorMsg: mapped.ok ? analysis.errorMsg : (envelope?.error?.message || "v2 error"),
      tokenUsage: analysis.tokenUsage || null,
      responseTelemetry: analysis.responseTelemetry || null,
    };
  } catch (err) {
    return {
      result: _errorPayload(`ATLAS v2 ${toolName} failed: ${err?.message || String(err)}`),
      ok: false,
      empty: true,
      resultChars: 0,
      errorMsg: err?.message || String(err),
      tokenUsage: null,
      responseTelemetry: null,
    };
  } finally {
    try { if (view) view.close(); } catch { /* ignore */ }
    try { if (ledger) ledger.close(); } catch { /* ignore */ }
    try { if (embeddingResources) await embeddingResources.close(); } catch { /* ignore */ }
    void start;
  }
}

// Exposed for tests only.
export const __testV2Helpers = {
  resolveAction: _resolveV2Action,
  envelopeToMcp: _v2EnvelopeToMcp,
  executeV2Call: _executeV2Call,
  effectiveAtlasV2Mode: () => (_config?.atlasV2Mode === "required" ? "required" : "on"),
  isDedupeEligible: _isDedupeEligible,
  isV2BlockingAction: _isV2BlockingAction,
  atlasV2ViewWaitMs: _atlasV2ViewWaitMs,
};
