// @ts-check
//
// Remote ATLAS encoder adapters. The remote encoder is Posse-specific: unlike
// the generic HTTP embedding adapter, it can accept structured symbols so the
// valuable symbol canonicalization rules can move server-side.

import {
  DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS,
} from "../../../remote/functions/atlas-encoder-client.js";
import { RemoteAtlasEncoderClient } from "../../../remote/classes/RemoteAtlasEncoderClient.js";

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoderContract */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSymbolInput} EmbeddingSymbolInput */

const DEFAULT_REMOTE_MODEL = "atlas-encoder";
const DEFAULT_REMOTE_DIM = 128;

/**
 * @typedef {Object} RemoteAtlasEmbeddingEncoderOptions
 * @property {string | null} [baseUrl]
 * @property {string} [model]
 * @property {number | string} [dim]
 * @property {string | null} [modelVersion]
 * @property {number | string | null} [timeoutMs]
 * @property {RemoteAtlasEncoderClient | null} [client]
 * @property {typeof fetch} [fetchImpl]
 * @property {string | null | undefined} [apiKey]
 * @property {string | null} [repoFingerprint]
 */

/**
 * @typedef {Object} SideBySideEmbeddingEncoderOptions
 * @property {EmbeddingEncoderContract} [local]
 * @property {EmbeddingEncoderContract} [remote]
 * @property {"shadow" | "preferred" | "required"} [mode]
 * @property {((result: any) => void) | null} [onShadowResult]
 */

/**
 * @implements {EmbeddingEncoderContract}
 */
export class RemoteAtlasEmbeddingEncoder {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;

  /** @type {RemoteAtlasEncoderClient} */
  #client;
  /** @type {string} */
  #modelName;
  /** @type {string | null} */
  #repoFingerprint;

