// @ts-check
//
// Strict posse-ml native method boundary. ML owns model loading,
// tokenization, pooling, normalization, and ONNX execution; callers provide
// only a canonical model ID, input kind, and text batch.

import path from "node:path";

import {
  ML_MODEL_PACKAGE_INSTALL_METHOD,
  ML_NATIVE_PROTOCOL,
  ML_NATIVE_ROUTE,
} from "../../../catalog/binary.js";
import { nativeBinaries } from "../../tools/classes/BinaryManager.js";

/**
 * @typedef {Object} MlNativeMethodRunOptions
 * @property {string} modelRoot Absolute directory containing canonical model-ID subdirectories.
 * @property {import("../../tools/classes/BinaryManager.js").BinaryManager} [manager]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {boolean} [idempotent]
 * @property {(event: Record<string, unknown>) => void} [onProgress]
 */

/**
 * @param {string} method
 * @param {unknown} payload
 */
export function buildMlNativeMethodRequest(method, payload) {
  const name = String(method || "").trim();
  if (!name) throw new TypeError("ML native method name is required");
  return {
    protocol: ML_NATIVE_PROTOCOL,
    method: name,
    payload: payload ?? null,
  };
}

/**
 * @param {string} method
 * @param {unknown} payload
 * @param {MlNativeMethodRunOptions} opts
 * @returns {Promise<unknown>}
 */
export async function runMlNativeMethodAsync(method, payload, opts) {
  const modelRoot = path.resolve(String(opts?.modelRoot || ""));
  if (!opts?.modelRoot || !path.isAbsolute(String(opts.modelRoot))) {
    throw new TypeError("ML native method requires an absolute modelRoot");
  }
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("ml")) {
    const error = new Error(`ML native method unavailable: ${method}`);
    /** @type {any} */ (error).code = "ML_NATIVE_UNAVAILABLE";
    throw error;
  }

  const request = buildMlNativeMethodRequest(method, payload);
  const modelArgs = ["--model-root", modelRoot];
  const useWorker = request.method !== ML_MODEL_PACKAGE_INSTALL_METHOD;
  const runOptions = {
    input: `${JSON.stringify(request)}\n`,
    json: true,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    worker: useWorker,
    ...(useWorker ? { workerArgs: ["worker", "--stdio", ...modelArgs] } : {}),
    workerFallback: true,
    idempotent: opts.idempotent !== false,
    onProgress: opts.onProgress,
    requiredRoute: ML_NATIVE_ROUTE,
  };
  const res = await manager.binary("ml").run(
    request.method,
    modelArgs,
    runOptions,
  );
  if (!res.ok) {
    if (res.error?.name === "AbortError") throw res.error;
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    const error = new Error(`ML native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
    /** @type {any} */ (error).code = "ML_NATIVE_METHOD_FAILED";
    throw error;
  }
  return unwrapMlNativeMethodResponse(res.json);
}

function unwrapMlNativeMethodResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (obj.ok === false) {
    const nativeError = obj.error && typeof obj.error === "object"
      ? /** @type {Record<string, unknown>} */ (obj.error)
      : null;
    const error = new Error(String(nativeError?.message || obj.message || "ML native method failed"));
    /** @type {any} */ (error).code = String(nativeError?.code || "ML_NATIVE_METHOD_FAILED");
    throw error;
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
}
