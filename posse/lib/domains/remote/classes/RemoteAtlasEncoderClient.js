// @ts-check

import {
  assertSafeRemoteAuthUrl,
  POSSE_REMOTE_MAX_RESPONSE_BYTES,
  readResponseTextWithLimit,
  resolvePosseKey,
} from "../functions/client.js";
import {
  DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS,
  normalizeRemoteAtlasEncodeRequest,
  REMOTE_ATLAS_ENCODER_PATH,
} from "../functions/atlas-encoder-client.js";

/**
 * Narrow client for the Posse remote ATLAS encoder. It intentionally talks to a
 * Posse-owned endpoint, not a generic embeddings API, so canonicalization can
 * live server-side.
 */
export class RemoteAtlasEncoderClient {
  /**
   * @param {import("../functions/atlas-encoder-client.js").RemoteAtlasEncoderClientOptions} opts
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
