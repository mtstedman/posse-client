// @ts-check
//
// Local Transformers.js/ONNX encoder for ATLAS semantic embeddings. The
// optional runtime is loaded lazily so default Atlas startup stays dependency
// light when local ONNX embeddings are not configured.

import path from "path";
import { createRequire } from "module";
import {
  defaultBuildSymbolText,
  TEXT_SHAPE_VERSION,
} from "../../functions/v2/embeddings/build-symbol-text.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeTexts,
} from "../../functions/v2/embeddings/forensics.js";

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoderContract */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSymbolInput} EmbeddingSymbolInput */

const require = createRequire(import.meta.url);
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

/**
 * @implements {EmbeddingEncoderContract}
 */
export class LocalOnnxEmbeddingEncoder {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;

  /** @type {string} */
  modelName;
  /** @type {string} */
  modelId;
  /** @type {string} */
  cacheDir;
  /** @type {number} */
  batchSize;
  /** @type {number} */
  maxInputChars;
  /** @type {number} */
  maxInputTokens;
  /** @type {string} */
  dtype;
  /** @type {boolean} */
  localFilesOnly;
  /** @type {Promise<any> | null} */
  _pipelinePromise = null;

  /**
   * @param {{
   *   cacheDir: string,
   *   modelName: string,
   *   modelId: string,
   *   dim: number,
   *   textShapeVersion?: number,
   *   modelVersion?: string | null,
   *   batchSize?: number,
   *   maxInputChars?: number,
   *   maxInputTokens?: number,
   *   dtype?: string,
   *   localFilesOnly?: boolean,
   * }} opts
   */
  constructor({
    cacheDir,
    modelName,
    modelId,
    dim,
    textShapeVersion = TEXT_SHAPE_VERSION,
    modelVersion = null,
    batchSize = 64,
    maxInputChars = 8192,
    maxInputTokens = 8192,
    dtype = "q8",
    localFilesOnly = true,
  }) {
    const normalizedCacheDir = String(cacheDir || "").trim();
    const normalizedModelName = String(modelName || "").trim();
    const normalizedModelId = String(modelId || "").trim();
    const normalizedDtype = String(dtype || "q8").trim() || "q8";
    if (!normalizedCacheDir) throw new TypeError("LocalOnnxEmbeddingEncoder: cacheDir required");
    if (!normalizedModelName) throw new TypeError("LocalOnnxEmbeddingEncoder: modelName required");
    if (!normalizedModelId) throw new TypeError("LocalOnnxEmbeddingEncoder: modelId required");
    if (!Number.isInteger(dim) || dim < 16 || dim > 32768) {
      throw new RangeError("LocalOnnxEmbeddingEncoder: dim must be in [16, 32768]");
    }

    this.model = "local-onnx";
    this.model_version = String(modelVersion || `onnx-${normalizedModelId}-${dim}-${normalizedDtype}-text${textShapeVersion}`);
    this.dim = dim;
    this.modelName = normalizedModelName;
    this.modelId = normalizedModelId;
    this.cacheDir = path.resolve(normalizedCacheDir);
    this.batchSize = Math.max(1, Math.min(Number.isInteger(batchSize) ? batchSize : 64, 512));
    this.maxInputChars = Math.max(1, Math.min(Number.isInteger(maxInputChars) ? maxInputChars : 8192, 200_000));
    this.maxInputTokens = Math.max(1, Math.min(Number.isInteger(maxInputTokens) ? maxInputTokens : 8192, 32768));
    this.dtype = normalizedDtype;
    this.localFilesOnly = localFilesOnly !== false;
  }

  async _pipeline() {
    if (this._pipelinePromise) return this._pipelinePromise;
    const pipelinePromise = (async () => {
      const startedAt = Date.now();
      recordEmbeddingForensics("onnx.pipeline.load.start", {
        encoder: this.#telemetry(),
      });
      const lib = await loadTransformersPackage();
      const cacheDir = modelCacheDir(this.cacheDir, this.modelId);
      const options = {
        cache_dir: cacheDir,
        local_files_only: this.localFilesOnly,
        revision: "main",
      };
      /** @type {any} */ (options).dtype = this.dtype;
      try {
        const pipeline = await lib.pipeline("feature-extraction", this.modelName, options);
        recordEmbeddingForensics("onnx.pipeline.load.done", {
          encoder: this.#telemetry(),
          cache_dir: cacheDir,
          elapsed_ms: Date.now() - startedAt,
        });
        return pipeline;
      } catch (err) {
        recordEmbeddingForensics("onnx.pipeline.load.error", {
          encoder: this.#telemetry(),
          cache_dir: cacheDir,
          elapsed_ms: Date.now() - startedAt,
          error: errorForTelemetry(err),
        });
        throw err;
      }
    })();
    this._pipelinePromise = pipelinePromise;
    try {
      return await pipelinePromise;
    } catch (err) {
      if (this._pipelinePromise === pipelinePromise) this._pipelinePromise = null;
      throw err;
    }
  }

