// @ts-check
//
// Strict ATLAS native method boundary.
//
// This is intentionally not a fallback wrapper. A migrated ATLAS function calls
// one Rust method through this module; if the binary is unavailable or returns
// an invalid response, the call fails. During migration, Node implementations
// are used only as explicit parity oracles outside this boundary.

import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";
import { hasNativeThreadBridge, nativeThreadBridgeRequest } from "../../../../../shared/tools/classes/daemon/native-thread-bridge.js";

export const ATLAS_NATIVE_PROTOCOL = "posse.atlas.native.v1";
export const ATLAS_EXECUTE_TOOL_CONTRACT_VERSION = 1;

/** @type {NativeMethodRunOptions | null} */
let atlasNativeOptionsForTests = null;

/** Narrow process-local test hook for an injected real debug binary. */
export function __setAtlasNativeOptionsForTests(opts) {
  atlasNativeOptionsForTests = opts && typeof opts === "object" ? opts : null;
}

export function __atlasNativeManagerForTests() {
  return atlasNativeOptionsForTests?.manager || null;
}

function effectiveRunOptions(opts) {
  return atlasNativeOptionsForTests ? { ...atlasNativeOptionsForTests, ...opts } : opts;
}

/**
 * Resolve the heartbeat auth envelope for a native request. An explicit
 * `opts.auth` always wins; otherwise the envelope comes from the manager's
 * single auth authority (cached, resolved once per runtime). Stub managers that
 * want auth in tests should expose nativeAuthEnvelope(); this leaf must not
 * silently re-read settings/env.
 *
 * @param {NativeMethodRunOptions} opts
 * @param {import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager} manager
 * @returns {Record<string, unknown> | null}
 */
function resolveAtlasAuthEnvelope(opts, manager) {
  if (opts.auth && typeof opts.auth === "object") return opts.auth;
  if (manager && typeof manager.nativeAuthEnvelope === "function") {
    return manager.nativeAuthEnvelope();
  }
  return null;
}

/**
 * @typedef {Object} NativeMethodRunOptions
 * @property {import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager} [manager]
 * @property {number} [timeoutMs]
 * @property {boolean} [disabled]
 * @property {Record<string, unknown>} [auth]
 * @property {Record<string, unknown>} [heartbeat]
 * @property {boolean} [bypassNativeBridge]
 * @property {boolean} [worker]
 * @property {boolean} [workerFallback]
 * @property {boolean} [idempotent]
 * @property {boolean} [allowOneShotSync]
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
 * Invoke one Rust-owned ATLAS method through a SYNCHRONOUS one-shot process
 * spawn. Retired from production: every production ATLAS operation routes
 * through the persistent worker via {@link runAtlasNativeMethodAsync}. Only
 * explicit opt-in callers (parity oracles, tests that exercise the one-shot
 * transport itself) may pass `allowOneShotSync: true`.
 *
 * Throws on missing opt-in, disabled/unavailable binary, non-zero exit,
 * invalid JSON, or a structured `{ ok: false }` response.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {NativeMethodRunOptions} [opts]
 * @returns {unknown}
 */
export function runAtlasNativeMethod(method, payload, opts = {}) {
  opts = effectiveRunOptions(opts);
  if (opts.allowOneShotSync !== true) {
    throw new Error(
      `ATLAS sync one-shot invocation of '${method}' is retired: use runAtlasNativeMethodAsync `
      + "(persistent worker), or pass allowOneShotSync: true from parity/test harnesses only",
    );
  }
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("atlas")) {
    throw new Error(`ATLAS native method unavailable: ${method}`);
  }
  const request = buildAtlasNativeMethodRequest(method, payload);
  const auth = resolveAtlasAuthEnvelope(opts, manager);
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
      worker: false,
    },
  );
  if (!res.ok) {
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`ATLAS native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapAtlasNativeMethodResponse(res.json);
}

/**
 * The production ATLAS invocation path: routes through the persistent
 * `posse-atlas worker --stdio` daemon. Worker degradation to a per-call
 * spawn is DISABLED here — a dead worker restarts (the daemon respawns its
 * transport and the request retries once on the replacement host) or the
 * call fails with POSSE_NATIVE_WORKER_UNAVAILABLE; it never silently forks a
 * one-shot process. Non-idempotent operations (ledger writes) must pass
 * `idempotent: false` so a host lost mid-request reports instead of
 * transparently retrying a write that may have committed.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {NativeMethodRunOptions & { signal?: AbortSignal }} [opts]
 * @returns {Promise<unknown>}
 */
export async function runAtlasNativeMethodAsync(method, payload, opts = {}) {
  opts = effectiveRunOptions(opts);
  if (opts.bypassNativeBridge !== true && hasNativeThreadBridge()) {
    const { bypassNativeBridge, manager, signal, ...bridgeOpts } = opts;
    // The bridge exists so worker threads share the PARENT process's native
    // manager and auth authority. Do not resolve or forward the worker
    // thread's manager envelope here: it can be stale/different and an
    // explicit `auth` would then override the parent manager at the final
    // native boundary. The parent attaches its own pulse before dispatch.
    delete /** @type {Record<string, unknown>} */ (bridgeOpts).auth;
    return nativeThreadBridgeRequest("atlas", method, payload, bridgeOpts, { signal, timeoutMs: opts.timeoutMs });
  }
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("atlas")) {
    throw new Error(`ATLAS native method unavailable: ${method}`);
  }
  const request = buildAtlasNativeMethodRequest(method, payload);
  const auth = resolveAtlasAuthEnvelope(opts, manager);
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
      signal: opts.signal,
      worker: opts.worker !== false,
      workerFallback: opts.workerFallback === true,
      idempotent: opts.idempotent !== false,
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
