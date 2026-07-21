// @ts-check
//
// Shared ATLAS v2 embedding resource opener.
//
// Production callers share one native-only encoder/index lifecycle.

import fs from "fs";
import path from "path";
import {
  ATLAS_JINA_MODEL,
  DEFAULT_ATLAS_EMBEDDING_PROVIDER,
  atlasEmbeddingModelForId,
  normalizeAtlasEmbeddingModelId,
} from "../../../../../catalog/atlas.js";
import { embeddingsRoot } from "../runtime-paths.js";
import { AtlasEmbeddingEncoder } from "../../../classes/v2/AtlasEmbeddingEncoder.js";
import { RustEmbeddingIndex, embeddingModelDirName } from "../../../classes/v2/RustEmbeddingIndex.js";
import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";
import { errorForTelemetry, recordEmbeddingForensics } from "./forensics.js";
import { ensureAtlasEmbeddingModelRoot, inspectAtlasEmbeddingModel } from "./jina-model.js";

/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndexContract */

/**
 * @typedef {Object} OpenEmbeddingResourcesResult
 * @property {boolean} enabled
 * @property {string} provider
 * @property {string | null} reason
 * @property {EmbeddingEncoder | null} encoder
 * @property {EmbeddingIndexContract | null} index
 * @property {string | null} backend
 * @property {() => void | Promise<void>} close
 */

/**
 * Semantic capability is always installed. Individual requests still choose
 * semantic or lexical behavior through their explicit `semantic` argument.
 *
 * @param {Record<string, unknown>} _config
 * @returns {boolean}
 */
export function semanticDispatchEnabled(_config = {}) {
  return true;
}

/**
 * @param {{
 *   repoRoot: string,
 *   config?: Record<string, unknown>,
 *   env?: Record<string, unknown>,
 * }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
// ---------------------------------------------------------------------------
// Per-realm embedding-resource pool (default ON).
//
// Successive opens for the same native index in this realm reuse one
// reference-counted encoder+index; an idle entry is closed after a grace TTL.
// Safe because B (reader read-only) + D (in-host flush serialization) keep a
// single writer regardless of pooling. Escape hatch:
// POSSE_ATLAS_EMBEDDING_CHILD_POOL=0 (or config atlasEmbeddingChildPool false).
// ---------------------------------------------------------------------------
// Idle pooled children are closed after this TTL. A short TTL (the original 60s)
// closes the child between spaced-out warms and loses the reuse benefit, so the
// default is 5min; override with POSSE_ATLAS_EMBEDDING_POOL_IDLE_MS. Only matters
// when pooling is enabled.
const EMBEDDING_POOL_IDLE_MS = Number(process.env.POSSE_ATLAS_EMBEDDING_POOL_IDLE_MS) > 0
  ? Number(process.env.POSSE_ATLAS_EMBEDDING_POOL_IDLE_MS)
  : 300_000;

// Default ON: pooling the per-realm child across warm slices avoids the
// fork-per-open churn (100+ child spawns/run) and is safe — B (reader read-only)
// + D (in-host flush serialization) remove concurrent writers regardless of
// pooling, and it ran clean under load. An explicit falsey value (0/false/off/no)
// is the escape hatch.
/**
 * @param {Record<string, any>} [config]
 * @param {Record<string, any>} [env]
 */
