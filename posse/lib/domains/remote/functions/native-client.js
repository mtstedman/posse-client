// @ts-check

import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";

export const REMOTE_NATIVE_PROTOCOL = "posse.remote.native.v1";
// Pulse route grant for the posse-remote server-proxy family. Distinct from
// the atlas/git grants: a remote pulse never authorizes atlas or git work and
// vice versa.
export const REMOTE_NATIVE_ROUTE = "remote:methods";

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
  const res = await manager.binary("remote").run(
    "request-json",
    [],
    {
      input: `${JSON.stringify(envelope)}\n`,
      json: true,
      timeoutMs: request.timeoutMs,
      requiredRoute: REMOTE_NATIVE_ROUTE,
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`remote native request ${request.method || "GET"} ${request.path} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapRemoteNativeResponse(res.json);
}
