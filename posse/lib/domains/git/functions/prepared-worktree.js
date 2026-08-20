// @ts-check
//
// Capability-gated boundary for the versioned prepared-worktree protocol.
// An older posse-git binary rejects an unknown method before dispatching any
// Git operation. Convert only that explicit protocol absence (or a wholly
// unavailable binary) into a no-mutation fallback signal; authorization,
// transport, cancellation, and Git safety failures still propagate.

import { WAITING_LANE_NATIVE_METHODS } from "../../../catalog/waiting-lane.js";
import { runGitNativeMethodAsync } from "./native/invoke.js";

const PREPARED_WORKTREE_METHODS = new Set(
  /** @type {string[]} */ (Object.values(WAITING_LANE_NATIVE_METHODS)),
);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPreparedWorktreeNativeCapabilityUnavailable(error) {
  const value = /** @type {{ code?: unknown, message?: unknown, stderr?: unknown, cause?: { message?: unknown } }} */ (error || {});
  if (value.code === "GIT_NATIVE_UNAVAILABLE") return true;
  const detail = [value.message, value.stderr, value.cause?.message]
    .filter(Boolean)
    .map(String)
    .join("\n");
  return /unknown git method:\s*git\.worktree\.(?:prepareDetached|refreshPrepared|activatePrepared|inspectPrepared)\b/iu.test(detail);
}

/**
 * Invoke one frozen prepared-worktree method with explicit feature detection.
 * The unavailable result is intentionally inert: callers may select the
 * established synchronous lifecycle, but this helper never performs it.
 *
 * @param {string} method
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{ available: true, result: any } | { available: false, result: null, reason: "native_capability_unavailable" }>}
 */
export async function invokePreparedWorktreeNativeMethodAsync(method, payload, options = {}) {
  if (!PREPARED_WORKTREE_METHODS.has(method)) {
    throw new TypeError(`Unsupported prepared-worktree native method: ${method}`);
  }
  try {
    return {
      available: true,
      result: await runGitNativeMethodAsync(method, payload, options),
    };
  } catch (error) {
    if (!isPreparedWorktreeNativeCapabilityUnavailable(error)) throw error;
    return {
      available: false,
      result: null,
      reason: "native_capability_unavailable",
    };
  }
}
