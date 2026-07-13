// @ts-check
//
// Jina model artifact ownership. Normal ATLAS operation is offline-only; the
// explicit `atlas-v2 models pull` command is the sole network boundary.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ATLAS_JINA_MODEL } from "../../../../../catalog/atlas.js";
import { atlasDir } from "../runtime-paths.js";

const require = createRequire(import.meta.url);
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

/** @param {string} repoRoot */
export function jinaModelCacheDir(repoRoot) {
  return path.join(atlasDir(repoRoot), "models", "onnx", ATLAS_JINA_MODEL.modelId);
}

/**
 * Adapt the historical ATLAS cache directory to posse-ml's canonical
 * `<modelRoot>/<model-id>` layout without moving or copying a large model.
 * The compatibility link lives beside the cache, never inside it, so native
 * recursive artifact discovery cannot follow a cycle.
 *
 * @param {string} modelCacheDir
 * @returns {string} absolute model root for posse-ml's --model-root
 */
export function ensureJinaMlModelRoot(modelCacheDir) {
  const cacheDir = path.resolve(String(modelCacheDir || ""));
  if (!String(modelCacheDir || "").trim() || !directoryExists(cacheDir)) {
    const error = new Error(`Jina model cache is not a directory: ${cacheDir}`);
    /** @type {any} */ (error).code = "JINA_MODEL_CACHE_MISSING";
    throw error;
  }

  if (path.basename(cacheDir).toLowerCase() === ATLAS_JINA_MODEL.mlModelDirectory.toLowerCase()) {
    return path.dirname(cacheDir);
  }

  const adapterRoot = path.join(
    path.dirname(cacheDir),
    ".posse-ml-model-roots",
    encodeURIComponent(path.basename(cacheDir)),
  );
  const canonicalDir = path.join(adapterRoot, ATLAS_JINA_MODEL.mlModelDirectory);
  fs.mkdirSync(adapterRoot, { recursive: true });

  if (pathEntryExists(canonicalDir)) {
    const actual = realPathOrNull(canonicalDir);
    const expected = realPathOrNull(cacheDir);
    if (actual && expected && samePath(actual, expected) && directoryExists(canonicalDir)) {
      return adapterRoot;
    }
    const error = new Error(`Jina ML model adapter points at an unexpected path: ${canonicalDir}`);
    /** @type {any} */ (error).code = "JINA_ML_MODEL_ROOT_CONFLICT";
    throw error;
  }

  try {
    fs.symlinkSync(cacheDir, canonicalDir, process.platform === "win32" ? "junction" : "dir");
  } catch (cause) {
    const error = new Error(`Unable to prepare posse-ml model root at ${adapterRoot}`);
    /** @type {any} */ (error).code = "JINA_ML_MODEL_ROOT_UNAVAILABLE";
    /** @type {any} */ (error).cause = cause;
    throw error;
  }
  return adapterRoot;
}

/**
 * @param {string} repoRoot
 * @param {{ modelCacheDir?: string }} [options]
 */
export function inspectJinaModel(repoRoot, { modelCacheDir: explicitModelCacheDir } = {}) {
  const modelCacheDir = explicitModelCacheDir
    ? path.resolve(explicitModelCacheDir)
    : jinaModelCacheDir(repoRoot);
  const files = collectFiles(modelCacheDir, 0);
  const tokenizer = files.find((file) => path.basename(file).toLowerCase() === "tokenizer.json") || null;
  const model = files.find((file) => /(^model(_quantized)?|_quantized)\.onnx$/i.test(path.basename(file)))
    || files.find((file) => file.toLowerCase().endsWith(".onnx"))
    || null;
  return {
    ready: !!tokenizer && !!model,
    modelCacheDir,
    tokenizer,
    model,
    reason: tokenizer && model ? null : "model_cache_missing",
  };
}

/**
 * @param {{ repoRoot: string, modelCacheDir?: string, onProgress?: (progress: any) => void }} args
 */
export async function pullJinaModel({ repoRoot, modelCacheDir: explicitModelCacheDir, onProgress }) {
  const modelCacheDir = explicitModelCacheDir
    ? path.resolve(explicitModelCacheDir)
    : jinaModelCacheDir(repoRoot);
  fs.mkdirSync(modelCacheDir, { recursive: true });
  const lib = await loadTransformersPackage();
  const pipeline = await lib.pipeline("feature-extraction", ATLAS_JINA_MODEL.modelName, {
    cache_dir: modelCacheDir,
    local_files_only: false,
    revision: "main",
    dtype: ATLAS_JINA_MODEL.dtype,
    progress_callback: typeof onProgress === "function" ? onProgress : undefined,
  });
  try {
    return inspectJinaModel(repoRoot, { modelCacheDir });
  } finally {
    if (typeof pipeline?.dispose === "function") await pipeline.dispose();
  }
}

/** @param {string} dir @param {number} depth */
function collectFiles(dir, depth) {
  if (depth > 6 || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isFile()) return [file];
      if (entry.isDirectory()) return collectFiles(file, depth + 1);
      return [];
    });
  } catch {
    return [];
  }
}

/** @param {string} dir */
function directoryExists(dir) {
  try { return fs.statSync(dir).isDirectory(); }
  catch { return false; }
}

/** @param {string} target */
function pathEntryExists(target) {
  try { fs.lstatSync(target); return true; }
  catch { return false; }
}

/** @param {string} target */
function realPathOrNull(target) {
  try { return fs.realpathSync.native(target); }
  catch { return null; }
}

/** @param {string} left @param {string} right */
function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function loadTransformersPackage() {
  try {
    const lib = require(TRANSFORMERS_PACKAGE);
    if (typeof lib?.pipeline === "function") return lib;
  } catch {
    // ESM-only installations are handled below.
  }
  try {
    const imported = await import(TRANSFORMERS_PACKAGE);
    const lib = imported?.default ?? imported;
    if (typeof lib?.pipeline === "function") return lib;
  } catch (error) {
    const missing = new Error(`${TRANSFORMERS_PACKAGE} is required to pull the Jina model`);
    /** @type {any} */ (missing).cause = error;
    throw missing;
  }
  throw new Error(`${TRANSFORMERS_PACKAGE} does not export pipeline()`);
}
