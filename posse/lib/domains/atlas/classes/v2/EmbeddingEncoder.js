// @ts-check
//
// ATLAS v2 EmbeddingEncoder implementations.
//
// The default ATLAS encoder is deterministic: a hashing-trick projection with
// a fixed hash and fixed seed. Production deployments can explicitly opt into
// a configured HTTP/OpenAI-compatible embedding service; that path is never
// selected implicitly so tests and offline installs remain reproducible.
//
// The model + model_version pair MUST change when the encoder changes
// semantics; that's what scopes the on-disk embedding store at
//   <repo>/.posse/atlas/embeddings/<model>--<version>/
// so stale vectors don't get mixed with new ones after an upgrade.

import { createHash } from "crypto";
import {
  RemoteAtlasEmbeddingEncoder,
  SideBySideEmbeddingEncoder,
} from "./RemoteAtlasEmbeddingEncoder.js";
import { LocalOnnxEmbeddingEncoder } from "./LocalOnnxEmbeddingEncoder.js";
import { defaultBuildSymbolText, TEXT_SHAPE_VERSION } from "../../functions/v2/embeddings/build-symbol-text.js";
import { assertSafeRemoteAuthUrl } from "../../../remote/functions/client.js";
import {
  inspectLocalOnnxStatus,
  LOCAL_ONNX_PROVIDER_ALIASES,
  resolveLocalOnnxCacheDir,
  resolveLocalOnnxModel,
} from "../../functions/v2/embeddings/local-onnx.js";

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoderContract */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSymbolInput} EmbeddingSymbolInput */

const STUB_DEFAULT_DIM = 128;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const STUB_PROVIDER_ALIASES = new Set(["stub", "test", "hash", "deterministic", "posse-stub-hash"]);
const HTTP_PROVIDER_ALIASES = new Set(["http", "https", "remote", "openai", "openai-compatible"]);
const POSSE_REMOTE_PROVIDER_ALIASES = new Set(["posse-remote", "remote-atlas", "atlas-remote", "posse"]);
const REMOTE_ENCODER_MODES = new Set(["shadow", "preferred", "required"]);
const DEFAULT_POSSE_REMOTE_URL = "https://api.yourposseai.com";

/**
 * Deterministic offline encoder. Maps text → vector via hashed n-gram
 * projection: every byte n-gram contributes a sign-randomized weight at
 * a hash-mapped dimension. The result is L2-normalized so cosine
 * similarity gives meaningful scores.
 *
 * Quality is modest — it captures lexical overlap, not semantics — but
 * it's reproducible across machines and runs without dependencies.
 * Useful for tests, smoke checks, and as a fallback when no
 * remote-encoder credentials are configured.
 *
 * @implements {EmbeddingEncoderContract}
 */
export class StubEmbeddingEncoder {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;
  /** @type {number} */
  #ngram;

  /**
   * @param {{ dim?: number, ngram?: number }} [opts]
   */
  constructor({ dim = STUB_DEFAULT_DIM, ngram = 4 } = {}) {
    if (!Number.isInteger(dim) || dim < 16 || dim > 4096) {
      throw new RangeError("StubEmbeddingEncoder: dim must be in [16, 4096]");
    }
    if (!Number.isInteger(ngram) || ngram < 2 || ngram > 8) {
      throw new RangeError("StubEmbeddingEncoder: ngram must be in [2, 8]");
    }
    this.model = "posse-stub-hash";
    // Version covers (dim, ngram) AND the buildSymbolText shape. Bump when
    // anything about either changes so stale vectors are partitioned to a
    // different on-disk store. v3 added the raw signature_text alongside
    // doc + body_lead, so vectors built under v2 have a strictly smaller
    // n-gram pool and must not be reused.
    this.model_version = `stub-hash-${dim}-ngram${ngram}-text${TEXT_SHAPE_VERSION}`;
    this.dim = dim;
    this.#ngram = ngram;
  }

