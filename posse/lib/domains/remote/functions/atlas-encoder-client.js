// @ts-check

import {
  assertSafeRemoteAuthUrl,
  POSSE_REMOTE_MAX_RESPONSE_BYTES,
  readResponseTextWithLimit,
  resolvePosseKey,
} from "./client.js";

export const REMOTE_ATLAS_ENCODER_PATH = "/v1/atlas/embeddings/encode";
export const DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS = 30000;
export const REMOTE_ATLAS_ENCODER_SYMBOL_EGRESS_FIELDS = Object.freeze([
  "content_hash",
  "local_id",
  "repo_rel_path",
  "kind",
  "lang",
  "name",
  "qualified_name",
  "signature_hash",
  "signature_text",
  "doc",
  "body_lead",
]);
export const REMOTE_ATLAS_ENCODER_QUERY_EGRESS_FIELDS = Object.freeze(["texts"]);
export const REMOTE_ATLAS_ENCODER_EGRESS_POLICY = Object.freeze({
  channel: "atlas_embeddings_encode",
  source_policy: "source_derived_symbol_text",
  symbol_fields: REMOTE_ATLAS_ENCODER_SYMBOL_EGRESS_FIELDS,
  query_fields: REMOTE_ATLAS_ENCODER_QUERY_EGRESS_FIELDS,
});

/**
 * @typedef {Object} RemoteAtlasEncoderClientOptions
 * @property {string} [baseUrl]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {number} [retryDelayMs]
 * @property {number} [maxResponseBytes]
 * @property {typeof fetch} [fetchImpl]
 * @property {string | null} [apiKey]
 */

/**
 * Narrow client for the Posse remote ATLAS encoder. It intentionally talks to a
 * Posse-owned endpoint, not a generic embeddings API, so canonicalization can
 * live server-side.
 */
export class RemoteAtlasEncoderClient {
  /**
   * @param {RemoteAtlasEncoderClientOptions} opts
   */
  constructor({
    baseUrl,
    timeoutMs = DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS,
    maxRetries = 1,
    retryDelayMs = 100,
    maxResponseBytes = POSSE_REMOTE_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    apiKey = resolvePosseKey(),
  } = {}) {
    if (!baseUrl) throw new Error("RemoteAtlasEncoderClient requires baseUrl");
    if (typeof fetchImpl !== "function") throw new Error("RemoteAtlasEncoderClient requires fetch");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(Number(maxRetries)) && Number(maxRetries) > 0
      ? Math.floor(Number(maxRetries))
      : 0;
    this.retryDelayMs = Number.isFinite(Number(retryDelayMs)) && Number(retryDelayMs) > 0
      ? Number(retryDelayMs)
      : 0;
    this.maxResponseBytes = Number.isFinite(Number(maxResponseBytes)) && Number(maxResponseBytes) > 0
      ? Math.floor(Number(maxResponseBytes))
      : POSSE_REMOTE_MAX_RESPONSE_BYTES;
    this.fetchImpl = fetchImpl;
    this.apiKey = apiKey == null ? "" : String(apiKey).trim();
    assertSafeRemoteAuthUrl(this.baseUrl, this.apiKey, "remote ATLAS encode");
  }

  endpoint(path = REMOTE_ATLAS_ENCODER_PATH) {
    const suffix = String(path || REMOTE_ATLAS_ENCODER_PATH);
    if (this.baseUrl.endsWith(suffix)) return this.baseUrl;
    return `${this.baseUrl}${suffix}`;
  }

