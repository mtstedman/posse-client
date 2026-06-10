import { execFileSync } from "child_process";
import { nativeBinaries } from "../../../classes/tools/BinaryManager.js";
import { runRemoteNativeRequestJson } from "./native-client.js";
import { nativeHeartbeatAuthFromSettings } from "./native-auth.js";

const DEFAULT_REMOTE_PROMPT_TIMEOUT_MS = 60_000;
export const POSSE_REMOTE_MAX_RESPONSE_BYTES = 1024 * 1024;

export class RemotePromptClient {
  constructor({
    baseUrl,
    timeoutMs = DEFAULT_REMOTE_PROMPT_TIMEOUT_MS,
    maxRetries = 1,
    retryDelayMs = 100,
    maxResponseBytes = POSSE_REMOTE_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    apiKey = resolvePosseKey(),
    nativeManager = nativeBinaries,
    useNativeClient = true,
    nativeAuth = null,
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
    this.apiKey = apiKey == null ? "" : String(apiKey).trim();
    this.nativeManager = nativeManager;
    this.useNativeClient = useNativeClient !== false;
    this.nativeAuth = nativeAuth;
    this._resolvedNativeAuth = undefined;
    assertSafeRemoteAuthUrl(this.baseUrl, this.apiKey, "remote prompt");
  }

  endpoint(path = "") {
    return `${this.baseUrl}${path}`;
  }

  async compile(request) {
    return this.requestJsonWithRetries({
      path: "/v1/prompts/compile",
      method: "POST",
      body: request,
      operation: "remote prompt compile",
    }, isRetryableRemoteRequestError);
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
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const url = this.endpoint(path);
    try {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
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
        const bodyDetail = formatBodyDetail(responseBody);
        const err = new Error(`${operation} failed for ${url}: ${response.status} ${response.statusText}${bodyDetail ? ` - ${bodyDetail}` : ""}`);
        err.status = response.status;
        err.body = responseBody;
        throw err;
      }
      return responseBody;
    } catch (err) {
      if (err?.name === "AbortError") {
        const timeoutErr = new Error(`${operation} timed out after ${this.timeoutMs}ms for ${url}`);
        timeoutErr.code = "POSSE_REMOTE_TIMEOUT";
        throw timeoutErr;
      }
      if (err?.code === "POSSE_REMOTE_RESPONSE_TOO_LARGE") throw err;
      if (err?.status) throw err;
      const wrapped = new Error(`${operation} request failed for ${url}: ${formatFetchError(err)}`);
      wrapped.code = "POSSE_REMOTE_FETCH_FAILED";
      wrapped.cause = err;
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  shouldUseNativeClient() {
    if (!this.useNativeClient || !this.usesDefaultFetch || !this.apiKey) return false;
    if (!this.nativeAuthEnvelope()) return false;
    return this.nativeManager?.shouldUse?.("remote") === true;
  }

  nativeAuthEnvelope() {
    if (this.nativeAuth && typeof this.nativeAuth === "object") {
      return Object.keys(this.nativeAuth).length > 0 ? this.nativeAuth : null;
    }
    if (this._resolvedNativeAuth === undefined) {
      this._resolvedNativeAuth = nativeHeartbeatAuthFromSettings();
    }
    return this._resolvedNativeAuth && typeof this._resolvedNativeAuth === "object"
      && Object.keys(this._resolvedNativeAuth).length > 0
      ? this._resolvedNativeAuth
      : null;
  }

  async requestJsonNative({
    path = "/",
    method = "GET",
    body = undefined,
    operation = "remote request",
  } = {}, {
    maxRetries = 0,
  } = {}) {
    return await runRemoteNativeRequestJson({
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
      apiKey: this.apiKey,
      auth: this.nativeAuthEnvelope(),
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseTooLargeError({ operation, url, maxBytes }) {
  const err = new Error(`${operation} response exceeded ${maxBytes} byte limit for ${url}`);
  err.code = "POSSE_REMOTE_RESPONSE_TOO_LARGE";
  err.maxResponseBytes = maxBytes;
  return err;
}

export async function readResponseTextWithLimit(response, {
  maxBytes = POSSE_REMOTE_MAX_RESPONSE_BYTES,
  operation = "remote request",
  url = "remote endpoint",
} = {}) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : POSSE_REMOTE_MAX_RESPONSE_BYTES;

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value ?? ""));
        total += chunk.byteLength;
        if (total > limit) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw responseTooLargeError({ operation, url, maxBytes: limit });
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  const text = await response.text();
  if (Buffer.byteLength(String(text || ""), "utf8") > limit) {
    throw responseTooLargeError({ operation, url, maxBytes: limit });
  }
  return text;
}

function isRetryableRemoteRequestError(err) {
  if (!err) return false;
  if (err.code === "POSSE_REMOTE_TIMEOUT" || err.code === "POSSE_REMOTE_FETCH_FAILED") return true;
  const status = Number(err.status);
  return Number.isFinite(status) && status >= 500 && status < 600;
}

/**
 * Resolve the canonical Posse key (POSSE_KEY) used by remote prompt/catalog
 * calls and native method binaries. Reads the process env first, then the
 * Windows-persisted user/machine env.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolvePosseKey(env = process.env) {
  const processValue = String(env?.POSSE_KEY || "").trim();
  if (processValue) return processValue;
  if (env !== process.env) return "";
  return readWindowsPersistedEnv("POSSE_KEY");
}

export function assertSafeRemoteAuthUrl(baseUrl, apiKey, operation = "remote request") {
  if (!apiKey) return;
  let url;
  try {
    url = new URL(String(baseUrl || ""));
  } catch {
    const err = new Error(`${operation} requires an absolute HTTPS URL when authorization is configured`);
    err.code = "POSSE_REMOTE_INVALID_URL";
    throw err;
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackRemoteHostname(url.hostname)) return;
  const err = new Error(`${operation} refuses to send authorization over ${url.protocol || "an insecure URL"} for ${url.origin}`);
  err.code = "POSSE_REMOTE_INSECURE_AUTH";
  throw err;
}

function isLoopbackRemoteHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

function readWindowsPersistedEnv(name) {
  if (process.platform !== "win32") return "";
  try {
    const script = [
      `$name = ${JSON.stringify(name)}`,
      "$user = [Environment]::GetEnvironmentVariable($name, 'User')",
      "if ($user) { $user; exit 0 }",
      "$machine = [Environment]::GetEnvironmentVariable($name, 'Machine')",
      "if ($machine) { $machine; exit 0 }",
    ].join("; ");
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
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
