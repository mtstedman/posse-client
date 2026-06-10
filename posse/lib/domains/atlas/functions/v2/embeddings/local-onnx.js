// @ts-check
//
// Local ONNX embedding provider metadata and readiness checks. The runtime is
// optional and loaded lazily by LocalOnnxEmbeddingEncoder, so repo.status can
// diagnose missing dependencies/model files without pulling the encoder in.

import path from "path";
import fs from "fs";
import { createRequire } from "module";
import { atlasDir } from "../runtime-paths.js";

const require = createRequire(import.meta.url);

export const LOCAL_ONNX_PROVIDER_ALIASES = new Set([
  "onnx",
  "local-onnx",
  "jina-v2-code",
  "jina-embeddings-v2-base-code",
]);

export const LOCAL_ONNX_MODELS = Object.freeze({
  "jina-v2-code": Object.freeze({
    id: "jina-v2-code",
    model: "jinaai/jina-embeddings-v2-base-code",
    dim: 768,
    format: "onnx",
    dtype: "q8",
  }),
});

export const DEFAULT_LOCAL_ONNX_MODEL_ID = "jina-v2-code";

/**
 * @param {Record<string, unknown>} config
 */
export function localOnnxRequested(config = {}) {
  const provider = normalizeProvider(config.embeddingProvider || config.atlasEmbeddingProvider || config.provider);
  return LOCAL_ONNX_PROVIDER_ALIASES.has(provider)
    || configFlag(config.localOnnxEmbeddings)
    || configFlag(config.localOnnxEmbeddingsEnabled)
    || configFlag(config.atlasLocalOnnxEmbeddings);
}

/**
 * @param {{ repoRoot?: string, config?: Record<string, unknown> }} args
 */
export function inspectLocalOnnxStatus({ repoRoot, config = {} } = {}) {
  const requested = localOnnxRequested(config);
  const model = resolveLocalOnnxModel(config);
  const cacheDir = resolveLocalOnnxCacheDir({ repoRoot, config });
  const runtime = optionalDependencyStatus(["@huggingface/transformers"]);
  const nativeRuntime = optionalDependencyStatus(["onnxruntime-node"]);
  const modelPresent = cacheDir ? modelCachePresent(cacheDir, model) : false;
  const runtimeAvailable = runtime.some((entry) => entry.available);
  const encoderImplemented = true;
  const ready = requested && runtimeAvailable && modelPresent && encoderImplemented;
  return {
    requested,
    enabled: ready,
    status: ready ? "ready" : requested ? "unavailable" : "not_configured",
    provider: requested ? "local-onnx" : null,
    model: model.id,
    modelName: model.model,
    dim: model.dim,
    cacheDir,
    modelCacheDir: cacheDir ? localOnnxModelCacheDir(cacheDir, model) : null,
    modelPresent,
    encoderImplemented,
    dependencies: [...runtime, ...nativeRuntime],
    reason: ready
      ? null
      : requested
        ? runtimeAvailable
          ? modelPresent ? null : "model_cache_missing"
          : "onnx_runtime_dependency_missing"
        : "not_configured",
  };
}

/**
 * @param {Record<string, unknown>} config
 */
export function resolveLocalOnnxModel(config = {}) {
  const raw = normalizeProvider(
    config.localOnnxModel
      || config.embeddingModel
      || config.model
      || config.embeddingProvider
      || config.atlasEmbeddingProvider
      || config.provider,
  );
  if (raw && !LOCAL_ONNX_PROVIDER_ALIASES.has(raw) && raw !== LOCAL_ONNX_MODELS[DEFAULT_LOCAL_ONNX_MODEL_ID].model.toLowerCase()) {
    return LOCAL_ONNX_MODELS[DEFAULT_LOCAL_ONNX_MODEL_ID];
  }
  return LOCAL_ONNX_MODELS[DEFAULT_LOCAL_ONNX_MODEL_ID];
}

/**
 * @param {{ repoRoot?: string, config?: Record<string, unknown> }} args
 */
export function resolveLocalOnnxCacheDir({ repoRoot, config = {} }) {
  const configured = String(
    config.localOnnxCacheDir
      || config.atlasLocalOnnxCacheDir
      || config.local_onnx_cache_dir
      || config.embeddingModelCacheDir
      || "",
  ).trim();
  if (configured) return path.resolve(configured);
  if (!repoRoot) return null;
  return path.join(atlasDir(repoRoot), "models", "onnx");
}

/**
 * @param {string} cacheDir
 * @param {{ id: string }} model
 */
export function localOnnxModelCacheDir(cacheDir, model) {
  return path.join(cacheDir, model.id);
}

/**
 * @param {string[]} names
 */
function optionalDependencyStatus(names) {
  return names.map((name) => {
    try {
      return { name, available: true, path: require.resolve(name) };
    } catch {
      return { name, available: false, path: null };
    }
  });
}

/**
 * @param {string} cacheDir
 * @param {{ id: string, model: string }} model
 */
export function modelCachePresent(cacheDir, model) {
  try {
    const modelDir = localOnnxModelCacheDir(cacheDir, model);
    if (!fs.existsSync(modelDir)) return false;
    return findOnnxModelFile(modelDir, 0);
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {number} depth
 * @returns {boolean}
 */
function findOnnxModelFile(dir, depth) {
  if (depth > 6) return false;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /(^model(_quantized)?|_quantized)\.onnx$/i.test(entry.name)) {
      return true;
    }
    if (entry.isDirectory() && findOnnxModelFile(path.join(dir, entry.name), depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} value
 */
function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * @param {unknown} value
 */
function configFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}
