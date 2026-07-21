import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import {
  PulseTokenManager,
  pulseTokenManager,
} from "../../../shared/native/classes/PulseTokenManager.js";
import {
  POSSE_REMOTE_MAX_RESPONSE_BYTES,
  readResponseTextWithLimit,
  verifyRemoteResponseIntegrity,
} from "../functions/client.js";
import { getPosseRemoteResponseSigningSecret } from "../functions/mode.js";
import { runRemoteNativeRequestJson } from "../functions/native-client.js";

const DEFAULT_REMOTE_PROMPT_TIMEOUT_MS = 60_000;
const TRUSTED_COMPILE_ISSUANCES = new WeakSet();

function deepFreezeJson(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(clone);
}

export function isRemotePromptClientIssuance(value) {
  return !!value && typeof value === "object" && TRUSTED_COMPILE_ISSUANCES.has(value);
}

export class RemotePromptClient {
  #compileIssuances = new WeakMap();

  /**
   * @param {{
   *   baseUrl?: string,
   *   timeoutMs?: number,
   *   maxRetries?: number,
   *   retryDelayMs?: number,
   *   maxResponseBytes?: number,
   *   fetchImpl?: typeof globalThis.fetch,
   *   nativeManager?: any,
   *   authManager?: any,
   *   pulseTokens?: any,
   *   responseSigningSecret?: string,
   * }} [options]
   */
  constructor({
    baseUrl,
    timeoutMs = DEFAULT_REMOTE_PROMPT_TIMEOUT_MS,
    maxRetries = 1,
    retryDelayMs = 100,
    maxResponseBytes = POSSE_REMOTE_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    nativeManager = nativeBinaries,
    authManager = null,
    pulseTokens = null,
    responseSigningSecret = getPosseRemoteResponseSigningSecret(),
  } = {}) {
    if (!baseUrl) throw new Error("RemotePromptClient requires baseUrl");
    if (typeof fetchImpl !== "function") throw new Error("RemotePromptClient requires fetch");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : DEFAULT_REMOTE_PROMPT_TIMEOUT_MS;
    this.maxRetries = Number.isFinite(Number(maxRetries)) && Number(maxRetries) > 0 ? Math.floor(Number(maxRetries)) : 0;
    this.retryDelayMs = Number.isFinite(Number(retryDelayMs)) && Number(retryDelayMs) > 0 ? Number(retryDelayMs) : 0;
    this.maxResponseBytes = Number.isFinite(Number(maxResponseBytes)) && Number(maxResponseBytes) > 0
      ? Math.floor(Number(maxResponseBytes))
      : POSSE_REMOTE_MAX_RESPONSE_BYTES;
    this.fetchImpl = fetchImpl;
    this.usesDefaultFetch = fetchImpl === globalThis.fetch;
    this.nativeManager = nativeManager;
    this.authManager = authManager || nativeManager?.nativeAuthManager || heartbeatAuthManager;
    this.pulseTokens = pulseTokens || (
      this.authManager === heartbeatAuthManager && fetchImpl === globalThis.fetch
        ? pulseTokenManager
        : new PulseTokenManager({ authManager: this.authManager, fetchImpl })
    );
    this.responseSigningSecret = String(responseSigningSecret || "").trim();
    if (this.hasAuthentication()) {
      this.pulseTokens.assertTrustedResourceUrl(this.baseUrl, "remote prompt");
    }
  }

  endpoint(path = "") {
    return `${this.baseUrl}${path}`;
  }

  async compile(request) {
    const response = await this.requestJsonWithRetries({
      path: "/v1/prompts/compile",
      method: "POST",
      body: request,
      operation: "remote prompt compile",
    }, isRetryableRemoteRequestError);
    if (response && typeof response === "object") {
      const issuance = response.issuance && typeof response.issuance === "object"
        ? deepFreezeJson(response.issuance)
        : null;
      this.#compileIssuances.set(response, issuance);
    }
    return response;
  }

