// @ts-check
//
// Embedded ATLAS v2 executor for providers that expose ATLAS as in-process
// tools.

import fs from "fs";
import crypto from "crypto";
import { AsyncGateBusyError, AsyncResourceGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import {
  buildAtlasProcessEnv,
  getAtlasIntegrationConfig,
  getAtlasRuntimeDisabledReason,
  resolveAtlasRepoTargetAsync,
} from "./atlas.js";
import {
  getAtlasDeterministicToolDefinitions,
  prepareAtlasDeterministicPayload,
  resolveAtlasDeterministicAction,
} from "../../../functions/toolkit/atlas.js";
import { getObservationContext, recordObservation, atlasSummaryHint } from "../../observability/functions/observations.js";
import { formatAtlasToolDisplayName } from "../../../functions/tools/mcp-surface.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { Ledger } from "../../atlas/classes/v2/Ledger.js";
import { View } from "../../atlas/classes/v2/View.js";
import { dispatch as dispatchAtlasV2, normalizeActionName } from "../../atlas/functions/v2/retrieval/dispatch.js";
import { getSharedConductor, isConductorIndexingInFlight, onConductorIndexingSuccess } from "../../atlas/functions/v2/parse/conductor.js";
import {
  openEmbeddingResources,
  retirePooledEmbeddingResources,
  semanticDispatchEnabled,
} from "../../atlas/functions/v2/embeddings/resources.js";
import { fallbackQueryPlan, planQueryAsync } from "../../atlas/functions/v2/retrieval/orchestrator/query-planner.js";
import { extractAtlasResponseTelemetry, extractAtlasResultArtifacts } from "../../atlas/functions/v2/signal-extraction.js";
import { ledgerDbPath, mainViewPath, worktreeViewPath } from "../../atlas/functions/v2/runtime-paths.js";
import { viewFreshness, waitForCurrentView } from "../../atlas/functions/v2/view-health.js";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { resolveTargetBranchAsync } from "../../git/functions/target-branch.js";
import { gitCurrentHashAsync } from "../../git/functions/utils.js";
import { recordMemorySample } from "../../../shared/telemetry/functions/memory.js";
import { clearSharedAtlasToolExecutorReadContexts, getSharedAtlasToolExecutor } from "../../atlas/functions/v2/tools/executor.js";
import {
  getAtlasEmbeddedQueueWaitMs,
  getAtlasEmbeddedTimeoutMs,
  getAtlasJobCacheTtlMs,
  getAtlasPrefetchCacheTtlMs,
} from "../../settings/functions/tunables.js";

const DEFAULT_EMBEDDED_MAX_BUFFER_BYTES = 1024 * 1024 * 4;
const ATLAS_JOB_CACHE_PER_JOB_MAX = 32;
const ATLAS_PREFETCH_CACHE_MAX = 128;
const ATLAS_JOB_CACHE_ACTIONS = new Set([
  "repo.status",
  "tree.overview",
  "context",
  "symbol.search",
  "symbol.card",
  "slice.build",
  "slice.refresh",
  "code.skeleton",
  "code.lens",
]);

// Cross-agent read-through cache for the hot "shape of the repo" reads that
// every agent issues right after attach. The first call after a (re)index
// executes and concurrent identical calls coalesce onto it; later callers get
// the settled result without touching the gate or the conductor. Entries are
// keyed by asset+version+args but version is git HEAD — a drift reindex lands
// new view content under the SAME HEAD, so the cache is also voided whenever
// a conductor indexing op completes successfully (see the subscription below).
const ATLAS_SHARED_READ_ACTIONS = new Set([
  "tree.overview",
  "repo.status",
]);
const ATLAS_SHARED_READ_CACHE = new Map(); // key → output string
const ATLAS_SHARED_READ_INFLIGHT = new Map(); // key → Promise<string>
const ATLAS_SHARED_READ_CACHE_MAX = 64;
let _sharedReadCacheEpoch = 0;

/** @type {Map<string, AtlasCachedResourceEntry>} */
const ATLAS_EMBEDDED_LEDGER_CACHE = new Map();
/** @type {Map<string, AtlasCachedResourceEntry>} */
const ATLAS_EMBEDDED_EMBEDDING_CACHE = new Map();
const ATLAS_EMBEDDED_RESOURCE_CACHE_MAX = 16;
const ATLAS_EMBEDDED_RESOURCE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} AtlasCachedResourceEntry
 * @property {any} value
 * @property {number} expiresAt
 * @property {number} refCount
 * @property {boolean} retired
 * @property {(value: any) => void} close
 */

/** Void the shared tree.overview/repo.status cache (post-reindex, tests). */
export function invalidateAtlasSharedReadCache() {
  _sharedReadCacheEpoch++;
  ATLAS_SHARED_READ_CACHE.clear();
}

export async function invalidateAtlasEmbeddedResourceCache() {
  const entries = [
    ...ATLAS_EMBEDDED_LEDGER_CACHE.entries(),
    ...ATLAS_EMBEDDED_EMBEDDING_CACHE.entries(),
  ];
  ATLAS_EMBEDDED_LEDGER_CACHE.clear();
  ATLAS_EMBEDDED_EMBEDDING_CACHE.clear();
  for (const [, entry] of entries) {
    entry.retired = true;
    if (entry.refCount <= 0) closeCachedAtlasResource(entry);
  }
  // The cached embedding entries hold POOLED wrappers, so closing them only
  // refcounts — retire the pool entries too or the next semantic open in this
  // realm resurrects the same stale child (and its pre-warm in-memory ANN).
  try { retirePooledEmbeddingResources(); } catch { /* best effort */ }
}

onConductorIndexingSuccess(() => {
  invalidateAtlasSharedReadCache();
  clearSharedAtlasToolExecutorReadContexts();
  void invalidateAtlasEmbeddedResourceCache();
});

function atlasSharedReadKey({ enabled = true, action = null, assetKey = null, versionId = null, payload = null } = {}) {
  if (!enabled) return null;
  if (!action || !ATLAS_SHARED_READ_ACTIONS.has(action)) return null;
  if (assetKey == null || versionId == null) return null;
  return `${assetKey}|${versionId}|${action}:${hashArgs(payload)}`;
}

function sharedReadCacheSet(key, value) {
  ATLAS_SHARED_READ_CACHE.delete(key);
  ATLAS_SHARED_READ_CACHE.set(key, value);
  while (ATLAS_SHARED_READ_CACHE.size > ATLAS_SHARED_READ_CACHE_MAX) {
    const oldest = ATLAS_SHARED_READ_CACHE.keys().next().value;
    if (oldest == null) break;
    ATLAS_SHARED_READ_CACHE.delete(oldest);
  }
}
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
  "memory.get",
  "memory.feedback",
  "memory.surface",
  "policy.get",
  "policy.set",
  "runtime.execute",
  "runtime.queryOutput",
  "usage.stats",
  "scip.ingest",
]);
// Ledger-only actions whose results do not depend on view currency: memory,
// policy, usage, feedback queries — plus repo.status, whose job is to REPORT
// freshness (failing it because the view is stale is self-defeating). These
// never wait for a current view and never fail on staleness; they use a stale
// view's meta for branch resolution only.
const ATLAS_V2_VIEW_FRESHNESS_EXEMPT_ACTIONS = new Set([
  "memory.store",
  "memory.get",
  "memory.feedback",
  "memory.surface",
  "agent.feedback.query",
  "policy.get",
  "policy.set",
  "usage.stats",
  "info",
  "action.search",
  "manual",
  "repo.status",
]);
const ATLAS_V2_GATEWAY_ACTIONS = new Set(["query", "code", "repo", "agent"]);
const ATLAS_V2_BLOCKING_ACTIONS = new Set([
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

const ATLAS_JOB_CACHE = new Map();
const ATLAS_PREFETCH_CACHE = new Map();
const ATLAS_CORRUPTION_BACKOFF = new Map();
const ATLAS_PROTECTED_ASSET_GATE = new AsyncResourceGate({ name: "ATLAS protected asset" });

function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hashArgs(payload) {
  return crypto.createHash("sha1").update(stableStringify(payload || {})).digest("hex").slice(0, 16);
}

function atlasJobCacheEnabled(config = {}) {
  return config?.jobCacheEnabled === true;
}

// In-flight coalescing eligibility. Concurrent identical reads (same repo asset
// + version + action + args) can share one execution. Writes / non-cacheable
// actions never coalesce because their results are not interchangeable, and a
// call is only coalesceable when it is scoped to a concrete repo asset and a
// concrete version (otherwise distinct states could share a result).
const ATLAS_EXEC_COALESCE_OFF_VALUES = new Set(["off", "false", "0", "no"]);

function atlasExecCoalesceEnabled(config = {}) {
  const raw = String(process.env.POSSE_ATLAS_EMBEDDED_COALESCE ?? "").trim().toLowerCase();
  if (raw && ATLAS_EXEC_COALESCE_OFF_VALUES.has(raw)) return false;
  if (config?.embeddedCoalesceEnabled === false) return false;
  return true;
}

function atlasExecCoalesceKey({
  enabled = true,
  action = null,
  assetKey = null,
  versionId = null,
  payload = null,
} = {}) {
  if (!enabled) return null;
  if (!action || !ATLAS_JOB_CACHE_ACTIONS.has(action)) return null;
  if (assetKey == null || versionId == null) return null;
  return `${assetKey}|${versionId}|${action}:${hashArgs(payload)}`;
}

function atlasCacheGet(jobId, action, payload, { enabled = false, versionId = "unknown" } = {}) {
  if (!enabled || jobId == null || !ATLAS_JOB_CACHE_ACTIONS.has(action)) return null;
  const per = ATLAS_JOB_CACHE.get(jobId);
  if (!per) return null;
  const key = `${versionId || "unknown"}|${action}:${hashArgs(payload)}`;
  const entry = per.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    per.delete(key);
    return null;
  }
  per.delete(key);
  per.set(key, entry);
  return entry.value;
}

function atlasCacheSet(jobId, action, payload, value, {
  enabled = false,
  versionId = "unknown",
  ttlMs = getAtlasJobCacheTtlMs(),
} = {}) {
  if (!enabled || jobId == null || !ATLAS_JOB_CACHE_ACTIONS.has(action)) return;
  let per = ATLAS_JOB_CACHE.get(jobId);
  if (!per) {
    per = new Map();
    ATLAS_JOB_CACHE.set(jobId, per);
  }
  const key = `${versionId || "unknown"}|${action}:${hashArgs(payload)}`;
  per.delete(key);
  per.set(key, { value, expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0) });
  while (per.size > ATLAS_JOB_CACHE_PER_JOB_MAX) {
    const oldest = per.keys().next().value;
    if (oldest == null) break;
    per.delete(oldest);
  }
}