  /**
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array[]>}
   */
  async encode(texts, signal) {
    if (!Array.isArray(texts)) {
      throw new TypeError("StubEmbeddingEncoder.encode: texts must be an array");
    }
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      if (signal?.aborted) {
        throw /** @type {any} */ (signal).reason ?? new Error("encode aborted");
      }
      out[i] = this.#encodeOne(String(texts[i] ?? ""));
    }
    return out;
  }

  /**
   * @param {EmbeddingSymbolInput} symbol
   * @returns {string}
   */
  buildSymbolText(symbol) {
    return defaultBuildSymbolText(symbol);
  }

  /**
   * @param {string} text
   * @returns {Float32Array}
   */
  #encodeOne(text) {
    const vec = new Float32Array(this.dim);
    const buf = Buffer.from(text.toLowerCase(), "utf8");
    if (buf.length === 0) {
      vec[0] = 1; // Avoid NaN from zero-norm vectors; pick a stable anchor.
      return vec;
    }
    const n = this.#ngram;
    const end = Math.max(1, buf.length - n + 1);
    for (let i = 0; i < end; i++) {
      const slice = buf.subarray(i, Math.min(i + n, buf.length));
      const digest = createHash("sha256").update(slice).digest();
      // Two 32-bit pulls per n-gram: one for dimension, one for sign.
      const dimIdx = digest.readUInt32LE(0) % this.dim;
      const signByte = digest.readUInt8(4);
      const weight = (signByte & 1) === 0 ? 1 : -1;
      vec[dimIdx] += weight;
    }
    // L2-normalize so cosine similarity is well-defined.
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    } else {
      vec[0] = 1;
    }
    return vec;
  }
}

/**
 * HTTP/OpenAI-compatible encoder. This intentionally keeps the transport
 * narrow: a single POST with `{ model, input }` and either OpenAI-style
 * `{ data: [{ embedding }] }` or generic `{ embeddings: [...] }` response.
 *
 * @implements {EmbeddingEncoderContract}
 */
export class HttpEmbeddingEncoder {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;

  /** @type {string} */
  #endpoint;
  /** @type {string} */
  #modelName;
  /** @type {string | null} */
  #apiKey;
  /** @type {number} */
  #timeoutMs;
  /** @type {Record<string, string>} */
  #headers;
  /** @type {boolean} */
  #sendDimensions;

  /**
   * @param {{
   *   provider: string,
   *   endpoint: string,
   *   model: string,
   *   dim: number,
   *   apiKey?: string | null,
   *   modelVersion?: string | null,
   *   timeoutMs?: number | null,
   *   headers?: Record<string, string>,
   *   sendDimensions?: boolean,
   * }} opts
   */
  constructor({
    provider,
    endpoint,
    model,
    dim,
    apiKey = null,
    modelVersion = null,
    timeoutMs = null,
    headers = {},
    sendDimensions = false,
  }) {
    const normalizedProvider = normalizeProviderName(provider);
    const normalizedEndpoint = String(endpoint || "").trim();
    const normalizedModel = String(model || "").trim();
    if (!normalizedProvider) throw new TypeError("HttpEmbeddingEncoder: provider is required");
    if (!normalizedEndpoint) throw new TypeError("HttpEmbeddingEncoder: endpoint is required");
    if (!normalizedModel) throw new TypeError("HttpEmbeddingEncoder: model is required");
    if (!Number.isInteger(dim) || dim <= 0 || dim > 32768) {
      throw new RangeError("HttpEmbeddingEncoder: dim must be in [1, 32768]");
    }
    const normalizedApiKey = String(apiKey || "").trim() || null;
    const normalizedHeaders = normalizeHeaders(headers);
    const authorizationHeader = Object.entries(normalizedHeaders)
      .find(([key]) => key.toLowerCase() === "authorization")?.[1];
    assertSafeRemoteAuthUrl(
      normalizedEndpoint,
      normalizedApiKey || String(authorizationHeader || "").trim(),
      "HTTP embedding encode",
    );
    this.#endpoint = normalizedEndpoint;
    this.#modelName = normalizedModel;
    this.#apiKey = normalizedApiKey;
    this.#timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : DEFAULT_HTTP_TIMEOUT_MS;
    this.#headers = normalizedHeaders;
    this.#sendDimensions = !!sendDimensions;
    this.model = `${normalizedProvider}:${normalizedModel}`;
    this.model_version = String(modelVersion || `http-v1:${normalizedModel}:${dim}`);
    this.dim = dim;
  }

