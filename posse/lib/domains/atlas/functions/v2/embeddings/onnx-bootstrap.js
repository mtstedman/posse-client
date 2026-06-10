// @ts-check
//
// Explicit local ONNX model bootstrap. Normal warm/search paths load models
// offline-only; this helper is the intentional network boundary.

import fs from "fs";
import { createRequire } from "module";
import { localOnnxModelCacheDir } from "./local-onnx.js";

const require = createRequire(import.meta.url);
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

/**
 * @param {{
 *   modelName: string,
 *   modelId: string,
 *   cacheDir: string,
 *   dtype?: string,
 *   onProgress?: (progress: any) => void,
 * }} args
 */
export async function ensureOnnxModelCached({ modelName, modelId, cacheDir, dtype = "q8", onProgress }) {
  const normalizedModelName = String(modelName || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  const normalizedCacheDir = String(cacheDir || "").trim();
  if (!normalizedModelName) throw new TypeError("ensureOnnxModelCached: modelName required");
  if (!normalizedModelId) throw new TypeError("ensureOnnxModelCached: modelId required");
  if (!normalizedCacheDir) throw new TypeError("ensureOnnxModelCached: cacheDir required");

  const modelCacheDir = localOnnxModelCacheDir(normalizedCacheDir, { id: normalizedModelId });
  fs.mkdirSync(modelCacheDir, { recursive: true });

  const lib = await loadTransformersPackage();
  const options = {
    cache_dir: modelCacheDir,
    local_files_only: false,
    revision: "main",
    progress_callback: typeof onProgress === "function" ? onProgress : undefined,
  };
  /** @type {any} */ (options).dtype = String(dtype || "q8");
  const pipe = await lib.pipeline("feature-extraction", normalizedModelName, options);
  if (typeof pipe?.dispose === "function") {
    await pipe.dispose();
  }
}

async function loadTransformersPackage() {
  /** @type {Error | null} */
  let lastError = null;
  try {
    const lib = require(TRANSFORMERS_PACKAGE);
    if (typeof lib?.pipeline === "function") return lib;
    lastError = new Error(`${TRANSFORMERS_PACKAGE}: pipeline export missing`);
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    try {
      const imported = await import(TRANSFORMERS_PACKAGE);
      const lib = /** @type {any} */ (imported?.default ?? imported);
      if (typeof lib?.pipeline === "function") return lib;
      lastError = new Error(`${TRANSFORMERS_PACKAGE}: pipeline export missing`);
    } catch (importErr) {
      lastError = importErr instanceof Error ? importErr : new Error(String(importErr));
    }
  }
  const error = new Error("transformers_lib_missing");
  if (lastError) /** @type {any} */ (error).cause = lastError;
  throw error;
}