export function clearAtlasJobCache(jobId) {
  if (jobId == null) return;
  ATLAS_JOB_CACHE.delete(jobId);
}

export function __testResetAtlasJobCache() {
  assertTestContext("__testResetAtlasJobCache");
  ATLAS_JOB_CACHE.clear();
  ATLAS_PREFETCH_CACHE.clear();
  ATLAS_CORRUPTION_BACKOFF.clear();
  ATLAS_SHARED_READ_CACHE.clear();
  ATLAS_SHARED_READ_INFLIGHT.clear();
  void invalidateAtlasEmbeddedResourceCache();
}

export function __testBuildAtlasProtectedAssetKey(opts = {}) {
  assertTestContext("__testBuildAtlasProtectedAssetKey");
  return atlasProtectedAssetKey(opts);
}

export function __testGetAtlasProtectedGateSnapshot() {
  assertTestContext("__testGetAtlasProtectedGateSnapshot");
  return ATLAS_PROTECTED_ASSET_GATE.snapshot();
}

export function __testHoldAtlasProtectedAsset(assetKey = "atlas:test", ms = 50) {
  assertTestContext("__testHoldAtlasProtectedAsset");
  const waitMs = Math.max(1000, Number(ms) + 1000);
  return ATLAS_PROTECTED_ASSET_GATE.write(assetKey, () => new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(ms) || 0));
  }), { label: "test-hold", waitMs });
}

export function __testSetAtlasCorruptionBackoff(repo = {}, reason = "ATLAS v2 storage corruption") {
  assertTestContext("__testSetAtlasCorruptionBackoff");
  setCorruptionBackoff(repo, reason);
}

export function __testGetAtlasCorruptionBackoff(repo = {}) {
  return activeCorruptionBackoff(repo);
}

export function __testAtlasExecCoalesceKey(opts = {}) {
  assertTestContext("__testAtlasExecCoalesceKey");
  return atlasExecCoalesceKey(opts);
}

export function __testAtlasExecCoalesceEnabled(config = {}) {
  assertTestContext("__testAtlasExecCoalesceEnabled");
  return atlasExecCoalesceEnabled(config);
}

export function __testAtlasSharedReadKey(opts = {}) {
  assertTestContext("__testAtlasSharedReadKey");
  return atlasSharedReadKey(opts);
}

export function __testAtlasSharedReadCacheSeed(key, value) {
  assertTestContext("__testAtlasSharedReadCacheSeed");
  sharedReadCacheSet(key, value);
}

export function __testAtlasSharedReadCacheState() {
  assertTestContext("__testAtlasSharedReadCacheState");
  return {
    size: ATLAS_SHARED_READ_CACHE.size,
    keys: [...ATLAS_SHARED_READ_CACHE.keys()],
    inflight: ATLAS_SHARED_READ_INFLIGHT.size,
    epoch: _sharedReadCacheEpoch,
  };
}

export function __testAtlasEmbeddedResourceCacheState() {
  assertTestContext("__testAtlasEmbeddedResourceCacheState");
  return {
    ledgers: ATLAS_EMBEDDED_LEDGER_CACHE.size,
    embeddings: ATLAS_EMBEDDED_EMBEDDING_CACHE.size,
    ledgerRefs: [...ATLAS_EMBEDDED_LEDGER_CACHE.values()].map((entry) => entry.refCount),
    embeddingRefs: [...ATLAS_EMBEDDED_EMBEDDING_CACHE.values()].map((entry) => entry.refCount),
  };
}

export function __testAcquireEmbeddedLedgerForCache(dbPath, opts = {}) {
  assertTestContext("__testAcquireEmbeddedLedgerForCache");
  return acquireEmbeddedLedger(dbPath, opts);
}

export function __testAcquireEmbeddedEmbeddingResourcesForCache(repoRoot, config = {}) {
  assertTestContext("__testAcquireEmbeddedEmbeddingResourcesForCache");
  return acquireEmbeddedEmbeddingResources(repoRoot, config);
}

export function __testReleaseEmbeddedResourceLease(lease) {
  assertTestContext("__testReleaseEmbeddedResourceLease");
  releaseEmbeddedResourceLease(lease);
}

export function __testSetAtlasLockBackoff() {
  assertTestContext("__testSetAtlasLockBackoff");
  return null;
}

export function __testGetAtlasLockBackoff() {
  return null;
}

function repoBackoffKey(repo = {}) {
  if (repo?.repoPath) return `path:${String(repo.repoPath).replace(/\\/g, "/").toLowerCase()}`;
  if (repo?.repoId) return `id:${String(repo.repoId).toLowerCase()}`;
  return "default";
}

function activeCorruptionBackoff(repo = {}) {
  const entry = ATLAS_CORRUPTION_BACKOFF.get(repoBackoffKey(repo));
  if (!entry) return null;
  if (Number(entry.untilMs || 0) <= Date.now()) {
    ATLAS_CORRUPTION_BACKOFF.delete(repoBackoffKey(repo));
    return null;
  }
  return entry;
}

function setCorruptionBackoff(repo = {}, reason = "ATLAS v2 storage corruption", cooldownMs = 120000) {
  ATLAS_CORRUPTION_BACKOFF.set(repoBackoffKey(repo), {
    untilMs: Date.now() + Math.max(0, Number(cooldownMs) || 0),
    reason: String(reason || "ATLAS v2 storage corruption"),
  });
}

function prefetchScopeId(ctx, repo) {
  if (ctx?.work_item_id != null) return `wi:${ctx.work_item_id}`;
  if (repo?.repoId) return `repo:${String(repo.repoId)}`;
  if (repo?.repoPath) return `path:${String(repo.repoPath).replace(/\\/g, "/").toLowerCase()}`;
  return null;
}

function gitHeadForCacheAsync(cwd) {
  if (!cwd) return Promise.resolve(null);
  return gitCurrentHashAsync(cwd, { timeoutMs: 5000 })
    .then((sha) => String(sha || "").trim() || null)
    .catch(() => null);
}

async function prefetchVersionId(cwd, repo = {}) {
  const head = await gitHeadForCacheAsync(cwd);
  if (head) return `head:${head}`;
  if (repo?.repoPath) return `path:${String(repo.repoPath).replace(/\\/g, "/").toLowerCase()}:unknown`;
  if (repo?.repoId) return `repo:${String(repo.repoId).toLowerCase()}:unknown`;
  return "unknown";
}

function prefetchCacheKey(scopeId, action, payload, versionId = "unknown") {
  if (!scopeId || !action) return null;
  return `${scopeId}|${versionId}|${action}:${hashArgs(payload)}`;
}

function prefetchCacheGet(scopeId, action, payload, versionId = "unknown") {
  const key = prefetchCacheKey(scopeId, action, payload, versionId);
  if (!key) return null;
  const entry = ATLAS_PREFETCH_CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    ATLAS_PREFETCH_CACHE.delete(key);
    return null;
  }
  ATLAS_PREFETCH_CACHE.delete(key);
  ATLAS_PREFETCH_CACHE.set(key, entry);
  return entry.value;
}