  consumeCompileIssuance(response) {
    if (!response || !this.#compileIssuances.has(response)) return null;
    const issuance = this.#compileIssuances.get(response);
    this.#compileIssuances.delete(response);
    if (!issuance) return null;
    TRUSTED_COMPILE_ISSUANCES.add(issuance);
    return issuance;
  }

  async compileOnce(request) {
    return this.requestJsonOnce({
      path: "/v1/prompts/compile",
      method: "POST",
      body: request,
      operation: "remote prompt compile",
    });
  }

  async getToolSuites() {
    return this.requestJsonWithRetries({
      path: "/v1/catalog/tool-suites",
      method: "GET",
      operation: "remote tool-suite catalog",
    }, isRetryableRemoteRequestError);
  }

  async getPromptBundle() {
    return this.requestJsonWithRetries({
      path: "/v1/prompts/bundle",
      method: "GET",
      operation: "remote prompt bundle",
    }, isRetryableRemoteRequestError);
  }

  async getModelCatalog() {
    return this.requestJsonWithRetries({
      path: "/v1/catalog/models",
      method: "GET",
      operation: "remote model catalog",
    }, isRetryableRemoteRequestError);
  }

  async resolveToolSurface(request) {
    return this.requestJsonWithRetries({
      path: "/v1/catalog/tool-surface",
      method: "POST",
      body: request,
      operation: "remote tool-surface catalog",
    }, isRetryableRemoteRequestError);
  }

  async requestJsonWithRetries(options, isRetryableError = isRetryableRemoteRequestError) {
    if (this.shouldUseNativeClient()) {
      return await this.requestJsonNative(options, { maxRetries: this.maxRetries });
    }
    const attempts = this.maxRetries + 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestJsonOnce(options);
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts || !isRetryableError(err)) {
          if (attempt > 1 && err instanceof Error) {
            err.attempts = attempt;
            err.message = `${err.message} (after ${attempt} attempts)`;
          }
          throw err;
        }
        if (this.retryDelayMs > 0) await sleep(this.retryDelayMs);
      }
    }
    throw lastErr;
  }

  async requestJsonOnce({
    path = "/",
    method = "GET",
    body = undefined,
    operation = "remote request",
  } = {}) {
    if (this.shouldUseNativeClient()) {
      return await this.requestJsonNative({ path, method, body, operation }, { maxRetries: 0 });
    }
    const ac = new AbortController();
    let timer = null;
    const url = this.endpoint(path);
    try {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      const pulseToken = await this.pulseTokens.getPulseToken({
        requiredRoute: requiredRouteFor(path, method, body),
      });
      if (pulseToken) {
        this.pulseTokens.assertTrustedResourceUrl(url, operation);
        headers.authorization = `Bearer ${pulseToken}`;
      }
      timer = setTimeout(() => ac.abort(), this.timeoutMs);
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: ac.signal,
      });
      const text = await readResponseTextWithLimit(response, {
        maxBytes: this.maxResponseBytes,
        operation,
        url,
      });
      let responseBody = null;
      if (text) {
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = { raw: text };
        }
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.pulseTokens.clearAuthentication();
        const safeResponseBody = redactCredentialValue(responseBody, pulseToken);
        const bodyDetail = formatBodyDetail(safeResponseBody);
        const err = new Error(`${operation} failed for ${url}: ${response.status} ${response.statusText}${bodyDetail ? ` - ${bodyDetail}` : ""}`);
        err.status = response.status;
        err.body = safeResponseBody;
        throw err;
      }
      return this.verifyResponseIntegrity(responseBody, { path, operation });
    } catch (err) {
      if (err?.name === "AbortError") {
        const timeoutErr = new Error(`${operation} timed out after ${this.timeoutMs}ms for ${url}`);
        timeoutErr.code = "POSSE_REMOTE_TIMEOUT";
        throw timeoutErr;
      }
      if (String(err?.code || "").startsWith("POSSE_PULSE_")) throw err;
      if (err?.code === "POSSE_REMOTE_RESPONSE_TOO_LARGE") throw err;
      if (err?.status) throw err;
      const wrapped = new Error(`${operation} request failed for ${url}: ${formatFetchError(err)}`);
      wrapped.code = "POSSE_REMOTE_FETCH_FAILED";
      wrapped.cause = err;
      throw wrapped;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  shouldUseNativeClient() {
    if (!this.usesDefaultFetch || !this.hasAuthentication()) return false;
    if (!this.nativeAuthEnvelope()) return false;
    if (this.nativeManager?.nativeAuthManager !== this.authManager) return false;
    // A production authenticated request belongs to the native client even if
    // its artifact is missing. Selecting by availability here would silently
    // resurrect the retired Node HTTP route instead of failing closed.
    if (typeof this.nativeManager?.enabled === "function") {
      return this.nativeManager.enabled("remote") === true;
    }
    return this.nativeManager?.shouldUse?.("remote") === true;
  }

  nativeAuthEnvelope() {
    const envelope = this.authManager?.getNativeAuthEnvelope?.();
    return envelope && typeof envelope === "object" && Object.keys(envelope).length > 0
      ? envelope
      : null;
  }

  hasAuthentication() {
    return this.authManager?.hasLaunchKey?.() === true;
  }

  async requestJsonNative({
    path = "/",
    method = "GET",
    body = undefined,
    operation = "remote request",
  } = {}, {
    maxRetries = 0,
  } = {}) {
    const responseBody = await runRemoteNativeRequestJson({
      baseUrl: this.baseUrl,
      path,
      method,
      body: body === undefined ? null : body,
      operation,
      timeoutMs: this.timeoutMs,
      maxRetries,
      retryDelayMs: this.retryDelayMs,
      maxResponseBytes: this.maxResponseBytes,
    }, {
      manager: this.nativeManager,
    });
    return this.verifyResponseIntegrity(responseBody, { path, operation });
  }

  verifyResponseIntegrity(responseBody, { path = "", operation = "remote request" } = {}) {
    return verifyRemoteResponseIntegrity(responseBody, {
      path,
      operation,
      signingSecret: this.responseSigningSecret,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredRouteFor(path, method, body = undefined) {
  const key = `${String(method || "GET").toUpperCase()} ${String(path || "")}`;
  if (key === "POST /v1/prompts/compile") return "prompts:compile";
  if (key === "GET /v1/prompts/bundle") return "prompts:bundle";
  if (key === "POST /v1/catalog/tool-surface") {
    return body?.mcp_oauth?.requested === true ? "prompts:compile" : "catalog:read";
  }
  if (key === "GET /v1/catalog/tool-suites"
    || key === "GET /v1/catalog/tools"
    || key === "GET /v1/catalog/models") return "catalog:read";
  return null;
}

function isRetryableRemoteRequestError(err) {
  if (!err) return false;
  if (err.code === "POSSE_REMOTE_TIMEOUT" || err.code === "POSSE_REMOTE_FETCH_FAILED") return true;
  if (err.code === "POSSE_PULSE_TIMEOUT" || err.code === "POSSE_PULSE_FETCH_FAILED") return true;
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

function redactCredentialValue(value, credential) {
  const secret = String(credential || "");
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactCredentialValue(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      redactCredentialValue(item, secret),
    ]));
  }
  return value;
}
