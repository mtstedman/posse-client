// @ts-check

import { ATLAS_CODERANK_MODEL } from "../../../../catalog/atlas.js";
import { runAtlasNativeMethodAsync } from "../../functions/v2/native/invoke.js";
import { defaultBuildSymbolText } from "../../functions/v2/embeddings/build-symbol-text.js";
import { unpackNativeEmbeddingVectors } from "../../functions/v2/embeddings/unpack-native-vectors.js";

export const ATLAS_CODERANK_MODEL_VERSION = "3c4b60807d71+onnx-int8.e74f446dc6e6";

// Available for a future explicit model selector. Production resource opening
// must not instantiate this encoder until that selection surface exists.
/** @implements {import("../../functions/v2/contracts/embeddings.js").EmbeddingEncoder} */
export class CodeRankEmbeddingEncoder {
  model = ATLAS_CODERANK_MODEL.modelName;
  model_version = ATLAS_CODERANK_MODEL_VERSION;
  dim = ATLAS_CODERANK_MODEL.dim;
  atlasBacked = true;

  #repoRoot;
  #invoke;

  /** @param {{ repoRoot?: string, invoke?: typeof runAtlasNativeMethodAsync }} [options] */
  constructor({ repoRoot, invoke = runAtlasNativeMethodAsync } = {}) {
    if (!repoRoot) throw new TypeError("CodeRankEmbeddingEncoder: repoRoot is required");
    this.#repoRoot = repoRoot;
    this.#invoke = invoke;
  }

  /** @param {import("../../functions/v2/contracts/embeddings.js").EmbeddingSymbolInput} symbol */
  buildSymbolText(symbol) {
    return defaultBuildSymbolText(symbol);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] */
  encode(texts, signal) {
    return this.encodeDocuments(texts, signal);
  }

  /** @param {string[]} texts @param {AbortSignal} [signal] */
  encodeDocuments(texts, signal) {
    return this.#encode(texts, "document", signal);
  }

  /** @param {string} text @param {AbortSignal} [signal] */
  encodeQuery(text, signal) {
    return this.#encode([String(text || "")], "query", signal).then((vectors) => vectors[0]);
  }

  /** @param {string[]} texts @param {"query" | "document"} inputKind @param {AbortSignal} [signal] */
  async #encode(texts, inputKind, signal) {
    if (!Array.isArray(texts)) throw new TypeError("CodeRankEmbeddingEncoder: texts must be an array");
    if (texts.length === 0) return [];
    const data = await this.#invoke("coderank-encode", {
      repoRoot: this.#repoRoot,
      texts: texts.map(String),
      inputKind,
    }, {
      signal,
      timeoutMs: 300_000,
      idempotent: true,
    });
    return unpackNativeEmbeddingVectors(data, texts.length, this.dim, "CodeRank");
  }

  dispose() {}
}