function prefetchCacheSet(scopeId, action, payload, value, versionId = "unknown", ttlMs = getAtlasPrefetchCacheTtlMs()) {
  const key = prefetchCacheKey(scopeId, action, payload, versionId);
  if (!key) return;
  ATLAS_PREFETCH_CACHE.set(key, { value, expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0) });
  while (ATLAS_PREFETCH_CACHE.size > ATLAS_PREFETCH_CACHE_MAX) {
    const oldest = ATLAS_PREFETCH_CACHE.keys().next().value;
    if (oldest == null) break;
    ATLAS_PREFETCH_CACHE.delete(oldest);
  }
}

/**
 * @param {any} [args]
 */
function atlasProtectedAssetKey({ repo = {}, graphDbPath = null, cwd = null, config = null } = {}) {
  const raw = graphDbPath
    || config?.requestedGraphDbPath
    || repo?.graphDbPath
    || repo?.repoPath
    || repo?.repoId
    || cwd
    || "default";
  const normalized = String(raw).replace(/\\/g, "/").toLowerCase();
  return `atlas:${normalized}`;
}

/**
 * @param {Map<string, AtlasCachedResourceEntry>} cache
 * @param {string} key
 * @param {() => any} open
 * @param {(value: any) => void} close
 * @returns {{ value: any, entry: AtlasCachedResourceEntry }}
 */
function acquireCachedAtlasResource(cache, key, open, close) {
  const now = Date.now();
  let entry = cache.get(key);
  if (entry && entry.expiresAt <= now) {
    retireCachedAtlasResource(cache, key, entry);
    entry = null;
  }
  if (!entry) {
    entry = {
      value: open(),
      expiresAt: now + ATLAS_EMBEDDED_RESOURCE_CACHE_TTL_MS,
      refCount: 0,
      retired: false,
      close,
    };
    cache.set(key, entry);
  } else {
    cache.delete(key);
    cache.set(key, entry);
    entry.expiresAt = now + ATLAS_EMBEDDED_RESOURCE_CACHE_TTL_MS;
  }
  entry.refCount += 1;
  while (cache.size > ATLAS_EMBEDDED_RESOURCE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    const oldestEntry = cache.get(oldest);
    if (!oldestEntry) break;
    retireCachedAtlasResource(cache, oldest, oldestEntry);
  }
  return { value: entry.value, entry };
}

/**
 * @param {Map<string, AtlasCachedResourceEntry>} cache
 * @param {string} key
 * @param {AtlasCachedResourceEntry} entry
 */
function retireCachedAtlasResource(cache, key, entry) {
  cache.delete(key);
  entry.retired = true;
  if (entry.refCount <= 0) closeCachedAtlasResource(entry);
}

/**
 * @param {AtlasCachedResourceEntry} entry
 */
function closeCachedAtlasResource(entry) {
  try {
    const result = entry.close(entry.value);
    if (result && typeof result.then === "function") result.catch(() => {});
  } catch {
    // Cache cleanup is best-effort; callers degrade on their next open.
  }
}

/**
 * @param {{ value?: any, entry?: AtlasCachedResourceEntry | null, close?: (value: any) => void } | null} lease
 */
function releaseEmbeddedResourceLease(lease) {
  if (!lease) return;
  if (lease.entry) {
    lease.entry.refCount = Math.max(0, lease.entry.refCount - 1);
    if (lease.entry.retired && lease.entry.refCount <= 0) closeCachedAtlasResource(lease.entry);
    return;
  }
  try { lease.close?.(lease.value); } catch { /* best effort */ }
}

function openEmbeddedLedger(dbPath, { readOnly = false } = {}) {
  if (!readOnly) return Ledger.open({ dbPath });
  // Never escalate a failed read-only open to a readwrite open: Ledger.open
  // runs migrations and can trigger the destructive format reset, so a READ
  // must not be able to rebuild (or delete) the ledger out from under a
  // concurrent writer. A missing/stale ledger surfaces as an error the
  // dispatch layer degrades on; the next warm (write path) repairs it.
  return Ledger.openReadOnly({ dbPath });
}

/**
 * @param {string} dbPath
 * @param {{ readOnly?: boolean, cache?: boolean }} opts
 */
function acquireEmbeddedLedger(dbPath, { readOnly = false, cache = false } = {}) {
  const normalized = String(dbPath || "").replace(/\\/g, "/").toLowerCase();
  if (!cache || !readOnly || !normalized) {
    const ledger = openEmbeddedLedger(dbPath, { readOnly });
    return {
      value: ledger,
      ledger,
      entry: null,
      close: (handle) => closeEmbeddedAtlasHandle(handle, "ledger", { action: "ledger-close", origin: "embedded" }),
    };
  }
  const lease = acquireCachedAtlasResource(
    ATLAS_EMBEDDED_LEDGER_CACHE,
    `ledger:${normalized}`,
    () => openEmbeddedLedger(dbPath, { readOnly: true }),
    (handle) => closeEmbeddedAtlasHandle(handle, "ledger", { action: "ledger-cache", origin: "embedded" }),
  );
  return { ...lease, ledger: lease.value };
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} config
 */
function acquireEmbeddedEmbeddingResources(repoRoot, config = {}) {
  // Fill-disabled acquisitions are pure readers — that flag is only set by
  // the conductor-fallback path, which runs while the writer is typically
  // mid-warm. Read-only opens can't quarantine or rewrite the live ANN.
  // (The cache key already separates modes: onDemandEmbeddingFill matches the
  // /embedding/ relevant-config filter, and the pool key carries ro/rw.)
  const readOnly = config?.onDemandEmbeddingFill === false;
  const key = embeddedEmbeddingResourceKey(repoRoot, config);
  const lease = acquireCachedAtlasResource(
    ATLAS_EMBEDDED_EMBEDDING_CACHE,
    key,
    () => openEmbeddingResources({ repoRoot, config, readOnly }),
    (resources) => {
      try {
        const result = resources?.close?.();
        if (result && typeof result.then === "function") result.catch(() => {});
      } catch { /* best effort */ }
    },
  );
  return { ...lease, resources: lease.value };
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} config
 */
function embeddedEmbeddingResourceKey(repoRoot, config = {}) {
  const relevantConfig = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (/embedding|encoder|onnx|vector/i.test(key)) relevantConfig[key] = value;
  }
  return stableStringify({
    repoRoot: String(repoRoot || "").replace(/\\/g, "/").toLowerCase(),
    config: relevantConfig,
  });
}

async function embeddedPlanQuery(input) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await planQueryAsync(input);
    } catch {
      // A planner hiccup should not fail the in-process fallback path.
    }
  }
  return fallbackQueryPlan(input);
}

function closeEmbeddedAtlasHandle(handle, label, { action = "unknown", origin = "agent" } = {}) {
  if (!handle || typeof handle.close !== "function") return;
  const startedAt = Date.now();
  try {
    handle.close();
  } finally {
    const durationMs = Date.now() - startedAt;
    if (durationMs > 1000) {
      log.warn("atlas", "Embedded ATLAS handle close was slow", { action, origin, label, durationMs });
    }
  }
}

function gatewayEffectiveAction(action, args = {}) {
  const target = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  // Normalize alias spellings so blocking/lane gates classify the SAME action
  // dispatch will execute (see normalizeActionName in retrieval/dispatch.js).
  return target ? normalizeActionName(target) : action;
}

function isBlockingAction(action, payload = {}) {
  const effective = ATLAS_V2_GATEWAY_ACTIONS.has(action) ? gatewayEffectiveAction(action, payload) : action;
  return ATLAS_V2_BLOCKING_ACTIONS.has(effective);
}

const ATLAS_PREFETCH_ORIGINS = new Set(["prefetch", "handoff_memory_prefetch"]);

function isAtlasPrefetchOrigin(origin) {
  return ATLAS_PREFETCH_ORIGINS.has(String(origin || ""));
}

function atlasGateMode(action, payload = {}, origin = "agent") {
  if (isAtlasPrefetchOrigin(origin)) return "non-blocking";
  return isBlockingAction(action, payload) ? "blocking" : "non-blocking";
}

function isAtlasGateError(err) {
  return err instanceof AsyncGateBusyError
    || err?.code === "ASYNC_GATE_BUSY"
    || err?.code === "ASYNC_GATE_TIMEOUT";
}

function formatAtlasGateMessage(err, { action = "unknown", payload = {}, origin = "agent" } = {}) {
  const raw = err?.message || String(err || "ATLAS protected asset is busy");
  const mode = atlasGateMode(action, payload, origin);
  return mode === "non-blocking"
    ? `${raw}; skipped non-blocking ATLAS read to avoid waiting behind protected-asset work.`
    : raw;
}

function atlasEmbeddedQueueWaitMs(config, fallbackMs = getAtlasEmbeddedQueueWaitMs()) {
  const raw = config?.queueWaitMs;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 120000);
  const fallback = Number(fallbackMs);
  if (Number.isFinite(fallback) && fallback >= 0) return Math.min(fallback, 120000);
  return getAtlasEmbeddedQueueWaitMs();
}

