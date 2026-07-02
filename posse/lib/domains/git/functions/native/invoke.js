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
import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";

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

function capString(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function errorSummary(err) {
  if (!err) return null;
  const cause = err.cause && err.cause !== err ? err.cause : null;
  return {
    name: err?.name || null,
    code: err?.code || err?.errno || null,
    status: err?.status || err?.statusCode || null,
    message: capString(err?.message || String(err), 900),
    cause: cause ? {
      name: cause?.name || null,
      code: cause?.code || cause?.errno || null,
      status: cause?.status || cause?.statusCode || null,
      message: capString(cause?.message || String(cause), 900),
    } : null,
  };
}

function isHeartbeatFailureText(value) {
  return /heartbeat|posse_key|pulse[\s_-]?token|identity[\s_-]?heartbeat/i.test(String(value || ""));
}

// A native heartbeat/identity failure is almost always a transient round-trip
// blip (network/5xx/clock) at binary startup, before any git work runs. Retry a
// couple of times here, in the leaf — BEFORE the error reaches the job layer and
// consumes an attempt. atlas_warm has maxAttempts:1, so a single un-retried blip
// dead-letters it; normal jobs waste a retry. Persistent auth (401/403) and
// aborts fail fast so we never spin on a real misconfiguration. Because the
// heartbeat is validated at process startup before mutations, retrying is safe.
const HEARTBEAT_RETRY_MAX_ATTEMPTS = 3;
const HEARTBEAT_RETRY_BASE_MS = 150;

function isPersistentNativeAuthError(err) {
  const status = Number(err?.status || err?.statusCode || err?.cause?.status || err?.cause?.statusCode || 0);
  if (status === 401 || status === 403) return true;
  // Native binaries report heartbeat auth failures as stderr text, and the
  // res.ok===false rethrow flattens that into a fresh Error message with no
  // structured status — so classify persistent auth from the text too, or a
  // real 401/403 would be retried three times.
  return /\b401\b|\b403\b|unauthor|forbidden/i.test(String(err?.message || err || ""));
}

export function shouldRetryNativeHeartbeat(err) {
  if (isAbortError(err)) return false;
  if (!isHeartbeatFailureText(err?.message || String(err || ""))) return false;
  if (isPersistentNativeAuthError(err)) return false;
  return true;
}

function sleepMsSync(ms) {
  const timeout = Math.max(1, Number(ms) || 1);
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout); }
  catch { /* best effort */ }
}

function delayMsAsync(ms) {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(1, Number(ms) || 1)); });
}

/**
 * Public sync entry point. Retries only transient native heartbeat failures;
 * all other errors (including the structured `{ ok: false }` git failures)
 * propagate on the first throw, exactly as before.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {GitNativeMethodRunOptions} [opts]
 * @returns {unknown}
 */