  /**
   * @param {EmbeddingSymbolInput} symbol
   * @returns {string}
   */
  buildSymbolText(symbol) {
    return defaultBuildSymbolText(symbol);
  }

  /**
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array[]>}
   */
  async encode(texts, signal) {
    if (!Array.isArray(texts)) {
      throw new TypeError("LocalOnnxEmbeddingEncoder.encode: texts must be an array");
    }
    if (texts.length === 0) return [];
    const encodeStartedAt = Date.now();
    recordEmbeddingForensics("onnx.encode.start", {
      encoder: this.#telemetry(),
      texts: summarizeTexts(texts),
    });
    const extractor = await this._pipeline();
    /** @type {Float32Array[]} */
    const out = new Array(texts.length);
    try {
      for (let i = 0; i < texts.length; i += this.batchSize) {
        throwIfAborted(signal, "encode aborted");
        const batchStartedAt = Date.now();
        const batch = texts.slice(i, i + this.batchSize)
          .map((text, offset) => normalizeInputText(text, i + offset, this.maxInputChars));
        recordEmbeddingForensics("onnx.encode.batch.start", {
          encoder: this.#telemetry(),
          offset: i,
          batch_size: batch.length,
          texts: summarizeTexts(batch),
        });
        let tensor;
        try {
          tensor = await extractor(batch, {
            pooling: "mean",
            normalize: true,
            truncation: true,
            max_length: this.maxInputTokens,
          });
        } catch (err) {
          recordEmbeddingForensics("onnx.encode.batch.native_error", {
            encoder: this.#telemetry(),
            offset: i,
            batch_size: batch.length,
            elapsed_ms: Date.now() - batchStartedAt,
            error: errorForTelemetry(err),
          });
          throw err;
        }
        throwIfAborted(signal, "encode aborted");
        const vectors = vectorsFromFeatureOutput(tensor, { expectedCount: batch.length, dim: this.dim });
        for (let k = 0; k < vectors.length; k++) out[i + k] = vectors[k];
        recordEmbeddingForensics("onnx.encode.batch.done", {
          encoder: this.#telemetry(),
          offset: i,
          batch_size: batch.length,
          vector_count: vectors.length,
          elapsed_ms: Date.now() - batchStartedAt,
        });
      }
    } catch (err) {
      recordEmbeddingForensics("onnx.encode.error", {
        encoder: this.#telemetry(),
        texts: summarizeTexts(texts),
        elapsed_ms: Date.now() - encodeStartedAt,
        error: errorForTelemetry(err),
      });
      throw err;
    }
    recordEmbeddingForensics("onnx.encode.done", {
      encoder: this.#telemetry(),
      text_count: texts.length,
      vector_count: out.length,
      elapsed_ms: Date.now() - encodeStartedAt,
    });
    return out;
  }

  async dispose() {
    const pipelinePromise = this._pipelinePromise;
    this._pipelinePromise = null;
    if (!pipelinePromise) return;
    let extractor = null;
    try { extractor = await pipelinePromise; } catch { return; }
    await disposeTransformersPipeline(extractor);
  }

  #telemetry() {
    return {
      model: this.model,
      model_version: this.model_version,
      model_name: this.modelName,
      model_id: this.modelId,
      dim: this.dim,
      dtype: this.dtype,
      batch_size: this.batchSize,
      max_input_chars: this.maxInputChars,
      max_input_tokens: this.maxInputTokens,
      local_files_only: this.localFilesOnly,
      cache_dir: this.cacheDir,
    };
  }
}

/**
 * @param {string} cacheDir
 * @param {string} modelId
 */
