// @ts-check
//
// Capability-gated boundary for the shared-trunk native contract. Every
// mutation is preceded by the harmless read-only capability method. An older
// binary therefore disables the feature before any mutating method is probed;
// authorization, cancellation, transport, and Git failures still propagate.

import {
  SHARED_TRUNK_NATIVE_CONTRACT_VERSION,
  SHARED_TRUNK_NATIVE_METHODS,
} from "../../../catalog/shared-trunk.js";
import { runGitNativeMethodAsync } from "./native/invoke.js";

const REQUIRED_METHODS = new Set(Object.values(SHARED_TRUNK_NATIVE_METHODS));

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSharedTrunkNativeCapabilityUnavailable(error) {
  const value = /** @type {{ code?: unknown, message?: unknown, stderr?: unknown, cause?: { message?: unknown } }} */ (error || {});
  if (value.code === "GIT_NATIVE_UNAVAILABLE") return true;
  const detail = [value.message, value.stderr, value.cause?.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
  return /unknown git method:\s*git\.capabilities\b/iu.test(detail);
}

/** @returns {{available: false, result: null, reason: "native_capability_unavailable"}} */
function unavailable() {
  return {
    available: false,
    result: null,
    reason: "native_capability_unavailable",
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isContractV1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = /** @type {Record<string, unknown>} */ (value);
  if (result.schemaVersion !== 1) return false;
  if (result.sharedTrunkContractVersion !== SHARED_TRUNK_NATIVE_CONTRACT_VERSION) return false;
  if (!Array.isArray(result.methods) || !result.methods.every((method) => typeof method === "string")) {
    return false;
  }
  const methods = new Set(result.methods);
  return [...REQUIRED_METHODS].every((method) => methods.has(method));
}

/**
 * Read-only feature detection for the complete shared-trunk v1 contract.
 *
 * @param {string} projectDir
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{available: true, result: any} | {available: false, result: null, reason: "native_capability_unavailable"}>}
 */
export async function getSharedTrunkNativeCapabilities(projectDir, options = {}) {
  const cwd = String(projectDir || "").trim();
  if (!cwd) throw new TypeError("projectDir is required for shared-trunk native capabilities");
  try {
    const result = await runGitNativeMethodAsync(
      SHARED_TRUNK_NATIVE_METHODS.CAPABILITIES,
      { cwd },
      options,
    );
    if (!isContractV1(result)) return unavailable();
    return { available: true, result };
  } catch (error) {
    if (!isSharedTrunkNativeCapabilityUnavailable(error)) throw error;
    return unavailable();
  }
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} args
 * @param {Record<string, unknown>} options
 */
async function invokeSharedTrunkMutation(method, args, options) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError(`${method} args must be an object`);
  }
  const cwd = String(args.cwd || "").trim();
  if (!cwd) throw new TypeError(`${method} args.cwd is required`);
  const capabilities = await getSharedTrunkNativeCapabilities(cwd, options);
  if (!capabilities.available) return capabilities;
  return {
    available: true,
    result: await runGitNativeMethodAsync(method, args, options),
  };
}

/** @param {Record<string, unknown>} args @param {Record<string, unknown>} [options] */
export function fetchSharedTrunkNative(args, options = {}) {
  return invokeSharedTrunkMutation(SHARED_TRUNK_NATIVE_METHODS.FETCH, args, options);
}

/** @param {Record<string, unknown>} args @param {Record<string, unknown>} [options] */
export function preflightSharedTrunkNative(args, options = {}) {
  return invokeSharedTrunkMutation(SHARED_TRUNK_NATIVE_METHODS.PREFLIGHT, args, options);
}

/** @param {Record<string, unknown>} args @param {Record<string, unknown>} [options] */
export function ffUpdateSharedTrunkNative(args, options = {}) {
  return invokeSharedTrunkMutation(SHARED_TRUNK_NATIVE_METHODS.FF_UPDATE, args, options);
}

/** @param {Record<string, unknown>} args @param {Record<string, unknown>} [options] */
export function pushSharedTrunkNative(args, options = {}) {
  return invokeSharedTrunkMutation(SHARED_TRUNK_NATIVE_METHODS.PUSH, args, options);
}

/** @param {Record<string, unknown>} args @param {Record<string, unknown>} [options] */
export function resetRejectedSharedTrunkNative(args, options = {}) {
  return invokeSharedTrunkMutation(SHARED_TRUNK_NATIVE_METHODS.RESET_REJECTED, args, options);
}

/** @param {Record<string, unknown>} args @param {Record<string, unknown>} [options] */
export function casPushSharedTrunkClaimNative(args, options = {}) {
  return invokeSharedTrunkMutation(SHARED_TRUNK_NATIVE_METHODS.CAS_PUSH_CLAIM, args, options);
}