export function runGitNativeMethod(method, payload, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= HEARTBEAT_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return runGitNativeMethodOnce(method, payload, opts);
    } catch (err) {
      lastErr = err;
      if (attempt >= HEARTBEAT_RETRY_MAX_ATTEMPTS || !shouldRetryNativeHeartbeat(err)) throw err;
      sleepMsSync(HEARTBEAT_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

/**
 * Public async entry point. Same heartbeat-retry policy as the sync form.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {GitNativeMethodRunOptions} [opts]
 * @returns {Promise<unknown>}
 */
export async function runGitNativeMethodAsync(method, payload, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= HEARTBEAT_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await runGitNativeMethodAsyncOnce(method, payload, opts);
    } catch (err) {
      lastErr = err;
      if (attempt >= HEARTBEAT_RETRY_MAX_ATTEMPTS || !shouldRetryNativeHeartbeat(err)) throw err;
      await delayMsAsync(HEARTBEAT_RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

function safeUrlOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function nativeAuthTelemetry(manager, auth) {
  const envelope = auth && typeof auth === "object" ? auth : null;
  let launchKeyPresent = false;
  let managerShouldUse = false;
  let binaryAvailable = false;
  try { launchKeyPresent = !!manager?.nativeAuthManager?.getLaunchKey?.(); } catch { launchKeyPresent = false; }
  try { managerShouldUse = manager?.shouldUse?.("git") === true; } catch { managerShouldUse = false; }
  try { binaryAvailable = manager?.available?.("git") === true; } catch { binaryAvailable = false; }
  return {
    auth_envelope_present: !!envelope,
    auth_heartbeat_url_present: !!String(envelope?.heartbeatUrl || "").trim(),
    auth_heartbeat_origin: safeUrlOrigin(envelope?.heartbeatUrl),
    auth_public_key_present: !!(envelope?.heartbeatJwtPublicKey || envelope?.heartbeatJwtPublicKeySha256),
    auth_audience_present: !!String(envelope?.heartbeatJwtAudience || "").trim(),
    launch_key_present: launchKeyPresent,
    binary_available: binaryAvailable,
    manager_should_use: managerShouldUse,
  };
}

function logNativeHeartbeatFailure({ method, asyncMode = false, bridge = false, workerRequested = null, workerEligible = null, manager, auth, detail = "", error = null } = {}) {
  appendRunTelemetry("diagnostics", {
    kind: "native.heartbeat.failure",
    component: "native_git",
    method: method || null,
    async: asyncMode === true,
    bridge: bridge === true,
    worker_requested: workerRequested,
    worker_eligible: workerEligible,
    detail: capString(detail || error?.message || "", 1200),
    error: errorSummary(error),
    ...nativeAuthTelemetry(manager, auth),
  });
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
 * Normalize a caller options bag into native invocation options: only
 * native-parity keys cross into the invocation, plus the explicitly threaded
 * manager/signal/timeout — never the whole caller options bag. Shared by the
 * `*Async` twins across the git function modules so the filtering cannot
 * drift per-file.
 *
 * @param {{ nativeParity?: Record<string, any>, manager?: unknown, signal?: AbortSignal | null, timeoutMs?: number }} [options]
 * @returns {Record<string, unknown>}
 */
export function nativeAsyncOptions(options = {}) {
  const parity = options.nativeParity || {};
  return {
    ...parity,
    manager: options.manager ?? parity.manager,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
}

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
function runGitNativeMethodOnce(method, payload, opts = {}) {
  const manager = opts.manager || nativeBinaries;
  if (!manager.shouldUse("git")) {
    throw new Error(`Git native method unavailable: ${method}`);
  }
  const request = buildGitNativeMethodRequest(method, payload);
  const auth = resolveGitAuthEnvelope(opts, manager);
  if (auth && typeof auth === "object") {
    /** @type {Record<string, unknown>} */ (request).auth = auth;
  }
  const workerEligible = WORKER_ELIGIBLE_METHODS.has(request.method);
  let res;
  try {
    res = manager.binary("git").runSync(
      request.method,
      [],
      {
        input: `${JSON.stringify(request)}\n`,
        json: true,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        worker: workerEligible,
      },
    );
  } catch (err) {
    const detail = err?.message || String(err);
    if (isHeartbeatFailureText(detail)) {
      logNativeHeartbeatFailure({
        method: request.method,
        asyncMode: false,
        workerRequested: workerEligible,
        workerEligible,
        manager,
        auth,
        detail,
        error: err,
      });
    }
    throw err;
  }
  if (!res.ok) {
    // Preserve abort identity: a cancelled native call must surface as an
    // AbortError (with its kill reason) so callers handle it as a cancellation
    // rather than a git failure (which would consume an attempt).
    if (isAbortError(res.error)) throw res.error;
    if (opts.signal?.aborted) throw signalAbortError(opts.signal);
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    if (isHeartbeatFailureText(detail)) {
      logNativeHeartbeatFailure({
        method: request.method,
        asyncMode: false,
        workerRequested: workerEligible,
        workerEligible,
        manager,
        auth,
        detail,
        error: res.error || null,
      });
    }
    throw new Error(`Git native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  try {
    return unwrapGitNativeMethodResponse(res.json);
  } catch (err) {
    const detail = err?.message || String(err);
    if (isHeartbeatFailureText(detail)) {
      logNativeHeartbeatFailure({
        method: request.method,
        asyncMode: false,
        workerRequested: workerEligible,
        workerEligible,
        manager,
        auth,
        detail,
        error: err,
      });
    }
    throw err;
  }
}

/**
 * Async form for call sites that are already off the sync path.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {GitNativeMethodRunOptions} [opts]
 * @returns {Promise<unknown>}
 */
async function runGitNativeMethodAsyncOnce(method, payload, opts = {}) {
  if (opts.bypassNativeBridge !== true && hasNativeThreadBridge()) {
    const { bypassNativeBridge, manager, signal, ...bridgeOpts } = opts;
    const bridgeManager = manager || nativeBinaries;
    const auth = resolveGitAuthEnvelope(opts, bridgeManager);
    if (auth && typeof auth === "object") {
      /** @type {Record<string, unknown>} */ (bridgeOpts).auth = auth;
    }
    const bridgeMethod = String(method || "").trim() || String(method || "");
    const workerEligible = WORKER_ELIGIBLE_METHODS.has(bridgeMethod);
    try {
      return await nativeThreadBridgeRequest("git", method, payload, bridgeOpts, { signal, timeoutMs: opts.timeoutMs });
    } catch (err) {
      const detail = err?.message || String(err);
      if (isHeartbeatFailureText(detail)) {
        logNativeHeartbeatFailure({
          method: bridgeMethod,
          asyncMode: true,
          bridge: true,
          workerRequested: opts.worker !== false,
          workerEligible,
          manager: bridgeManager,
          auth,
          detail,
          error: err,
        });
      }
      throw err;
    }
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
  const workerEligible = WORKER_ELIGIBLE_METHODS.has(request.method);
  const workerRequested = opts.worker !== false && workerEligible;
  let res;
  try {
    res = await manager.binary("git").run(
      request.method,
      [],
      {
        input: `${JSON.stringify(request)}\n`,
        json: true,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        worker: workerRequested,
      },
    );
  } catch (err) {
    const detail = err?.message || String(err);
    if (isHeartbeatFailureText(detail)) {
      logNativeHeartbeatFailure({
        method: request.method,
        asyncMode: true,
        workerRequested,
        workerEligible,
        manager,
        auth,
        detail,
        error: err,
      });
    }
    throw err;
  }
  if (!res.ok) {
    // Preserve abort identity: a cancelled native call must surface as an
    // AbortError (with its kill reason) so callers handle it as a cancellation
    // rather than a git failure (which would consume an attempt).
    if (isAbortError(res.error)) throw res.error;
    if (opts.signal?.aborted) throw signalAbortError(opts.signal);
    const detail = String(res.stderr || res.error?.message || "native process failed").trim();
    if (isHeartbeatFailureText(detail)) {
      logNativeHeartbeatFailure({
        method: request.method,
        asyncMode: true,
        workerRequested,
        workerEligible,
        manager,
        auth,
        detail,
        error: res.error || null,
      });
    }
    throw new Error(`Git native method ${request.method} failed${detail ? `: ${detail}` : ""}`);
  }
  try {
    return unwrapGitNativeMethodResponse(res.json);
  } catch (err) {
    const detail = err?.message || String(err);
    if (isHeartbeatFailureText(detail)) {
      logNativeHeartbeatFailure({
        method: request.method,
        asyncMode: true,
        workerRequested,
        workerEligible,
        manager,
        auth,
        detail,
        error: err,
      });
    }
    throw err;
  }
}
