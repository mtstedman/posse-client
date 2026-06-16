// @ts-check

import { nativeBinaries } from "../../../classes/tools/BinaryManager.js";
import { nativeHeartbeatAuthFromSettings } from "../../../shared/native/functions/auth.js";

export const REMOTE_NATIVE_PROTOCOL = "posse.remote.native.v1";

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
 *   manager?: import("../../../classes/tools/BinaryManager.js").BinaryManager,
 *   apiKey?: string,
 *   auth?: Record<string, unknown> | null,
 * }} [opts]
 * @returns {Promise<unknown>}
 */
export async function runRemoteNativeRequestJson(request, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("remote")) {
    throw new Error("remote native client unavailable");
  }
  const apiKey = String(opts.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("remote native client requires a Posse key");
  }
  const envelope = buildRemoteNativeRequest("request-json", request);
  // Heartbeat envelope from the manager's single auth authority (cached) when
  // available; an explicit caller `auth` wins, and settings is only a defensive
  // fallback for stub managers.
  const auth = (opts.auth && typeof opts.auth === "object")
    ? opts.auth
    : (typeof manager.nativeAuthEnvelope === "function"
      ? manager.nativeAuthEnvelope()
      : nativeHeartbeatAuthFromSettings());
  if (auth && typeof auth === "object") {
    /** @type {Record<string, unknown>} */ (envelope).auth = auth;
  }
  const res = await manager.binary("remote").run(
    "request-json",
    [],
    {
      input: `${JSON.stringify(envelope)}\n`,
      json: true,
      timeoutMs: request.timeoutMs,
      key: apiKey,
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`remote native request ${request.method || "GET"} ${request.path} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapRemoteNativeResponse(res.json);
}
