// @ts-check
//
// Strict Git native method boundary.
//
// Migration discipline:
//   1. Rust implements a `posse-git` method.
//   2. Node call sites run an explicit A/B parity check against the Rust method.
//   3. Once parity is exact for the covered surface, the call site switches to
//      the Rust method and the matching Node body is deleted in the same change.

import { nativeBinaries } from "../../../../classes/tools/BinaryManager.js";
import { hasNativeThreadBridge, nativeThreadBridgeRequest } from "../../../../classes/tools/daemon/native-thread-bridge.js";
import { isAbortError, signalAbortError } from "../../../runtime/functions/yield.js";

export const GIT_NATIVE_PROTOCOL = "posse.git.native.v1";

/**
 * Resolve the heartbeat auth envelope for a native request. An explicit
 * `opts.auth` always wins; otherwise the envelope comes from the manager's
 * single auth authority (cached, resolved once per runtime). Stub managers that
 * want auth in tests should expose nativeAuthEnvelope(); this leaf must not
 * silently re-read settings/env.
 *
 * @param {GitNativeMethodRunOptions} opts
 * @param {import("../../../../classes/tools/BinaryManager.js").BinaryManager} manager
 * @returns {Record<string, unknown> | null}
 */
function resolveGitAuthEnvelope(opts, manager) {
  if (opts.auth && typeof opts.auth === "object") return opts.auth;
  if (manager && typeof manager.nativeAuthEnvelope === "function") {
    return manager.nativeAuthEnvelope();
  }
  return null;
}

// Read-only methods that are safe to run through the persistent worker: no
// side effects (or idempotent ones), so an abort can simply discard the result
// without needing to kill the in-flight process. Mutating/cancellable methods
// keep the per-call spawn path so an abort kills their own process.
const WORKER_ELIGIBLE_METHODS = new Set([
  "git.currentBranch",
  "git.currentHash",
  "git.hasChanges",
  "git.hasIgnoredChanges",
  "git.statusPorcelain",
  "git.mergeBase",
  "git.isAncestor",
  "git.localBranchExists",
  "git.remoteHeadBranch",
  "git.findStallStash",
  "git.resolveTargetBranch",
  "git.resolvePushBranch",
  "git.isReadOnly",
  "git.commitScope.hasScope",
  "git.commitScope.isWildcard",
  "git.commitScope.containsFile",
  "git.commitScope.lockRows",
  "git.commitScope.findConflict",
  "git.commitScope.conflictsWith",
  "git.commitScope.fromInput",
  "git.commitScope.fromPayload",
  "git.repairWebAssetCreateScope",
  "git.worktree.lockPath",
  "git.worktree.branchLockPath",
  "git.worktree.stashLockPath",
  "git.worktree.root",
  "git.worktree.path",
  "git.worktree.findLegacy",
  "git.worktree.exists",
  "git.worktree.currentBranch",
  "git.worktree.isUsable",
  "git.worktree.classifyDirty",
  "git.worktree.isMergeInProgress",
  "git.worktree.listMergeConflicts",
  "git.snapshot.recoveryRoot",
  "git.snapshot.safeFilename",
  "git.snapshot.refName",
  "git.snapshot.dirSizeBytes",
  "git.snapshot.listRefs",
  "git.snapshot.readNote",
  "git.snapshot.findExistingDedupRef",
  "git.snapshot.exists",
  // Read-only by construction (log/diff queries with scope filtering); riding
  // the persistent worker saves the 150-200ms per-call posse-git spawn that
  // every git_history tool invocation otherwise pays.
  "git.history",
]);

/**
 * @typedef {Object} GitNativeMethodRunOptions
 * @property {import("../../../../classes/tools/BinaryManager.js").BinaryManager} [manager]
 * @property {number} [timeoutMs]
 * @property {boolean} [disabled]
 * @property {AbortSignal} [signal]
 * @property {Record<string, unknown>} [auth]
 * @property {boolean} [bypassNativeBridge]
 * @property {boolean} [worker]
 * @property {(value: unknown) => unknown} [normalizeNodeResult]
 * @property {(value: unknown) => unknown} [normalizeNativeResult]
 * @property {(value: unknown) => unknown} [mapNativeReturn]
 */

