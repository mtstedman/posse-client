// @ts-check
//
// NativeBinary — a thin, OS/arch-aware wrapper around one Rust-compiled helper
// binary (e.g. posse-atlas, posse-git) staged under lib/bin/<name>/<os>/...
//
// Responsibilities:
//   - Resolve the correct build for the current os/arch from the catalog
//     (lib/catalog/binary.js), preferring lib/bin/<name>/<os>/<arch>/<file>
//     and falling back to lib/bin/<name>/<os>/<file> (universal macOS).
//   - Report availability so migration code can decide when a Rust-owned
//     method is callable. Availability is not a fallback policy.
//   - Invoke it protocol-agnostically: pass a subcommand + args, optionally
//     pipe a stdin payload, capture stdout (with an opt-in JSON parse).
//
// Invocation wrapping mirrors lib/shared/tools/classes/McpServer.js: injected spawn
// impls for testability, windowsHide, and taskkill-based termination on win32.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import {
  nativeBinaryExactVersion,
  nativeBinaryEntry,
  nativeBinaryIsKeyGated,
  nativeBinaryIsWorkerCapable,
  nativeBinaryPlatform,
} from "../../../catalog/binary.js";
import { osKey, archKey } from "../../platform/functions/native-platform.js";
import { buildRuntimeEnv } from "../../../domains/runtime/functions/paths.js";
import { signalAbortError } from "../../../domains/runtime/functions/yield.js";
import { appendBoundedText } from "../../format/functions/bounded-text.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";
import { Daemon, ProcessTransport, daemonSupervisor } from "./daemon/index.js";
import { HeartbeatAuthManager } from "../../native/classes/HeartbeatAuthManager.js";
import { PulseTokenManager } from "../../native/classes/PulseTokenManager.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/shared/tools/classes -> lib/bin
const DEFAULT_BIN_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "bin");
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
// A silent probe only retires the host once it has produced no message at all
// for this long (see #probeWorkerHealth): long enough that any worker-routed
// request a serial host could legitimately be chewing has passed its own
// timeout, short enough that a truly wedged host is replaced within minutes.
const WORKER_WEDGE_SILENCE_MS = 120_000;
// When a scheduled pulse refresh fails while the delivered pulse is still
// valid, retry the mint on this cadence until expiry.
const PULSE_REFRESH_RETRY_MS = 5_000;
// Never schedule a refresh timer closer than this (also the floor for a
// refreshAfter that is already in the past).
const PULSE_REFRESH_MIN_DELAY_MS = 250;

// Manager-owned request fields at the final stdin boundary. Whatever a caller
// supplies for these is deleted before the manager attaches its own pulse, so
// caller data can never override manager state (credentials, trust roots,
// route grants, or development gates).
const MANAGER_OWNED_REQUEST_FIELDS = Object.freeze([
  "posse_key",
  "pulse",
  "auth",
  "origin",
  "audience",
  "pins",
  "signingKeyPins",
  "routes",
  "development",
  "developmentMode",
]);

/**
 * Minimal Node-side shape check for a native pulse envelope. Node does NOT
 * verify the JWT (the native child verifies it offline against compiled
 * trust); this only decides whether a usable, unexpired envelope exists.
 *
 * @param {unknown} pulse
 * @param {number} [nowSeconds]
 * @returns {boolean}
 */
function isValidPulseEnvelope(pulse, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!pulse || typeof pulse !== "object" || Array.isArray(pulse)) return false;
  const envelope = /** @type {Record<string, unknown>} */ (pulse);
  if (!String(envelope.token || "").trim()) return false;
  if (!String(envelope.kid || "").trim()) return false;
  if (!String(envelope.route || "").trim()) return false;
  const expiresAt = Number(envelope.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowSeconds;
}

function isNativeProtocolRequest(request) {
  return !!request && typeof request === "object" && !Array.isArray(request)
    && Object.prototype.hasOwnProperty.call(request, "protocol")
    && Object.prototype.hasOwnProperty.call(request, "method");
}

function isNativeHeartbeatAuthFailure(value) {
  return /heartbeat|posse_key|pulse[\s_-]?token|identity[\s_-]?heartbeat/i.test(String(value || ""));
}

/**
 * @typedef {Object} RunResult
 * @property {boolean} ok
 * @property {number | null} code
 * @property {string | null} [signal]
 * @property {string} stdout
 * @property {string} stderr
 * @property {Error | null} error
 * @property {any} [json]            Present when `{ json: true }` and parsing succeeded.
 */

