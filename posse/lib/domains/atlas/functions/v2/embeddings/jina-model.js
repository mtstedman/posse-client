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

/** @param {string} repoRoot */
export function inspectJinaModel(repoRoot) {
  const modelCacheDir = jinaModelCacheDir(repoRoot);
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
 * @param {{ repoRoot: string, onProgress?: (progress: any) => void }} args
 */
export async function pullJinaModel({ repoRoot, onProgress }) {
  const modelCacheDir = jinaModelCacheDir(repoRoot);
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
    return inspectJinaModel(repoRoot);
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
