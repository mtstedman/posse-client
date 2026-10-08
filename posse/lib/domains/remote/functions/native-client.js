// @ts-check

import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import {
  REMOTE_ARTIFACT_CATALOG_METHOD,
  REMOTE_ARTIFACT_DOWNLOAD_METHOD,
  REMOTE_ARTIFACT_STATUS_METHOD,
  REMOTE_ARTIFACTS_READ_ROUTE,
  REMOTE_CATALOG_READ_ROUTE,
  REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD,
  REMOTE_NATIVE_PROTOCOL,
  REMOTE_PROMPTS_BUNDLE_ROUTE,
  REMOTE_PROMPTS_COMPILE_ROUTE,
} from "../../../catalog/binary.js";

export {
  REMOTE_ARTIFACT_CATALOG_METHOD,
  REMOTE_ARTIFACT_DOWNLOAD_METHOD,
  REMOTE_ARTIFACT_STATUS_METHOD,
  REMOTE_ARTIFACTS_READ_ROUTE,
  REMOTE_CATALOG_READ_ROUTE,
  REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD,
  REMOTE_NATIVE_PROTOCOL,
  REMOTE_PROMPTS_BUNDLE_ROUTE,
  REMOTE_PROMPTS_COMPILE_ROUTE,
} from "../../../catalog/binary.js";

const REMOTE_ARTIFACT_METHODS = new Set([
  REMOTE_ARTIFACT_CATALOG_METHOD,
  REMOTE_ARTIFACT_DOWNLOAD_METHOD,
  REMOTE_ARTIFACT_STATUS_METHOD,
  REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD,
]);

const INVALID_POSSE_KEY_RE = /\binvalid posse_key\b/iu;
const NATIVE_REQUEST_STARTUP_GRACE_MS = 10_000;

// timeoutMs is the HTTP budget for each attempt. The child process must be
// allowed to finish all authorized attempts plus its own startup/exit work.
/** @param {{ timeoutMs?: number, maxRetries?: number, retryDelayMs?: number }} options */
function nativeRequestProcessBudgetMs({ timeoutMs, maxRetries, retryDelayMs }) {
  const perAttempt = Number(timeoutMs);
  if (!Number.isFinite(perAttempt) || perAttempt <= 0) return undefined;
  const retries = Number.isInteger(maxRetries) ? Math.max(0, Number(maxRetries)) : 0;
  const delay = Number.isFinite(Number(retryDelayMs)) ? Math.max(0, Number(retryDelayMs)) : 0;
  return Math.min(2_147_483_647, Math.ceil(perAttempt * (retries + 1) + delay * retries + NATIVE_REQUEST_STARTUP_GRACE_MS));
}

/** @param {unknown} value */
function nativeHeartbeatFailureDetail(value) {
  const message = String(value || "").trim();
  if (!INVALID_POSSE_KEY_RE.test(message)) return message;
  return `${message} (native heartbeat validation can also fail when the system clock differs from the server by more than 30 seconds; sync the system clock and retry)`;
}

/**
 * Select the same endpoint-specific pulse grant enforced by posse-remote.
 * The child forwards this pulse as the API bearer after verifying it offline,
 * so an umbrella native-process grant cannot authorize the HTTP request.
 *
 * @param {{ method?: string, path: string, body?: any }} request
 * @returns {string}
 */
export function remoteNativeRequestRoute(request) {
  const method = String(request?.method || "GET").trim().toUpperCase();
  const requestPath = String(request?.path || "").trim();
  if (method === "POST" && requestPath === "/v1/prompts/compile") return REMOTE_PROMPTS_COMPILE_ROUTE;
  if (method === "GET" && requestPath === "/v1/prompts/bundle") return REMOTE_PROMPTS_BUNDLE_ROUTE;
  if (method === "POST" && requestPath === "/v1/catalog/tool-surface") {
    return request?.body?.mcp_oauth?.requested === true
      ? REMOTE_PROMPTS_COMPILE_ROUTE
      : REMOTE_CATALOG_READ_ROUTE;
  }
  if (
    (method === "GET" && [
      "/v1/catalog/tool-suites",
      "/v1/catalog/tools",
      "/v1/catalog/models",
    ].includes(requestPath))
  ) return REMOTE_CATALOG_READ_ROUTE;
  throw new Error(`remote native client refuses unsupported route: ${method} ${requestPath}`);
}

/**
 * @param {string} method
 * @param {unknown} payload
 * @returns {{ protocol: string, method: string, payload: unknown }}
 */