export function embeddingChildPoolEnabled(config = {}, env = {}) {
  const raw = config?.atlasEmbeddingChildPool
    ?? config?.atlas_embedding_child_pool
    ?? env?.POSSE_ATLAS_EMBEDDING_CHILD_POOL
    ?? process.env.POSSE_ATLAS_EMBEDDING_CHILD_POOL;
  if (raw == null || String(raw).trim() === "") return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

export function createEmbeddingResourcePool({ idleMs = EMBEDDING_POOL_IDLE_MS } = {}) {
  /** @type {Map<string, { resources: any, refCount: number, idleTimer: any, retired: boolean }>} */
  const entries = new Map();

  function wrap(key, entry) {
    let released = false;
    return {
      ...entry.resources,
      close: async () => {
        if (released) return;
        released = true;
        entry.refCount = Math.max(0, entry.refCount - 1);
        if (entries.get(key) !== entry) {
          // Entry was retired (invalidation) or evicted while we held it: the
          // pool no longer owns it, so the LAST holder closes the underlying
          // resources for real — otherwise the stale child leaks forever.
          if (entry.retired && entry.refCount <= 0) {
            try { await entry.resources.close(); } catch { /* best effort */ }
          }
          return;
        }
        if (entry.refCount > 0) return;
        // No active users — keep the child warm briefly, then really close.
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => { void evict(key, entry); }, idleMs);
        entry.idleTimer?.unref?.();
      },
    };
  }

  async function evict(key, entry) {
    if (entries.get(key) !== entry || entry.refCount > 0) return; // reacquired
    entries.delete(key);
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    try { await entry.resources.close(); } catch { /* best effort */ }
  }

  /**
   * Drop an entry from the pool NOW so the next acquire rebuilds fresh
   * resources. Active holders keep the old resources until their close; the
   * last one closes the underlying child. This is the invalidation hook —
   * without it, wrapper close only refcounts and a "reopened" reader gets the
   * same stale in-memory ANN back.
   *
   * @param {string} key
   * @returns {{ retired: boolean, closePromise: Promise<void> | null }} retirement state
   */
  function retireEntry(key) {
    const entry = entries.get(key);
    if (!entry) return { retired: false, closePromise: null };
    entries.delete(key);
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    entry.retired = true;
    const closePromise = entry.refCount <= 0
      ? (async () => { try { await entry.resources.close(); } catch { /* best effort */ } })()
      : null;
    return { retired: true, closePromise };
  }

  function retire(key) {
    return retireEntry(key).retired;
  }

  return {
    /** @param {string} key @param {() => any} build */
    acquire(key, build) {
      let entry = entries.get(key);
      if (!entry) {
        const resources = build();
        // Never pool a disabled/failed open — return it unwrapped so the caller
        // sees the real reason and nothing lingers in the pool.
        if (!resources || resources.enabled === false) return resources;
        entry = { resources, refCount: 0, idleTimer: null, retired: false };
        entries.set(key, entry);
      }
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      entry.refCount += 1;
      return wrap(key, entry);
    },
    retire,
    retireAll() {
      let retired = 0;
      for (const key of [...entries.keys()]) {
        if (retire(key)) retired += 1;
      }
      return retired;
    },
    async retireAllAndWait() {
      let retired = 0;
      const closePromises = [];
      for (const key of [...entries.keys()]) {
        const result = retireEntry(key);
        if (result.retired) retired += 1;
        if (result.closePromise) closePromises.push(result.closePromise);
      }
      await Promise.all(closePromises);
      return retired;
    },
    async closeAll() {
      const all = [...entries.values()];
      entries.clear();
      for (const entry of all) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.retired = true;
        try { await entry.resources.close(); } catch { /* best effort */ }
      }
    },
    size() { return entries.size; },
  };
}

const embeddingResourcePool = createEmbeddingResourcePool();

/** Close every pooled embedding resource (for explicit realm/daemon teardown). */
export function closeAllPooledEmbeddingResources() {
  return embeddingResourcePool.closeAll();
}

/**
 * Invalidation hook: retire every pooled embedding entry in THIS realm so the
 * next semantic open forks a fresh child that reads the just-rewritten index.
 * Cross-lane ANN invalidation is only effective through this — a wrapper
 * close alone refcounts and the next acquire resurrects the stale child.
 *
 * @returns {number} entries retired
 */
export function retirePooledEmbeddingResources() {
  return embeddingResourcePool.retireAll();
}

/**
 * Retire every pooled entry and wait for resources that are already idle to
 * close. Active holders remain valid and close their retired resource when
 * the final holder releases it.
 */
export function retirePooledEmbeddingResourcesAndWait() {
  return embeddingResourcePool.retireAllAndWait();
}