  /**
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array[]>}
   */
  async encode(texts, signal) {
    if (!Array.isArray(texts)) {
      throw new TypeError("HttpEmbeddingEncoder.encode: texts must be an array");
    }
    if (typeof fetch !== "function") {
      throw new Error("HttpEmbeddingEncoder.encode: global fetch is unavailable");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason || new Error("encode aborted"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      controller.abort(new Error(`embedding request timed out after ${this.#timeoutMs}ms`));
    }, this.#timeoutMs);
    try {
      const body = {
        model: this.#modelName,
        input: texts.map((text) => String(text ?? "")),
        ...(this.#sendDimensions ? { dimensions: this.dim } : {}),
      };
      const response = await fetch(this.#endpoint, {
        method: "POST",
        headers: this.#requestHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payloadText = await response.text();
      if (!response.ok) {
        throw new Error(`embedding request failed: ${response.status} ${capErrorText(payloadText)}`);
      }
      let payload;
      try {
        payload = payloadText ? JSON.parse(payloadText) : null;
      } catch (err) {
        throw new Error(`embedding response was not JSON: ${err?.message || String(err)}`);
      }
      return vectorsFromEmbeddingPayload(payload, { expectedCount: texts.length, dim: this.dim });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", onAbort);
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
   * @returns {Record<string, string>}
   */
  #requestHeaders() {
    /** @type {Record<string, string>} */
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      ...this.#headers,
    };
    if (this.#apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }
    return headers;
  }
}

/**
 * Resolve the encoder for the current environment. Unknown providers are
 * rejected loudly; missing/disabled providers still resolve to the deterministic
 * stub so tests and direct callers can keep using this factory.
 *
 * @param {Record<string, unknown>} [config]
 * @param {Record<string, unknown>} [env]
 * @returns {EmbeddingEncoderContract}
 */
export function resolveConfiguredEncoder(config = {}, env = {}) {
  const effective = {
    ...embeddingEnvConfig(env),
    ...(config && typeof config === "object" ? config : {}),
  };
  const provider = normalizeProviderName(
    effective.embeddingProvider
    || effective.atlasEmbeddingProvider
    || effective.provider
    || "",
  );
  const remoteEncoderMode = normalizeRemoteEncoderMode(
    effective.remoteEncoderMode
    || effective.atlasRemoteEncoderMode
    || effective.atlas_remote_encoder_mode
    || "",
  );
  if (REMOTE_ENCODER_MODES.has(remoteEncoderMode)) {
    const remote = createRemoteAtlasEmbeddingEncoder(effective);
    if (remoteEncoderMode === "required") return remote;
    const activeRemoteEncoderMode = /** @type {"shadow" | "preferred"} */ (remoteEncoderMode);
    const localProvider = normalizeProviderName(
      effective.localEmbeddingProvider
      || effective.fallbackEmbeddingProvider
      || (provider && !POSSE_REMOTE_PROVIDER_ALIASES.has(provider) ? provider : "stub"),
    ) || "stub";
    const local = resolveConfiguredEncoder({
      ...effective,
      embeddingProvider: localProvider,
      atlasEmbeddingProvider: localProvider,
      provider: localProvider,
      remoteEncoderMode: "off",
      atlasRemoteEncoderMode: "off",
      atlas_remote_encoder_mode: "off",
    }, env);
    return new SideBySideEmbeddingEncoder({
      local,
      remote,
      mode: activeRemoteEncoderMode,
      onShadowResult: typeof effective.onRemoteEncoderShadowResult === "function"
        ? /** @type {(result: any) => void} */ (effective.onRemoteEncoderShadowResult)
        : null,
    });
  }
  if (!provider || provider === "off" || provider === "none" || provider === "false" || STUB_PROVIDER_ALIASES.has(provider)) {
    return new StubEmbeddingEncoder({
      dim: parseIntInRange(effective.embeddingDim ?? effective.dim, 16, 4096) || STUB_DEFAULT_DIM,
      ngram: parseIntInRange(effective.embeddingNgram ?? effective.ngram, 2, 8) || 4,
    });
  }
  if (POSSE_REMOTE_PROVIDER_ALIASES.has(provider)) {
    return createRemoteAtlasEmbeddingEncoder(effective);
  }
  if (LOCAL_ONNX_PROVIDER_ALIASES.has(provider)) {
    const model = resolveLocalOnnxModel(effective);
    const cacheDir = resolveLocalOnnxCacheDir({
      repoRoot: String(effective.repoRoot || "").trim() || undefined,
      config: effective,
    });
    if (!cacheDir) {
      throw new Error("local_onnx_cache_dir_unresolved: provide repoRoot or localOnnxCacheDir");
    }
    const status = inspectLocalOnnxStatus({
      repoRoot: String(effective.repoRoot || "").trim() || undefined,
      config: effective,
    });
    if (!status.enabled) {
      throw new Error(`local_onnx_unavailable: ${status.reason}`);
    }
    return new LocalOnnxEmbeddingEncoder({
      cacheDir,
      modelName: model.model,
      modelId: model.id,
      dim: model.dim,
      dtype: model.dtype || "q8",
      modelVersion: String(effective.embeddingModelVersion || effective.localOnnxModelVersion || effective.modelVersion || "").trim() || null,
      batchSize: parseIntInRange(effective.localOnnxBatchSize ?? effective.embeddingBatchSize, 1, 512) || undefined,
      maxInputChars: parseIntInRange(effective.localOnnxMaxInputChars ?? effective.embeddingMaxInputChars, 1, 200000) || undefined,
    });
  }
  if (HTTP_PROVIDER_ALIASES.has(provider)) {
    const dim = parseIntInRange(effective.embeddingDim ?? effective.dim, 1, 32768);
    if (!dim) throw new Error(`embedding_dim_required: provider '${provider}' requires embeddingDim`);
    const endpoint = resolveEmbeddingEndpoint(provider, effective);
    const apiKey = String(effective.embeddingApiKey || effective.apiKey || "").trim() || null;
    if (provider === "openai" && endpoint.includes("api.openai.com") && !apiKey) {
      throw new Error("embedding_api_key_required: provider 'openai' requires embeddingApiKey");
    }
    return new HttpEmbeddingEncoder({
      provider,
      endpoint,
      model: String(effective.embeddingModel || effective.model || "").trim(),
      dim,
      apiKey,
      modelVersion: String(effective.embeddingModelVersion || effective.modelVersion || "").trim() || null,
      timeoutMs: parseIntInRange(effective.embeddingTimeoutMs ?? effective.timeoutMs, 1, 600000),
      headers: parseHeaders(effective.embeddingHeaders || effective.headers),
      sendDimensions: parseBoolean(effective.embeddingSendDimensions || effective.sendDimensions),
    });
  }
  throw new Error(`unsupported_embedding_provider: ${provider}`);
}

/**
 * Resolve the deterministic fallback encoder.
 *
 * @returns {EmbeddingEncoderContract}
 */
export function resolveDefaultEncoder() {
  return new StubEmbeddingEncoder();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {"off" | "shadow" | "preferred" | "required"}
 */
function normalizeRemoteEncoderMode(value) {
  const raw = String(value || "off").trim().toLowerCase();
  return raw === "off" || REMOTE_ENCODER_MODES.has(raw)
    ? /** @type {"off" | "shadow" | "preferred" | "required"} */ (raw)
    : "off";
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
function parseIntInRange(value, min, max) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function parseBoolean(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * @param {Record<string, unknown>} env
 * @returns {Record<string, unknown>}
 */
function embeddingEnvConfig(env = {}) {
  return {
    embeddingApiKey: env.POSSE_ATLAS_EMBEDDING_API_KEY,
    remoteEncoderMode: env.POSSE_ATLAS_REMOTE_ENCODER_MODE,
    remoteEncoderUrl: env.POSSE_ATLAS_REMOTE_ENCODER_URL || env.POSSE_REMOTE_URL || env.POSSE_REMOTE_BASE_URL,
    remoteEncoderModel: env.POSSE_ATLAS_REMOTE_ENCODER_MODEL,
    remoteEncoderDim: env.POSSE_ATLAS_REMOTE_ENCODER_DIM,
    remoteEncoderModelVersion: env.POSSE_ATLAS_REMOTE_ENCODER_MODEL_VERSION,
    remoteEncoderTimeoutMs: env.POSSE_ATLAS_REMOTE_ENCODER_TIMEOUT_MS,
  };
}

/**
 * @param {Record<string, unknown>} config
 * @returns {RemoteAtlasEmbeddingEncoder}
 */
function createRemoteAtlasEmbeddingEncoder(config) {
  const dim = parseIntInRange(
    config.remoteEncoderDim ?? config.atlasRemoteEncoderDim ?? config.embeddingDim ?? config.dim,
    1,
    32768,
  );
  if (!dim) throw new Error("remote_encoder_dim_required: provider 'posse-remote' requires remoteEncoderDim or embeddingDim");
  const baseUrl = String(
    config.remoteEncoderUrl
    || config.atlasRemoteEncoderUrl
    || config.embeddingEndpoint
    || config.endpoint
    || DEFAULT_POSSE_REMOTE_URL,
  ).trim();
  const model = String(
    config.remoteEncoderModel
    || config.atlasRemoteEncoderModel
    || config.embeddingModel
    || config.model
    || "atlas-encoder",
  ).trim();
  const modelVersion = String(
    config.remoteEncoderModelVersion
    || config.atlasRemoteEncoderModelVersion
    || config.embeddingModelVersion
    || config.modelVersion
    || "",
  ).trim() || null;
  return new RemoteAtlasEmbeddingEncoder({
    baseUrl,
    model,
    dim,
    modelVersion,
    timeoutMs: parseIntInRange(config.remoteEncoderTimeoutMs ?? config.embeddingTimeoutMs ?? config.timeoutMs, 1, 600000)
      || DEFAULT_HTTP_TIMEOUT_MS,
    fetchImpl: typeof config.fetchImpl === "function" ? /** @type {typeof fetch} */ (config.fetchImpl) : globalThis.fetch,
    ...(config.authManager ? { authManager: config.authManager } : {}),
    ...(config.pulseTokens ? { pulseTokens: config.pulseTokens } : {}),
    repoFingerprint: String(config.repoFingerprint || "").trim() || null,
  });
}

/**
 * @param {string} provider
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function resolveEmbeddingEndpoint(provider, config) {
  const explicit = String(config.embeddingEndpoint || config.endpoint || "").trim();
  if (explicit) return explicit;
  if (provider === "openai") return "https://api.openai.com/v1/embeddings";
  throw new Error(`embedding_endpoint_required: provider '${provider}' requires embeddingEndpoint`);
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function parseHeaders(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return normalizeHeaders(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return normalizeHeaders(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const name = String(key || "").trim();
    if (!name || /[\r\n:]/.test(name)) continue;
    if (entry == null) continue;
    const text = String(entry);
    if (/[\r\n]/.test(text)) continue;
    out[name.toLowerCase()] = text;
  }
  return out;
}

/**
 * @param {unknown} payload
 * @param {{ expectedCount: number, dim: number }} opts
 * @returns {Float32Array[]}
 */
function vectorsFromEmbeddingPayload(payload, { expectedCount, dim }) {
  const rawVectors = Array.isArray(/** @type {any} */ (payload)?.data)
    ? /** @type {any[]} */ (/** @type {any} */ (payload).data).map((entry) => entry?.embedding)
    : /** @type {any} */ (payload)?.embeddings;
  if (!Array.isArray(rawVectors) || rawVectors.length !== expectedCount) {
    throw new Error(`embedding response count mismatch: expected ${expectedCount}, got ${Array.isArray(rawVectors) ? rawVectors.length : "none"}`);
  }
  return rawVectors.map((raw, index) => toVector(raw, { dim, index }));
}

/**
 * @param {unknown} raw
 * @param {{ dim: number, index: number }} opts
 * @returns {Float32Array}
 */
function toVector(raw, { dim, index }) {
  if (!Array.isArray(raw) && !(raw instanceof Float32Array)) {
    throw new Error(`embedding ${index} is not an array`);
  }
  if (raw.length !== dim) {
    throw new Error(`embedding ${index} dimension mismatch: expected ${dim}, got ${raw.length}`);
  }
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const value = Number(raw[i]);
    if (!Number.isFinite(value)) throw new Error(`embedding ${index} contains non-finite value at ${i}`);
    vec[i] = value;
  }
  return vec;
}

/**
 * @param {string} text
 * @returns {string}
 */
function capErrorText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > 240 ? `${clean.slice(0, 240)}...` : clean;
}
