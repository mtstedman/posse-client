// @ts-check
//
// Strict Git native method boundary.
//
// Migration discipline:
//   1. Rust implements a `posse-git` method.
//   2. Node call sites run an explicit A/B parity check against the Rust method.
//   3. Once parity is exact for the covered surface, the call site switches to
//      the Rust method and the matching Node body is deleted in the same change.

import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";
import { hasNativeThreadBridge, nativeThreadBridgeRequest } from "../../../../shared/tools/classes/daemon/native-thread-bridge.js";
import { isAbortError, signalAbortError } from "../../../runtime/functions/yield.js";
import { appendRunTelemetry } from "../../../../shared/telemetry/functions/run-telemetry.js";

export const GIT_NATIVE_PROTOCOL = "posse.git.native.v1";

/**
 * Resolve the heartbeat auth envelope for FAILURE TELEMETRY only. The request
 * itself carries no trust object: native trust is compiled into the binary,
 * and NativeBinary attaches the manager-owned pulse envelope at the final
 * stdin boundary. An explicit `opts.auth` wins; otherwise the envelope comes
 * from the manager's single auth authority (cached, resolved once per
 * runtime). This leaf must not silently re-read settings/env.
 *
 * @param {GitNativeMethodRunOptions} opts
 * @param {import("../../../../shared/tools/classes/BinaryManager.js").BinaryManager} manager
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
// blip (network/5xx/clock) at binary startup, before any git work runs. Async
// calls retry here before the error reaches the job layer and consumes an
// attempt. Sync calls cannot do that safely: blocking the JS thread also blocks
// the background pulse mint that could make a retry succeed.
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

function delayMsAsync(ms) {
  return new Promise((resolve) => { setTimeout(resolve, Math.max(1, Number(ms) || 1)); });
}

/**
 * Public sync entry point. A cold pulse cache fails immediately so the event
 * loop can service the background mint; retrying synchronously only delays it.
 *
 * @param {string} method
 * @param {unknown} payload
 * @param {GitNativeMethodRunOptions} [opts]
 * @returns {unknown}
 */