  /**
   * @param {RemoteAtlasEmbeddingEncoderOptions} [opts]
   */
  constructor({
    baseUrl = null,
    model = DEFAULT_REMOTE_MODEL,
    dim = DEFAULT_REMOTE_DIM,
    modelVersion = null,
    timeoutMs = DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS,
    client = null,
    fetchImpl = globalThis.fetch,
    apiKey = undefined,
    repoFingerprint = null,
  } = {}) {
    const normalizedModel = String(model || DEFAULT_REMOTE_MODEL).trim();
    const parsedDim = Number(dim);
    if (!normalizedModel) throw new TypeError("RemoteAtlasEmbeddingEncoder: model is required");
    if (!Number.isInteger(parsedDim) || parsedDim <= 0 || parsedDim > 32768) {
      throw new RangeError("RemoteAtlasEmbeddingEncoder: dim must be in [1, 32768]");
    }
    const parsedTimeoutMs = Number(timeoutMs);
    this.#modelName = normalizedModel;
    this.model = `posse-remote:${normalizedModel}`;
    this.model_version = String(modelVersion || `remote-v1:${normalizedModel}:${parsedDim}`);
    this.dim = parsedDim;
    this.#repoFingerprint = String(repoFingerprint || "").trim() || null;
    this.#client = client || new RemoteAtlasEncoderClient({
      baseUrl: baseUrl || undefined,
      timeoutMs: Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0
        ? parsedTimeoutMs
        : DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS,
      fetchImpl,
      apiKey,
    });
  }

  async encode(texts, signal) {
    if (!Array.isArray(texts)) {
      throw new TypeError("RemoteAtlasEmbeddingEncoder.encode: texts must be an array");
    }
    const payload = await this.#client.encodeBatch({
      kind: "queries",
      batch_id: `queries-${texts.length}`,
      repo_fingerprint: this.#repoFingerprint || undefined,
      model_hint: this.#modelHint(),
      texts: texts.map((text) => String(text ?? "")),
    }, signal);
    return this.#vectorsFromPayload(payload, { expectedCount: texts.length });
  }

  async encodeSymbols(symbols, signal) {
    if (!Array.isArray(symbols)) {
      throw new TypeError("RemoteAtlasEmbeddingEncoder.encodeSymbols: symbols must be an array");
    }
    const payload = await this.#client.encodeBatch({
      kind: "symbols",
      batch_id: `symbols-${symbols.length}`,
      repo_fingerprint: this.#repoFingerprint || undefined,
      model_hint: this.#modelHint(),
      symbols,
    }, signal);
    return this.#vectorsFromPayload(payload, { expectedCount: symbols.length });
  }

  buildSymbolText(symbol) {
    if (!symbol || typeof symbol.name !== "string") {
      throw new TypeError("RemoteAtlasEmbeddingEncoder.buildSymbolText: symbol with .name is required");
    }
    // Compatibility only. Normal ATLAS ingest calls encodeSymbols() so the
    // production canonical text shape remains owned by Posse remote.
    return [
      symbol.kind,
      symbol.lang,
      symbol.qualified_name || symbol.name,
      symbol.signature_text || "",
    ].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  }

  #modelHint() {
    return {
      provider: "posse-remote",
      model: this.#modelName,
      model_version: this.model_version,
      dim: this.dim,
    };
  }

  #vectorsFromPayload(payload, { expectedCount }) {
    this.#assertMetadata(payload);
    const rawVectors = rawVectorsFromPayload(payload);
    if (!Array.isArray(rawVectors) || rawVectors.length !== expectedCount) {
      throw new Error(`remote ATLAS encode response count mismatch: expected ${expectedCount}, got ${Array.isArray(rawVectors) ? rawVectors.length : "none"}`);
    }
    return rawVectors.map((raw, index) => toVector(raw, { dim: this.dim, index }));
  }

  #assertMetadata(payload) {
    const remoteDim = Number(payload?.dim);
    if (payload?.dim != null && remoteDim !== this.dim) {
      throw new Error(`remote ATLAS encode dim mismatch: expected ${this.dim}, got ${payload.dim}`);
    }
    const remoteModel = String(payload?.model || "").trim();
    if (remoteModel && remoteModel !== this.#modelName && remoteModel !== this.model) {
      throw new Error(`remote ATLAS encode model mismatch: expected ${this.#modelName}, got ${remoteModel}`);
    }
    const remoteVersion = String(payload?.model_version || payload?.modelVersion || "").trim();
    if (remoteVersion && remoteVersion !== this.model_version) {
      throw new Error(`remote ATLAS encode model_version mismatch: expected ${this.model_version}, got ${remoteVersion}`);
    }
  }
}

/**
 * Side-by-side adapter for testing the remote lane without removing the local
 * encoder. Shadow mode returns local vectors, preferred/required return remote
 * vectors unless a same-dimension local fallback is allowed.
 *
 * @implements {EmbeddingEncoderContract}
 */
export class SideBySideEmbeddingEncoder {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;
  /** @type {any} */
  lastShadowResult = null;

  /** @type {EmbeddingEncoderContract} */
  #local;
  /** @type {EmbeddingEncoderContract} */
  #remote;
  /** @type {"shadow" | "preferred" | "required"} */
  #mode;
  /** @type {boolean} */
  #localFallbackCompatible;
  /** @type {((result: any) => void) | null} */
  #onShadowResult;

  /**
   * @param {SideBySideEmbeddingEncoderOptions} opts
   */
  constructor({
    local,
    remote,
    mode = "shadow",
    onShadowResult = null,
  } = {}) {
    if (!local) throw new TypeError("SideBySideEmbeddingEncoder: local encoder is required");
    if (!remote) throw new TypeError("SideBySideEmbeddingEncoder: remote encoder is required");
    const normalizedMode = String(mode || "shadow").trim().toLowerCase();
    if (!["shadow", "preferred", "required"].includes(normalizedMode)) {
      throw new Error(`unsupported_side_by_side_encoder_mode: ${mode}`);
    }
    this.#local = /** @type {EmbeddingEncoderContract} */ (local);
    this.#remote = /** @type {EmbeddingEncoderContract} */ (remote);
    this.#mode = /** @type {"shadow" | "preferred" | "required"} */ (normalizedMode);
    this.#localFallbackCompatible = this.#local.dim === this.#remote.dim;
    const authoritative = normalizedMode === "shadow" ? this.#local : this.#remote;
    this.model = authoritative.model;
    this.model_version = authoritative.model_version;
    this.dim = authoritative.dim;
    this.#onShadowResult = typeof onShadowResult === "function" ? onShadowResult : null;
  }