function withProtectedAtlasGate(fn, {
  action = "unknown",
  payload = {},
  origin = "agent",
  config = null,
  timeoutMs = null,
  assetKey = "atlas:default",
} = {}) {
  const mode = atlasGateMode(action, payload, origin);
  const opts = {
    label: `${origin}:${action}`,
    waitMs: atlasEmbeddedQueueWaitMs(config, timeoutMs),
  };
  return mode === "blocking"
    ? ATLAS_PROTECTED_ASSET_GATE.write(assetKey, fn, opts)
    : ATLAS_PROTECTED_ASSET_GATE.read(assetKey, fn, opts);
}

function truncateForObservation(value, max = 240) {
  const text = String(value == null ? "" : value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function atlasObservationTypeForOrigin(origin = "agent") {
  if (origin === "prefetch") return "tool.atlas.prefetch";
  if (origin === "handoff_memory_prefetch") return "atlas.prefetch.memory";
  // Finalizer-driven auto-feedback is harness work: keep the job_id join for
  // analytics but stay out of agent tool feeds/counts (filtered alongside
  // %.prefetch in observability).
  if (origin === "auto_feedback") return "tool.atlas.autofeedback";
  return "tool.atlas";
}

function atlasOriginTag(origin = "agent", cacheHit = false) {
  if (origin === "prefetch") return " [prefetch]";
  if (origin === "handoff_memory_prefetch") return " [memory prefetch]";
  if (origin === "auto_feedback") return " [auto-feedback]";
  return cacheHit ? " [cache]" : "";
}

export function classifyAtlasFailure(message) {
  const lower = String(message || "").toLowerCase();
  if (!lower) return "ATLAS unavailable";
  if (
    lower.includes("invalid atlas parameters")
    || lower.includes("invalid_params")
    || lower.includes("schema validation")
    || lower.includes("must be one of")
    || lower.includes("not a supported parameter")
    || lower.includes("unsupported parameter")
    || lower.includes("gateway cannot route action")
    || lower.includes("unknown atlas action")
  ) {
    return "ATLAS bad parameters";
  }
  if (
    lower.includes("ledger branch")
    || lower.includes("view branch")
    || lower.includes("branch_missing")
    || lower.includes("ledger lacks")
    || lower.includes("view/ledger")
  ) {
    return "ATLAS view/ledger mismatch";
  }
  if (
    lower.includes("view is not current")
    || lower.includes("view not current")
    || lower.includes("view is behind")
    || lower.includes("view is ahead")
    || lower.includes("stale view")
    || lower.includes("out-of-date view")
    || lower.includes("out of date view")
  ) {
    return "ATLAS view not current";
  }
  if (
    lower.includes("not_indexed")
    || lower.includes("requires an atlas view")
    || lower.includes("missing atlas view")
    || lower.includes("no atlas view")
  ) {
    return "ATLAS view unavailable";
  }
  if (lower.includes("busy") || lower.includes("locked") || lower.includes("sqlite_busy")) return "ATLAS SQLite lock contention";
  if (
    lower.includes("sqlite_corrupt")
    || lower.includes("database disk image is malformed")
    || lower.includes("file is not a database")
    || lower.includes("database schema is corrupt")
    || lower.includes("wal")
    || lower.includes("write-ahead")
  ) {
    return "ATLAS v2 storage corruption";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) return "ATLAS timeout";
  return "ATLAS unavailable";
}

function summarizeAtlasArgs(args = {}) {
  const out = {};
  const source = args && typeof args === "object" ? args : {};
  const keys = Object.keys(source).slice(0, 8);
  for (const key of keys) {
    const value = source[key];
    if (value == null) out[key] = null;
    else if (typeof value === "string") out[key] = truncateForObservation(value, 160);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map((item) => truncateForObservation(item, 80));
    else if (typeof value === "object") out[key] = "[object]";
    else out[key] = truncateForObservation(value, 80);
  }
  return out;
}

/**
 * @param {any} [args]
 */
function recordAtlasToolObservation({
  action,
  cliAction = null,
  invocation = null,
  args = {},
  ok = false,
  durationMs = null,
  error = null,
  origin = "agent",
  cacheHit = false,
  queueInfo = null,
  artifacts = null,
  resultChars = null,
  responseTelemetry = null,
} = {}) {
  try {
    const rawContext = getObservationContext();
    const context = rawContext || {};
    const originTag = atlasOriginTag(origin, cacheHit);
    const hint = atlasSummaryHint(args, action);
    const displayName = formatAtlasToolDisplayName(action) || `atlas ${action}`;
    const failureKind = ok ? null : classifyAtlasFailure(error);
    const fallbackText = origin === "prefetch" && !ok ? " -> using deterministic fallback tools" : "";
    const statusText = ok ? "ok" : `failed: ${failureKind}${fallbackText}`;
    recordObservation(/** @type {any} */ ({
      work_item_id: context.work_item_id ?? null,
      job_id: context.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: atlasObservationTypeForOrigin(origin),
      summary: `${displayName}${hint ? ` (${hint})` : ""}${originTag} ${statusText}${durationMs != null ? ` (${durationMs}ms)` : ""}`,
      detail: {
        kind: "atlas",
        origin,
        action,
        role: context.role ?? null,
        cli_action: cliAction,
        ok: !!ok,
        duration_ms: durationMs,
        transport: invocation?.source || null,
        command: invocation?.command || null,
        args: summarizeAtlasArgs(args),
        error: error ? truncateForObservation(error, 500) : null,
        failure_classification: failureKind,
        fallback: origin === "prefetch" && !ok ? "deterministic_tools" : null,
        cache_hit: !!cacheHit,
        atlas_artifacts: artifacts || null,
        response: responseTelemetry ? {
          ...responseTelemetry,
          result_chars: Number(resultChars || 0),
        } : null,
        context_missing: !rawContext,
        queue: queueInfo ? {
          wait_ms: Number(queueInfo.waitMs || 0),
          depth_at_enqueue: Number(queueInfo.depthAtEnqueue || 0),
          in_flight_at_enqueue: Number(queueInfo.inFlightAtEnqueue || 0),
          label: queueInfo.label || null,
          key: queueInfo.key || null,
          mode: queueInfo.mode || null,
        } : null,
      },
    }));
  } catch (err) {
    try { log.debug("atlas", "observation write failed", { action, origin, err: err?.message || String(err) }); }
    catch { /* logger itself can't fail quietly */ }
  }
}

function existingFilePath(value) {
  if (!value || typeof value !== "string") return null;
  try { return fs.existsSync(value) ? value : null; } catch { return null; }
}

function candidateEmbeddedV2ViewPaths({ cwd, repoRoot }) {
  const candidates = [
    cwd ? worktreeViewPath(cwd) : null,
    repoRoot ? worktreeViewPath(repoRoot) : null,
    repoRoot ? mainViewPath(repoRoot) : null,
  ];
  const paths = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const found = existingFilePath(candidate);
    if (found && !seen.has(found)) {
      seen.add(found);
      paths.push(found);
    }
  }
  return paths;
}

function preferredEmbeddedV2ViewPath({ cwd }) {
  const candidates = [cwd ? worktreeViewPath(cwd) : null];
  for (const candidate of candidates) {
    const found = existingFilePath(candidate);
    if (found) return found;
  }
  return null;
}

function uniqueExistingFilePaths(candidates = []) {
  const paths = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const found = existingFilePath(candidate);
    if (found && !seen.has(found)) {
      seen.add(found);
      paths.push(found);
    }
  }
  return paths;
}

function candidateEmbeddedV2LedgerPaths({ repoRoot, viewMeta, cwd = null, config = null }) {
  const candidates = [
    config?.atlasV2LedgerDbPath || null,
    config?.ledgerDbPath || null,
    repoRoot ? ledgerDbPath(repoRoot) : null,
    viewMeta?.repo_root ? ledgerDbPath(viewMeta.repo_root) : null,
    cwd ? ledgerDbPath(cwd) : null,
  ];
  return uniqueExistingFilePaths(candidates);
}

function resolveEmbeddedV2LedgerPath({ repoRoot, viewMeta, cwd = null, config = null }) {
  return candidateEmbeddedV2LedgerPaths({ repoRoot, viewMeta, cwd, config })[0] || null;
}

function embeddedLedgerSupportsViewMeta(ledger, viewMeta) {
  const branch = typeof viewMeta?.branch === "string" && viewMeta.branch ? viewMeta.branch : null;
  if (!ledger || !branch || typeof ledger.getBranch !== "function") return true;
  try { return !!ledger.getBranch(branch); } catch { return false; }
}

