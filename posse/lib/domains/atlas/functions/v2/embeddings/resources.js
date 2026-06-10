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
 * @returns {"auto" | "usearch" | "off"}
 */
export function configuredVectorBackend(config = {}) {
  const raw = String(config?.vectorBackend || "auto").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "none" || raw === "off") return "off";
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

/**
 * @param {{
 *   repoRoot: string,
 *   config?: Record<string, unknown>,
 *   env?: Record<string, unknown>,
 * }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
export function openEmbeddingResources({ repoRoot, config = {}, env = {} }) {
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

  try {
    const encoder = resolveConfiguredEncoder(effectiveConfig, env);
    const result = openIndexForBackend({
      backend: vectorBackend,
      encoder,
      repoRoot,
      requestedProvider: provider,
    });
    recordEmbeddingForensics("resources.open.enabled", {
      repo_root: repoRoot,
      provider: result.provider,
      backend: result.backend,
      encoder: encoderTelemetry(result.encoder),
      index: indexTelemetry(result.index),
      embeddings_root: embeddingsRoot(repoRoot),
    });
    return result;
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
 *   backend: "auto" | "usearch" | "off",
 *   encoder: EmbeddingEncoder,
 *   repoRoot: string,
 *   requestedProvider: string,
 * }} args
 * @returns {OpenEmbeddingResourcesResult}
 */
function openIndexForBackend({ backend, encoder, repoRoot, requestedProvider }) {
  const root = embeddingsRoot(repoRoot);
  const openUsearch = () => {
    if (!usearchPackageResolvable()) {
      throw new Error("usearch_unavailable: missing");
    }
    return ChildEmbeddingIndex.open({
      model: encoder.model,
      model_version: encoder.model_version,
      dim: encoder.dim,
      embeddingsRoot: root,
    });
  };

  // usearch is the only supported backend. `auto` and `usearch` resolve to
  // the same path; anything else falls through to `auto`.
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