export function runGitNativeMethod(method, payload, opts = {}) {
  return runGitNativeMethodOnce(method, payload, opts);
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

// Methods that are safe to run through the persistent worker: they are either
// read-only or idempotent, so an abort can simply discard the result without
// needing to kill the in-flight process. This is a transport/idempotency
// decision only; authorization is classified independently below.
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

export const GIT_READ_ROUTE = "git:read";
export const GIT_MUTATE_ROUTE = "git:mutate";

// This allowlist mirrors every statically read-only arm in posse-git's
// dispatch_git_method. Payload-sensitive methods are handled separately and
// every unrecognized method falls through to git:mutate.
const GIT_READ_ONLY_METHODS = new Set([
  "git.branchExists",
  "git.commitScope.conflictsWith",
  "git.commitScope.containsFile",
  "git.commitScope.findConflict",
  "git.commitScope.fromInput",
  "git.commitScope.fromPayload",
  "git.commitScope.hasScope",
  "git.commitScope.isWildcard",
  "git.commitScope.lockRows",
  "git.currentBranch",
  "git.currentHash",
  "git.findStallStash",
  "git.hasChanges",
  "git.hasIgnoredChanges",
  "git.history",
  "git.isAncestor",
  "git.isReadOnly",
  "git.jobNeedsWorktree",
  "git.jobsNeedWorktree",
  "git.localBranchExists",
  "git.mergeBase",
  "git.push.refspecCanPublishSnapshotRefs",
  "git.remoteHeadBranch",
  "git.repairWebAssetCreateScope",
  "git.repo.branchExists",
  "git.repo.currentBranch",
  "git.repo.currentHash",
  "git.repo.hasChanges",
  "git.repo.isAncestor",
  "git.repo.isReadOnly",
  "git.repo.mergeBase",
  "git.repo.statusPorcelain",
  "git.repo.workflowStatus",
  "git.resolvePushBranch",
  "git.resolveTargetBranch",
  "git.snapshot.dirSizeBytes",
  "git.snapshot.exists",
  "git.snapshot.findExistingDedupRef",
  "git.snapshot.listRefs",
  "git.snapshot.readNote",
  "git.snapshot.refName",
  "git.snapshot.safeFilename",
  "git.snapshotPublishingPushConfigs",
  "git.statusFromRepo",
  "git.statusPorcelain",
  "git.workflow.status",
  "git.workflow.statusFromRepo",
  "git.workflowStatus",
  "git.worktree.branchLockPath",
  "git.worktree.classifyDirty",
  "git.worktree.currentBranch",
  "git.worktree.exists",
  "git.worktree.findLegacy",
  "git.worktree.isMergeInProgress",
  "git.worktree.isUsable",
  "git.worktree.listMergeConflicts",
  "git.worktree.lockPath",
  "git.worktree.parsePorcelainRemainingPaths",
  "git.worktree.path",
  "git.worktree.stashLockPath",
  "status",
  "workflow-status",
]);

// git.exec must use the encoder's argument policy, not the broader Node Repo
// scheduling classifier. These tables intentionally match git_core::repo.
const GIT_EXEC_READ_ONLY_COMMANDS = new Set([
  "blame",
  "cat-file",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
]);
const GIT_EXEC_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);
const GIT_EXEC_GLOBAL_FLAGS = new Set([
  "--bare",
  "--glob-pathspecs",
  "--icase-pathspecs",
  "--literal-pathspecs",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
]);
const GIT_EXEC_GLOBAL_OPTIONS_WITH_EQUALS = [
  "--exec-path=",
  "--git-dir=",
  "--namespace=",
  "--work-tree=",
];
const GIT_EXEC_BRANCH_MUTATING_FLAGS = new Set([
  "-c", "-C", "-d", "-D", "-f", "-m", "-M", "--copy",
  "--create-reflog", "--delete", "--edit-description", "--force", "--move",
  "--no-create-reflog", "--no-track", "--set-upstream-to", "--track", "--unset-upstream",
]);
const GIT_EXEC_BRANCH_READ_FLAGS = new Set([
  "-a", "-r", "-v", "-vv", "--all", "--color", "--column", "--contains",
  "--format", "--ignore-case", "--list", "--merged", "--no-color", "--no-column",
  "--no-contains", "--no-merged", "--points-at", "--remotes", "--show-current",
  "--sort", "--verbose",
]);
const GIT_EXEC_BRANCH_READ_OPTIONS_WITH_VALUE = new Set([
  "--color", "--column", "--contains", "--format", "--merged",
  "--no-contains", "--no-merged", "--points-at", "--sort",
]);
const GIT_EXEC_CONFIG_READ_FLAGS = new Set([
  "-l", "--get", "--get-all", "--get-color", "--get-colorbool",
  "--get-regexp", "--get-urlmatch", "--list",
]);
const GIT_EXEC_CONFIG_WRITE_FLAGS = new Set([
  "--add", "--remove-section", "--rename-section", "--replace-all",
  "--set", "--unset", "--unset-all",
]);
const GIT_EXEC_CONFIG_OPTIONS_WITH_VALUE = new Set(["--blob", "--file", "--type"]);
const GIT_EXEC_READ_ONLY_UNSAFE_OPTIONS = new Set(["--ext-diff", "--filters", "--output", "--textconv"]);

/**
 * @param {string} arg
 * @returns {string}
 */
function gitExecOptionName(arg) {
  const text = String(arg || "");
  const equals = text.indexOf("=");
  return equals === -1 ? text : text.slice(0, equals);
}

/**
 * @param {string[]} args
 * @returns {string[] | null}
 */