  async encodeBatch(request, signal) {
    const attempts = this.maxRetries + 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.encodeOnce(request, signal);
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts || !isRetryableRemoteEncoderError(err)) {
          if (attempt > 1 && err instanceof Error) {
            /** @type {any} */ (err).attempts = attempt;
            err.message = `${err.message} (after ${attempt} attempts)`;
          }
          throw err;
        }
        if (this.retryDelayMs > 0) await sleep(this.retryDelayMs);
      }
    }
    throw lastErr;
  }

  async encodeOnce(request, signal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal?.reason || new Error("remote ATLAS encode aborted"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      ac.abort(new Error(`remote ATLAS encode timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    const url = this.endpoint();
    try {
      const normalized = normalizeRemoteAtlasEncodeRequest(request);
      /** @type {Record<string, string>} */
      const headers = {
        accept: "application/json",
        "content-type": "application/json",
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const idempotencyKey = idempotencyKeyFor(normalized);
      if (idempotencyKey) headers["x-posse-idempotency-key"] = idempotencyKey;
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(normalized),
        signal: ac.signal,
      });
      const text = await readResponseTextWithLimit(response, {
        maxBytes: this.maxResponseBytes,
        operation: "remote ATLAS encode",
        url,
      });
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
      if (!response.ok) {
        const detail = formatBodyDetail(body);
        const err = new Error(`remote ATLAS encode failed for ${url}: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`);
        /** @type {any} */ (err).status = response.status;
        /** @type {any} */ (err).body = body;
        throw err;
      }
      return body || {};
    } catch (err) {
      if (err?.name === "AbortError") {
        const timeoutErr = new Error(`remote ATLAS encode timed out after ${this.timeoutMs}ms for ${url}`);
        /** @type {any} */ (timeoutErr).code = "POSSE_REMOTE_ATLAS_ENCODER_TIMEOUT";
        throw timeoutErr;
      }
      if (err?.code === "POSSE_REMOTE_RESPONSE_TOO_LARGE") {
        /** @type {any} */ (err).code = "POSSE_REMOTE_ATLAS_ENCODER_RESPONSE_TOO_LARGE";
        throw err;
      }
      if (err?.status) throw err;
      const wrapped = new Error(`remote ATLAS encode request failed for ${url}: ${formatFetchError(err)}`);
      /** @type {any} */ (wrapped).code = "POSSE_REMOTE_ATLAS_ENCODER_FETCH_FAILED";
      /** @type {any} */ (wrapped).cause = err;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }
}

export function normalizeRemoteAtlasEncodeRequest(request = {}) {
  const symbols = Array.isArray(request.symbols) ? request.symbols.map(buildRemoteAtlasSymbol) : null;
  const texts = Array.isArray(request.texts)
    ? request.texts.map((text) => String(text ?? ""))
    : null;
  const kind = String(request.kind || (symbols ? "symbols" : "queries")).trim().toLowerCase();
  if (kind === "symbols" && (!symbols || symbols.length === 0)) {
    throw new TypeError("remote ATLAS encode symbols request requires symbols");
  }
  if (kind === "queries" && (!texts || texts.length === 0)) {
    throw new TypeError("remote ATLAS encode queries request requires texts");
  }
  return compactObject({
    request_id: request.request_id || request.requestId || undefined,
    batch_id: request.batch_id || request.batchId || undefined,
    repo_fingerprint: request.repo_fingerprint || request.repoFingerprint || undefined,
    kind,
    model_hint: request.model_hint || request.modelHint || undefined,
    symbols: kind === "symbols" ? symbols : undefined,
    texts: kind === "queries" ? texts : undefined,
  });
}

export function buildRemoteAtlasSymbol(symbol = {}) {
  const out = {};
  for (const field of REMOTE_ATLAS_ENCODER_SYMBOL_EGRESS_FIELDS) {
    out[field] = field === "local_id"
      ? (Number.isInteger(symbol.local_id) ? symbol.local_id : undefined)
      : symbol[field];
  }
  return compactObject(out);
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null),
  );
}

function idempotencyKeyFor(request) {
  return [
    request.request_id,
    request.batch_id,
    request.kind,
  ].map((part) => String(part || "").trim()).filter(Boolean).join(":");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRemoteEncoderError(err) {
  if (!err) return false;
  if (err.code === "POSSE_REMOTE_ATLAS_ENCODER_TIMEOUT" || err.code === "POSSE_REMOTE_ATLAS_ENCODER_FETCH_FAILED") return true;
  const status = Number(err.status);
  return Number.isFinite(status) && status >= 500 && status < 600;
}

function formatBodyDetail(body) {
  if (!body) return "";
  const detail = body.error || body.message || body.raw || "";
  if (detail && typeof detail === "object") {
    return [
      detail.code,
      detail.message,
      detail.detail,
    ].map((part) => String(part || "").trim()).filter(Boolean).join(": ").slice(0, 500);
  }
  return String(detail || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function formatFetchError(err) {
  const parts = [
    err?.message,
    err?.cause?.code,
    err?.cause?.name,
  ].map((part) => String(part || "").trim()).filter(Boolean);
  return parts.join(" ") || "fetch failed";
}
