// @ts-check
//
// Central ATLAS tool execution coordinator. Protocol layers (MCP, embedded
// providers, prefetch) should route ATLAS tool calls through this object so
// queueing, dedupe, telemetry, and conductor ownership stay in one place.

import { AsyncResourceGate } from "../../../../shared/concurrency/classes/AsyncGate.js";
import { getSharedConductor } from "../../functions/v2/parse/conductor.js";
import { ATLAS_TOOL_ACTIONS } from "../../functions/v2/contracts/tool-params.js";
import { normalizeActionName } from "../../functions/v2/retrieval/dispatch.js";
import { ledgerDbPath, mainViewPath } from "../../functions/v2/runtime-paths.js";
import { resolveTargetBranchAsync } from "../../../git/functions/target-branch.js";
import {
  ATLAS_EXECUTE_TOOL_CONTRACT_VERSION,
  runAtlasNativeMethodAsync,
} from "../../functions/v2/native/invoke.js";
import { buildNativeVectorBridge } from "../../functions/v2/embeddings/native-vector-bridge.js";
import { grepIndexedSource } from "../../functions/v2/retrieval/nonindexed-grep.js";
import {
  applyPathQualityPriors,
  pathQualityPriorsEnabled,
} from "../../functions/v2/retrieval/path-priors.js";
import { AtlasToolDispatchCache } from "./AtlasToolDispatchCache.js";
import path from "node:path";

const DEFAULT_DEDUPE_WINDOW_MS = 1500;
const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_DEDUPE_MAX = 256;
const DEFAULT_DISPATCH_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DISPATCH_CACHE_MAX = 256;
export const DEFAULT_SEMANTIC_FILE_LEXICAL_OVERLAP_WEIGHT = 0.75;

const ATLAS_READONLY_DEDUPE_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  "action.search",
  "manual",
  "info",
  "symbol.search",
  "symbol.card",
  "slice.build",
  "context",
  "context.summary",
  "agent.context",
  "repo.status",
  "repo.overview",
  "repo.quality",
  "code.skeleton",
  "code.lens",
  "code.window",
  "code.structure",
  "code.db",
  "file.read",
  "review.risk",
  "memory.get",
  "policy.get",
  "runtime.queryoutput",
  "usage.stats",
]);

// Process-level write gate: these actions take the write slot on this
// executor's per-repo gate. Broader than the conductor's ledger-mutation set
// (memory.feedback belongs here — it serializes in-process — but is lane-safe
// on the reader thread). Every entry must be a registered action (pinned by
// the parity suite).
export const ATLAS_BLOCKING_ACTIONS = new Set([
  "repo.register",
  "index.refresh",
  "scip.ingest",
  "workflow",
  "buffer.push",
  "buffer.checkpoint",
  "agent.feedback",
  "memory.store",
  "memory.feedback",
  "policy.set",
  "runtime.execute",
]);

const ATLAS_GATEWAY_ACTIONS = new Set(["query", "code", "repo", "agent"]);
const ATLAS_NATIVE_COMPLETE_TOOL_ACTIONS = new Set([
  "symbol.search",
  "tree.scope",
  "code.skeleton",
  "code.lens",
  "code.structure",
  "code.survey",
  "symbol.overview",
]);

const DISPATCH_CACHE_POLICIES = Object.freeze({
  NEVER: "never",
  INFLIGHT_ONLY: "inflightOnly",
});