export function modelCacheDir(cacheDir, modelId) {
  return path.join(cacheDir, modelId);
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

/**
 * @param {unknown} output
 * @param {{ expectedCount: number, dim: number }} opts
 * @returns {Float32Array[]}
 */
function vectorsFromFeatureOutput(output, { expectedCount, dim }) {
  if (Array.isArray(output)) {
    if (output.length !== expectedCount) {
      throw new Error(`LocalOnnxEmbeddingEncoder.encode: expected ${expectedCount} tensors, got ${output.length}`);
    }
    return output.map((entry, index) => vectorFromTensorLike(entry, { dim, index }));
  }
  const tensor = /** @type {{ data?: unknown, dims?: number[] }} */ (output);
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  if (dims.length !== 2 || Number(dims[0]) !== expectedCount || Number(dims[1]) !== dim) {
    throw new RangeError(`LocalOnnxEmbeddingEncoder.encode: tensor dim ${dims.join("x") || "unknown"} != expected ${expectedCount}x${dim}`);
  }
  const data = tensor?.data;
  const total = expectedCount * dim;
  if (!isArrayLike(data) || data.length !== total) {
    throw new Error(`LocalOnnxEmbeddingEncoder.encode: tensor data length ${isArrayLike(data) ? data.length : "none"} != expected ${total}`);
  }
  /** @type {Float32Array[]} */
  const vectors = [];
  for (let i = 0; i < expectedCount; i++) {
    vectors.push(toFloat32Slice(data, i * dim, (i + 1) * dim));
  }
  return vectors;
}

/**
 * @param {unknown} tensor
 * @param {{ dim: number, index: number }} opts
 */
function vectorFromTensorLike(tensor, { dim, index }) {
  const entry = /** @type {{ data?: unknown, dims?: number[] }} */ (tensor);
  const dims = Array.isArray(entry?.dims) ? entry.dims : [];
  if (dims.length > 0 && (Number(dims[dims.length - 1]) !== dim || dimsProduct(dims) !== dim)) {
    throw new RangeError(`LocalOnnxEmbeddingEncoder.encode: tensor[${index}] dim ${dims.join("x")} != expected ${dim}`);
  }
  if (!isArrayLike(entry?.data) || entry.data.length !== dim) {
    throw new Error(`LocalOnnxEmbeddingEncoder.encode: tensor[${index}] data length ${isArrayLike(entry?.data) ? entry.data.length : "none"} != expected ${dim}`);
  }
  return toFloat32Slice(entry.data, 0, dim);
}

function dimsProduct(dims = []) {
  return dims.reduce((total, value) => total * Math.max(0, Number(value) || 0), 1);
}

async function disposeTransformersPipeline(extractor) {
  const seen = new Set();
  for (const target of [extractor, extractor?.model, extractor?.tokenizer, extractor?.processor]) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    await disposeTarget(target);
  }
}

async function disposeTarget(target) {
  for (const method of ["dispose", "free", "release", "destroy"]) {
    const fn = target?.[method];
    if (typeof fn !== "function") continue;
    try { await fn.call(target); } catch { /* best-effort cleanup */ }
    return;
  }
}

/**
 * @param {unknown} value
 * @returns {value is ArrayLike<number>}
 */
function isArrayLike(value) {
  return !!value && typeof /** @type {any} */ (value).length === "number";
}

/**
 * @param {unknown} text
 * @param {number} index
 * @param {number} maxInputChars
 * @returns {string}
 */
function normalizeInputText(text, index, maxInputChars) {
  const value = String(text ?? "").slice(0, maxInputChars);
  if (value.trim().length === 0) {
    throw new RangeError(`LocalOnnxEmbeddingEncoder.encode: text[${index}] is empty after trim`);
  }
  return value;
}

/**
 * @param {ArrayLike<number>} data
 * @param {number} start
 * @param {number} end
 */
function toFloat32Slice(data, start, end) {
  if (data instanceof Float32Array) {
    const out = data.slice(start, end);
    assertFiniteOutputVector(out);
    return out;
  }
  const out = new Float32Array(end - start);
  for (let i = start; i < end; i++) {
    const value = Number(data[i]);
    if (!Number.isFinite(value)) {
      throw new RangeError(`LocalOnnxEmbeddingEncoder.encode: vector contains non-finite value at index ${i - start}`);
    }
    out[i - start] = value;
  }
  return out;
}

/**
 * @param {Float32Array} vector
 * @returns {void}
 */
function assertFiniteOutputVector(vector) {
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new RangeError(`LocalOnnxEmbeddingEncoder.encode: vector contains non-finite value at index ${i}`);
    }
  }
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {string} fallback
 */
function throwIfAborted(signal, fallback) {
  if (!signal?.aborted) return;
  throw /** @type {any} */ (signal).reason ?? new Error(fallback);
}