export function buildRemoteNativeRequest(method, payload) {
  const name = String(method || "").trim();
  if (!name) throw new TypeError("remote native method name is required");
  return {
    protocol: REMOTE_NATIVE_PROTOCOL,
    method: name,
    payload: payload ?? null,
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function unwrapRemoteNativeResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (obj.ok === false) {
    const err = obj.error && typeof obj.error === "object"
      ? /** @type {Record<string, unknown>} */ (obj.error)
      : null;
    /** @type {Error & { code?: string | number, status?: number }} */
    const failure = new Error(String(err?.message || obj.message || "remote native request failed"));
    if (typeof err?.code === "string" || typeof err?.code === "number") failure.code = err.code;
    if (Number.isInteger(err?.status)) failure.status = Number(err.status);
    throw failure;
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
}

/**
 * @param {string} method
 * @param {unknown} payload
 * @param {{
 *   manager?: import("../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 *   requiredRoute?: string,
 *   timeoutMs?: number,
 * }} [options]
 */
async function runRemoteNativeMethodJson(method, payload, {
  manager = nativeBinaries,
  requiredRoute,
  timeoutMs,
} = {}) {
  if (!manager.shouldUse("remote")) {
    throw new Error("remote native client unavailable");
  }
  if (manager.nativeAuthManager?.hasLaunchKey?.() !== true) {
    throw new Error("remote native client requires a Posse key");
  }
  const envelope = buildRemoteNativeRequest(method, payload);
  const res = await manager.binary("remote").run(
    method,
    [],
    {
      input: `${JSON.stringify(envelope)}\n`,
      json: true,
      timeoutMs,
      requiredRoute,
      ...(method === "request-json" ? { workerFallback: false } : {}),
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    /** @type {Error & { code?: string | number }} */
    const failure = new Error(`remote native method ${method} failed${detail ? `: ${detail}` : ""}`, { cause: res.error });
    const nativeCode = /** @type {{ code?: string | number } | null} */ (res.error)?.code;
    if (nativeCode === "POSSE_NATIVE_WORKER_UNAVAILABLE"
      && /** @type {{ details?: { reason?: string } } | null} */ (res.error)?.details?.reason === "timeout") {
      failure.code = "POSSE_REMOTE_TIMEOUT";
    } else if (nativeCode != null) failure.code = nativeCode;
    else if (/timed out after \d+ms/.test(detail)) failure.code = "POSSE_REMOTE_TIMEOUT";
    throw failure;
  }
  return unwrapRemoteNativeResponse(res.json);
}

/**
 * Invoke an artifact method through the key-gated native Remote client. The
 * native binary owns trust verification, transfer bounds, resumable download
 * state, and the final cache path.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {{ manager?: import("../../../shared/tools/classes/BinaryManager.js").BinaryManager, timeoutMs?: number }} [opts]
 * @returns {Promise<unknown>}
 */
export function runRemoteNativeArtifactJson(method, payload, opts = {}) {
  const normalized = String(method || "").trim();
  if (!REMOTE_ARTIFACT_METHODS.has(normalized)) {
    throw new Error(`remote native artifact method is unsupported: ${normalized || "<empty>"}`);
  }
  return runRemoteNativeMethodJson(normalized, payload, {
    ...opts,
    requiredRoute: REMOTE_ARTIFACTS_READ_ROUTE,
  });
}

/**
 * @param {{
 *   baseUrl: string,
 *   path: string,
 *   method?: string,
 *   body?: unknown,
 *   operation?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   retryDelayMs?: number,
 *   maxResponseBytes?: number,
 * }} request
 * @param {{
 *   manager?: import("../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 * }} [opts]
 * @returns {Promise<unknown>}
 */
export async function runRemoteNativeRequestJson(request, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  // NativeBinary owns request.pulse at the final stdin boundary: it strips any
  // caller-supplied credential/trust fields and attaches a route-scoped pulse
  // envelope. The raw key never enters the child; the resource payload accepts
  // no caller auth override.
  const requiredRoute = remoteNativeRequestRoute(request);
  try {
    return await runRemoteNativeMethodJson("request-json", request, {
      manager,
      timeoutMs: nativeRequestProcessBudgetMs(request),
      requiredRoute,
    });
  } catch (error) {
    const message = nativeHeartbeatFailureDetail(
      String(error?.message || error || "native process failed")
        .replace(/^remote native method request-json failed:?\s*/i, "")
        .trim(),
    );
    /** @type {Error & { code?: string | number, status?: number }} */
    const wrapped = new Error(`remote native request ${request.method || "GET"} ${request.path} failed${message ? `: ${message}` : ""}`, { cause: error });
    if (error?.code != null) wrapped.code = error.code;
    if (error?.status != null) wrapped.status = error.status;
    throw wrapped;
  }
}
