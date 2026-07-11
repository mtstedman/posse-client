// @ts-check

import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";

export const REMOTE_NATIVE_PROTOCOL = "posse.remote.native.v1";
export const REMOTE_PROMPTS_COMPILE_ROUTE = "prompts:compile";
export const REMOTE_PROMPTS_BUNDLE_ROUTE = "prompts:bundle";
export const REMOTE_CATALOG_READ_ROUTE = "catalog:read";

/**
 * Select the same endpoint-specific pulse grant enforced by posse-remote.
 * The child forwards this pulse as the API bearer after verifying it offline,
 * so an umbrella native-process grant cannot authorize the HTTP request.
 *
 * @param {{ method?: string, path: string }} request
 * @returns {string}
 */
export function remoteNativeRequestRoute(request) {
  const method = String(request?.method || "GET").trim().toUpperCase();
  const requestPath = String(request?.path || "").trim();
  if (method === "POST" && requestPath === "/v1/prompts/compile") return REMOTE_PROMPTS_COMPILE_ROUTE;
  if (method === "GET" && requestPath === "/v1/prompts/bundle") return REMOTE_PROMPTS_BUNDLE_ROUTE;
  if (
    (method === "GET" && [
      "/v1/catalog/tool-suites",
      "/v1/catalog/tools",
      "/v1/catalog/models",
    ].includes(requestPath))
    || (method === "POST" && requestPath === "/v1/catalog/tool-surface")
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
    throw new Error(String(err?.message || obj.message || "remote native request failed"));
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
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
  if (!manager.shouldUse("remote")) {
    throw new Error("remote native client unavailable");
  }
  if (manager.nativeAuthManager?.hasLaunchKey?.() !== true) {
    throw new Error("remote native client requires a Posse key");
  }
  // NativeBinary owns request.pulse at the final stdin boundary: it strips any
  // caller-supplied credential/trust fields and attaches a route-scoped pulse
  // envelope. The raw key never enters the child; the resource payload accepts
  // no caller auth override.
  const envelope = buildRemoteNativeRequest("request-json", request);
  const requiredRoute = remoteNativeRequestRoute(request);
  const res = await manager.binary("remote").run(
    "request-json",
    [],
    {
      input: `${JSON.stringify(envelope)}\n`,
      json: true,
      timeoutMs: request.timeoutMs,
      requiredRoute,
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`remote native request ${request.method || "GET"} ${request.path} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapRemoteNativeResponse(res.json);
}