function openEmbeddedLedgerForView({ repoRoot, viewMeta, cwd = null, config = null, readOnly = false }) {
  const paths = candidateEmbeddedV2LedgerPaths({ repoRoot, viewMeta, cwd, config });
  let fallback = null;
  for (const dbPath of paths) {
    let candidateLease = null;
    let candidate = null;
    try {
      candidateLease = acquireEmbeddedLedger(dbPath, { readOnly, cache: readOnly });
      candidate = candidateLease.ledger;
      if (embeddedLedgerSupportsViewMeta(candidate, viewMeta)) {
        if (fallback) releaseEmbeddedResourceLease(fallback);
        return { ledger: candidate, dbPath, lease: candidateLease };
      }
      log.debug("atlas", "Skipping ATLAS ledger that does not contain view branch", {
        ledgerPath: dbPath,
        branch: viewMeta?.branch || null,
      });
      if (!fallback) fallback = candidateLease;
      else releaseEmbeddedResourceLease(candidateLease);
    } catch (err) {
      log.debug("atlas", "Skipping unreadable ATLAS ledger candidate", {
        ledgerPath: dbPath,
        error: err?.message || String(err),
      });
      try { releaseEmbeddedResourceLease(candidateLease); } catch { /* ignore */ }
    }
  }
  return fallback ? { ledger: fallback.ledger, dbPath: null, lease: fallback } : { ledger: null, dbPath: null, lease: null };
}

function resolveEmbeddedV2ReadRoot({ cwd, repoRoot, viewPath, viewMeta }) {
  if (cwd && viewPath === worktreeViewPath(cwd)) return cwd;
  return cwd || viewMeta?.repo_root || repoRoot || process.cwd();
}

function atlasV2ViewWaitMs(config) {
  const raw = config?.viewWaitMs;
  if (raw == null || String(raw).trim() === "") return 2500;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 30000);
  return 2500;
}

async function baselineBranchForRepo(repoRoot) {
  try {
    return await resolveTargetBranchAsync(repoRoot || process.cwd());
  } catch {
    return "main";
  }
}

function atlasV2EnvelopeError(envelope) {
  const message = envelope?.error?.message || envelope?.error?.code || "v2 dispatch failed";
  const err = new Error(message);
  /** @type {any} */ (err).atlasV2Error = envelope?.error || null;
  return err;
}

function formatAtlasV2EmbeddedError(action, err) {
  const message = err?.message || String(err);
  const text = `Error: ATLAS tool ${action} failed via atlas-v2: ${message.slice(0, 600)}`;
  let error = (/** @type {any} */ (err))?.atlasV2Error;
  if (!error || typeof error !== "object") {
    // Executor-level failures carry no dispatch envelope. Synthesize the
    // machine code so gate strike/unlock classification keys on codes, not
    // prose — a queue-timeout or missing conductor is ATLAS-unavailable and
    // must unlock the ATLAS-first gate rather than accrue strikes.
    const syntheticCode = isAtlasGateError(err)
      ? "atlas_gate_timeout"
      : (/does not expose (executeTool|retrieve)/i.test(message) ? "atlas_conductor_unavailable" : null);
    if (!syntheticCode) return text;
    error = { code: syntheticCode, message };
  }
  const structured = {
    code: error.code ? String(error.code) : "error",
    message: error.message ? String(error.message) : message,
  };
  if (error.details !== undefined) structured.details = error.details;
  try {
    return `${text}\n${JSON.stringify({ error: structured }, null, 2)}`;
  } catch {
    return text;
  }
}

function canUseAtlasToolExecutor(action, payload, config = {}) {
  if ((config?.embeddedDispatch || "conductor") === "in-process") return false;
  if (ATLAS_V2_GATEWAY_ACTIONS.has(action)) return false;
  if (ATLAS_V2_BLOCKING_ACTIONS.has(action)) return false;
  if (isBlockingAction(action, payload)) return false;
  if (action.startsWith("buffer.") || action.startsWith("runtime.")) return false;
  if (action === "memory.store" || action === "memory.feedback") return false;
  if (action === "policy.set" || action === "agent.feedback") return false;
  return true;
}