function gitExecCommandArgs(args) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (!arg) {
      index += 1;
      continue;
    }
    if (arg === "--") return args.slice(index + 1);
    if (!arg.startsWith("-")) break;
    if (arg === "-c" || (arg.startsWith("-c") && arg.length > 2) || arg === "-p" || arg === "--paginate") {
      return null;
    }
    if (GIT_EXEC_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (GIT_EXEC_GLOBAL_OPTIONS_WITH_EQUALS.some((prefix) => arg.startsWith(prefix))) {
      index += 1;
      continue;
    }
    if (GIT_EXEC_GLOBAL_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    break;
  }
  return args.slice(index);
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function gitExecBranchArgsAreReadOnly(args) {
  if (args.length === 0) return true;
  let sawReadIntent = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = gitExecOptionName(arg);
    if (GIT_EXEC_BRANCH_MUTATING_FLAGS.has(name)) return false;
    if (GIT_EXEC_BRANCH_READ_FLAGS.has(name)) {
      sawReadIntent = true;
      if (GIT_EXEC_BRANCH_READ_OPTIONS_WITH_VALUE.has(name) && !arg.includes("=")) index += 1;
      continue;
    }
    if (arg.startsWith("-") || !sawReadIntent) return false;
  }
  return sawReadIntent;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function gitExecConfigArgsAreReadOnly(args) {
  let sawNonOptionBeforeReadAction = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = gitExecOptionName(arg);
    if (GIT_EXEC_CONFIG_WRITE_FLAGS.has(name)) return false;
    if (GIT_EXEC_CONFIG_READ_FLAGS.has(name)) return !sawNonOptionBeforeReadAction;
    if (GIT_EXEC_CONFIG_OPTIONS_WITH_VALUE.has(name) && !arg.includes("=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    sawNonOptionBeforeReadAction = true;
  }
  return false;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function gitExecArgsAreReadOnly(args) {
  const command = gitExecCommandArgs(args);
  if (!command?.length) return false;
  const [name, ...commandArgs] = command;
  if (name === "branch") return gitExecBranchArgsAreReadOnly(commandArgs);
  if (name === "config") return gitExecConfigArgsAreReadOnly(commandArgs);
  return GIT_EXEC_READ_ONLY_COMMANDS.has(name)
    && !commandArgs.some((arg) => GIT_EXEC_READ_ONLY_UNSAFE_OPTIONS.has(gitExecOptionName(arg)));
}

/**
 * @param {unknown} payload
 * @returns {boolean}
 */
function gitExecPayloadRequiresMutate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return true;
  const value = /** @type {Record<string, unknown>} */ (payload);
  const args = Object.prototype.hasOwnProperty.call(value, "args") ? value.args : [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return true;
  return !gitExecArgsAreReadOnly(args);
}

/**
 * Pulse route grant one git native method must present. Authorization is
 * payload-aware and deliberately independent from persistent-worker
 * eligibility. Only explicitly classified read operations receive `git:read`;
 * unknown or malformed operations fail closed to `git:mutate`.
 *
 * @param {string} method
 * @param {unknown} [payload]
 * @returns {string}
 */
export function gitNativeMethodRoute(method, payload = null) {
  const command = String(method || "").trim();
  if (command === "git.exec" || command === "git.repo.exec") {
    return gitExecPayloadRequiresMutate(payload) ? GIT_MUTATE_ROUTE : GIT_READ_ROUTE;
  }
  if (command === "git.worktree.root") {
    return payload && typeof payload === "object" && !Array.isArray(payload)
      && /** @type {Record<string, unknown>} */ (payload).create === true
      ? GIT_MUTATE_ROUTE
      : GIT_READ_ROUTE;
  }
  return GIT_READ_ONLY_METHODS.has(command) ? GIT_READ_ROUTE : GIT_MUTATE_ROUTE;
}

/**
 * @typedef {Object} GitNativeMethodRunOptions
 * @property {import("../../../../shared/tools/classes/BinaryManager.js").BinaryManager} [manager]
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
    throw gitNativeError(message, err);
  }
  if (obj.ok === true && Object.prototype.hasOwnProperty.call(obj, "data")) {
    return obj.data;
  }
  return value;
}

function gitNativeError(message, source = null) {
  const cause = source instanceof Error ? source : undefined;
  const error = cause ? new Error(message, { cause }) : new Error(message);
  if (source && typeof source === "object") {
    for (const key of ["code", "errno", "status", "statusCode", "signal"]) {
      if (source[key] != null) error[key] = source[key];
    }
    if (source.details !== undefined) error.details = source.details;
  }
  return error;
}

function gitNativeProcessError(method, res, detail) {
  const error = gitNativeError(
    `Git native method ${method} failed${detail ? `: ${detail}` : ""}`,
    res?.error || null,
  );
  if (error.code == null) error.code = "GIT_NATIVE_METHOD_FAILED";
  if (error.status == null && res?.code != null) error.status = res.code;
  error.stdout = String(res?.stdout || "");
  error.stderr = String(res?.stderr || "");
  return error;
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
    const unavailable = new Error(`Git native method unavailable: ${method}`);
    unavailable.code = "GIT_NATIVE_UNAVAILABLE";
    throw unavailable;
  }
  const request = buildGitNativeMethodRequest(method, payload);
  // NativeBinary owns the request's auth material: it attaches a route-scoped
  // pulse envelope at the final stdin boundary. The heartbeat envelope is
  // resolved here only for failure telemetry.
  const auth = resolveGitAuthEnvelope(opts, manager);
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
        maxBuffer: opts.maxBuffer,
        requiredRoute: gitNativeMethodRoute(request.method, request.payload),
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
    throw gitNativeProcessError(request.method, res, detail);
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
    const unavailable = new Error(`Git native method unavailable: ${method}`);
    unavailable.code = "GIT_NATIVE_UNAVAILABLE";
    throw unavailable;
  }
  const request = buildGitNativeMethodRequest(method, payload);
  // NativeBinary owns the request's auth material: it attaches a route-scoped
  // pulse envelope at the final stdin boundary. The heartbeat envelope is
  // resolved here only for failure telemetry.
  const auth = resolveGitAuthEnvelope(opts, manager);
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
        maxBuffer: opts.maxBuffer,
        requiredRoute: gitNativeMethodRoute(request.method, request.payload),
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
    throw gitNativeProcessError(request.method, res, detail);
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