/**
 * @param {string} method
 * @param {unknown} payload
 * @returns {{ protocol: string, method: string, payload: unknown }}
 */
export function buildGitNativeMethodRequest(method, payload) {
  const name = String(method || "").trim();
  if (!name) throw new TypeError("Git native method name is required");
  return {
    protocol: GIT_NATIVE_PROTOCOL,
    method: name,
    payload: payload ?? null,
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function unwrapGitNativeMethodResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (obj.ok === false) {
    const err = obj.error && typeof obj.error === "object"
      ? /** @type {Record<string, unknown>} */ (obj.error)
      : null;
    const message = String(err?.message || obj.message || "Git native method failed");
    throw new Error(message);
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
}

/**
 * Invoke one Rust-owned Git method. Throws on disabled/unavailable binary,
 * non-zero exit, invalid JSON, or a structured `{ ok: false }` response.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {GitNativeMethodRunOptions} [opts]
 * @returns {unknown}
 */
export function runGitNativeMethod(method, payload, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("git")) {
    throw new Error(`Git native method unavailable: ${method}`);
  }
  const request = buildGitNativeMethodRequest(method, payload);
  const auth = resolveGitAuthEnvelope(opts, manager);
  if (auth && typeof auth === "object") {
    /** @type {Record<string, unknown>} */ (request).auth = auth;
  }
  const res = manager.binary("git").runSync(
    request.method,
    [],
    {
      input: `${JSON.stringify(request)}\n`,
      json: true,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      worker: WORKER_ELIGIBLE_METHODS.has(request.method),
    },
  );
  if (!res.ok) {
    // Preserve abort identity: a cancelled native call must surface as an
    // AbortError (with its kill reason) so callers handle it as a cancellation
    // rather than a git failure (which would consume an attempt).
    if (isAbortError(res.error)) throw res.error;
    if (opts.signal?.aborted) throw signalAbortError(opts.signal);
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`Git native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapGitNativeMethodResponse(res.json);
}

/**
 * Async form for call sites that are already off the sync path.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {GitNativeMethodRunOptions} [opts]
 * @returns {Promise<unknown>}
 */
export async function runGitNativeMethodAsync(method, payload, opts = {}) {
  if (opts.bypassNativeBridge !== true && hasNativeThreadBridge()) {
    const { bypassNativeBridge, manager, signal, ...bridgeOpts } = opts;
    const auth = resolveGitAuthEnvelope(opts, manager || nativeBinaries);
    if (auth && typeof auth === "object") {
      /** @type {Record<string, unknown>} */ (bridgeOpts).auth = auth;
    }
    return nativeThreadBridgeRequest("git", method, payload, bridgeOpts);
  }
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("git")) {
    throw new Error(`Git native method unavailable: ${method}`);
  }
  const request = buildGitNativeMethodRequest(method, payload);
  const auth = resolveGitAuthEnvelope(opts, manager);
  if (auth && typeof auth === "object") {
    /** @type {Record<string, unknown>} */ (request).auth = auth;
  }
  const res = await manager.binary("git").run(
    request.method,
    [],
    {
      input: `${JSON.stringify(request)}\n`,
      json: true,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      worker: opts.worker !== false && WORKER_ELIGIBLE_METHODS.has(request.method),
    },
  );
  if (!res.ok) {
    // Preserve abort identity: a cancelled native call must surface as an
    // AbortError (with its kill reason) so callers handle it as a cancellation
    // rather than a git failure (which would consume an attempt).
    if (isAbortError(res.error)) throw res.error;
    if (opts.signal?.aborted) throw signalAbortError(opts.signal);
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    throw new Error(`Git native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  return unwrapGitNativeMethodResponse(res.json);
}
