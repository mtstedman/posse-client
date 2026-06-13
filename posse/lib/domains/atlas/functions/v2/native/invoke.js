// @ts-check
//
// Strict ATLAS native method boundary.
//
// This is intentionally not a fallback wrapper. A migrated ATLAS function calls
// one Rust method through this module; if the binary is unavailable or returns
// an invalid response, the call fails. During migration, Node implementations
// are used only as explicit parity oracles outside this boundary.

import { nativeBinaries } from "../../../../../classes/tools/BinaryManager.js";
import { nativeAuthFromSettings } from "../../../../remote/functions/native-auth.js";

export const ATLAS_NATIVE_PROTOCOL = "posse.atlas.native.v1";

/**
 * @typedef {Object} NativeMethodRunOptions
 * @property {import("../../../../../classes/tools/BinaryManager.js").BinaryManager} [manager]
 * @property {number} [timeoutMs]
 * @property {string} [key]
 * @property {boolean} [disabled]
 * @property {Record<string, unknown>} [auth]
 * @property {Record<string, unknown>} [heartbeat]
 * @property {(value: unknown) => unknown} [normalizeNodeResult]
 * @property {(value: unknown) => unknown} [normalizeNativeResult]
 * @property {(value: unknown) => unknown} [mapNativeReturn]
 */

/**
 * @param {string} method
 * @param {unknown} payload
 * @returns {{ protocol: string, method: string, payload: unknown }}
 */
export function buildAtlasNativeMethodRequest(method, payload) {
  const name = String(method || "").trim();
  if (!name) throw new TypeError("ATLAS native method name is required");
  return {
    protocol: ATLAS_NATIVE_PROTOCOL,
    method: name,
    payload: payload ?? null,
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function unwrapAtlasNativeMethodResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (obj.ok === false) {
    const err = obj.error && typeof obj.error === "object"
      ? /** @type {Record<string, unknown>} */ (obj.error)
      : null;
    const message = String(err?.message || obj.message || "ATLAS native method failed");
    throw new Error(message);
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
}

/**
 * Invoke one Rust-owned ATLAS method. Throws on disabled/unavailable binary,
 * non-zero exit, invalid JSON, or a structured `{ ok: false }` response.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {NativeMethodRunOptions} [opts]
 * @returns {unknown}
 */
export function runAtlasNativeMethod(method, payload, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("atlas")) {
    throw new Error(`ATLAS native method unavailable: ${method}`);
  }
  const request = buildAtlasNativeMethodRequest(method, payload);
  const auth = opts.auth && typeof opts.auth === "object"
    ? opts.auth
    : nativeAuthFromSettings();
  if (auth && typeof auth === "object") {
    /** @type {Record<string, unknown>} */ (request).auth = auth;
  }
  if (opts.heartbeat && typeof opts.heartbeat === "object") {
    /** @type {Record<string, unknown>} */ (request).heartbeat = opts.heartbeat;
  }
  const res = manager.binary("atlas").runSync(
    request.method,
    [],
    {
      input: `${JSON.stringify(request)}\n`,
      json: true,
      timeoutMs: opts.timeoutMs,
      key: opts.key,
      // Sync calls are per-call spawns now (the sync bridge was removed) —
      // runSync accepts and ignores `worker`. Keep call volume O(1) per
      // action (batch lines, memoize tokenize) or prefer the async variant,
      // which does route through the persistent Atlas-Helper daemon.
      worker: true,
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`ATLAS native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapAtlasNativeMethodResponse(res.json);
}

/**
 * Async variant of {@link runAtlasNativeMethod}. Routes through the persistent
 * Atlas-Helper daemon (async, off the main loop) — the preferred path for the
 * off-thread callers (e.g. the conductor and ingest pipelines).
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {NativeMethodRunOptions & { signal?: AbortSignal }} [opts]
 * @returns {Promise<unknown>}
 */
export async function runAtlasNativeMethodAsync(method, payload, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("atlas")) {
    throw new Error(`ATLAS native method unavailable: ${method}`);
  }
  const request = buildAtlasNativeMethodRequest(method, payload);
  const auth = opts.auth && typeof opts.auth === "object"
    ? opts.auth
    : nativeAuthFromSettings();
  if (auth && typeof auth === "object") {
    /** @type {Record<string, unknown>} */ (request).auth = auth;
  }
  if (opts.heartbeat && typeof opts.heartbeat === "object") {
    /** @type {Record<string, unknown>} */ (request).heartbeat = opts.heartbeat;
  }
  const res = await manager.binary("atlas").run(
    request.method,
    [],
    {
      input: `${JSON.stringify(request)}\n`,
      json: true,
      timeoutMs: opts.timeoutMs,
      key: opts.key,
      signal: opts.signal,
      worker: true,
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`ATLAS native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapAtlasNativeMethodResponse(res.json);
}

/**
 * Invoke one Rust-owned AtlasService `Operation` through the generic `op`
 * command. This is the preferred A/B path for deterministic helpers because it
 * exercises the same service enum the binary will keep after Node deletion.
 *
 * @param {Record<string, unknown>} operation
 * @param {NativeMethodRunOptions} [opts]
 * @returns {unknown}
 */
export function runAtlasNativeOperation(operation, opts = {}) {
  return runAtlasNativeMethod("op", operation, opts);
}

/**
 * Async variant of {@link runAtlasNativeOperation} — the generic `op` method
 * through the Atlas-Helper daemon off the main loop.
 *
 * @param {Record<string, unknown>} operation
 * @param {NativeMethodRunOptions & { signal?: AbortSignal }} [opts]
 * @returns {Promise<unknown>}
 */
export function runAtlasNativeOperationAsync(operation, opts = {}) {
  return runAtlasNativeMethodAsync("op", operation, opts);
}
