// @ts-check

import path from "node:path";

import { ATLAS_JINA_MODEL } from "../../../../catalog/atlas.js";
import { ML_EMBED_METHOD } from "../../../../catalog/binary.js";
import { runMlNativeMethodAsync } from "../../../../shared/native/functions/ml-invoke.js";
import {
  defaultBuildSymbolText,
  TEXT_SHAPE_VERSION,
} from "../../functions/v2/embeddings/build-symbol-text.js";
import { jinaModelCacheDir } from "../../functions/v2/embeddings/jina-model.js";
import { unpackNativeEmbeddingVectors } from "../../functions/v2/embeddings/unpack-native-vectors.js";

export const ATLAS_JINA_MODEL_VERSION =
  `onnx-${ATLAS_JINA_MODEL.modelId}-${ATLAS_JINA_MODEL.dim}-${ATLAS_JINA_MODEL.dtype}-text${TEXT_SHAPE_VERSION}`;

// The active production encoder. Jina artifacts are staged explicitly, while
// tokenization, pooling, normalization, and ONNX execution live in posse-ml.
/** @implements {import("../../functions/v2/contracts/embeddings.js").EmbeddingEncoder} */
export class AtlasEmbeddingEncoder {
  model = ATLAS_JINA_MODEL.indexModel;
  model_version = ATLAS_JINA_MODEL_VERSION;
  modelName = ATLAS_JINA_MODEL.modelName;
  modelId = ATLAS_JINA_MODEL.modelId;
  mlModelId = ATLAS_JINA_MODEL.mlModelId;
  dim = ATLAS_JINA_MODEL.dim;
  dtype = ATLAS_JINA_MODEL.dtype;
  atlasBacked = true;
  /** @type {number | null} */
  batchSize = null;
  /** @type {number | null} */
  intraOpThreads = null;

  #modelCacheDir;
  #modelRoot;
  #invoke;

  /** @param {{ repoRoot?: string, modelCacheDir?: string, modelRoot?: string, modelVersion?: string, batchSize?: number, intraOpThreads?: number, invoke?: typeof runMlNativeMethodAsync, manager?: import("../../../../shared/tools/classes/BinaryManager.js").BinaryManager }} [options] */
  constructor({ repoRoot, modelCacheDir = null, modelRoot = null, modelVersion = null, batchSize = null, intraOpThreads = null, invoke = null, manager = null } = {}) {
    if (!repoRoot) throw new TypeError("AtlasEmbeddingEncoder: repoRoot is required");
    this.#modelCacheDir = modelCacheDir ? path.resolve(modelCacheDir) : jinaModelCacheDir(repoRoot);
    this.#modelRoot = modelRoot ? path.resolve(modelRoot) : path.dirname(this.#modelCacheDir);
    if (modelVersion) this.model_version = String(modelVersion);
    if (Number.isInteger(batchSize)) this.batchSize = Math.max(1, Math.min(Number(batchSize), 512));
    if (Number.isInteger(intraOpThreads)) this.intraOpThreads = Math.max(1, Math.min(Number(intraOpThreads), 32));
    this.#invoke = invoke || (manager
      ? (method, payload, options) => runMlNativeMethodAsync(method, payload, { ...options, manager })
      : runMlNativeMethodAsync);
  }

  get cacheDir() {
    return this.#modelCacheDir;
  }

  get modelRoot() {
    return this.#modelRoot;
  }

  /** @param {import("../../functions/v2/contracts/embeddings.js").EmbeddingSymbolInput} symbol */
  buildSymbolText(symbol) {
    return defaultBuildSymbolText(symbol);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] @param {(event: Record<string, unknown>) => void} [onProgress] */
  encode(texts, signal, onProgress) {
    return this.#encode(texts, "document", signal, onProgress);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] @param {(event: Record<string, unknown>) => void} [onProgress] */
  encodeDocuments(texts, signal, onProgress) {
    return this.#encode(texts, "document", signal, onProgress);
  }

  /** @param {string} text @param {AbortSignal} [signal] */
  encodeQuery(text, signal) {
    return this.#encode([String(text || "")], "query", signal).then((vectors) => vectors[0]);
  }

  /** @param {string[]} texts @param {"query" | "document"} inputKind @param {AbortSignal} [signal] @param {(event: Record<string, unknown>) => void} [onProgress] */
  async #encode(texts, inputKind, signal, onProgress = null) {
    if (!Array.isArray(texts)) throw new TypeError("AtlasEmbeddingEncoder: texts must be an array");
    if (texts.length === 0) return [];
    const data = await this.#invoke(ML_EMBED_METHOD, {
      modelId: this.mlModelId,
      texts: texts.map(String),
      inputKind,
      ...(this.batchSize ? { batchSize: Math.min(this.batchSize, 64) } : {}),
      ...(this.intraOpThreads ? { intraOpThreads: this.intraOpThreads } : {}),
    }, {
      modelRoot: this.#modelRoot,
      signal,
      timeoutMs: 300_000,
      idempotent: true,
      ...(typeof onProgress === "function" ? { onProgress } : {}),
    });
    return unpackNativeEmbeddingVectors(data, texts.length, this.dim, "Jina");
  }

  dispose() {}
}