const ATLAS_DISPATCH_CACHE_POLICIES = new Map([
  ["action.search", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["manual", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["info", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["symbol.search", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["symbol.card", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["slice.build", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["slice.refresh", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["context", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["context.summary", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["repo.status", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["repo.overview", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["repo.quality", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["tree.overview", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["tree.branch", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["tree.scope", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["tree.expand", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["code.skeleton", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["code.lens", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["code.structure", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["code.db", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["review.delta", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["review.analyze", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
  ["review.risk", DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY],
]);

function stableStringify(value) {
  if (value === undefined || value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function mcpTextResult(text, isError = false) {
  return {
    content: [{ type: "text", text: String(text || "") }],
    isError: !!isError,
  };
}

function conductorEnvelopeToToolResult(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { result: mcpTextResult("Error: ATLAS v2 dispatch returned no envelope", true), ok: false };
  }
  if (envelope.ok === false || envelope.error) {
    const message = envelope.error?.message || envelope.error?.code || "v2 backend error";
    return {
      result: mcpTextResult(`Error: ATLAS v2 ${envelope.action || ""}: ${message}`, true),
      ok: false,
      errorMsg: String(message),
    };
  }
  const data = envelope.data === undefined ? {} : envelope.data;
  const payload = envelope.meta && data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, _meta: envelope.meta }
    : data;
  // Compact on purpose: pretty-printing inflated every agent-facing tool
  // result by double-digit percent for zero information (2026-07 A/B).
  let text;
  try { text = JSON.stringify(payload); }
  catch { text = String(payload); }
  return { result: mcpTextResult(text, false), ok: true, errorMsg: null };
}

export function nativeSymbolSearchArgs(action, args = {}) {
  if (action !== "symbol.search") return args;

  // Atlas keeps 0.0 as the native compatibility default. The client enables
  // the balanced semantic ranking profile verified for Atlas 0.1.19. Nullish
  // selection is deliberate: an explicit caller value, including 0, wins.
  const effectiveArgs = args.semantic === true && args.fileLexicalOverlapWeight == null
    ? {
        ...args,
        fileLexicalOverlapWeight: DEFAULT_SEMANTIC_FILE_LEXICAL_OVERLAP_WEIGHT,
      }
    : args;

  if (!pathQualityPriorsEnabled(effectiveArgs)) return effectiveArgs;

  const callerLimit = Math.max(
    1,
    Math.min(Math.trunc(Number(effectiveArgs.limit) || 50), 500),
  );
  const vectorLimit = Math.max(
    0,
    Math.trunc(Number(effectiveArgs.vectorCandidateLimit) || 0),
  );
  const fileWindow = Math.max(
    0,
    Math.trunc(Number(effectiveArgs.hierarchicalFileLimit) || 0),
  );
  const candidatePoolLimit = Math.min(500, Math.max(
    callerLimit,
    vectorLimit,
    callerLimit * 2,
    fileWindow * 4,
  ));
  return candidatePoolLimit === callerLimit
    ? effectiveArgs
    : { ...effectiveArgs, limit: candidatePoolLimit };
}

function applyNativeSymbolSearchPriors(envelope, args = {}) {
  if (!pathQualityPriorsEnabled(args) || envelope?.ok === false || envelope?.error) return envelope;
  if (envelope?.meta?.pathPriors?.enabled) return envelope;
  const items = Array.isArray(envelope?.data?.items) ? envelope.data.items : null;
  if (!items) return envelope;
  const callerLimit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 50), 500));
  const entries = items.map((item, index) => ({
    id: String(item?.symbolId || item?.id || `native-symbol-${index}`),
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : 1 / (RRF_SCORE_K + index + 1),
    payload: item,
    contributions: {},
  }));
  const rawScoreById = new Map(entries.map((entry) => [entry.id, entry.score]));
  const result = applyPathQualityPriors(entries, {
    query: String(args.query || ""),
    plan: envelope?.meta?.queryPlan || null,
    options: args,
    rawScoreById,
  });
  const rankedItems = result.entries.slice(0, callerLimit).map((entry) => ({
    ...entry.payload,
    score: Number(entry.score.toFixed(12)),
    ranking: {
      ...(entry.payload?.ranking && typeof entry.payload.ranking === "object" ? entry.payload.ranking : {}),
      pathPrior: entry.pathPrior,
    },
  }));
  const originalTotal = Number(envelope?.data?.total);
  const total = Number.isFinite(originalTotal) ? originalTotal : items.length;
  const pathPriors = {
    ...result.summary,
    callerLimit,
    deliveredCandidatePool: items.length,
  };
  return {
    ...envelope,
    data: {
      ...envelope.data,
      items: rankedItems,
      total,
      truncated: total > rankedItems.length || result.entries.length > rankedItems.length,
    },
    meta: {
      ...(envelope.meta || {}),
      pathPriors,
      scoreScheme: {
        ...(envelope?.meta?.scoreScheme || {}),
        score: "path_prior_adjusted_rrf",
        rawScore: "ranking.pathPrior.rawFusedScore",
      },
    },
  };
}

const RRF_SCORE_K = 60;

function withDedupeMarker(value, mode) {
  const cloned = cloneJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return cloned;
  return {
    ...cloned,
    executor: {
      ...(cloned.executor || {}),
      deduped: mode,
    },
  };
}

function withDispatchCacheMarker(value) {
  const cloned = withDedupeMarker(value, "cache");
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return cloned;
  return {
    ...cloned,
    executor: {
      ...(cloned.executor || {}),
      cache: {
        ...(cloned.executor?.cache || {}),
        hit: true,
        source: "dispatch",
        state: "ready",
      },
    },
  };
}

function withDispatchWaitingMarker(value) {
  const cloned = withDedupeMarker(value, "waiting");
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) return cloned;
  return {
    ...cloned,
    executor: {
      ...(cloned.executor || {}),
      cache: {
        ...(cloned.executor?.cache || {}),
        hit: true,
        source: "dispatch",
        state: "waiting",
      },
    },
  };
}

function stripAtlasPrefix(name = "") {
  const raw = String(name || "").trim();
  if (raw.startsWith("atlas.")) return raw.slice("atlas.".length);
  if (raw.startsWith("atlas_")) return raw.slice("atlas_".length).replace(/_/g, ".");
  return raw;
}

function resolveAtlasAction(toolName = "") {
  const stripped = stripAtlasPrefix(toolName);
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (stripped))) return stripped;
  const lowered = stripped.toLowerCase();
  for (const candidate of ATLAS_TOOL_ACTIONS) {
    if (String(candidate).toLowerCase() === lowered) return candidate;
  }
  return stripped;
}

function gatewayEffectiveAction(action, args = {}) {
  if (!ATLAS_GATEWAY_ACTIONS.has(action)) return action;
  const target = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  // Normalize alias spellings so the blocking/dedupe gates classify the SAME
  // action dispatch will execute (raw-string checks let a variant spelling
  // slip a mutation through the read path).
  return target ? normalizeActionName(target) : action;
}

function dispatchCachePolicyFor(action) {
  return ATLAS_DISPATCH_CACHE_POLICIES.get(String(action || "").toLowerCase()) || DISPATCH_CACHE_POLICIES.NEVER;
}

function gatewaySelectorKeysFor(action, args = {}) {
  if (!ATLAS_GATEWAY_ACTIONS.has(action) || !args || typeof args !== "object") return [];
  const keys = [];
  for (const key of ["gatewayAction", "targetAction", "actionName", "action"]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) keys.push(key);
  }
  return keys;
}

function directReadEligible(action, args = {}) {
  if (ATLAS_GATEWAY_ACTIONS.has(action)) return false;
  if (ATLAS_BLOCKING_ACTIONS.has(action)) return false;
  if (gatewayEffectiveAction(action, args) !== action) return false;
  if (String(action || "").startsWith("buffer.") || String(action || "").startsWith("runtime.")) return false;
  if (action === "memory.store" || action === "memory.feedback") return false;
  if (action === "policy.set" || action === "agent.feedback") return false;
  return true;
}

function normalizeRepoKey(value) {
  let text = String(value || "global").replace(/\\/g, "/").trim();
  // Windows paths are case-insensitive but drive-letter casing varies between
  // process.cwd(), settings, and MCP boot config — `C:/repo` vs `c:/repo`
  // would split the per-repo gate into two independent queues (no mutual
  // exclusion) and fracture the dedupe/dispatch caches. Mirrors sqlite-gate's
  // normalizeSqlitePath.
  if (process.platform === "win32") text = text.toLowerCase();
  return text || "global";
}

function normalizeWorkItemKey(value) {
  if (value == null) return null;
  const text = String(value || "").trim();
  if (!text) return null;
  const id = text.replace(/^wi[-:]/i, "");
  return id ? `wi-${id}` : null;
}

function maybeWorkItemKey(value) {
  if (typeof value === "number" && Number.isFinite(value)) return normalizeWorkItemKey(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^wi[-:]/i.test(text) || /^\d+$/.test(text)) return normalizeWorkItemKey(text);
  return null;
}

function workItemKeyForRequest(request = {}) {
  const config = request.config || {};
  const session = request.session || {};
  const boot = session.bootConfig || session || {};
  const source = request.source && typeof request.source === "object" ? request.source : {};
  return normalizeWorkItemKey(
    request.workItemId
    ?? request.work_item_id
    ?? config.workItemId
    ?? config.work_item_id
    ?? boot.workItemId
    ?? boot.work_item_id
    ?? session.workItemId
    ?? session.work_item_id
    ?? source.workItemId
    ?? source.work_item_id
    ?? null,
  );
}

function readContextKeyFor(scope) {
  if (scope && typeof scope === "object") {
    const wiKey = normalizeWorkItemKey(scope.workItemId ?? scope.work_item_id ?? scope.wi ?? null);
    if (wiKey) return wiKey;
    const location = scope.location || scope.repoKey || scope.repoRoot || scope.repoPath || scope.cwd || null;
    return normalizeRepoKey(location);
  }
  const wiKey = maybeWorkItemKey(scope);
  return wiKey || normalizeRepoKey(scope);
}

function dispatchCacheEnabledFor(request = {}) {
  const config = request.config || {};
  const session = request.session || {};
  const boot = session.bootConfig || session || {};
  const atlas = boot.atlas && typeof boot.atlas === "object" ? boot.atlas : {};
  const explicit = config.dispatchCacheEnabled
    ?? config.gatewayDispatchCacheEnabled
    ?? config.jobCacheEnabled
    ?? atlas.dispatchCacheEnabled
    ?? atlas.gatewayDispatchCacheEnabled
    ?? atlas.jobCacheEnabled
    ?? false;
  return explicit === true;
}

function dispatchCacheTtlFor(request = {}) {
  const config = request.config || {};
  const session = request.session || {};
  const boot = session.bootConfig || session || {};
  const atlas = boot.atlas && typeof boot.atlas === "object" ? boot.atlas : {};
  const ttlMs = Number(
    config.dispatchCacheTtlMs
    ?? config.gatewayDispatchCacheTtlMs
    ?? config.jobCacheTtlMs
    ?? atlas.dispatchCacheTtlMs
    ?? atlas.gatewayDispatchCacheTtlMs
    ?? atlas.jobCacheTtlMs
    ?? DEFAULT_DISPATCH_CACHE_TTL_MS,
  );
  return Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : DEFAULT_DISPATCH_CACHE_TTL_MS;
}

/**
 * @typedef {{
 *   toolName: string,
 *   args?: Record<string, any>,
 *   session?: Record<string, any> | null,
 *   config?: Record<string, any> | null,
 *   source?: Record<string, any> | string | null,
 *   workItemId?: string | number | null,
 *   work_item_id?: string | number | null,
 *   waitMs?: number | null,
 * }} AtlasToolRequest
 */

export class AtlasToolExecutor {
  #conductorFactory;
  #nativeToolCall;
  #nativeVectorBridge;
  #gate;
  #dedupeWindowMs;
  #waitMs;
  #dedupeMax;
  #dispatchCache;
  /** @type {Map<string, Promise<any>>} */
  #inflightDedupe = new Map();
  /** @type {Map<string, { atMs: number, payload: any }>} */
  #recentDedupe = new Map();
  /** @type {Map<string, Record<string, any>>} */
  #readContexts = new Map();
  /** @type {Map<string, string>} */
  #readContextVersions = new Map();
  #now;

  constructor({
    conductorFactory = getSharedConductor,
    nativeToolCall = (payload, opts) => runAtlasNativeMethodAsync("execute-tool", payload, opts),
    nativeVectorBridge = buildNativeVectorBridge,
    gate = new AsyncResourceGate({ name: "ATLAS tool executor", policy: "writer-priority" }),
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    waitMs = DEFAULT_WAIT_MS,
    dedupeMax = DEFAULT_DEDUPE_MAX,
    dispatchCache = null,
    dispatchCacheTtlMs = DEFAULT_DISPATCH_CACHE_TTL_MS,
    dispatchCacheMax = DEFAULT_DISPATCH_CACHE_MAX,
    readContexts = null,
    now = Date.now,
  } = {}) {
    this.#conductorFactory = conductorFactory;
    this.#nativeToolCall = nativeToolCall;
    this.#nativeVectorBridge = nativeVectorBridge;
    this.#gate = gate;
    this.#dedupeWindowMs = Math.max(0, Number(dedupeWindowMs) || 0);
    this.#waitMs = Math.max(0, Number(waitMs) || DEFAULT_WAIT_MS);
    this.#dedupeMax = Math.max(1, Number(dedupeMax) || DEFAULT_DEDUPE_MAX);
    this.#now = now;
    if (dispatchCache === true) {
      this.#dispatchCache = new AtlasToolDispatchCache({
        actions: ATLAS_DISPATCH_CACHE_POLICIES.keys(),
        ttlMs: dispatchCacheTtlMs,
        maxEntries: dispatchCacheMax,
        now,
      });
    } else {
      this.#dispatchCache = dispatchCache instanceof AtlasToolDispatchCache ? dispatchCache : null;
    }
    if (readContexts && typeof readContexts === "object") {
      for (const [repoKey, context] of Object.entries(readContexts)) {
        this.setReadContext(repoKey, context);
      }
    }
  }

  /**
   * Execute one ATLAS tool call through the shared conductor boundary.
   *
   * @param {AtlasToolRequest} request
   */
  async executeTool(request = {}) {
    const toolName = String(request.toolName || "").trim();
    if (!toolName) throw new Error("AtlasToolExecutor.executeTool requires toolName");
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const baseAction = resolveAtlasAction(toolName);
    const action = gatewayEffectiveAction(baseAction, args);
    const repoKey = this.#repoKeyFor(request);
    const dispatchCachePolicy = dispatchCachePolicyFor(action);
    const dispatchKeyParts = this.#dispatchCacheKeyParts({ policy: dispatchCachePolicy });
    const dispatchCacheKey = dispatchCacheEnabledFor(request) && dispatchKeyParts
      ? this.#dispatchCache?.keyFor({
        repoKey,
        action,
        args,
        selectorKeys: gatewaySelectorKeysFor(baseAction, args),
        keyParts: dispatchKeyParts,
      })
      : null;
    const dispatchCacheTtlMs = dispatchCacheKey ? dispatchCacheTtlFor(request) : 0;
    const dispatchCacheReady = this.#dispatchCacheReady();
    const run = () => this.#runThroughGate({ ...request, toolName, args, action, repoKey });
    if (dispatchCacheKey) {
      const result = await this.#dispatchCache.getOrRun(dispatchCacheKey, async () => {
        const value = await run();
        const dedupeEligible = ATLAS_READONLY_DEDUPE_ACTIONS.has(String(action).toLowerCase());
        const dedupeKey = dedupeEligible ? this.#dedupeKey({ toolName, args, repoKey }) : null;
        if (dedupeKey) this.#rememberDedupe(dedupeKey, value);
        return value;
      }, { ttlMs: dispatchCacheTtlMs, cacheReady: dispatchCacheReady, repoKey });
      if (result.state === "hit") return withDispatchCacheMarker(result.value);
      if (result.state === "waiting") return withDispatchWaitingMarker(result.value);
      return result.value;
    }
    const dedupeEligible = ATLAS_READONLY_DEDUPE_ACTIONS.has(String(action).toLowerCase());
    const dedupeKey = dedupeEligible ? this.#dedupeKey({ toolName, args, repoKey }) : null;
    if (dedupeKey) {
      const cached = this.#recentDedupe.get(dedupeKey);
      if (cached && this.#now() - cached.atMs <= this.#dedupeWindowMs) {
        return withDedupeMarker(cached.payload, "cache");
      }
      const inflight = this.#inflightDedupe.get(dedupeKey);
      if (inflight) {
        const value = await inflight;
        return withDedupeMarker(value, "inflight");
      }
    }

    if (!dedupeKey) return run();

    const promise = run()
      .then((value) => {
        this.#rememberDedupe(dedupeKey, value);
        return value;
      })
      .finally(() => {
        if (this.#inflightDedupe.get(dedupeKey) === promise) this.#inflightDedupe.delete(dedupeKey);
      });
    this.#inflightDedupe.set(dedupeKey, promise);
    return promise;
  }

  /**
   * Queue an incremental ATLAS warm after a deterministic file write. This is
   * intentionally owner/conductor-side; MCP reports the write result and never
   * runs parse/index refresh work itself.
   *
   * @param {AtlasToolRequest & { result?: any }} request
   */
  async scheduleDeterministicWriteRefresh(request = {}) {
    const toolName = String(request.toolName || "").trim();
    if (toolName !== "write_file" && toolName !== "edit_file") return null;
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const boot = request.session?.bootConfig || request.session || {};
    const atlas = boot?.atlas || {};
    const liveBuffers = String(atlas.liveBuffers || "off").trim().toLowerCase();
    if (!["1", "true", "deterministic-writes"].includes(liveBuffers)) return null;
    if (!args.path) return null;

    const cwd = String(boot.cwd || request.config?.cwd || process.cwd());
    const repoRoot = String(request.config?.repoRoot || atlas.repoPath || cwd);
    const absPath = path.resolve(cwd, String(args.path));
    const relPath = path.relative(cwd, absPath).replace(/\\/g, "/");
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) return null;
    const repoKey = normalizeRepoKey(repoRoot);
    const requestRepoKey = this.#repoKeyFor({
      ...request,
      args,
      config: {
        ...(request.config && typeof request.config === "object" ? request.config : {}),
        repoRoot,
      },
    });
    this.#clearRecentDedupeForRepo(repoKey);
    if (requestRepoKey !== repoKey) this.#clearRecentDedupeForRepo(requestRepoKey);
    const branch = await this.#branchForRepo(repoRoot);
    const config = {
      ...(atlas && typeof atlas === "object" ? atlas : {}),
      ...(request.config && typeof request.config === "object" ? request.config : {}),
    };
    return this.#gate.write(
      repoKey,
      async (queueInfo) => {
        const conductor = this.#conductorFactory();
        const result = await conductor.warm({
          ledgerPath: ledgerDbPath(repoRoot),
          dbPath: mainViewPath(repoRoot),
          repoRoot,
          branch,
          config,
          job: {
            purpose: "main-incremental",
            branch,
            paths: [relPath],
            trigger_event: "atlas.executor.deterministic_write",
            out_view_path: mainViewPath(repoRoot),
          },
        }, { timeoutMs: request.waitMs || this.#waitMs });
        this.#clearRecentDedupeForRepo(repoKey);
        if (requestRepoKey !== repoKey) this.#clearRecentDedupeForRepo(requestRepoKey);
        return {
          ok: result?.ok !== false,
          action: "index.refresh",
          path: relPath,
          via: "AtlasToolExecutor",
          branch,
          queue: {
            key: queueInfo.key,
            waitMs: queueInfo.waitMs,
            depthAtEnqueue: queueInfo.depthAtEnqueue,
            inFlightAtEnqueue: queueInfo.inFlightAtEnqueue,
          },
          result,
        };
      },
      { label: "atlas.deterministic_write.refresh", waitMs: request.waitMs || this.#waitMs },
    );
  }

  setReadContext(scope, context = null) {
    const key = readContextKeyFor(scope);
    if (!context || typeof context !== "object") {
      this.clearReadContext(key);
      return;
    }
    const cloned = cloneJson(context) || {};
    const version = this.#readContextVersion(cloned);
    const previous = this.#readContextVersions.get(key);
    this.#readContexts.set(key, cloned);
    this.#readContextVersions.set(key, version);
    if (previous !== version) this.#clearRecentDedupeForRepo(key);
  }

  hasReadContext(scope) {
    return this.#readContexts.has(readContextKeyFor(scope));
  }

  clearReadContext(scope) {
    const key = readContextKeyFor(scope);
    this.#readContexts.delete(key);
    this.#readContextVersions.delete(key);
    this.#clearRecentDedupeForRepo(key);
  }

  clearReadContexts() {
    this.#readContexts.clear();
    this.#readContextVersions.clear();
    this.invalidateReadCaches();
  }

  invalidateReadCaches() {
    this.#recentDedupe.clear();
    this.#dispatchCache?.clear?.();
  }

  snapshot() {
    return {
      gate: this.#gate.snapshot?.() || null,
      inflightDedupe: this.#inflightDedupe.size,
      recentDedupe: this.#recentDedupe.size,
      dispatchCache: this.#dispatchCache?.snapshot?.() || null,
      readContexts: this.#readContexts.size,
      dedupeWindowMs: this.#dedupeWindowMs,
      waitMs: this.#waitMs,
    };
  }

  async close() {
    this.#inflightDedupe.clear();
    this.#recentDedupe.clear();
    this.#dispatchCache?.clear?.();
    this.#readContexts.clear();
    this.#readContextVersions.clear();
  }

  #dispatchCacheKeyParts({ policy }) {
    if (policy === DISPATCH_CACHE_POLICIES.NEVER) return null;
    if (policy === DISPATCH_CACHE_POLICIES.INFLIGHT_ONLY) {
      return { policyVersion: 1, policy };
    }
    return null;
  }

  #dispatchCacheReady() {
    // Every mapped action is INFLIGHT_ONLY (pure coalescing, no TTL replay).
    // The old VERSIONED/GIT_STATE policies were unreachable machinery: no
    // action mapped to them, and GIT_STATE could never become ready — they
    // read as if version/git-keyed TTL caching existed when it cannot.
    return false;
  }

  #runThroughGate(request) {
    const mode = ATLAS_BLOCKING_ACTIONS.has(String(request.action || ""));
    const label = `atlas.tool.${request.action || request.toolName}`;
    const runner = async (queueInfo) => {
      const conductor = this.#conductorFactory();
      const payload = {
        toolName: request.toolName,
        action: request.action,
        args: request.args,
        session: request.session || null,
        config: request.config || null,
        source: request.source || null,
        executor: {
          queue: {
            key: queueInfo.key,
            waitMs: queueInfo.waitMs,
            depthAtEnqueue: queueInfo.depthAtEnqueue,
            inFlightAtEnqueue: queueInfo.inFlightAtEnqueue,
            mode: queueInfo.mode,
          },
        },
      };
      const readPayload = await this.#readPayloadFor(request, conductor);
      if (ATLAS_NATIVE_COMPLETE_TOOL_ACTIONS.has(request.action)) {
        if (!readPayload) {
          throw new Error(`ATLAS ${request.action} requires a resolved native read context`);
        }
        const timeoutMs = request.waitMs || this.#waitMs;
        const vectorQuery = request.action === "symbol.search"
          ? String(request.args?.query || "")
          : request.action === "tree.scope"
            ? String(request.args?.taskText || "")
            : "";
        const vectorBridge = vectorQuery && (
          (request.action === "symbol.search" && request.args?.semantic === true)
          || request.action === "tree.scope"
        )
          ? await this.#nativeVectorBridge({
            query: vectorQuery,
            limit: Number(request.args?.limit || 50),
            candidateLimit: request.args?.vectorCandidateLimit == null
              ? undefined
              : Number(request.args.vectorCandidateLimit),
            repoRoot: readPayload.readRoot
              || request.config?.repoRoot
              || request.session?.bootConfig?.atlas?.repoPath
              || request.session?.bootConfig?.cwd
              || request.session?.cwd
              || process.cwd(),
            config: readPayload.config || {},
          })
          : null;
        const nativeArgs = request.action === "tree.scope"
          ? treeScopeDiscoveryArgs(request.args || {}, readPayload.readRoot)
          : nativeSymbolSearchArgs(request.action, request.args || {});
        // code.survey's agent-visible map is deliberately compact, but its
        // hash ref must be able to search every symbol collected by that same
        // survey. This private runtime flag asks the native complete-tool path
        // for a lean full-symbol snapshot; the hash pager consumes it before
        // the result reaches the model. It is intentionally absent from the
        // advertised tool schema.
        const completeToolArgs = request.action === "code.survey"
          ? { ...nativeArgs, _backedSnapshot: true }
          : nativeArgs;
        const envelope = await this.#nativeToolCall({
          contractVersion: ATLAS_EXECUTE_TOOL_CONTRACT_VERSION,
          action: request.action,
          args: cloneJson(completeToolArgs) || {},
          viewPath: readPayload.viewPath,
          ledgerPath: readPayload.ledgerPath,
          repoRoot: readPayload.readRoot
            || request.config?.repoRoot
            || request.session?.bootConfig?.atlas?.repoPath
            || request.session?.bootConfig?.cwd
            || request.session?.cwd
            || process.cwd(),
          repoId: readPayload.repoId,
          versionId: readPayload.versionId,
          config: readPayload.config || {},
          ...(vectorBridge ? { vectorBridge } : {}),
          deadline: this.#now() + timeoutMs,
        }, {
          timeoutMs,
          idempotent: true,
        });
        return conductorEnvelopeToToolResult(
          request.action === "symbol.search"
            ? applyNativeSymbolSearchPriors(envelope, request.args || {})
            : envelope,
        );
      }
      if (readPayload && typeof conductor.retrieve === "function") {
        const envelope = await conductor.retrieve(readPayload, { timeoutMs: request.waitMs || this.#waitMs });
        return conductorEnvelopeToToolResult(envelope);
      }
      if (typeof conductor.executeTool === "function") {
        return conductor.executeTool(payload, { timeoutMs: request.waitMs || this.#waitMs });
      }
      if (typeof conductor.retrieve === "function") {
        return conductor.retrieve(payload, { timeoutMs: request.waitMs || this.#waitMs });
      }
      throw new Error("ATLAS conductor does not expose executeTool/retrieve");
    };
    return mode
      ? this.#gate.write(request.repoKey, runner, { label, waitMs: request.waitMs || this.#waitMs })
      : this.#gate.read(request.repoKey, runner, { label, waitMs: request.waitMs || this.#waitMs });
  }

  #repoKeyFor(request) {
    const wiKey = workItemKeyForRequest(request);
    if (wiKey) return wiKey;
    const config = request.config || {};
    const session = request.session || {};
    const boot = session.bootConfig || session || {};
    return normalizeRepoKey(
      config.repoRoot
      || config.cwd
      || boot?.atlas?.repoPath
      || boot?.cwd
      || request.args?.repoRoot
      || request.args?.cwd
      || "global",
    );
  }

  async #readPayloadFor(request, conductor = null) {
    if (!directReadEligible(request.action, request.args)) return null;
    const context = await this.#readContextFor(request, conductor);
    if (!context) return null;
    const args = request.args && typeof request.args === "object" ? request.args : {};
    const action = request.action;
    // action LAST: an `action` key inside args (a legitimate semantic arg for
    // some domains) must not clobber the resolved dispatch action — mirrors
    // the gateway branch in retrieve-runner, which spreads args first.
    const call = { ...args, action };
    const taskText = typeof args.taskText === "string"
      ? args.taskText
      : (action === "symbol.search" && typeof args.query === "string" ? args.query : undefined);
    const wantsSemantic = (action === "symbol.search" && args.semantic)
      || (action === "slice.build" && args.taskText && args.semantic !== false)
      || ((action === "context" || action === "context.summary") && args.taskText);
    return {
      call,
      viewPath: context.viewPath || null,
      ledgerPath: context.ledgerPath || null,
      versionId: String(context.versionId || ""),
      readRoot: context.readRoot || undefined,
      repoId: context.repoId || null,
      semantic: !!wantsSemantic,
      taskText,
      taskType: typeof args.taskType === "string" ? args.taskType : undefined,
      config: cloneJson(request.config || context.config || {}) || {},
    };
  }

  #dedupeKey({ toolName, args, repoKey }) {
    return `${repoKey}|${String(toolName || "")}|${stableStringify(args || {})}`;
  }

  async #readContextFor(request, conductor = null) {
    let context = this.#readContexts.get(request.repoKey);
    const wiKey = workItemKeyForRequest(request);
    if (context) return context;
    if (!wiKey && !ATLAS_NATIVE_COMPLETE_TOOL_ACTIONS.has(request.action)) return null;
    if (!wiKey) {
      const resolved = this.#requestReadContext(request);
      if (!resolved) return null;
      this.setReadContext(request.repoKey, resolved);
      return resolved;
    }
    const resolved = typeof conductor?.resolveReadContext === "function"
      ? await conductor.resolveReadContext({
        workItemKey: wiKey,
        workItemId: wiKey.replace(/^wi-/, ""),
        repoKey: request.repoKey,
        config: request.config || null,
        session: request.session || null,
        source: request.source || null,
      })
      : null;
    const effective = resolved && typeof resolved === "object"
      ? resolved
      : this.#requestReadContext(request);
    if (!effective) return null;
    this.setReadContext({ workItemId: wiKey }, effective);
    context = this.#readContexts.get(wiKey);
    return context || null;
  }

  #requestReadContext(request) {
    const config = request.config || {};
    const session = request.session || {};
    const boot = session.bootConfig || session || {};
    const repoRoot = config.repoRoot || config.cwd || boot?.atlas?.repoPath || boot?.cwd || null;
    if (!repoRoot) return null;
    return {
      viewPath: mainViewPath(repoRoot),
      ledgerPath: ledgerDbPath(repoRoot),
      versionId: String(config.versionId || boot?.atlas?.versionId || "main"),
      readRoot: String(repoRoot),
      repoId: config.repoId || boot?.atlas?.repoId || null,
      config,
    };
  }

  #readContextVersion(context) {
    return stableStringify({
      viewPath: context?.viewPath || null,
      ledgerPath: context?.ledgerPath || null,
      versionId: context?.versionId || null,
      readRoot: context?.readRoot || null,
      repoId: context?.repoId || null,
    });
  }

  #clearRecentDedupeForRepo(repoKey) {
    const prefix = `${repoKey}|`;
    for (const key of [...this.#recentDedupe.keys()]) {
      if (String(key).startsWith(prefix)) this.#recentDedupe.delete(key);
    }
    this.#dispatchCache?.clearRepo?.(repoKey);
  }

  #rememberDedupe(key, payload) {
    this.#recentDedupe.set(key, { atMs: this.#now(), payload: cloneJson(payload) });
    while (this.#recentDedupe.size > this.#dedupeMax) {
      const oldest = this.#recentDedupe.keys().next().value;
      if (oldest == null) break;
      this.#recentDedupe.delete(oldest);
    }
  }

  async #branchForRepo(repoRoot) {
    try {
      return await resolveTargetBranchAsync(repoRoot || process.cwd());
    } catch {
      return "main";
    }
  }
}

export function treeScopeDiscoveryArgs(args = {}, repoRoot = "") {
  const taskText = typeof args.taskText === "string" ? args.taskText.trim() : "";
  if (!taskText || !repoRoot) return args;
  const wordTerms = [...new Set(
    taskText.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [],
  )].filter((term) => !TREE_SCOPE_TEXT_STOP_WORDS.has(term));
  const terms = [taskText, ...wordTerms].slice(0, 12);
  if (terms.length === 0) return args;
  const grep = grepIndexedSource({ repoRoot, terms, maxTotal: 20 });
  const discoveredPaths = [];
  const seen = new Set();
  for (const match of Array.isArray(grep?.matches) ? grep.matches : []) {
    const path = String(match?.path || "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    discoveredPaths.push(path);
  }
  return discoveredPaths.length > 0 ? { ...args, discoveredPaths } : args;
}

const TREE_SCOPE_TEXT_STOP_WORDS = new Set([
  "about", "after", "again", "against", "being", "between", "could",
  "during", "every", "first", "from", "have", "into", "only", "other",
  "should", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "until", "when", "where",
  "which", "while", "with", "without", "would",
]);