export class NativeBinary {
  /**
   * @param {{
   *   name: string,
   *   binRoot?: string,
   *   platform?: NodeJS.Platform,
   *   arch?: string,
   *   env?: NodeJS.ProcessEnv,
   *   nativeAuthManager?: import("../../native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager,
   *   pulseManager?: import("../../native/classes/PulseTokenManager.js").PulseTokenManager,
   *   exactVersion?: string | null,
   *   spawnImpl?: typeof spawn,
   *   spawnSyncImpl?: typeof spawnSync,
   * }} args
   */
  constructor({ name, binRoot, platform, arch, env, nativeAuthManager, pulseManager, exactVersion = undefined, spawnImpl = spawn, spawnSyncImpl = spawnSync } = /** @type {any} */ ({})) {
    if (!name) throw new TypeError("NativeBinary: name is required");
    this.name = name;
    this._binRoot = binRoot || null;
    this._env = env || null;
    // Single native-auth authority. Production injects the shared manager via
    // BinaryManager; standalone construction (tests) lazily derives one from
    // settings/env for the heartbeat envelope and pulse minting. Leaf call
    // sites never supply native keys.
    this._nativeAuthManager = nativeAuthManager || null;
    // Pulse broker: mints/caches route-scoped pulse envelopes against the
    // trusted heartbeat. Injectable for tests; lazily derived from the auth
    // manager otherwise. Native children only ever see its derived envelopes.
    this._fixedPulseManager = pulseManager || null;
    /** @type {import("../../native/classes/PulseTokenManager.js").PulseTokenManager | null} */
    this._pulseManager = null;
    this._pulseManagerAuth = null;
    /**
     * Per-route pulse state delivered to the live persistent worker: the last
     * envelope sent, the scheduled refresh timer, and whether an expired
     * control frame has parked protected work for the route.
     * @type {Map<string, { envelope: Record<string, unknown>, timer: NodeJS.Timeout | null, expired: boolean }>}
     */
    this._workerAuthState = new Map();
    this.keyGated = nativeBinaryIsKeyGated(name);
    this.workerCapable = nativeBinaryIsWorkerCapable(name);
    this.exactVersion = exactVersion === undefined ? nativeBinaryExactVersion(name) : exactVersion;
    this._versionProbe = null;
    /** @type {import("./daemon/index.js").Daemon | null} */
    this._daemon = null;
    /**
     * Worker→per-call fallback visibility: every time a worker-eligible
     * request degrades to a per-call spawn the daemon layer is unhealthy, and
     * the transparent fallback would otherwise hide it completely. Counted
     * here, surfaced once per run at closeout (and via BinaryManager stats);
     * each fallback also lands in the run diagnostics stream with its reason
     * and method so the closeout warning is diagnosable after the fact.
     * @type {{ count: number, byReason: Record<string, number> }}
     */
    this.workerFallbacks = { count: 0, byReason: {} };
    // os/arch resolved once at construction; throws on unsupported host.
    this.os = osKey(platform);
    this.arch = archKey(arch);
    this._spawn = spawnImpl;
    this._spawnSync = spawnSyncImpl;
    this._instanceSeq = NativeBinary._nextInstanceSeq++;
  }

  /** Distinguishes supervisor identities across instances (tests construct many). */
  static _nextInstanceSeq = 1;