/**
 * @param {{ repoRoot: string, config?: Record<string, any>, env?: Record<string, any>, readOnly?: boolean }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
export function openEmbeddingResources({ repoRoot, config = {}, env = {}, readOnly = false }) {
  const provider = normalizeAtlasEmbeddingModelId(
    config.atlasEmbeddingModelId ?? config.atlas_embedding_model_id,
  );
  const activeModel = atlasEmbeddingModelForId(provider);
  const vectorBackend = "posse-vector";
  const nativeManager = config.nativeManager ?? config.nativeVectorManager ?? nativeBinaries;
  const modelCacheDir = config.atlasEmbeddingModelCacheDir
    ? path.resolve(String(config.atlasEmbeddingModelCacheDir))
    : activeModel.modelId === ATLAS_JINA_MODEL.modelId && config.atlasJinaModelCacheDir
    ? path.resolve(String(config.atlasJinaModelCacheDir))
    : null;
  const modelVersion = String(config.atlasEmbeddingModelVersion || "").trim() || null;
  const batchSize = Number.isInteger(config.atlasEmbeddingBatchSize)
    ? Math.max(1, Math.min(Number(config.atlasEmbeddingBatchSize), 512))
    : null;
  const intraOpThreads = Number.isInteger(config.atlasEmbeddingThreads)
    ? Math.max(1, Math.min(Number(config.atlasEmbeddingThreads), 32))
    : null;
  recordEmbeddingForensics("resources.open.start", {
    repo_root: repoRoot || null,
    provider,
    vector_backend: vectorBackend,
    semantic_enabled: true,
  });
  if (!repoRoot) {
    return disabled(provider, "missing_repo_root", vectorBackend, { repoRoot });
  }
  const modelInspection = inspectAtlasEmbeddingModel(activeModel, repoRoot, { modelCacheDir: modelCacheDir || undefined });
  if (!modelInspection.ready) {
    return disabled(provider, `${activeModel.modelId}_model_cache_missing`, vectorBackend, {
      repoRoot,
      model_cache_dir: modelInspection.modelCacheDir,
      model_id: activeModel.modelId,
    });
  }

  // Mode is part of the pool identity: a read-only child (no quarantine, no
  // saves) must never be handed to a caller that intends to write.
  const poolKey = embeddingChildPoolEnabled(config, env)
    ? `${embeddingsRoot(repoRoot)}|${provider}|${vectorBackend}|${modelInspection.modelCacheDir}|${modelVersion || "default"}|batch=${batchSize || "default"}|threads=${intraOpThreads || "default"}|${readOnly ? "ro" : "rw"}`
    : null;
  const build = () => {
    if (!nativeManager.shouldUse("ml")) throw new Error("posse-ml unavailable");
    if (!nativeManager.shouldUse("vector")) throw new Error("posse-atlas-vector unavailable");
    const modelRoot = ensureAtlasEmbeddingModelRoot(activeModel, modelInspection.modelCacheDir);
    const encoder = new AtlasEmbeddingEncoder({
      repoRoot,
      modelConfig: activeModel,
      modelCacheDir: modelInspection.modelCacheDir,
      modelRoot,
      modelVersion,
      batchSize,
      intraOpThreads,
      manager: nativeManager,
    });
    const result = openIndexForBackend({
      provider,
      encoder,
      repoRoot,
      readOnly,
      nativeVectorManager: nativeManager,
    });
    recordEmbeddingForensics("resources.open.enabled", {
      repo_root: repoRoot,
      provider: result.provider,
      backend: result.backend,
      encoder: encoderTelemetry(result.encoder),
      index: indexTelemetry(result.index),
      embeddings_root: embeddingsRoot(repoRoot),
      pooled: !!poolKey,
    });
    return result;
  };
  try {
    return poolKey ? embeddingResourcePool.acquire(poolKey, build) : build();
  } catch (err) {
    recordEmbeddingForensics("resources.open.error", {
      repo_root: repoRoot,
      provider,
      vector_backend: "posse-vector",
      error: errorForTelemetry(err),
    });
    return disabled(provider, `open_failed: ${err?.message || String(err)}`, vectorBackend, { repoRoot });
  }
}

/**
 * Remove old embedding index directories for the same encoder model after a
 * grace period. The current `(model, model_version)` directory is never
 * removed; other providers/models are left alone.
 *
 * @param {{
 *   repoRoot: string,
 *   currentModel: string,
 *   currentModelVersion: string,
 *   graceMs?: number,
 *   nowMs?: number,
 * }} args
 * @returns {{ removed: number }}
 */