  async encode(texts, signal) {
    if (this.#mode === "shadow") {
      return this.#runShadow(
        () => this.#local.encode(texts, signal),
        () => this.#remote.encode(texts, signal),
        { kind: "queries", count: Array.isArray(texts) ? texts.length : 0 },
      );
    }
    return this.#runRemoteAuthoritative(
      () => this.#remote.encode(texts, signal),
      () => this.#local.encode(texts, signal),
    );
  }

  async encodeSymbols(symbols, signal) {
    if (this.#mode === "shadow") {
      return this.#runShadow(
        () => encodeSymbolsWith(this.#local, symbols, signal),
        () => encodeSymbolsWith(this.#remote, symbols, signal),
        { kind: "symbols", count: Array.isArray(symbols) ? symbols.length : 0 },
      );
    }
    return this.#runRemoteAuthoritative(
      () => encodeSymbolsWith(this.#remote, symbols, signal),
      () => encodeSymbolsWith(this.#local, symbols, signal),
    );
  }

  buildSymbolText(symbol) {
    return this.#local.buildSymbolText(symbol);
  }

  async #runShadow(localCall, remoteCall, meta) {
    const [localResult, remoteResult] = await Promise.allSettled([
      localCall(),
      remoteCall(),
    ]);
    this.lastShadowResult = {
      ...meta,
      localOk: localResult.status === "fulfilled",
      remoteOk: remoteResult.status === "fulfilled",
      remoteError: remoteResult.status === "rejected" ? String(remoteResult.reason?.message || remoteResult.reason) : null,
    };
    this.#onShadowResult?.(this.lastShadowResult);
    if (localResult.status === "rejected") throw localResult.reason;
    return localResult.value;
  }

  async #runRemoteAuthoritative(remoteCall, localCall) {
    try {
      return await remoteCall();
    } catch (err) {
      if (this.#mode === "required" || !this.#localFallbackCompatible) throw err;
      return localCall();
    }
  }
}

function rawVectorsFromPayload(payload) {
  if (Array.isArray(payload?.vectors)) {
    return payload.vectors.map((entry) => {
      if (Array.isArray(entry) || entry instanceof Float32Array) return entry;
      return entry?.vector || entry?.embedding;
    });
  }
  if (Array.isArray(payload?.embeddings)) return payload.embeddings;
  if (Array.isArray(payload?.data)) return payload.data.map((entry) => entry?.embedding || entry?.vector);
  return null;
}

function toVector(raw, { dim, index }) {
  if (!Array.isArray(raw) && !(raw instanceof Float32Array)) {
    throw new Error(`remote ATLAS embedding ${index} is not an array`);
  }
  if (raw.length !== dim) {
    throw new Error(`remote ATLAS embedding ${index} dimension mismatch: expected ${dim}, got ${raw.length}`);
  }
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const value = Number(raw[i]);
    if (!Number.isFinite(value)) throw new Error(`remote ATLAS embedding ${index} contains non-finite value at ${i}`);
    vec[i] = value;
  }
  return vec;
}

async function encodeSymbolsWith(encoder, symbols, signal) {
  if (typeof encoder.encodeSymbols === "function") {
    return encoder.encodeSymbols(symbols, signal);
  }
  if (!Array.isArray(symbols)) {
    throw new TypeError("encodeSymbolsWith: symbols must be an array");
  }
  const texts = symbols.map((symbol) => encoder.buildSymbolText(symbol));
  return encoder.encode(texts, signal);
}
