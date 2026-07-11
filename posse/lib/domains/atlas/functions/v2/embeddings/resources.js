// @ts-check
//
// Shared ATLAS v2 embedding resource opener.
//
// The encoder/index contracts are intentionally generic, but production
// callers all need the same policy:
//   * embeddings are disabled unless the operator explicitly opts in;
//   * the optional ANN dependency may be absent and should degrade cleanly;
//   * opened indexes must be closed by the caller.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { embeddingsRoot } from "../runtime-paths.js";
import { inspectLocalOnnxStatus, localOnnxRequested, LOCAL_ONNX_PROVIDER_ALIASES } from "./local-onnx.js";
import { resolveConfiguredEncoder } from "../../../classes/v2/EmbeddingEncoder.js";
import { ChildEmbeddingIndex, childEmbeddingModelDirName } from "../../../classes/v2/ChildEmbeddingIndex.js";
import { RustEmbeddingIndex } from "../../../classes/v2/RustEmbeddingIndex.js";
import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";
import { encodeViaSharedOnnxDaemon } from "./onnx-daemon.js";
import { errorForTelemetry, recordEmbeddingForensics } from "./forensics.js";

/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndexContract */

const localRequire = createRequire(import.meta.url);

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
 * Embeddings are opt-in for product paths. Direct unit tests can still
 * instantiate StubEmbeddingEncoder by hand; production warmer/proxy paths
 * only enable vector indexing/search when the provider is explicit.
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function configuredEmbeddingProvider(config = {}) {
  const provider = String(config?.embeddingProvider || config?.atlasEmbeddingProvider || config?.provider || "").trim().toLowerCase();
  if (provider) return provider;
  if (localOnnxRequested(config)) return "local-onnx";
  return configuredRemoteEncoderMode(config) !== "off" ? "posse-remote" : "";
}

/**
 * @param {Record<string, unknown>} config
 * @returns {"off" | "shadow" | "preferred" | "required"}
 */
export function configuredRemoteEncoderMode(config = {}) {
  const raw = String(config?.remoteEncoderMode || config?.atlasRemoteEncoderMode || config?.atlas_remote_encoder_mode || "off").trim().toLowerCase();
  return raw === "shadow" || raw === "preferred" || raw === "required" ? raw : "off";
}

/**
 * @param {Record<string, unknown>} config
 * @returns {boolean}
 */
export function embeddingsExplicitlyEnabled(config = {}) {
  const provider = configuredEmbeddingProvider(config);
  return provider !== "" && provider !== "off" && provider !== "none" && provider !== "false" && provider !== "0" && provider !== "no";
}

/**
 * Operator-opt-in gate for ATLAS semantic dispatch in symbol.search. Even when
 * the embedding index is opened for the warmer or another consumer, the dispatcher only honors a caller's
 * `semantic: true` flag when this gate returns true. Default is off because
 * the deterministic-stub encoder's recall is modest (≈27% top-1 token match
 * on real codebases) and FTS is the safer baseline.
 *
 * @param {Record<string, unknown>} config
 * @returns {boolean}
 */