export function cleanupStaleEmbeddingDirs({
  repoRoot,
  currentModel,
  currentModelVersion,
  graceMs = 7 * 24 * 60 * 60 * 1000,
  nowMs = Date.now(),
}) {
  const root = embeddingsRoot(repoRoot);
  const model = String(currentModel || "").trim();
  const modelVersion = String(currentModelVersion || "").trim();
  if (!repoRoot || !model || !modelVersion || !fs.existsSync(root)) return { removed: 0 };
  const current = embeddingModelDirName({ model, model_version: modelVersion });
  const prefix = `${encodeModelDirComponent(model)}--`;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === current) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const dirPath = path.join(root, entry.name);
    let stat;
    try { stat = fs.statSync(dirPath); }
    catch { continue; }
    if (Number(nowMs) - Number(stat.mtimeMs) < graceMs) continue;
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      // Best effort: a locked stale index can be swept by a later warm.
    }
  }
  return { removed };
}

/**
 * @param {string} provider
 * @param {string} reason
 * @param {string | null} backend
 * @returns {OpenEmbeddingResourcesResult}
 */
function disabled(provider, reason, backend = null, details = {}) {
  recordEmbeddingForensics("resources.open.disabled", {
    provider,
    reason,
    backend,
    ...details,
  });
  return {
    enabled: false,
    provider,
    reason,
    encoder: null,
    index: null,
    backend,
    close: () => {},
  };
}

/**
 * @param {{
 *   provider?: string,
 *   encoder: EmbeddingEncoder,
 *   repoRoot: string,
 *   readOnly?: boolean,
 *   nativeVectorManager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 * }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
function openIndexForBackend({ provider = DEFAULT_ATLAS_EMBEDDING_PROVIDER, encoder, repoRoot, readOnly = false, nativeVectorManager = nativeBinaries }) {
  const root = embeddingsRoot(repoRoot);
  if (!nativeVectorManager.shouldUse("vector")) {
    throw new Error("posse-atlas-vector unavailable");
  }
  const index = RustEmbeddingIndex.open({
    model: encoder.model,
    model_version: encoder.model_version,
    dim: encoder.dim,
    embeddingsRoot: root,
    readOnly,
    manager: nativeVectorManager,
  });
  return enabled({ provider, backend: "posse-vector", encoder, index });
}

/**
 * @param {{ provider: string, backend: string, encoder: EmbeddingEncoder, index: EmbeddingIndexContract }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
function enabled({ provider, backend, encoder, index }) {
  return {
    enabled: true,
    provider,
    reason: null,
    encoder,
    index,
    backend,
    close: async () => {
      recordEmbeddingForensics("resources.close.start", {
        provider,
        backend,
        encoder: encoderTelemetry(encoder),
        index: indexTelemetry(index),
      });
      try { await index.close(); } catch (err) {
        recordEmbeddingForensics("resources.close.index_error", {
          provider,
          backend,
          error: errorForTelemetry(err),
        });
      }
      try { await encoder?.dispose?.(); } catch (err) {
        recordEmbeddingForensics("resources.close.encoder_error", {
          provider,
          backend,
          error: errorForTelemetry(err),
        });
      }
      recordEmbeddingForensics("resources.close.done", {
        provider,
        backend,
      });
    },
  };
}

function encoderTelemetry(encoder) {
  return {
    model: encoder?.model || null,
    model_version: encoder?.model_version || null,
    model_name: /** @type {any} */ (encoder)?.modelName || null,
    model_id: /** @type {any} */ (encoder)?.modelId || null,
    dim: encoder?.dim || null,
    dtype: /** @type {any} */ (encoder)?.dtype || null,
    cache_dir: /** @type {any} */ (encoder)?.cacheDir || null,
  };
}

function indexTelemetry(index) {
  return {
    model: index?.model || null,
    model_version: index?.model_version || null,
    backend: /** @type {any} */ (index)?.backend || null,
    dim: index?.dim || null,
    gate_key: /** @type {any} */ (index)?.gateKey || null,
    child_index: !!/** @type {any} */ (index)?.childIndex,
    async_index: !!/** @type {any} */ (index)?.asyncIndex,
    protected_async_index: !!/** @type {any} */ (index)?.protectedAsyncIndex,
  };
}

/**
 * @param {string} value
 */
function encodeModelDirComponent(value) {
  return encodeURIComponent(String(value)).replace(/%/g, "~");
}
