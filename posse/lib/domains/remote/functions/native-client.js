// @ts-check

import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";

export const REMOTE_NATIVE_PROTOCOL = "posse.remote.native.v1";
export const REMOTE_PROMPTS_COMPILE_ROUTE = "prompts:compile";
export const REMOTE_PROMPTS_BUNDLE_ROUTE = "prompts:bundle";
export const REMOTE_CATALOG_READ_ROUTE = "catalog:read";
export const REMOTE_ARTIFACTS_READ_ROUTE = "artifacts:read";

export const REMOTE_ARTIFACT_CATALOG_METHOD = "remote.artifactCatalog";
export const REMOTE_ARTIFACT_DOWNLOAD_METHOD = "remote.artifactDownload";
export const REMOTE_ARTIFACT_STATUS_METHOD = "remote.artifactStatus";
export const REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD = "remote.modelPackageDownload";

const REMOTE_ARTIFACT_METHODS = new Set([
  REMOTE_ARTIFACT_CATALOG_METHOD,
  REMOTE_ARTIFACT_DOWNLOAD_METHOD,
  REMOTE_ARTIFACT_STATUS_METHOD,
  REMOTE_MODEL_PACKAGE_DOWNLOAD_METHOD,
]);

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
    throw new Error(String(err?.message || obj.message || "remote native request failed"));
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
}

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
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`remote native method ${method} failed${detail ? `: ${detail}` : ""}`);
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
      timeoutMs: request.timeoutMs,
      requiredRoute,
    });
  } catch (error) {
    const message = String(error?.message || error || "native process failed")
      .replace(/^remote native method request-json failed:?\s*/i, "")
      .trim();
    throw new Error(`remote native request ${request.method || "GET"} ${request.path} failed${message ? `: ${message}` : ""}`);
  }
}