  /** Args to launch this binary's `worker --stdio` host. */
  #buildWorkerArgs() {
    return ["worker", "--stdio"];
  }

  /**
   * Lazily create the shared async Daemon (process transport) for this binary,
   * registered with the process-wide supervisor so shutdown and lifecycle
   * telemetry cover it. Identity is per NativeBinary instance: production has
   * exactly one manager singleton (one handle per name), so this equals
   * per-name dedup there, while test-constructed managers with injected spawn
   * impls stay isolated from each other.
   */
  #daemon() {
    if (!this._daemon) {
      const label = `${this.name}:worker`;
      this._daemon = daemonSupervisor.daemon({
        kind: "native-binary",
        identity: `${this.name}#${this._instanceSeq}`,
        label,
        create: () => new Daemon({
          label,
          transportFactory: () => ProcessTransport({
            resolveBin: () => this.resolvePath(),
            buildArgs: () => this.#buildWorkerArgs(),
            env: () => this.#childEnv(),
            spawnImpl: this._spawn,
            label,
          }),
        }),
      });
      // Worker startup prewarm: mint the route grants this worker will use so
      // the first dispatch (and the sync cache-only boundary) finds a cached
      // pulse instead of paying — or failing closed on — a cold heartbeat.
      if (this.keyGated) void this.prewarmNativeAuth();
    }
    return this._daemon;
  }

  /**
   * Prewarm route-scoped pulse envelopes for this binary (fire-and-forget
   * safe). Defaults to the routes this binary's worker dispatches; callers
   * warming a specific grant (e.g. `git:mutate` ahead of a commit) may pass it
   * explicitly. Mint failures stay silent here — dispatch fails closed.
   *
   * @param {string[]} [routes]
   * @returns {Promise<void>}
   */
  async prewarmNativeAuth(routes = []) {
    if (!this.keyGated) return;
    const list = Array.isArray(routes) && routes.length > 0 ? routes : this.#defaultRoutes();
    await Promise.all(list.map(async (route) => {
      try {
        await this.#pulseManager().getPulseEnvelope({ requiredRoute: String(route || "").trim() });
      } catch { /* dispatch fails closed when no pulse is available */ }
    }));
  }

  /** Route grants this binary requests when no explicit route is threaded. */
  #defaultRoutes() {
    if (this.name === "atlas") return ["atlas:methods"];
    // Worker-routed git methods are the read-only set; mutating calls thread
    // `git:mutate` explicitly from the invoke boundary.
    if (this.name === "git") return ["git:read"];
    return [`${this.name}:methods`];
  }

  /** @param {string} reason @param {string | null} [method] */
  #noteWorkerFallback(reason, method = null) {
    this.workerFallbacks.count += 1;
    this.workerFallbacks.byReason[reason] = (this.workerFallbacks.byReason[reason] || 0) + 1;
    appendRunTelemetry("diagnostics", {
      kind: "native.worker_fallback",
      binary: this.name,
      reason,
      method,
      fallback_count: this.workerFallbacks.count,
    });
  }

  /**
   * After a request timeout: decide whether the host is wedged instead of
   * inferring it. Any reply to the probe — even an "unknown method" error from
   * hosts that predate daemon.ping — proves the request loop is alive, so the
   * slow request stays an isolated abandon. Single-flight so a burst of
   * timeouts can't stack probes.
   *
   * A silent probe alone is NOT enough to retire: the Rust worker hosts read
   * stdin serially with no out-of-band ping handler, so a host mid-way through
   * one slow request is silent essentially deterministically right after a
   * caller timeout. Silence only means wedged when the host has also produced
   * NO message for the wedge window — a host that replied recently is busy,
   * not dead, and killing it would discard its in-progress work, cold-start a
   * replacement, and (repeated) read as a crash loop. Retire (gracefully: EOF
   * + drain window) only on silent probe + prolonged total silence.
   */
  async #probeWorkerHealth() {
    if (this._workerProbeInFlight) return;
    this._workerProbeInFlight = true;
    try {
      const daemon = this.#daemon();
      const verdict = await daemon.probe({
        protocol: "posse.daemon.v1",
        method: "daemon.ping",
        payload: null,
      });
      if (verdict === "silent" && daemon.silenceMs() >= WORKER_WEDGE_SILENCE_MS) {
        daemon.retire({});
      }
    } catch { /* probe is best-effort */ } finally {
      this._workerProbeInFlight = false;
    }
  }

  /**
   * Run a native method through the persistent worker, mapping the worker's
   * JSON response to a RunResult. Falls back to a per-call spawn if the worker
   * is gone, so a worker crash never fails a request.
   *
   * @param {string | null} subcommand
   * @param {string[]} args
   * @param {{ input?: Buffer | string, json?: boolean, timeoutMs?: number, signal?: AbortSignal, requiredRoute?: string, workerFallback?: boolean, idempotent?: boolean }} opts
   * @returns {Promise<RunResult>}
   */
  async #runViaWorker(subcommand, args, opts) {
    const inputWithAuth = await this.#inputWithNativeAuthAsync(opts.input, opts.requiredRoute);
    if (this.#shouldFailMissingNativeAuth(inputWithAuth.request)) {
      this.#retireWorkerAfterAuthFailure();
      return this.#nativeAuthUnavailableResult();
    }
    const route = inputWithAuth.route;
    const pulse = inputWithAuth.request?.pulse;
    // Expired-route gate: after a nativeAuthExpired frame, protected work for
    // that route stays parked until a refreshed pulse frame reaches the
    // worker. We just minted a valid pulse (or failed closed above), so
    // deliver it as the refresh before dispatching.
    if (route && this.#workerRouteExpired(route) && !this.#deliverWorkerPulseRefresh(route, pulse)) {
      return this.#nativeAuthUnavailableResult();
    }
    const requestOpts = {
      ...opts,
      input: inputWithAuth.input,
    };
    let envelope = inputWithAuth.request;
    if (!envelope) {
      try {
        envelope = JSON.parse(String(requestOpts.input));
      } catch {
        return this.#runPerCall(subcommand, args, requestOpts);
      }
    }
    if (route && pulse) this.#noteWorkerPulse(route, pulse);
    let response = await this.#daemon().request(envelope, {
      signal: requestOpts.signal,
      timeoutMs: requestOpts.timeoutMs,
    });
    if (response?._transportGone === true) {
      // The host this pulse state was delivered to is gone; the replacement
      // host is (re)seeded by the request-borne pulse on its next dispatch.
      this.#clearWorkerAuthState();
    }
    if (response?._transportGone === true && requestOpts.signal?.aborted !== true && opts.idempotent !== false) {
      // Host died/retired under this request. Reads and idempotent methods
      // take one transparent retry on the replacement host, which keeps the
      // fast path instead of degrading to a per-call spawn. Non-idempotent
      // calls (ledger writes pass `idempotent: false`) skip the retry — the
      // lost host may have committed before dying, so the caller must see
      // the failure rather than risk a double-apply.
      response = await this.#daemon().request(envelope, {
        signal: requestOpts.signal,
        timeoutMs: requestOpts.timeoutMs,
      });
      if (response?._transportGone !== true && route && pulse) {
        // The replacement host answered: re-seed refresh scheduling for the
        // pulse it just received in the request envelope.
        this.#noteWorkerPulse(route, pulse);
      }
    }
    if (response?._timedOut === true) {
      // One slow request is not a dead host: the Daemon already abandoned the
      // request id (a late reply is dropped), so only PROBE the host — retire
      // fires solely when the probe gets silence. Fire-and-forget; this
      // request still falls back per-call below.
      void this.#probeWorkerHealth();
    }
    if (response?._transportGone === true || response?._timedOut === true || response?._overloaded === true) {
      // Degrade to a per-call spawn — counted, because the transparent
      // fallback otherwise hides an unhealthy daemon layer completely.
      const reason = response._transportGone === true ? "transport_gone"
        : response._timedOut === true ? "timeout" : "overloaded";
      this.#noteWorkerFallback(reason, subcommand);
      if (opts.workerFallback === false) {
        const error = new Error(`native ${this.name} worker unavailable (${reason})`);
        error.code = "POSSE_NATIVE_WORKER_UNAVAILABLE";
        return { ok: false, code: null, signal: null, stdout: "", stderr: error.message, error };
      }
      return this.#runPerCall(subcommand, args, requestOpts);
    }
    if (response?._aborted === true) {
      // Rebuild a real AbortError from the signal so callers preserve abort
      // identity (a cancelled native call must not read as a git failure).
      return {
        ok: false, code: null, signal: null, stdout: "", stderr: "aborted",
        error: requestOpts.signal ? signalAbortError(requestOpts.signal) : new Error("aborted"),
      };
    }
    if (response?.ok === false && isNativeHeartbeatAuthFailure(response?.error?.message || response?.message)) {
      this.#retireWorkerAfterAuthFailure();
    }
    return {
      ok: true,
      code: 0,
      signal: null,
      stdout: JSON.stringify(response),
      stderr: response?.ok === false ? String(/** @type {any} */ (response.error)?.message || "") : "",
      error: null,
      json: response,
    };
  }

  /**
   * Staging root. An explicit constructor value wins; otherwise honor the
   * `POSSE_NATIVE_BIN_ROOT` env override (resolved at call time so the shared
   * singleton stays redirectable in tests), falling back to lib/bin.
   *
   * @returns {string}
   */
  get binRoot() {
    return this._binRoot || process.env.POSSE_NATIVE_BIN_ROOT || DEFAULT_BIN_ROOT;
  }

  /**
   * Candidate file paths in resolution order: arch-specific first, then the
   * os-level (universal) location.
   *
   * @returns {string[]}
   */
  candidatePaths() {
    const plat = nativeBinaryPlatform(this.name, this.os);
    if (!plat) return [];
    const file = plat.destinationFile;
    return [
      path.join(this.binRoot, this.name, this.os, this.arch, file),
      path.join(this.binRoot, this.name, this.os, file),
    ];
  }

  /**
   * The on-disk path that will be used, or `null` when no build is present.
   *
   * @returns {string | null}
   */
  resolvePath() {
    for (const candidate of this.candidatePaths()) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not present; try next */ }
    }
    return null;
  }

  /**
   * Canonical path a build *should* live at (for diagnostics), regardless of
   * whether it currently exists. Universal-macOS uses the os-level path.
   *
   * @returns {string | null}
   */
  expectedPath() {
    const candidates = this.candidatePaths();
    if (candidates.length === 0) return null;
    const plat = nativeBinaryPlatform(this.name, this.os);
    return plat?.universal ? candidates[1] : candidates[0];
  }

  /** @returns {boolean} */
  isAvailable() {
    const binaryPath = this.resolvePath();
    if (!binaryPath) return false;
    if (!this.exactVersion) return true;
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(binaryPath).mtimeMs; } catch { return false; }
    if (this._versionProbe?.path === binaryPath && this._versionProbe?.mtimeMs === mtimeMs) {
      return this._versionProbe.matches;
    }
    const result = this._spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    const expected = `${nativeBinaryEntry(this.name)?.package} ${this.exactVersion}`;
    const matches = !result?.error && result?.status === 0 && String(result?.stdout || "").trim() === expected;
    this._versionProbe = { path: binaryPath, mtimeMs, matches };
    return matches;
  }

  /**
   * Best-effort: ensure the resolved binary is executable (posix only).
   * No-op on Windows and when the file is missing.
   *
   * @returns {void}
   */
  ensureExecutable() {
    if (process.platform === "win32") return;
    const bin = this.resolvePath();
    if (!bin) return;
    try { fs.chmodSync(bin, 0o755); } catch { /* best effort */ }
  }

  /**
   * Synchronous invocation. Preserves sync call sites (e.g. parseBuffer).
   *
   * @param {string | null} subcommand
   * @param {string[]} [args]
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, key?: string, worker?: boolean, signal?: AbortSignal, requiredRoute?: string }} [opts]
   * @returns {RunResult}
   */
  runSync(subcommand, args = [], opts = {}) {
    // Sync invocations are always per-call spawns. The Atomics SyncBridge that
    // used to serve `worker: true` here was removed because it both wedged for
    // the full wait timeout when its broker failed to boot and stranded its
    // host child on stop(). NOTE: the sync atlas invoke path still has live
    // production callers (retrieval redaction/tokenize/rank, tree-compression
    // — see invoke.js runAtlasNativeMethod), so every such call pays a full
    // spawn here. Call sites batch/memoize to stay O(1) spawns per action;
    // the durable fix is migrating the retrieval pipeline to the async
    // daemon variants. `opts.worker` is accepted and ignored so shared call
    // sites (invoke.js) need no sync/async forks.
    return this.#runSyncPerCall(subcommand, args, opts);
  }

  /**
   * Synchronous per-call spawn (one process per invocation).
   *
   * @param {string | null} subcommand
   * @param {string[]} [args]
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, requiredRoute?: string }} [opts]
   * @returns {RunResult}
   */
  #runSyncPerCall(subcommand, args = [], opts = {}) {
    const bin = this.resolvePath();
    if (!bin) return this.#unavailableResult();
    const fullArgs = this.#buildArgs(subcommand, args);
    const inputWithAuth = this.#inputWithNativeAuthSync(opts.input, opts.requiredRoute);
    if (this.#shouldFailMissingNativeAuth(inputWithAuth.request)) {
      this.#retireWorkerAfterAuthFailure();
      return this.#nativeAuthUnavailableResult();
    }
    const res = this._spawnSync(bin, fullArgs, {
      cwd: opts.cwd || process.cwd(),
      env: this.#childEnv(opts.env),
      input: inputWithAuth.input,
      encoding: "utf8",
      windowsHide: true,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Callers with large expected payloads (base64 envelopes) may raise the
      // capture ceiling; never shrink below the default.
      maxBuffer: Math.max(DEFAULT_MAX_BUFFER, Number(opts.maxBuffer) || 0),
    });
    return this.#finishResult({
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      stderr: typeof res.stderr === "string" ? res.stderr : "",
      code: typeof res.status === "number" ? res.status : null,
      signal: res.signal ?? null,
      error: res.error || null,
    }, opts.json === true);
  }

  /**
   * Asynchronous invocation for long-running / streamed calls.
   *
   * @param {string | null} subcommand
   * @param {string[]} [args]
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal, worker?: boolean, maxBuffer?: number, requiredRoute?: string }} [opts]
   * @returns {Promise<RunResult>}
   */
  run(subcommand, args = [], opts = {}) {
    if (this.workerCapable && opts.worker === true) {
      return this.#runViaWorker(subcommand, args, opts);
    }
    return this.#runPerCall(subcommand, args, opts);
  }

  /**
   * Async per-call spawn (one process per invocation).
   *
   * @param {string | null} subcommand
   * @param {string[]} args
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal, maxBuffer?: number, requiredRoute?: string }} [opts]
   * @returns {Promise<RunResult>}
   */
  #runPerCall(subcommand, args = [], opts = {}) {
    const bin = this.resolvePath();
    if (!bin) return Promise.resolve(this.#unavailableResult());
    if (opts.signal?.aborted) {
      return Promise.resolve(this.#finishResult({
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        error: signalAbortError(opts.signal),
      }, opts.json === true));
    }
    const fullArgs = this.#buildArgs(subcommand, args);
    const parsed = this.#parseNativeProtocolInput(opts.input);
    if (!parsed.protocol) {
      // Non-protocol stdin (parse buffers, --version probes) carries no pulse;
      // keep the historical synchronous spawn timing for those callers.
      return this.#spawnPerCall(bin, fullArgs, opts, parsed.input);
    }
    return (async () => {
      const inputWithAuth = await this.#attachPulseAsync(parsed, opts.requiredRoute);
      if (this.#shouldFailMissingNativeAuth(inputWithAuth.request)) {
        this.#retireWorkerAfterAuthFailure();
        return this.#nativeAuthUnavailableResult();
      }
      if (opts.signal?.aborted) {
        // The signal can flip while the pulse mint awaits; an already-aborted
        // signal never re-fires its abort event, so check again before spawning.
        return this.#finishResult({
          stdout: "",
          stderr: "",
          code: null,
          signal: null,
          error: signalAbortError(opts.signal),
        }, opts.json === true);
      }
      return this.#spawnPerCall(bin, fullArgs, opts, inputWithAuth.input);
    })();
  }

  /**
   * The raw per-call spawn: pipe `input`, capture stdout/stderr, honor
   * timeout/abort. Auth decisions happen before this point.
   *
   * @param {string} bin
   * @param {string[]} fullArgs
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal, maxBuffer?: number }} opts
   * @param {Buffer | string | undefined} input
   * @returns {Promise<RunResult>}
   */
  #spawnPerCall(bin, fullArgs, opts, input) {
    return new Promise((resolve) => {
      let settled = false;
      const child = this._spawn(bin, fullArgs, {
        cwd: opts.cwd || process.cwd(),
        env: this.#childEnv(opts.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const captureMaxChars = Math.max(DEFAULT_MAX_BUFFER, Number(opts.maxBuffer) || 0);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => { stdout = appendBoundedText(stdout, d, captureMaxChars); });
      child.stderr?.on("data", (d) => { stderr = appendBoundedText(stderr, d, captureMaxChars); });
      child.stdin?.on?.("error", () => {});

      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.#kill(child);
        finish(null, "SIGTERM", new Error(`native binary timed out after ${timeoutMs}ms: ${this.name}`));
      }, timeoutMs) : null;
      const onAbort = opts.signal
        ? () => {
          this.#kill(child);
          finish(null, "SIGTERM", signalAbortError(opts.signal));
        }
        : null;
      if (opts.signal && onAbort) opts.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (code, signal, error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
        resolve(this.#finishResult({
          stdout,
          stderr,
          code,
          signal,
          error,
        }, opts.json === true));
      };

      child.on("error", (err) => finish(null, null, err));
      child.on("close", (code, signal) => finish(code, signal, null));

      if (input != null) {
        try {
          child.stdin?.end(input);
        } catch (err) {
          this.#kill(child);
          finish(null, null, /** @type {Error} */ (err));
        }
      } else {
        child.stdin?.end();
      }
    });
  }

  /**
   * Probe the binary's version (`<bin> --version`). Returns trimmed stdout, or
   * `null` if unavailable / non-zero exit.
   *
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {string | null}
   */
  version(opts = {}) {
    const res = this.runSync(null, ["--version"], { timeoutMs: opts.timeoutMs ?? 10000 });
    return res.ok ? res.stdout.trim() : null;
  }

  /**
   * The native-auth authority for this handle. Production injects the shared
   * HeartbeatAuthManager through BinaryManager; a standalone handle lazily
   * derives one for heartbeat-envelope resolution.
   *
   * @returns {HeartbeatAuthManager}
   */
  #authManager() {
    if (!this._nativeAuthManager) {
      this._nativeAuthManager = new HeartbeatAuthManager({
        env: this._env,
      });
    }
    return this._nativeAuthManager;
  }

  /**
   * Build the argv. Native auth is carried only as the manager-owned pulse
   * envelope inside the JSON request; no credential or token ever enters
   * argv. Stdin payloads are passed via spawn `input`, which matches the
   * binaries' default `-i -`.
   *
   * @param {string | null} subcommand
   * @param {string[]} args
   * @returns {string[]}
   */
  #buildArgs(subcommand, args) {
    /** @type {string[]} */
    const out = [];
    if (subcommand) out.push(subcommand);
    for (const a of args) out.push(a);
    return out;
  }

  /**
   * Fail closed when a key-gated native protocol request carries no valid
   * pulse envelope. The raw POSSE_KEY is never an acceptable substitute — it
   * must not reach a native child at all.
   *
   * @param {Record<string, unknown> | null} request
   * @returns {boolean}
   */
  #shouldFailMissingNativeAuth(request) {
    return this.keyGated
      && isNativeProtocolRequest(request)
      && !isValidPulseEnvelope(request?.pulse);
  }

  /**
   * The pulse broker for this handle. Injectable for tests; otherwise derived
   * from (and kept in lockstep with) the current auth manager, so a swapped
   * authority (BinaryManager.setNativeAuthManager) rebuilds the broker.
   *
   * @returns {import("../../native/classes/PulseTokenManager.js").PulseTokenManager}
   */
  #pulseManager() {
    if (this._fixedPulseManager) return this._fixedPulseManager;
    const authManager = this.#authManager();
    if (!this._pulseManager || this._pulseManagerAuth !== authManager) {
      this._pulseManager = new PulseTokenManager({ authManager });
      this._pulseManagerAuth = authManager;
    }
    return this._pulseManager;
  }

  /**
   * The route grant one native call must present. An explicitly threaded route
   * (invoke boundaries classify git read vs mutate) always wins; otherwise the
   * binary's method family: `atlas:methods`, `git:read` (least privilege —
   * mutating git calls MUST thread `git:mutate`), `<name>:methods`.
   *
   * @param {string | undefined} explicitRoute
   * @returns {string}
   */
  #requiredRouteFor(explicitRoute) {
    const explicit = String(explicitRoute || "").trim();
    if (explicit) return explicit;
    return this.#defaultRoutes()[0];
  }

  /**
   * Parse a key-gated stdin payload and, when it is a native protocol request,
   * delete every manager-owned field a caller may have supplied. Caller data
   * can never override manager state.
   *
   * @param {Buffer | string | undefined} input
   * @returns {{ input: Buffer | string | undefined, request: Record<string, unknown> | null, protocol: boolean, wasBuffer: boolean }}
   */
  #parseNativeProtocolInput(input) {
    if (!this.keyGated || input == null) return { input, request: null, protocol: false, wasBuffer: false };
    const wasBuffer = Buffer.isBuffer(input);
    const raw = wasBuffer ? input.toString("utf8") : String(input);
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      return { input, request: null, protocol: false, wasBuffer };
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return { input, request: null, protocol: false, wasBuffer };
    }
    if (!Object.prototype.hasOwnProperty.call(request, "protocol")
      || !Object.prototype.hasOwnProperty.call(request, "method")) {
      return { input, request, protocol: false, wasBuffer };
    }
    const sanitized = { ...request };
    for (const field of MANAGER_OWNED_REQUEST_FIELDS) delete sanitized[field];
    return { input, request: sanitized, protocol: true, wasBuffer };
  }

  /** @param {Record<string, unknown>} request @param {boolean} wasBuffer */
  #encodeNativeRequest(request, wasBuffer) {
    const encoded = `${JSON.stringify(request)}\n`;
    return wasBuffer ? Buffer.from(encoded, "utf8") : encoded;
  }

  /**
   * Async stdin boundary: strip caller-supplied auth fields and attach the
   * manager-owned route-scoped pulse envelope as `request.pulse`. The raw
   * POSSE_KEY never enters the request; when no pulse can be minted the
   * request is returned WITHOUT one so the fail-closed guard stops the spawn.
   *
   * @param {Buffer | string | undefined} input
   * @param {string | undefined} requiredRoute
   * @returns {Promise<{ input: Buffer | string | undefined, request: Record<string, unknown> | null, route: string | null }>}
   */
  async #inputWithNativeAuthAsync(input, requiredRoute) {
    const parsed = this.#parseNativeProtocolInput(input);
    if (!parsed.protocol) return { input: parsed.input, request: parsed.request, route: null };
    return this.#attachPulseAsync(parsed, requiredRoute);
  }

  /**
   * Mint (or reuse) the route-scoped pulse for an already-parsed protocol
   * request and attach it as `request.pulse`.
   *
   * @param {{ input: Buffer | string | undefined, request: Record<string, unknown> | null, wasBuffer: boolean }} parsed
   * @param {string | undefined} requiredRoute
   * @returns {Promise<{ input: Buffer | string | undefined, request: Record<string, unknown> | null, route: string | null }>}
   */
  async #attachPulseAsync(parsed, requiredRoute) {
    const route = this.#requiredRouteFor(requiredRoute);
    let pulse = null;
    try {
      pulse = await this.#pulseManager().getPulseEnvelope({ requiredRoute: route });
    } catch {
      // Mint failures fail closed below; error details (which never include
      // token material) are not propagated into the child request.
      pulse = null;
    }
    if (!isValidPulseEnvelope(pulse)) {
      return {
        input: this.#encodeNativeRequest(/** @type {Record<string, unknown>} */ (parsed.request), parsed.wasBuffer),
        request: parsed.request,
        route,
      };
    }
    const requestWithPulse = { .../** @type {Record<string, unknown>} */ (parsed.request), pulse };
    return {
      input: this.#encodeNativeRequest(requestWithPulse, parsed.wasBuffer),
      request: requestWithPulse,
      route,
    };
  }

  /**
   * Sync stdin boundary: identical stripping, but the pulse comes from the
   * broker's cache only — a sync spawn cannot await the heartbeat exchange.
   * On a cache miss we kick a background mint (so a later call succeeds) and
   * return the request without a pulse, which fails closed before spawn.
   *
   * @param {Buffer | string | undefined} input
   * @param {string | undefined} requiredRoute
   * @returns {{ input: Buffer | string | undefined, request: Record<string, unknown> | null, route: string | null }}
   */
  #inputWithNativeAuthSync(input, requiredRoute) {
    const parsed = this.#parseNativeProtocolInput(input);
    if (!parsed.protocol) return { input: parsed.input, request: parsed.request, route: null };
    const route = this.#requiredRouteFor(requiredRoute);
    let pulse = null;
    try {
      pulse = this.#pulseManager().getCachedPulseEnvelope({ requiredRoute: route });
    } catch {
      pulse = null;
    }
    if (!isValidPulseEnvelope(pulse)) {
      this.#warmPulse(route);
      return {
        input: this.#encodeNativeRequest(/** @type {Record<string, unknown>} */ (parsed.request), parsed.wasBuffer),
        request: parsed.request,
        route,
      };
    }
    const requestWithPulse = { .../** @type {Record<string, unknown>} */ (parsed.request), pulse };
    return {
      input: this.#encodeNativeRequest(requestWithPulse, parsed.wasBuffer),
      request: requestWithPulse,
      route,
    };
  }

  /** Fire-and-forget background mint so a later sync call finds a cached pulse. */
  #warmPulse(route) {
    try {
      void Promise.resolve(this.#pulseManager().getPulseEnvelope({ requiredRoute: route })).catch(() => {});
    } catch { /* fail-closed guard already covers the caller */ }
  }

  // -------------------------------------------------------------------------
  // Persistent-worker pulse refresh: near expiry Node re-mints and delivers a
  // `nativeAuthRefresh` control frame over the worker's stdin; when it cannot
  // refresh in time it sends `nativeAuthExpired` and parks protected work for
  // that route until a refresh is delivered.
  // -------------------------------------------------------------------------

  /** @param {string} route */
  #workerRouteExpired(route) {
    return this._workerAuthState.get(route)?.expired === true;
  }

  /**
   * Send one control frame line to the live worker host's stdin. Control
   * frames are id-less notifications, so they bypass the Daemon request queue
   * and go straight to the transport.
   *
   * @param {Record<string, unknown>} frame
   * @returns {boolean} whether a live host received the frame
   */
  #sendWorkerControlFrame(frame) {
    const daemon = this._daemon;
    if (!daemon?.isHostAlive?.()) return false;
    const transport = daemon._transport;
    if (!transport || typeof transport.send !== "function") return false;
    try {
      transport.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `nativeAuthRefresh` control frame. The refreshed envelope is emitted under
   * BOTH field names — `pulse` (Wave 0 coordinator contract) and `auth` (the
   * encoder's compiled NativeAuthControlFrame serde contract) — so either
   * reader accepts the frame; neither shape rejects unknown fields.
   *
   * @param {Record<string, unknown>} envelope
   */
  #refreshControlFrame(envelope) {
    return { control: "nativeAuthRefresh", pulse: envelope, auth: envelope };
  }

  /**
   * `nativeAuthExpired` control frame. `expiredAt` is the documented contract
   * key; `expired_at` mirrors the encoder's serde field name.
   *
   * @param {string} route @param {number} expiredAt
   */
  #expiredControlFrame(route, expiredAt) {
    return { control: "nativeAuthExpired", route, expiredAt, expired_at: expiredAt };
  }

  /**
   * Un-park an expired route by delivering a refresh frame with a valid
   * envelope. Returns false when no valid envelope exists (callers fail
   * closed). When no live host remains there is nothing to un-park: the next
   * spawn is seeded by its own request-borne pulse.
   *
   * @param {string} route
   * @param {unknown} envelope
   * @returns {boolean}
   */
  #deliverWorkerPulseRefresh(route, envelope) {
    if (!isValidPulseEnvelope(envelope)) return false;
    if (!this.#sendWorkerControlFrame(this.#refreshControlFrame(/** @type {Record<string, unknown>} */ (envelope)))) {
      this.#clearWorkerAuthRoute(route);
      return true;
    }
    const state = this._workerAuthState.get(route);
    if (state) state.expired = false;
    this.#noteWorkerPulse(route, /** @type {Record<string, unknown>} */ (envelope));
    return true;
  }

  /**
   * Track the pulse most recently delivered to the live worker for a route and
   * (re)schedule its refresh at `refreshAfter`.
   *
   * @param {string} route
   * @param {Record<string, unknown>} envelope
   */
  #noteWorkerPulse(route, envelope) {
    if (!route || !isValidPulseEnvelope(envelope)) return;
    const existing = this._workerAuthState.get(route);
    if (existing && existing.envelope?.token === envelope.token) return;
    if (existing?.timer) clearTimeout(existing.timer);
    const state = { envelope, timer: null, expired: existing?.expired === true };
    this._workerAuthState.set(route, state);
    this.#scheduleWorkerPulseRefresh(route);
  }

  /** @param {string} route */
  #scheduleWorkerPulseRefresh(route) {
    const state = this._workerAuthState.get(route);
    if (!state?.envelope) return;
    const refreshAtMs = Number(state.envelope.refreshAfter) * 1000;
    const delay = Number.isFinite(refreshAtMs)
      ? Math.max(refreshAtMs - Date.now(), PULSE_REFRESH_MIN_DELAY_MS)
      : PULSE_REFRESH_MIN_DELAY_MS;
    state.timer = setTimeout(() => { void this.#refreshWorkerPulse(route); }, delay);
    state.timer.unref?.();
  }

  /** @param {string} route */
  async #refreshWorkerPulse(route) {
    const state = this._workerAuthState.get(route);
    if (!state) return;
    state.timer = null;
    if (!this._daemon?.isHostAlive?.()) {
      // No live host to keep fresh; the next spawn re-seeds from its request.
      this.#clearWorkerAuthRoute(route);
      return;
    }
    let envelope = null;
    try {
      envelope = await this.#pulseManager().getPulseEnvelope({ requiredRoute: route, refresh: true });
    } catch {
      envelope = null;
    }
    if (isValidPulseEnvelope(envelope)) {
      if (this.#sendWorkerControlFrame(this.#refreshControlFrame(/** @type {Record<string, unknown>} */ (envelope)))) {
        state.expired = false;
        state.envelope = /** @type {Record<string, unknown>} */ (envelope);
        this.#scheduleWorkerPulseRefresh(route);
      } else {
        this.#clearWorkerAuthRoute(route);
      }
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = Number(state.envelope?.expiresAt) || nowSeconds;
    if (nowSeconds >= expiresAt) {
      // Could not refresh in time: tell the worker, then park protected work
      // for this route until a refresh frame is delivered (see #runViaWorker).
      this.#sendWorkerControlFrame(this.#expiredControlFrame(route, expiresAt));
      state.expired = true;
      appendRunTelemetry("diagnostics", {
        kind: "native.pulse_expired",
        binary: this.name,
        route,
        expired_at: expiresAt,
      });
      return;
    }
    // Pulse still valid: retry the mint before expiry.
    const retryMs = Math.min(PULSE_REFRESH_RETRY_MS, Math.max((expiresAt - nowSeconds) * 1000, PULSE_REFRESH_MIN_DELAY_MS));
    state.timer = setTimeout(() => { void this.#refreshWorkerPulse(route); }, retryMs);
    state.timer.unref?.();
  }

  /** @param {string} route */
  #clearWorkerAuthRoute(route) {
    const state = this._workerAuthState.get(route);
    if (state?.timer) clearTimeout(state.timer);
    this._workerAuthState.delete(route);
  }

  #clearWorkerAuthState() {
    for (const route of [...this._workerAuthState.keys()]) this.#clearWorkerAuthRoute(route);
  }

  #retireWorkerAfterAuthFailure() {
    this.#clearWorkerAuthState();
    try {
      if (this._daemon?.isHostAlive?.()) this._daemon.retire({ graceMs: 0 });
    } catch { /* best effort */ }
  }

  /**
   * Build the child env. Starts from the caller's env or the runtime env, and
   * for key-gated Posse binaries injects POSSE_HEARTBEAT_URL (canonical native
   * heartbeat route on the central server) when it isn't already present. These
   * binaries require heartbeat auth and shouldn't depend on ambient shell setup.
   *
   * @param {NodeJS.ProcessEnv} [optsEnv]
   * @returns {NodeJS.ProcessEnv}
   */
  #childEnv(optsEnv) {
    const base = optsEnv || buildRuntimeEnv();
    if (!this.keyGated) return base;
    const env = { ...base };
    // Native helpers never receive the raw Posse API key — not in argv, env,
    // or stdin. They authenticate with short-lived pulse envelopes minted by
    // the manager-owned broker. Never let them discover the key from ambient
    // (or caller-supplied) env.
    delete env.POSSE_KEY;
    const auth = this.#authManager().getNativeAuthEnvelope();
    const url = String(auth?.heartbeatUrl || "").trim();
    if (url) env.POSSE_HEARTBEAT_URL = url;
    else delete env.POSSE_HEARTBEAT_URL;
    return env;
  }

  /** @returns {RunResult} */
  #nativeAuthUnavailableResult() {
    // Wording is load-bearing: the heartbeat-failure classifiers
    // (isNativeHeartbeatAuthFailure here, shouldRetryNativeHeartbeat in the
    // git invoke boundary) match on "heartbeat"/"pulse token". Never include
    // token material in this message.
    const error = new Error(`native pulse token heartbeat auth unavailable for ${this.name}; refusing to start key-gated binary`);
    error.code = "POSSE_NATIVE_HEARTBEAT_UNAVAILABLE";
    return {
      ok: false,
      code: null,
      signal: null,
      stdout: "",
      stderr: error.message,
      error,
    };
  }

  /** @returns {RunResult} */
  #unavailableResult() {
    return {
      ok: false,
      code: null,
      signal: null,
      stdout: "",
      stderr: `native binary not available: ${this.name} (expected ${this.expectedPath() || "<unknown>"})`,
      error: new Error(`native binary not available: ${this.name}`),
    };
  }

  /**
   * @param {{ stdout: string, stderr: string, code: number | null, signal: string | null, error: Error | null }} raw
   * @param {boolean} wantJson
   * @returns {RunResult}
   */
  #finishResult(raw, wantJson) {
    let ok = !raw.error && raw.code === 0;
    /** @type {RunResult} */
    const result = {
      ok,
      code: raw.code,
      signal: raw.signal,
      stdout: raw.stdout,
      stderr: raw.stderr,
      error: raw.error,
    };
    if (wantJson && ok) {
      try {
        result.json = JSON.parse(raw.stdout);
      } catch (err) {
        result.ok = false;
        result.error = /** @type {Error} */ (err);
      }
    }
    return result;
  }

  /** @param {import("node:child_process").ChildProcess} child */
  #kill(child) {
    if (!child || child.exitCode != null || child.killed) return;
    if (process.platform === "win32" && child.pid) {
      try {
        const killer = this._spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref?.();
        return;
      } catch { /* fall through to signal */ }
    }
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}
