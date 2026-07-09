// @ts-check
//
// ATLAS native verification helpers. Node values are accepted only as migration
// oracles; when the Rust method is enabled and matches, the Rust value is the
// live return path.

import { isDeepStrictEqual } from "node:util";

import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";
import { runAtlasNativeMethod, runAtlasNativeOperation } from "./invoke.js";

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeAtlasResultForNativeParity(value) {
  if (typeof value === "undefined") return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {import("./invoke.js").NativeMethodRunOptions} [opts]
 * @returns {boolean}
 */
export function shouldRunAtlasNativeParity(opts = {}) {
  if (opts.disabled === true) return false;
  const manager = opts.manager || nativeBinaries;
  try {
    return manager.shouldUse("atlas") === true;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   method: string,
 *   payload: unknown,
 *   nodeResult: unknown,
 *   manager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 *   timeoutMs?: number,
 *   key?: string,
 *   auth?: Record<string, unknown>,
 *   heartbeat?: Record<string, unknown>,
 *   normalizeNodeResult?: (value: unknown) => unknown,
 *   normalizeNativeResult?: (value: unknown) => unknown,
 *   mapNativeReturn?: (value: unknown) => unknown,
 * }} args
 * @returns {{ ok: true, node: unknown, native: unknown } | { ok: false, node: unknown, native: unknown, message: string }}
 */
export function diffAtlasNativeParity(args) {
  const nativeResult = runAtlasNativeMethod(args.method, args.payload, args);
  const node = normalizeAtlasResultForNativeParity(
    typeof args.normalizeNodeResult === "function"
      ? args.normalizeNodeResult(args.nodeResult)
      : args.nodeResult,
  );
  const native = normalizeAtlasResultForNativeParity(
    typeof args.normalizeNativeResult === "function"
      ? args.normalizeNativeResult(nativeResult)
      : nativeResult,
  );
  if (isDeepStrictEqual(native, node)) return { ok: true, node, native };
  return {
    ok: false,
    node,
    native,
    message: `ATLAS native method ${args.method} output does not match Node output`,
  };
}

/**
 * @param {{
 *   operation: Record<string, unknown>,
 *   nodeResult: unknown,
 *   manager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 *   timeoutMs?: number,
 *   key?: string,
 *   auth?: Record<string, unknown>,
 *   heartbeat?: Record<string, unknown>,
 *   normalizeNodeResult?: (value: unknown) => unknown,
 *   normalizeNativeResult?: (value: unknown) => unknown,
 *   mapNativeReturn?: (value: unknown) => unknown,
 * }} args
 * @returns {{ ok: true, node: unknown, native: unknown } | { ok: false, node: unknown, native: unknown, message: string }}
 */
export function diffAtlasNativeOperationParity(args) {
  return diffAtlasNativeParity({
    ...args,
    method: "op",
    payload: args.operation,
  });
}

/**
 * @template T
 * @param {string} method
 * @param {unknown} payload
 * @param {T} nodeResult
 * @param {import("./invoke.js").NativeMethodRunOptions} [opts]
 * @returns {T}
 */
export function assertAtlasNativeParity(method, payload, nodeResult, opts = {}) {
  if (!shouldRunAtlasNativeParity(opts)) return nodeResult;
  const parity = diffAtlasNativeParity({ method, payload, nodeResult, ...opts });
  if (parity.ok === false) {
    const err = /** @type {Error & { node?: unknown, native?: unknown }} */ (new Error(parity.message));
    err.node = parity.node;
    err.native = parity.native;
    throw err;
  }
  return /** @type {T} */ (
    typeof opts.mapNativeReturn === "function"
      ? opts.mapNativeReturn(parity.native)
      : parity.native
  );
}

/**
 * @template T
 * @param {Record<string, unknown>} operation
 * @param {T} nodeResult
 * @param {import("./invoke.js").NativeMethodRunOptions} [opts]
 * @returns {T}
 */
export function assertAtlasNativeOperationParity(operation, nodeResult, opts = {}) {
  if (!shouldRunAtlasNativeParity(opts)) return nodeResult;
  const nativeResult = runAtlasNativeOperation(operation, opts);
  const node = normalizeAtlasResultForNativeParity(
    typeof opts.normalizeNodeResult === "function"
      ? opts.normalizeNodeResult(nodeResult)
      : nodeResult,
  );
  const native = normalizeAtlasResultForNativeParity(
    typeof opts.normalizeNativeResult === "function"
      ? opts.normalizeNativeResult(nativeResult)
      : nativeResult,
  );
  if (isDeepStrictEqual(native, node)) {
    return /** @type {T} */ (
      typeof opts.mapNativeReturn === "function"
        ? opts.mapNativeReturn(native)
        : native
    );
  }
  const err = /** @type {Error & { node?: unknown, native?: unknown }} */ (
    new Error("ATLAS native operation output does not match Node output")
  );
  err.node = node;
  err.native = native;
  throw err;
}
