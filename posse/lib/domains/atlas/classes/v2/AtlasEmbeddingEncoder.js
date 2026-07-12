// @ts-check

import { ATLAS_JINA_MODEL } from "../../../../catalog/atlas.js";
import { runAtlasNativeMethodAsync } from "../../functions/v2/native/invoke.js";
import {
  defaultBuildSymbolText,
  TEXT_SHAPE_VERSION,
} from "../../functions/v2/embeddings/build-symbol-text.js";
import { jinaModelCacheDir } from "../../functions/v2/embeddings/jina-model.js";
import { unpackNativeEmbeddingVectors } from "../../functions/v2/embeddings/unpack-native-vectors.js";

export const ATLAS_JINA_MODEL_VERSION =
  `onnx-${ATLAS_JINA_MODEL.modelId}-${ATLAS_JINA_MODEL.dim}-${ATLAS_JINA_MODEL.dtype}-text${TEXT_SHAPE_VERSION}`;

// The active production encoder. Jina artifacts are staged explicitly, while
// tokenization, pooling, normalization, and ONNX execution live in posse-atlas.
/** @implements {import("../../functions/v2/contracts/embeddings.js").EmbeddingEncoder} */
export class AtlasEmbeddingEncoder {
  model = ATLAS_JINA_MODEL.indexModel;
  model_version = ATLAS_JINA_MODEL_VERSION;
  modelName = ATLAS_JINA_MODEL.modelName;
  modelId = ATLAS_JINA_MODEL.modelId;
  dim = ATLAS_JINA_MODEL.dim;
  dtype = ATLAS_JINA_MODEL.dtype;
  atlasBacked = true;

  #modelCacheDir;
  #invoke;

  /** @param {{ repoRoot?: string, invoke?: typeof runAtlasNativeMethodAsync }} [options] */
  constructor({ repoRoot, invoke = runAtlasNativeMethodAsync } = {}) {
    if (!repoRoot) throw new TypeError("AtlasEmbeddingEncoder: repoRoot is required");
    this.#modelCacheDir = jinaModelCacheDir(repoRoot);
    this.#invoke = invoke;
  }

  /** @param {import("../../functions/v2/contracts/embeddings.js").EmbeddingSymbolInput} symbol */
  buildSymbolText(symbol) {
    return defaultBuildSymbolText(symbol);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] */
  encode(texts, signal) {
    return this.#encode(texts, signal);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] */
  encodeDocuments(texts, signal) {
    return this.#encode(texts, signal);
  }

  /** @param {string} text @param {AbortSignal} [signal] */
  encodeQuery(text, signal) {
    return this.#encode([String(text || "")], signal).then((vectors) => vectors[0]);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] */
  async #encode(texts, signal) {
    if (!Array.isArray(texts)) throw new TypeError("AtlasEmbeddingEncoder: texts must be an array");
    if (texts.length === 0) return [];
    const data = await this.#invoke("onnx-encode", {
      model_cache_dir: this.#modelCacheDir,
      model_version: this.model_version,
      texts: texts.map(String),
      dim: this.dim,
    }, {
      signal,
      timeoutMs: 300_000,
      idempotent: true,
    });
    return unpackNativeEmbeddingVectors(data, texts.length, this.dim, "Jina");
  }

  dispose() {}
}