export function semanticDispatchEnabled(config = {}) {
  const raw = String(config?.semanticEnabled ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * @param {Record<string, unknown>} config
 * @returns {"auto" | "rust" | "usearch" | "off"}
 */
export function configuredVectorBackend(config = {}) {
  const raw = String(config?.vectorBackend || "auto").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "none" || raw === "off") return "off";
  if (raw === "rust") return raw;
  if (raw === "usearch") return raw;
  // Unknown values (including legacy "lancedb") silently degrade to auto so
  // existing settings don't crash the pipeline after the lance removal.
  return "auto";
}

function usearchPackageResolvable() {
  try {
    localRequire.resolve("usearch");
    return true;
  } catch {
    return false;
  }
}

// Encode placement. Local-ONNX inference is transformers.js: tokenization and
// pooling are synchronous JS, so calling encoder.encode() inline pins whatever
// thread asked for vectors — the main loop on the in-process retrieval path,
// the conductor thread during warms/retrieves. Local-ONNX opens therefore wrap
// the encoder so encode() delegates to the shared persistent ONNX worker set
// (one warm model per worker). The wrapper preserves the encoder's full identity
// (model/model_version/dim drive index dir naming), and forwards `workers` so
// bulk ingest gets data-parallel encode across the warm set.

/**
 * @param {any} encoder  a LocalOnnxEmbeddingEncoder instance
 * @returns {EmbeddingEncoder}
 */
function daemonBackedLocalOnnxEncoder(encoder) {
  // The daemon host reconstructs the encoder from this config — it must round-
  // trip the exact constructor identity (model_version is passed back as
  // modelVersion so the host's composed version string matches ours).
  const daemonConfig = {
    cacheDir: encoder.cacheDir,
    modelName: encoder.modelName,
    modelId: encoder.modelId,
    dim: encoder.dim,
    modelVersion: encoder.model_version,
    batchSize: encoder.batchSize,
    maxInputChars: encoder.maxInputChars,
    maxInputTokens: encoder.maxInputTokens,
    dtype: encoder.dtype,
    localFilesOnly: encoder.localFilesOnly,
  };
  return /** @type {any} */ ({
    model: encoder.model,
    model_version: encoder.model_version,
    dim: encoder.dim,
    modelName: encoder.modelName,
    modelId: encoder.modelId,
    cacheDir: encoder.cacheDir,
    batchSize: encoder.batchSize,
    maxInputChars: encoder.maxInputChars,
    maxInputTokens: encoder.maxInputTokens,
    dtype: encoder.dtype,
    localFilesOnly: encoder.localFilesOnly,
    daemonBacked: true,
    buildSymbolText: (/** @type {any} */ symbol) => encoder.buildSymbolText(symbol),
    encode: (/** @type {string[]} */ texts, /** @type {AbortSignal} */ signal, /** @type {{ workers?: number }} */ opts = {}) =>
      encodeViaSharedOnnxDaemon(texts, daemonConfig, { signal, workers: opts?.workers ?? 1 }),
    // Dispose the wrapped inline encoder only (it never loaded a model — encode
    // is delegated). The shared daemon outlives any one open and is reclaimed
    // by its own idle eviction / session cleanup.
    dispose: () => encoder.dispose?.(),
  });
}

export function __testDaemonBackedLocalOnnxEncoder(encoder) {
  return daemonBackedLocalOnnxEncoder(encoder);
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
// The old behavior forked a fresh ChildEmbeddingIndex (and encoder) per
// openEmbeddingResources() and killed it on close() — one fork per warm slice,
// the dominant source of child-index churn (100+ spawns/run). Successive opens
// for the same (repo, provider, backend) in this realm now reuse ONE
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
   * @returns {boolean} whether an entry existed
   */
  function retire(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    entry.retired = true;
    if (entry.refCount <= 0) {
      void (async () => { try { await entry.resources.close(); } catch { /* best effort */ } })();
    }
    return true;
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

export function openEmbeddingResources({ repoRoot, config = {}, env = {}, readOnly = false }) {
  /** @type {Record<string, unknown>} */
  const effectiveConfig = {
    ...normalizeEmbeddingConfig(config, env),
    repoRoot,
  };
  const provider = configuredEmbeddingProvider(effectiveConfig);
  if (provider && !effectiveConfig.embeddingProvider && !effectiveConfig.atlasEmbeddingProvider && !effectiveConfig.provider) {
    effectiveConfig.embeddingProvider = provider;
    effectiveConfig.atlasEmbeddingProvider = provider;
  }
  const vectorBackend = configuredVectorBackend(effectiveConfig);
  recordEmbeddingForensics("resources.open.start", {
    repo_root: repoRoot || null,
    provider: provider || null,
    vector_backend: vectorBackend,
    semantic_enabled: semanticDispatchEnabled(effectiveConfig),
    embedding_threads: effectiveConfig.embeddingThreads
      ?? effectiveConfig.atlasEmbeddingThreads
      ?? effectiveConfig.atlas_embedding_threads
      ?? null,
  });
  if (!repoRoot) {
    return disabled(provider, "missing_repo_root", vectorBackend, { repoRoot });
  }
  if (!embeddingsExplicitlyEnabled(effectiveConfig)) {
    return disabled(provider || "off", "disabled", vectorBackend, { repoRoot });
  }
  if (vectorBackend === "off") {
    return disabled(provider, "vector_backend_disabled", "off", { repoRoot });
  }
  if (LOCAL_ONNX_PROVIDER_ALIASES.has(provider)) {
    const onnx = inspectLocalOnnxStatus({ repoRoot, config: effectiveConfig });
    if (!onnx.enabled) {
      return disabled(provider, `local_onnx: ${onnx.reason}`, vectorBackend, { repoRoot, onnx });
    }
  }

  // Mode is part of the pool identity: a read-only child (no quarantine, no
  // saves) must never be handed to a caller that intends to write.
  const poolKey = embeddingChildPoolEnabled(effectiveConfig, env)
    ? `${embeddingsRoot(repoRoot)}|${provider}|${vectorBackend}|${readOnly ? "ro" : "rw"}`
    : null;
  const build = () => {
    let encoder = resolveConfiguredEncoder(effectiveConfig, env);
    if (encoder?.model === "local-onnx") {
      encoder = daemonBackedLocalOnnxEncoder(encoder);
    }
    const result = openIndexForBackend({
      backend: vectorBackend,
      encoder,
      repoRoot,
      requestedProvider: provider,
      readOnly,
      nativeVectorManager: effectiveConfig.nativeVectorManager,
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
      vector_backend: vectorBackend,
      error: errorForTelemetry(err),
    });
    return disabled(provider, `open_failed: ${err?.message || String(err)}`, vectorBackend, { repoRoot });
  }
}

function normalizeEmbeddingConfig(config = {}, env = {}) {
  return {
    ...envConfig(env),
    ...(config && typeof config === "object" ? config : {}),
  };
}

function envConfig(env = {}) {
  return {
    embeddingApiKey: env.POSSE_ATLAS_EMBEDDING_API_KEY,
  };
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
  const current = childEmbeddingModelDirName({ model, model_version: modelVersion });
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
 *   backend: "auto" | "rust" | "usearch" | "off",
 *   encoder: EmbeddingEncoder,
 *   repoRoot: string,
 *   requestedProvider: string,
 *   nativeVectorManager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 * }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
function openIndexForBackend({ backend, encoder, repoRoot, requestedProvider, readOnly = false, nativeVectorManager = nativeBinaries }) {
  const root = embeddingsRoot(repoRoot);
  const openRust = () => RustEmbeddingIndex.open({
    model: encoder.model,
    model_version: encoder.model_version,
    dim: encoder.dim,
    embeddingsRoot: root,
    readOnly,
    manager: nativeVectorManager,
  });
  const openUsearch = () => {
    if (!usearchPackageResolvable()) {
      throw new Error("usearch_unavailable: missing");
    }
    return ChildEmbeddingIndex.open({
      model: encoder.model,
      model_version: encoder.model_version,
      dim: encoder.dim,
      embeddingsRoot: root,
      readOnly,
    });
  };

  if (backend === "auto" || backend === "rust") {
    try {
      if (!nativeVectorManager.shouldUse("vector")) {
        throw new Error("server-issued posse-vector unavailable");
      }
      return enabled({ provider: encoder.model, backend: "rust", encoder, index: openRust() });
    } catch (err) {
      if (backend === "rust") {
        return disabled(requestedProvider, `rust: ${err?.message || String(err)}`, backend);
      }
    }
  }

  // During the transition `usearch` explicitly selects the JS child. `auto`
  // reaches it only when the server-issued Rust worker is unavailable.
  try {
    return enabled({ provider: encoder.model, backend: "usearch", encoder, index: openUsearch() });
  } catch (err) {
    return disabled(requestedProvider, `usearch: ${err?.message || String(err)}`, backend);
  }
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