function mcpResultText(result) {
  if (!result || typeof result !== "object") return "";
  if (Array.isArray(result.content)) {
    return result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("");
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function embeddedWorkItemId(obsCtx = {}, config = {}) {
  return obsCtx?.work_item_id
    ?? obsCtx?.workItemId
    ?? config?.work_item_id
    ?? config?.workItemId
    ?? null;
}

function atlasExecutorReadScope(workItemId, repoRoot) {
  return workItemId != null ? { workItemId } : { location: repoRoot };
}

async function resolveEmbeddedAtlasV2ReadContext({
  action,
  payload,
  cwd,
  config,
  repo,
}) {
  if (!canUseAtlasToolExecutor(action, payload, config)) return null;
  const repoRoot = repo?.repoPath || config?.requestedRepoPath || cwd || process.cwd();
  const optionalView = ATLAS_V2_VIEW_OPTIONAL_ACTIONS.has(action);
  const freshnessExempt = ATLAS_V2_VIEW_FRESHNESS_EXEMPT_ACTIONS.has(action);
  const preferredViewPath = preferredEmbeddedV2ViewPath({ cwd: cwd || repoRoot });
  const viewCandidates = preferredViewPath
    ? [preferredViewPath]
    : candidateEmbeddedV2ViewPaths({ cwd: cwd || repoRoot, repoRoot });
  if (viewCandidates.length === 0 && !optionalView) return null;

  let view = null;
  let ledger = null;
  let ledgerLease = null;
  let viewPath = null;
  try {
    let meta = null;
    const expectedLayerMerge = config?.viewLayerMerge === true;
    const configuredLedgerPath = existingFilePath(config?.atlasV2LedgerDbPath || config?.ledgerDbPath || null);
    if (configuredLedgerPath) {
      ledgerLease = acquireEmbeddedLedger(configuredLedgerPath, { readOnly: true, cache: true });
      ledger = ledgerLease.ledger;
    }
    const waitMs = atlasV2ViewWaitMs(config);
    if (viewCandidates.length > 0) {
      const probe = await waitForCurrentView({
        viewPaths: viewCandidates,
        ViewClass: View,
        ledger,
        timeoutMs: freshnessExempt ? 0 : waitMs,
        layerMerge: expectedLayerMerge,
        allowStale: freshnessExempt,
      });
      if (probe.ok) {
        view = probe.view;
        meta = probe.meta;
        viewPath = probe.dbPath;
      }
    }
    if ((!view || !meta) && !optionalView) return null;
    if (ledger && meta && !embeddedLedgerSupportsViewMeta(ledger, meta)) {
      try { releaseEmbeddedResourceLease(ledgerLease); } catch { /* ignore */ }
      ledger = null;
      ledgerLease = null;
    }
    let ledgerPath = configuredLedgerPath
      || resolveEmbeddedV2LedgerPath({ repoRoot, viewMeta: meta, cwd, config });
    if (!ledger && ledgerPath) {
      const opened = openEmbeddedLedgerForView({
        repoRoot,
        viewMeta: meta,
        cwd,
        config,
        readOnly: true,
      });
      ledger = opened.ledger;
      ledgerLease = opened.lease;
      ledgerPath = opened.dbPath || ledgerPath;
    }
    if (!ledgerPath && !optionalView) return null;
    if (view && meta && ledger && !freshnessExempt) {
      const freshness = viewFreshness(meta, ledger, { layerMerge: expectedLayerMerge });
      if (!freshness.current) {
        try { view.close(); } catch { /* ignore */ }
        view = null;
        const secondProbe = await waitForCurrentView({
          viewPaths: viewCandidates,
          ViewClass: View,
          ledger,
          timeoutMs: waitMs,
          layerMerge: expectedLayerMerge,
        });
        if (!secondProbe.ok) return null;
        view = secondProbe.view;
        meta = secondProbe.meta;
        viewPath = secondProbe.dbPath;
      }
    }
    const branch = meta?.branch || await baselineBranchForRepo(repoRoot);
    const ledgerSeq = freshnessExempt && ledger && typeof ledger.headSeq === "function"
      ? ledger.headSeq(branch)
      : (meta?.ledger_seq ?? (ledger && typeof ledger.headSeq === "function" ? ledger.headSeq(branch) : 0));
    const readRoot = resolveEmbeddedV2ReadRoot({ cwd: cwd || null, repoRoot, viewPath, viewMeta: meta });
    let conductorConfig = {};
    try { conductorConfig = JSON.parse(JSON.stringify(config || {})); } catch { conductorConfig = {}; }
    return {
      viewPath: viewPath || null,
      ledgerPath: ledgerPath || null,
      versionId: `${branch}@${ledgerSeq}`,
      readRoot,
      repoId: repo?.repoId || config?.requestedRepoId || null,
      config: conductorConfig,
    };
  } finally {
    try { view?.close?.(); } catch { /* ignore */ }
    try { releaseEmbeddedResourceLease(ledgerLease); } catch { /* ignore */ }
  }
}

async function executeEmbeddedAtlasViaExecutor({
  action,
  payload,
  cwd,
  config,
  repo,
  startedAt,
  origin,
  queueInfo = null,
  workItemId = null,
}) {
  const repoRoot = repo?.repoPath || config?.requestedRepoPath || cwd || process.cwd();
  const executor = getSharedAtlasToolExecutor();
  const scope = atlasExecutorReadScope(workItemId, repoRoot);
  if (!executor.hasReadContext(scope)) {
    const context = await resolveEmbeddedAtlasV2ReadContext({ action, payload, cwd, config, repo });
    if (context) executor.setReadContext(scope, context);
  }
  const executed = await executor.executeTool({
    toolName: action,
    args: payload && typeof payload === "object" ? payload : {},
    workItemId,
    config: {
      ...(config && typeof config === "object" ? config : {}),
      cwd: cwd || repoRoot,
      repoRoot,
      repoId: repo?.repoId || config?.requestedRepoId || null,
      workItemId,
    },
    session: {
      bootConfig: {
        cwd: cwd || repoRoot,
        workItemId,
        atlas: {
          ...(config && typeof config === "object" ? config : {}),
          repoPath: repoRoot,
          repoId: repo?.repoId || config?.requestedRepoId || null,
        },
      },
    },
    source: {
      kind: "embedded",
      origin,
      workItemId,
    },
    waitMs: Math.max(5000, Number(config?.embeddedTimeoutMs) || getAtlasEmbeddedTimeoutMs()),
  });
  const text = mcpResultText(executed?.result);
  const ok = !!executed?.result && executed.result.isError !== true && !/^Error:/i.test(text);
  const executorCacheHit = executed?.executor?.cache?.hit === true
    || executed?.executor?.deduped === "cache"
    || executed?.executor?.deduped === "inflight"
    || executed?.executor?.deduped === "waiting";
  recordAtlasToolObservation({
    action,
    invocation: { source: "atlas-tool-executor", command: null },
    args: payload,
    ok,
    durationMs: Date.now() - startedAt,
    origin,
    queueInfo,
    cacheHit: executorCacheHit,
    resultChars: text.length,
    ...(ok ? {
      artifacts: extractAtlasResultArtifacts(text, { action, args: payload }),
      responseTelemetry: extractAtlasResponseTelemetry(text),
    } : {
      error: text || "ATLAS executor returned no result",
    }),
  });
  return text || `Error: ATLAS tool ${action} failed via AtlasToolExecutor: empty result`;
}

/**
 * @param {any} args
 */
async function executeEmbeddedAtlasV2Tool({
  action,
  payload,
  cwd,
  config,
  repo,
  startedAt,
  origin,
  queueInfo = null,
}) {
  const repoRoot = repo?.repoPath || config?.requestedRepoPath || cwd || process.cwd();
  const optionalView = ATLAS_V2_VIEW_OPTIONAL_ACTIONS.has(action);
  const freshnessExempt = ATLAS_V2_VIEW_FRESHNESS_EXEMPT_ACTIONS.has(action);
  const preferredViewPath = preferredEmbeddedV2ViewPath({ cwd: cwd || repoRoot });
  const viewCandidates = preferredViewPath
    ? [preferredViewPath]
    : candidateEmbeddedV2ViewPaths({ cwd: cwd || repoRoot, repoRoot });
  if (viewCandidates.length === 0 && !optionalView) {
    const message = "ATLAS v2 view is not available";
    recordAtlasToolObservation({
      action,
      invocation: { source: "atlas-v2", command: null },
      args: payload,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
      queueInfo,
    });
    return `Error: ATLAS tool ${action} failed via atlas-v2: ${message}`;
  }
  let view = null;
  let ledger = null;
  let embeddingResources = null;
  let ledgerLease = null;
  let embeddingResourcesLease = null;
  let viewPath = null;
  try {
    let meta = null;
    const expectedLayerMerge = config?.viewLayerMerge === true;
    const configuredLedgerPath = existingFilePath(config?.atlasV2LedgerDbPath || config?.ledgerDbPath || null);
    if (configuredLedgerPath) {
      const readOnlyLedger = !isBlockingAction(action, payload);
      ledgerLease = acquireEmbeddedLedger(configuredLedgerPath, { readOnly: readOnlyLedger, cache: readOnlyLedger });
      ledger = ledgerLease.ledger;
    }
    const waitMs = atlasV2ViewWaitMs(config);
    if (viewCandidates.length > 0) {
      const probe = await waitForCurrentView({
        viewPaths: viewCandidates,
        ViewClass: View,
        ledger,
        // Freshness-exempt actions never wait on view currency — take the
        // view as it is right now (stale included) or run ledger-only.
        timeoutMs: freshnessExempt ? 0 : waitMs,
        layerMerge: expectedLayerMerge,
        allowStale: freshnessExempt,
      });
      if (probe.ok) {
        view = probe.view;
        meta = probe.meta;
        viewPath = probe.dbPath;
      } else {
        log.debug("atlas", "ATLAS v2 view not ready", {
          viewPath: probe.dbPath,
          error: probe.error?.message || String(probe.error),
          attempts: probe.attempts || 0,
        });
      }
    }
    if ((!view || !meta) && !optionalView) throw new Error("ATLAS v2 view is not available");
    if (ledger && meta && !embeddedLedgerSupportsViewMeta(ledger, meta)) {
      try { releaseEmbeddedResourceLease(ledgerLease); } catch { /* ignore */ }
      ledger = null;
      ledgerLease = null;
    }
    const ledgerPath = ledger ? null : resolveEmbeddedV2LedgerPath({ repoRoot, viewMeta: meta, cwd, config });
    if (!ledger && !ledgerPath && !optionalView) throw new Error("ATLAS v2 ledger is not available");
    if (!ledger && ledgerPath) {
      const opened = openEmbeddedLedgerForView({
        repoRoot,
        viewMeta: meta,
        cwd,
        config,
        readOnly: !isBlockingAction(action, payload),
      });
      ledger = opened.ledger;
      ledgerLease = opened.lease;
    }
    if (view && meta && ledger && !freshnessExempt) {
      const freshness = viewFreshness(meta, ledger, { layerMerge: expectedLayerMerge });
      if (!freshness.current) {
        try { view.close(); } catch { /* ignore stale view close */ }
        view = null;
        const secondProbe = await waitForCurrentView({
          viewPaths: viewCandidates,
          ViewClass: View,
          ledger,
          timeoutMs: waitMs,
          layerMerge: expectedLayerMerge,
        });
        if (!secondProbe.ok) {
          throw new Error(`ATLAS v2 view is not current: ${secondProbe.error?.message || "view is stale"}`);
        }
        view = secondProbe.view;
        meta = secondProbe.meta;
        viewPath = secondProbe.dbPath;
      }
    }
    const branch = meta?.branch || await baselineBranchForRepo(repoRoot);
    // Exempt actions may hold a stale view whose meta.ledger_seq is behind —
    // stamp their results with the ledger's actual head instead.
    const ledgerSeq = freshnessExempt && ledger && typeof ledger.headSeq === "function"
      ? ledger.headSeq(branch)
      : (meta?.ledger_seq ?? (ledger && typeof ledger.headSeq === "function" ? ledger.headSeq(branch) : 0));
    const versionId = `${branch}@${ledgerSeq}`;
    const readRoot = resolveEmbeddedV2ReadRoot({ cwd: cwd || null, repoRoot, viewPath, viewMeta: meta });
    const wantsSemanticDispatch = (action === "symbol.search" && payload?.semantic)
      || (action === "slice.build" && payload?.taskText && payload?.semantic !== false)
      || ((action === "context" || action === "context.summary") && payload?.taskText);
    const semanticWanted = !!(wantsSemanticDispatch && semanticDispatchEnabled(config || {}));
    const callPayload = payload && typeof payload === "object" ? payload : {};
    const dispatchCall = ATLAS_V2_GATEWAY_ACTIONS.has(action)
      ? { ...callPayload, action, gatewayAction: typeof callPayload.action === "string" ? callPayload.action : callPayload.gatewayAction }
      : { action, ...callPayload };
    // Off-loop dispatch: better-sqlite3 is synchronous, so in-process reads
    // block the orchestrator event loop for their full duration (multi-second
    // for graph walks). Eligible plain reads run in the Atlas-Conductor
    // thread instead; anything needing process-local state (semantic encoder
    // handles, live buffers, runtime exec) or write semantics stays here, as
    // does everything when the daemon misbehaves (automatic fallback).
    const conductorEligible = (config?.embeddedDispatch || "conductor") !== "in-process"
      && (!!viewPath || freshnessExempt)
      && !ATLAS_V2_GATEWAY_ACTIONS.has(action)
      && !ATLAS_V2_BLOCKING_ACTIONS.has(action)
      && !isBlockingAction(action, payload)
      && !action.startsWith("buffer.")
      && !action.startsWith("runtime.")
      && action !== "memory.store"
      && action !== "policy.set" && action !== "agent.feedback";
    let envelope = null;
    let conductorFellBack = false;
    if (conductorEligible) {
      try {
        const conductorLedgerPath = configuredLedgerPath
          || resolveEmbeddedV2LedgerPath({ repoRoot, viewMeta: meta, cwd, config });
        let conductorConfig = {};
        try { conductorConfig = JSON.parse(JSON.stringify(config || {})); } catch { conductorConfig = {}; }
        envelope = await getSharedConductor().retrieve({
          call: dispatchCall,
          viewPath: viewPath || null,
          ledgerPath: conductorLedgerPath || null,
          versionId,
          readRoot,
          repoId: repo?.repoId || null,
          semantic: semanticWanted,
          taskText: typeof payload?.taskText === "string" ? payload.taskText : (action === "symbol.search" ? payload?.query : undefined),
          taskType: typeof payload?.taskType === "string" ? payload.taskType : undefined,
          config: conductorConfig,
        }, { timeoutMs: Math.max(5000, Number(config?.embeddedTimeoutMs) || getAtlasEmbeddedTimeoutMs()) });
      } catch (err) {
        // Daemon trouble (timeout/overload/transport) or a mount race with a
        // view rebuild — run the call in-process rather than failing it.
        log.debug("atlas", "Conductor retrieval fell back in-process", {
          action,
          error: String(/** @type {any} */ (err)?.message || err).slice(0, 200),
          code: /** @type {any} */ (err)?.code || null,
        });
        envelope = null;
        conductorFellBack = true;
      }
    }
    if (!envelope) {
      // In-process path (kill switch, ineligible action, or daemon fallback):
      // open the semantic handles here, exactly as before the conductor split.
      // On a daemon FALLBACK the conductor is typically busy (mid-warm) — skip
      // the bulk on-demand embedding fill so the main loop only pays for the
      // search itself, not for encoding the view's vector gap.
      const inProcessConfig = conductorFellBack
        ? { ...(config || {}), onDemandEmbeddingFill: false }
        : (config || {});
      if (semanticWanted && !embeddingResources) {
        try {
          embeddingResourcesLease = acquireEmbeddedEmbeddingResources(readRoot, inProcessConfig);
          embeddingResources = embeddingResourcesLease.resources;
        } catch { embeddingResources = null; }
      }
      envelope = await Promise.resolve(dispatchAtlasV2(dispatchCall, {
        view,
        ledger,
        versionId,
        repoRoot: readRoot,
        repoId: repo?.repoId || null,
        config: inProcessConfig,
        embeddingIndex: embeddingResources?.enabled ? embeddingResources.index : undefined,
        encoder: embeddingResources?.enabled ? embeddingResources.encoder : undefined,
        taskText: typeof payload?.taskText === "string" ? payload.taskText : (action === "symbol.search" ? payload?.query : undefined),
        taskType: typeof payload?.taskType === "string" ? payload.taskType : undefined,
        planner: embeddedPlanQuery,
        asyncNativeRedaction: true,
      }));
    }
    if (envelope?.ok === false || envelope?.error) throw atlasV2EnvelopeError(envelope);
    const data = envelope?.data ?? {};
    const payloadWithMeta = envelope?.meta && data && typeof data === "object" && !Array.isArray(data)
      ? { ...data, _meta: envelope.meta }
      : data;
    // Compact on purpose: pretty-printing inflated every agent-facing tool
    // result by double-digit percent for zero information (2026-07 A/B).
    const output = JSON.stringify(payloadWithMeta);
    const responseTelemetry = extractAtlasResponseTelemetry(output);
    recordAtlasToolObservation({
      action,
      invocation: { source: "atlas-v2", command: viewPath },
      args: payload,
      ok: true,
      durationMs: Date.now() - startedAt,
      origin,
      queueInfo,
      resultChars: output.length,
      responseTelemetry,
      artifacts: extractAtlasResultArtifacts(output, { action, args: payload }),
    });
    return output;
  } catch (err) {
    const message = err?.message || String(err);
    recordAtlasToolObservation({
      action,
      invocation: { source: "atlas-v2", command: viewPath },
      args: payload,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
      queueInfo,
    });
    return formatAtlasV2EmbeddedError(action, err);
  } finally {
    try { closeEmbeddedAtlasHandle(view, "view", { action, origin }); } catch { /* ignore */ }
    try { releaseEmbeddedResourceLease(ledgerLease); } catch { /* ignore */ }
    try { releaseEmbeddedResourceLease(embeddingResourcesLease); } catch { /* ignore */ }
  }
}

export function getAtlasEmbeddedToolDefinitions(toolNames = []) {
  return getAtlasDeterministicToolDefinitions(toolNames);
}

export function resolveEmbeddedAtlasAction(toolName) {
  return resolveAtlasDeterministicAction(toolName);
}

export function createAtlasEmbeddedToolkit({ executor = null } = {}) {
  const run = typeof executor === "function"
    ? executor
    : async (toolName, args = {}, opts = {}) => executeEmbeddedAtlasTool(toolName, args, opts);
  return {
    getToolDefinitions: getAtlasEmbeddedToolDefinitions,
    toolDefinitions: getAtlasEmbeddedToolDefinitions,
    resolveAction: resolveEmbeddedAtlasAction,
    executeTool: run,
  };
}

export function buildEmbeddedAtlasInvocation(action, { cwd = null, config = getAtlasIntegrationConfig() } = {}) {
  const env = buildAtlasProcessEnv({ cwd, config });
  return {
    command: null,
    args: [],
    cwd: cwd || process.cwd(),
    env,
    source: "atlas-v2-native",
    action,
    accessMode: isBlockingAction(action) ? "readwrite" : "readonly",
    readOnlyRequested: !isBlockingAction(action),
    repoId: config?.requestedRepoId || null,
    backend: "atlas-v2",
  };
}

// Transient ATLAS failures: conditions that resolve themselves within
// seconds (a view mid-rebuild, sqlite write contention, daemon churn).
// A single occurrence must not fail the tool call — and absolutely must not
// flip the role into deterministic fallback. Corruption/disabled states are
// deliberately NOT transient.
const ATLAS_TRANSIENT_ERROR_RE = /view is not current|view is not ready|view is stale|database is locked|SQLITE_BUSY|DAEMON_TIMEOUT|DAEMON_OVERLOADED|DAEMON_TRANSPORT_GONE/i;
const ATLAS_TRANSIENT_RETRY_DELAYS_MS = [400, 1200];
const ATLAS_TRANSIENT_INDEXING_WAIT_MS = 15_000;

export function isTransientAtlasError(text) {
  const value = String(text || "");
  if (!/^Error:/i.test(value)) return false;
  if (/corrupt|disabled by configuration|disabled for this repository/i.test(value)) return false;
  return ATLAS_TRANSIENT_ERROR_RE.test(value);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// When the conductor is mid-warm/merge, "view is not current" means "your
// data is seconds away" — wait for the indexing to land instead of burning
// retries against a moving target.
async function waitForConductorIndexingToSettle(maxMs = ATLAS_TRANSIENT_INDEXING_WAIT_MS) {
  const deadline = Date.now() + Math.max(0, maxMs);
  while (Date.now() < deadline && isConductorIndexingInFlight()) {
    await sleepMs(500);
  }
}

function isRuntimeDisabled(config = {}) {
  const mode = String(config?.normalizedMode || config?.mode || "").trim().toLowerCase();
  return config?.enabled === false || mode === "off";
}

export async function executeEmbeddedAtlasTool(action, args = {}, {
  cwd = null,
  config = getAtlasIntegrationConfig(),
  timeoutMs = null,
  origin = "agent",
  maxBufferBytes = DEFAULT_EMBEDDED_MAX_BUFFER_BYTES,
} = {}) {
  void maxBufferBytes;
  const startedAt = Date.now();
  if (isRuntimeDisabled(config)) {
    const message = "ATLAS is disabled by configuration.";
    recordAtlasToolObservation({
      action,
      invocation: { source: "disabled-config", command: null },
      args,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
    });
    return `Error: ATLAS tool ${action} skipped: ${message}`;
  }
  const repo = await resolveAtlasRepoTargetAsync({ cwd, config });
  const graphDbPath = buildAtlasProcessEnv({ cwd, config })?.ATLAS_GRAPH_DB_PATH || null;
  const protectedAssetKey = atlasProtectedAssetKey({ repo, graphDbPath, cwd, config });
  const repoDisabledReason = getAtlasRuntimeDisabledReason(repo.repoId)
    || getAtlasRuntimeDisabledReason(repo.repoPath)
    || getAtlasRuntimeDisabledReason(graphDbPath);
  if (repoDisabledReason) {
    const message = `ATLAS is disabled for this repository: ${repoDisabledReason}`;
    recordAtlasToolObservation({
      action,
      invocation: { source: "repo-disabled", command: null },
      args,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
    });
    return `Error: ATLAS tool ${action} skipped: ${message}`;
  }
  const corruptionBackoff = activeCorruptionBackoff(repo);
  if (corruptionBackoff) {
    const waitMs = Math.max(0, Number(corruptionBackoff.untilMs || 0) - Date.now());
    const message = `ATLAS temporarily disabled for ${Math.ceil(waitMs / 1000)}s after ${corruptionBackoff.reason}; using deterministic fallback tools.`;
    recordAtlasToolObservation({
      action,
      invocation: { source: "corruption-backoff", command: null },
      args,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
    });
    return `Error: ATLAS tool ${action} skipped: ${message}`;
  }
  let prepared;
  try {
    prepared = prepareAtlasDeterministicPayload(action, args, { repoId: repo.repoId || null });
  } catch (err) {
    const message = err?.message || String(err);
    recordAtlasToolObservation({
      action,
      invocation: null,
      args,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
    });
    return `Error: ${message}`;
  }

  const obsCtx = getObservationContext() || {};
  const prefetchLike = isAtlasPrefetchOrigin(origin);
  const prefetchScope = prefetchLike ? prefetchScopeId(obsCtx, repo) : null;
  const prefetchVersion = prefetchLike ? await prefetchVersionId(cwd, repo) : null;
  const jobVersion = origin === "agent" ? await prefetchVersionId(cwd || repo.repoPath, repo) : null;
  const jobCacheEnabled = atlasJobCacheEnabled(config);
  if (origin === "agent") {
    const cached = atlasCacheGet(obsCtx.job_id ?? null, prepared.action, prepared.payload, { enabled: jobCacheEnabled, versionId: jobVersion });
    if (cached != null) {
      recordAtlasToolObservation({
        action: prepared.action,
        cliAction: prepared.cliAction,
        invocation: null,
        args: prepared.payload || args,
        ok: true,
        durationMs: Date.now() - startedAt,
        origin,
        cacheHit: true,
        artifacts: extractAtlasResultArtifacts(cached, { action: prepared.action, args: prepared.payload }),
      });
      return cached;
    }
  } else if (prefetchLike) {
    const cached = prefetchCacheGet(prefetchScope, prepared.action, prepared.payload, prefetchVersion);
    if (cached != null) {
      recordAtlasToolObservation({
        action: prepared.action,
        cliAction: prepared.cliAction,
        invocation: null,
        args: prepared.payload || args,
        ok: true,
        durationMs: Date.now() - startedAt,
        origin,
        cacheHit: true,
        artifacts: extractAtlasResultArtifacts(cached, { action: prepared.action, args: prepared.payload }),
      });
      return cached;
    }
  }

  try {
    recordMemorySample("atlas.embedded.before", {
      action: prepared.action,
      origin,
      repo_id: repo.repoId || null,
      work_item_id: obsCtx.work_item_id ?? null,
      job_id: obsCtx.job_id ?? null,
    });
    const useToolExecutor = canUseAtlasToolExecutor(prepared.action, prepared.payload, config);
    const workItemId = embeddedWorkItemId(obsCtx, config);
    const runGatedCall = () => withProtectedAtlasGate((queueInfo) => {
      const runArgs = {
        action: prepared.action,
        payload: prepared.payload,
        cwd,
        config,
        repo,
        startedAt,
        origin,
        queueInfo,
        workItemId,
      };
      return useToolExecutor
        ? executeEmbeddedAtlasViaExecutor(runArgs)
        : executeEmbeddedAtlasV2Tool(runArgs);
    }, {
      action: prepared.action,
      payload: prepared.payload,
      origin,
      config,
      timeoutMs: Math.max(1000, Number(timeoutMs) || Number(config?.embeddedTimeoutMs) || getAtlasEmbeddedTimeoutMs()),
      assetKey: protectedAssetKey,
    });
    // Read calls get a bounded second chance on transient failures instead of
    // surfacing one-off errors (which downstream treats as fallback signals).
    const transientRetryable = !isBlockingAction(prepared.action, prepared.payload)
      && prepared.action !== "memory.store"
      && prepared.action !== "policy.set";
    const runWithTransientRetries = async () => {
      let result = await runGatedCall();
      for (let attempt = 0; transientRetryable
        && attempt < ATLAS_TRANSIENT_RETRY_DELAYS_MS.length
        && isTransientAtlasError(result); attempt++) {
        if (isConductorIndexingInFlight()) {
          await waitForConductorIndexingToSettle();
        } else {
          await sleepMs(ATLAS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        }
        log.debug("atlas", "Retrying embedded ATLAS call after transient failure", {
          action: prepared.action,
          attempt: attempt + 1,
          error: String(result).slice(0, 160),
        });
        result = await runGatedCall();
      }
      return result;
    };

    const sharedReadKey = atlasSharedReadKey({
      enabled: atlasExecCoalesceEnabled(config),
      action: prepared.action,
      assetKey: protectedAssetKey,
      versionId: origin === "agent" ? jobVersion : prefetchVersion,
      payload: prepared.payload,
    });
    let output;
    let sharedReadHit = false;
    if (sharedReadKey != null) {
      const cached = ATLAS_SHARED_READ_CACHE.get(sharedReadKey);
      if (cached != null) {
        output = cached;
        sharedReadHit = true;
      } else if (ATLAS_SHARED_READ_INFLIGHT.has(sharedReadKey)) {
        // Coalesce: ride the identical in-flight call instead of queueing on
        // the gate/conductor behind it.
        output = await ATLAS_SHARED_READ_INFLIGHT.get(sharedReadKey);
        sharedReadHit = true;
      } else {
        const epochAtStart = _sharedReadCacheEpoch;
        const pending = runWithTransientRetries();
        ATLAS_SHARED_READ_INFLIGHT.set(sharedReadKey, pending);
        try {
          output = await pending;
        } finally {
          if (ATLAS_SHARED_READ_INFLIGHT.get(sharedReadKey) === pending) {
            ATLAS_SHARED_READ_INFLIGHT.delete(sharedReadKey);
          }
        }
        // Don't promote a result that raced a reindex landing mid-call.
        if (epochAtStart === _sharedReadCacheEpoch && !/^Error:/i.test(String(output || ""))) {
          sharedReadCacheSet(sharedReadKey, output);
        }
      }
    } else {
      output = await runWithTransientRetries();
    }
    if (sharedReadHit) {
      recordAtlasToolObservation({
        action: prepared.action,
        cliAction: prepared.cliAction,
        invocation: null,
        args: prepared.payload || args,
        ok: !/^Error:/i.test(String(output || "")),
        durationMs: Date.now() - startedAt,
        origin,
        cacheHit: true,
        artifacts: extractAtlasResultArtifacts(output, { action: prepared.action, args: prepared.payload }),
      });
      return output;
    }
    if (!/^Error:/i.test(String(output || ""))) {
      if (origin === "agent") {
        atlasCacheSet(obsCtx.job_id ?? null, prepared.action, prepared.payload, output, {
          enabled: jobCacheEnabled,
          versionId: jobVersion,
          ttlMs: config?.jobCacheTtlMs,
        });
      } else if (prefetchLike) {
        prefetchCacheSet(prefetchScope, prepared.action, prepared.payload, output, prefetchVersion, config?.prefetchCacheTtlMs);
      }
    }
    recordMemorySample("atlas.embedded.after_success", {
      action: prepared.action,
      origin,
      repo_id: repo.repoId || null,
      work_item_id: obsCtx.work_item_id ?? null,
      job_id: obsCtx.job_id ?? null,
      duration_ms: Date.now() - startedAt,
      output_chars: typeof output === "string" ? output.length : null,
    });
    return output;
  } catch (err) {
    recordMemorySample("atlas.embedded.after_error", {
      action: prepared.action,
      origin,
      repo_id: repo.repoId || null,
      work_item_id: obsCtx.work_item_id ?? null,
      job_id: obsCtx.job_id ?? null,
      duration_ms: Date.now() - startedAt,
      error_name: err?.name || null,
      error_message: String(err?.message || err).slice(0, 1000),
    });
    if (!isAtlasGateError(err)) throw err;
    const message = formatAtlasGateMessage(err, { action: prepared.action, payload: prepared.payload, origin });
    recordAtlasToolObservation({
      action: prepared.action,
      cliAction: prepared.cliAction,
      invocation: { source: "atlas-gate", command: null },
      args: prepared.payload || args,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: message,
      origin,
      queueInfo: {
        key: protectedAssetKey,
        mode: atlasGateMode(prepared.action, prepared.payload, origin),
        label: `${origin}:${prepared.action}`,
        waitMs: 0,
        depthAtEnqueue: 0,
        inFlightAtEnqueue: 0,
      },
    });
    return `Error: ATLAS tool ${action} skipped: ${message}`;
  }
}

export function __testBuildEmbeddedAtlasInvocation(action, opts = {}) {
  return buildEmbeddedAtlasInvocation(action, opts);
}
