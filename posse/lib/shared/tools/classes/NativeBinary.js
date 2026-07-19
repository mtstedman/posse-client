// @ts-check
//
// NativeBinary — a thin, OS/arch-aware wrapper around one Rust-compiled helper
// binary (e.g. posse-atlas, posse-git) staged under lib/bin/<name>/<os>/...
//
// Responsibilities:
//   - Resolve the correct build for the current os/arch from the catalog
//     (lib/catalog/binary.js), preferring a direct development override under
//     lib/bin/<name>/..., then a downloaded version under the catalog-owned
//     package path lib/bin/<package>/<version>/....
//   - Report availability so migration code can decide when a Rust-owned
//     method is callable. Availability is not a fallback policy.
//   - Invoke it protocol-agnostically: pass a subcommand + args, optionally
//     pipe a stdin payload, capture stdout (with an opt-in JSON parse).
//
// Invocation wrapping mirrors lib/shared/tools/classes/McpServer.js: injected spawn
// impls for testability, windowsHide, and taskkill-based termination on win32.

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import {
  ATLAS_VECTOR_NATIVE_ROUTE,
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
import { NativeAuthHandshake } from "../../native/classes/NativeAuthHandshake.js";
import { PulseTokenManager } from "../../native/classes/PulseTokenManager.js";
import {
  defaultNativeBinRoot,
  installedNativeArtifactVersionsSync,
  nativeArtifactLayout,
  nativeDevelopmentBinaryPaths,
} from "../../native/functions/artifact-layout.js";

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
const WORKER_PULL_BOOTSTRAP_WAIT_MS = 500;
const WORKER_PULL_GRANT_WAIT_MS = 30_000;

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

function isUnsupportedNativeVersionError(error) {
  return error?.code === "POSSE_PULSE_NATIVE_VERSION_UNSUPPORTED"
    || error?.code === "POSSE_NATIVE_VERSION_UNSUPPORTED"
    || error?.remoteCode === "unsupported_native_version";
}

/** @typedef {Error & { code?: string, status?: number | null, remoteCode?: string }} NativeBinaryError */

/**
 * @typedef {object} PulseEnvelopeProvider
 * @property {(options: any) => Promise<Readonly<Record<string, any>> | null>} getPulseEnvelope
 * @property {(options: any) => Readonly<Record<string, any>> | null} getCachedPulseEnvelope
 */

/**
 * @typedef {object} NativeRunOptions
 * @property {Buffer | string} [input]
 * @property {boolean} [json]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {boolean} [worker]
 * @property {string[]} [workerArgs]
 * @property {boolean} [workerFallback]
 * @property {boolean} [idempotent]
 * @property {number} [maxBuffer]
 * @property {string} [requiredRoute]
 * @property {(event: unknown) => void} [onProgress]
 */

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
   *   pulseManager?: PulseEnvelopeProvider,
   *   exactVersion?: string | null,
   *   heartbeatVersion?: string | null,
   *   spawnImpl?: typeof spawn,
   *   spawnSyncImpl?: typeof spawnSync,
   * }} args
   */
  constructor({ name, binRoot, platform, arch, env, nativeAuthManager, pulseManager, exactVersion = undefined, heartbeatVersion = null, spawnImpl = spawn, spawnSyncImpl = spawnSync } = /** @type {any} */ ({})) {
    if (!name) throw new TypeError("NativeBinary: name is required");
    this.name = name;
    this._binRoot = binRoot || null;
    this._env = env || null;
    // Single native-auth authority. Production injects the shared manager via
    // BinaryManager; standalone construction (tests) lazily derives one from
    // settings/env for the heartbeat envelope and pulse minting. Leaf call
    // sites never supply native keys.
    this._nativeAuthManager = nativeAuthManager || null;
    // Pulse broker: owns or inherits the process heartbeat and returns
    // route-labelled views of its signed grant. Injectable for tests; lazily
    // derived from the auth manager otherwise. Native children never see the
    // root credential.
    this._fixedPulseManager = pulseManager || null;
    /** @type {import("../../native/classes/PulseTokenManager.js").PulseTokenManager | null} */
    this._pulseManager = null;
    this._pulseManagerAuth = null;
    /** Parent-minted, route-scoped pulse envelopes for child thread runtimes. */
    this._runtimePulseEnvelopes = new Map();
    /**
     * Per-route pulse state delivered to the live persistent worker: the last
     * envelope sent, the scheduled refresh timer, and whether an expired
     * control frame has parked protected work for the route.
     * @type {Map<string, { envelope: Record<string, unknown>, timer: NodeJS.Timeout | null, expired: boolean }>}
     */
    this._workerAuthState = new Map();
    /** @type {Map<string, Array<{ finish: (value: boolean) => void, claim: () => void }>>} */
    this._workerAuthWaiters = new Map();
    /** @type {Map<string, Promise<readonly string[]>>} */
    this._workerAuthHandoffs = new Map();
    /** @type {Map<string, Promise<boolean>>} */
    this._workerAuthGates = new Map();
    /** Permanent-for-this-artifact route failures. Replacing the handle clears them. */
    this._workerAuthFailures = new Map();
    this._workerPullManaged = false;
    this._nativeAuthHandshake = null;
    this._nativeAuthHandshakePulseManager = null;
    this.keyGated = nativeBinaryIsKeyGated(name);
    this.workerCapable = nativeBinaryIsWorkerCapable(name);
    this.exactVersion = exactVersion === undefined ? nativeBinaryExactVersion(name) : exactVersion;
    this.heartbeatVersion = heartbeatVersion;
    this._versionProbe = null;
    this._nativePulseIdentity = null;
    /** @type {import("./daemon/index.js").Daemon | null} */
    this._daemon = null;
    /** @type {string[] | null} */
    this._configuredWorkerArgs = null;
    /** @type {Promise<void>} Serialize worker configurations whose startup argv differs (ML model roots). */
    this._workerArgsTail = Promise.resolve();
    /** Exact concurrent Git reads share one serial-worker request. */
    this._coalescedGitReads = new Map();
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
    return this._configuredWorkerArgs
      ? [...this._configuredWorkerArgs]
      : ["worker", "--stdio"];
  }

  /**
   * Run against a worker whose startup argv is part of the request contract.
   * A NativeBinary owns one daemon at a time, so root changes are serialized
   * and retire the old host before the replacement starts. Same-root calls
   * reuse the warm host and its loaded model session.
   *
   * @param {string | null} subcommand
   * @param {string[]} args
   * @param {NativeRunOptions & { workerArgs: string[] }} opts
   * @returns {Promise<RunResult>}
   */
  async #runViaConfiguredWorker(subcommand, args, opts) {
    const workerArgs = opts.workerArgs.map((value) => String(value));
    if (workerArgs.length === 0 || workerArgs.some((value) => value.length === 0)) {
      const error = new TypeError(`native ${this.name} workerArgs must contain non-empty strings`);
      return { ok: false, code: null, signal: null, stdout: "", stderr: error.message, error };
    }

    const previous = this._workerArgsTail;
    /** @type {() => void} */
    let release = () => {};
    this._workerArgsTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const changed = !this._configuredWorkerArgs
        || this._configuredWorkerArgs.length !== workerArgs.length
        || this._configuredWorkerArgs.some((value, index) => value !== workerArgs[index]);
      if (changed) {
        this.#clearWorkerAuthState();
        const daemon = this._daemon;
        // Model-root changes are deliberate host replacements, not crashes.
        // Retire lets the old process drain and exempts the replacement from
        // crash-breaker accounting; the serialized queue guarantees no prior
        // configured-root request is still active here.
        if (daemon) daemon.retire({});
        this._configuredWorkerArgs = workerArgs;
      }
      return await this.#runViaWorker(subcommand, args, opts);
    } finally {
      release();
    }
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
          onControl: (message, daemon) => this.#handleWorkerControl(message, daemon),
          onLifecycle: (event) => {
            if (event.kind === "spawn") {
              this.#clearWorkerAuthState();
              this._workerPullManaged = false;
            }
          },
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
        await this.ensureNativeAuth([route]);
      } catch { /* dispatch fails closed when no pulse is available */ }
    }));
  }

  /**
   * Establish the route grants this handle will need before any protected
   * native call runs. Unlike the fire-and-forget prewarm used by lazy daemon
   * construction, startup callers await this strict form so a cold or rejected
   * heartbeat fails at the boot boundary instead of surfacing later from a
   * synchronous native helper.
   *
   * @param {string[]} [routes]
   * @returns {Promise<Readonly<Record<string, unknown>>[]>}
   */
  async ensureNativeAuth(routes = []) {
    if (!this.keyGated) return [];
    const list = [...new Set(
      (Array.isArray(routes) && routes.length > 0 ? routes : this.#defaultRoutes())
        .map((route) => String(route || "").trim())
        .filter(Boolean),
    )];
    const envelopes = await Promise.all(list.map((route) => (
      this.#pulseManager().getPulseEnvelope(this.#versionedPulseOptions(route))
    )));
    if (envelopes.some((envelope) => !isValidPulseEnvelope(envelope))) {
      throw new Error(`native pulse token heartbeat auth unavailable for ${this.name}`);
    }
    return /** @type {Readonly<Record<string, unknown>>[]} */ (envelopes);
  }

  /** Route grants this binary requests when no explicit route is threaded. */
  #defaultRoutes() {
    if (this.name === "atlas") return ["atlas:methods"];
    if (this.name === "vector") return [ATLAS_VECTOR_NATIVE_ROUTE];
    // Worker-routed git methods are the read-only set; mutating calls thread
    // `git:mutate` explicitly from the invoke boundary.
    if (this.name === "git") return ["git:read"];
    return [`${this.name}:methods`];
  }

  async #handleWorkerControl(message, daemon) {
    const control = String(message?.control || "");
    const capability = String(message?.capability || "native.pulse");
    if (control !== "nativeAuthRequest"
      && !(control === "capabilityRequest" && capability === "native.pulse")) return;
    const requested = [...new Set(
      (Array.isArray(message?.routes) ? message.routes : message?.scopes)
        ?.map?.((route) => String(route || "").trim())
        .filter(Boolean) || [],
    )];
    if (requested.length === 0) return;
    let resolveHandoff = /** @type {(routes: readonly string[]) => void} */ (() => {});
    const handoff = new Promise((resolve) => { resolveHandoff = resolve; });
    for (const route of requested) this._workerAuthHandoffs.set(route, handoff);
    this._workerPullManaged = true;
    for (const route of requested) this.#claimWorkerAuthWaiters(route);
    const deliveredRoutes = [];
    try {
      const grant = await this.#nativeAuthHandshake().issue({
        protocol: message?.protocol,
        requestId: String(message?.requestId || `native-${this.name}-${Date.now()}`),
        capability: "native.pulse",
        scopes: requested,
      });
      const pulses = grant.artifacts.tokens.pulses || {};
      for (const route of grant.scopes) {
        const pulse = pulses[route];
        if (!isValidPulseEnvelope(pulse)) continue;
        if (!daemon.sendControl(this.#refreshControlFrame(pulse))) continue;
        this.#noteWorkerPulse(route, pulse);
        this.#resolveWorkerAuthWaiters(route, true);
        deliveredRoutes.push(route);
      }
    } catch (error) {
      if (isUnsupportedNativeVersionError(error)) {
        for (const route of requested) this._workerAuthFailures.set(route, error);
      }
      for (const route of requested) this.#resolveWorkerAuthWaiters(route, false);
      appendRunTelemetry("diagnostics", {
        kind: "native.capability_handoff_failed",
        binary: this.name,
        routes: requested,
        code: String(error?.code || "POSSE_CAPABILITY_HANDOFF_FAILED"),
        remote_code: String(error?.remoteCode || "") || null,
        status: Number(error?.status) || null,
      });
      // The worker keeps its previous live pulse and asks again. Protected work
      // remains fail-closed if no valid grant can be handed down.
    } finally {
      resolveHandoff(Object.freeze([...deliveredRoutes]));
      for (const route of requested) {
        if (this._workerAuthHandoffs.get(route) === handoff) {
          this._workerAuthHandoffs.delete(route);
        }
      }
    }
  }

  #resolveWorkerAuthWaiters(route, value) {
    const waiters = this._workerAuthWaiters.get(route) || [];
    this._workerAuthWaiters.delete(route);
    for (const waiter of waiters) waiter.finish(value);
  }

  #claimWorkerAuthWaiters(route) {
    const waiters = this._workerAuthWaiters.get(route) || [];
    for (const waiter of waiters) waiter.claim();
  }

  async #awaitWorkerAuthHandoff(route) {
    const handoff = this._workerAuthHandoffs.get(route);
    if (!handoff) return isValidPulseEnvelope(this._workerAuthState.get(route)?.envelope);
    let handoffTimer = null;
    const delivered = await Promise.race([
      handoff.then((routes) => routes.includes(route)),
      new Promise((resolve) => {
        handoffTimer = setTimeout(() => resolve(false), WORKER_PULL_GRANT_WAIT_MS);
      }),
    ]);
    if (handoffTimer) clearTimeout(handoffTimer);
    return delivered || isValidPulseEnvelope(this._workerAuthState.get(route)?.envelope);
  }

  async #ensureWorkerRouteAuth(route, fallbackPulse = null) {
    if (isUnsupportedNativeVersionError(this._workerAuthFailures.get(route))) return false;
    const daemon = this.#daemon();
    const live = this._workerAuthState.get(route)?.envelope;
    if (daemon.isHostAlive() && isValidPulseEnvelope(live)) return true;
    const existing = this._workerAuthGates.get(route);
    if (existing) return existing;
    const gate = this.#establishWorkerRouteAuth(route, fallbackPulse);
    this._workerAuthGates.set(route, gate);
    try {
      return await gate;
    } finally {
      if (this._workerAuthGates.get(route) === gate) this._workerAuthGates.delete(route);
    }
  }

  async #establishWorkerRouteAuth(route, fallbackPulse = null) {
    const daemon = this.#daemon();
    let timer = null;
    const pulled = new Promise((resolve) => {
      let settled = false;
      const waiter = {
        finish: (value) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const current = this._workerAuthWaiters.get(route) || [];
          const remaining = current.filter((candidate) => candidate !== waiter);
          if (remaining.length > 0) this._workerAuthWaiters.set(route, remaining);
          else this._workerAuthWaiters.delete(route);
          resolve(value);
        },
        claim: () => {
          if (settled) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => waiter.finish(false), WORKER_PULL_GRANT_WAIT_MS);
        },
      };
      const waiters = this._workerAuthWaiters.get(route) || [];
      waiters.push(waiter);
      this._workerAuthWaiters.set(route, waiters);
      timer = setTimeout(() => waiter.finish(false), WORKER_PULL_BOOTSTRAP_WAIT_MS);
    });
    if (!daemon.ensureStarted()) {
      if (timer) clearTimeout(timer);
      this.#resolveWorkerAuthWaiters(route, false);
      return false;
    }
    const granted = await pulled;
    if (timer) clearTimeout(timer);
    if (granted) return true;
    if (this._workerPullManaged) return this.#awaitWorkerAuthHandoff(route);
    // Rollout bridge for an already-released worker that predates pull: seed it
    // once over the same private pipe. New workers request this themselves.
    try {
      if (!isValidPulseEnvelope(fallbackPulse)) {
        fallbackPulse = await this.#pulseManager().getPulseEnvelope(
          this.#versionedPulseOptions(route),
        );
      }
      if (this._workerPullManaged) return this.#awaitWorkerAuthHandoff(route);
      if (!isValidPulseEnvelope(fallbackPulse) || String(fallbackPulse?.route || "") !== route) {
        fallbackPulse = null;
      }
    } catch (error) {
      if (isUnsupportedNativeVersionError(error)) this._workerAuthFailures.set(route, error);
      fallbackPulse = null;
    }
    if (!isValidPulseEnvelope(fallbackPulse)) return false;
    if (!daemon.sendControl(this.#refreshControlFrame(fallbackPulse))) return false;
    this.#noteWorkerPulse(route, fallbackPulse);
    return true;
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
   * @param {NativeRunOptions} opts
   * @returns {Promise<RunResult>}
   */
  async #runViaWorker(subcommand, args, opts) {
    const parsed = this.#parseNativeProtocolInput(opts.input);
    const route = parsed.protocol ? this.#requiredRouteFor(opts.requiredRoute) : null;
    const requestOpts = {
      ...opts,
      input: parsed.protocol
        ? this.#encodeNativeRequest(/** @type {Record<string, unknown>} */ (parsed.request), parsed.wasBuffer)
        : parsed.input,
    };
    let envelope = parsed.request;
    if (!envelope) {
      try {
        envelope = JSON.parse(String(requestOpts.input));
      } catch {
        return this.#runPerCall(subcommand, args, requestOpts);
      }
    }
    if (route && !(await this.#ensureWorkerRouteAuth(route))) {
      const authFailure = this._workerAuthFailures.get(route);
      if (isUnsupportedNativeVersionError(authFailure)) {
        return this.#nativeVersionUnsupportedResult(authFailure);
      }
      this.#noteWorkerFallback("auth_handshake_unavailable", subcommand);
      if (opts.workerFallback === false) return this.#nativeAuthUnavailableResult();
      return this.#runPerCall(subcommand, args, requestOpts);
    }
    // Persistent workers authenticate from the grant they pulled at boot or
    // refresh time. Keep the request-borne envelope only for the one-shot
    // compatibility path; normal daemon calls no longer re-authorize every
    // command.
    const workerEnvelope = { ...envelope };
    delete workerEnvelope.pulse;
    let response = await this.#daemon().request(workerEnvelope, {
      signal: requestOpts.signal,
      timeoutMs: requestOpts.timeoutMs,
      onProgress: requestOpts.onProgress,
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
      if (!route || await this.#ensureWorkerRouteAuth(route)) {
        response = await this.#daemon().request(workerEnvelope, {
          signal: requestOpts.signal,
          timeoutMs: requestOpts.timeoutMs,
          onProgress: requestOpts.onProgress,
        });
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
      // An overload is rejected before Daemon.send(), so a one-shot fallback
      // cannot duplicate work. A timeout or lost transport is different: the
      // worker may have committed before its reply disappeared. Preserve the
      // caller's non-idempotent contract and surface the uncertain outcome
      // instead of replaying it in a second process.
      const replayUnsafe = opts.idempotent === false && reason !== "overloaded";
      if (opts.workerFallback === false || replayUnsafe) {
        const error = /** @type {NativeBinaryError} */ (
          new Error(`native ${this.name} worker unavailable (${reason})`)
        );
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
    if (response?.ok === false && isNativeHeartbeatAuthFailure(
      /** @type {any} */ (response?.error)?.message || response?.message,
    )) {
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
    return this._binRoot || process.env.POSSE_NATIVE_BIN_ROOT || defaultNativeBinRoot();
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
    const direct = nativeDevelopmentBinaryPaths({
      binRoot: this.binRoot,
      name: this.name,
      os: this.os,
      arch: this.arch,
    });
    const entry = nativeBinaryEntry(this.name);
    if (!entry?.package) return direct;
    const versions = this.exactVersion
      ? [this.exactVersion]
      : installedNativeArtifactVersionsSync({ binRoot: this.binRoot, name: this.name });
    const downloaded = versions
      .map((version) => nativeArtifactLayout({
        binRoot: this.binRoot,
        name: this.name,
        version,
        os: this.os,
        arch: this.arch,
      })?.binaryPath)
      .filter(Boolean);
    return this.exactVersion
      ? [...downloaded, ...direct]
      : [...direct, ...downloaded];
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
    if (this.exactVersion) {
      const downloaded = nativeArtifactLayout({
        binRoot: this.binRoot,
        name: this.name,
        version: this.exactVersion,
        os: this.os,
        arch: this.arch,
      });
      if (downloaded) return downloaded.binaryPath;
    }
    const candidates = nativeDevelopmentBinaryPaths({
      binRoot: this.binRoot,
      name: this.name,
      os: this.os,
      arch: this.arch,
    });
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
   * @param {NativeRunOptions} [opts]
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
   * @param {NativeRunOptions} [opts]
   * @returns {RunResult}
   */
  #runSyncPerCall(subcommand, args = [], opts = {}) {
    const bin = this.resolvePath();
    if (!bin) return this.#unavailableResult();
    const fullArgs = this.#buildArgs(subcommand, args);
    const inputWithAuth = this.#inputWithNativeAuthSync(opts.input, opts.requiredRoute);
    if (this.#shouldFailMissingNativeAuth(inputWithAuth.request)) {
      this.#retireWorkerAfterAuthFailure();
      return inputWithAuth.pulseCold
        ? this.#nativePulseColdResult()
        : this.#nativeAuthUnavailableResult();
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
   * @param {NativeRunOptions} [opts]
   * @returns {Promise<RunResult>}
   */
  run(subcommand, args = [], opts = {}) {
    if (this.workerCapable && opts.worker === true) {
      if (Array.isArray(opts.workerArgs)) {
        return this.#runViaConfiguredWorker(subcommand, args, /** @type {any} */ (opts));
      }
      if (this.name === "git"
        && opts.idempotent !== false
        && !opts.signal
        && typeof opts.onProgress !== "function"
        && (!opts.requiredRoute || opts.requiredRoute === "git:read")) {
        const input = typeof opts.input === "string"
          ? opts.input
          : Buffer.isBuffer(opts.input)
            ? opts.input.toString("utf8")
            : "";
        if (input && input.length <= 64 * 1024) {
          const key = `${subcommand || ""}\u0000${opts.timeoutMs || ""}\u0000${input}`;
          const existing = this._coalescedGitReads.get(key);
          if (existing) {
            appendRunTelemetry("diagnostics", {
              kind: "native.worker_request_coalesced",
              binary: this.name,
              method: subcommand,
            });
            return existing;
          }
          const request = Promise.resolve(this.#runViaWorker(subcommand, args, opts)).finally(() => {
            if (this._coalescedGitReads.get(key) === request) this._coalescedGitReads.delete(key);
          });
          this._coalescedGitReads.set(key, request);
          return request;
        }
      }
      return this.#runViaWorker(subcommand, args, opts);
    }
    return this.#runPerCall(subcommand, args, opts);
  }

  /**
   * Async per-call spawn (one process per invocation).
   *
   * @param {string | null} subcommand
   * @param {string[]} args
   * @param {NativeRunOptions} [opts]
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
      if (inputWithAuth.error) {
        return this.#nativeVersionUnsupportedResult(inputWithAuth.error);
      }
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
   * Mint least-privilege pulse envelopes for a child thread. Only signed,
   * expiring route grants cross the workerData boundary; the raw launch key
   * remains parent-owned.
   *
   * @param {string[]} [routes]
   * @param {{ strict?: boolean }} [options]
   * @returns {Promise<Record<string, Record<string, unknown>>>}
   */
  async workerPulseCapability(routes = [], { strict = false } = {}) {
    if (!this.keyGated) return {};
    const selected = Array.isArray(routes) && routes.length > 0 ? routes : this.#defaultRoutes();
    /** @type {Record<string, Record<string, unknown>>} */
    const pulses = {};
    for (const routeValue of [...new Set(selected)]) {
      const route = String(routeValue || "").trim();
      if (!route) continue;
      let pulse = null;
      try {
        pulse = await this.#pulseManager().getPulseEnvelope(this.#versionedPulseOptions(route));
      } catch (error) {
        if (strict || isUnsupportedNativeVersionError(error)) throw error;
        pulse = null;
      }
      if (isValidPulseEnvelope(pulse) && String(/** @type {any} */ (pulse).route || "") === route) {
        pulses[route] = { .../** @type {Record<string, unknown>} */ (pulse) };
      } else if (strict) {
        const error = /** @type {NativeBinaryError} */ (
          new Error(`native pulse token heartbeat auth unavailable for ${this.name}`)
        );
        error.code = "POSSE_NATIVE_HEARTBEAT_UNAVAILABLE";
        throw error;
      }
    }
    return pulses;
  }

  /** Install parent-minted route grants into a child thread runtime. */
  installWorkerPulseCapability(pulses) {
    this._runtimePulseEnvelopes.clear();
    if (!pulses || typeof pulses !== "object" || Array.isArray(pulses)) return [];
    const installed = [];
    for (const [route, pulse] of Object.entries(pulses)) {
      if (!route || !isValidPulseEnvelope(pulse)) continue;
      if (String(/** @type {any} */ (pulse).route || "") !== route) continue;
      this._runtimePulseEnvelopes.set(route, Object.freeze({ .../** @type {Record<string, unknown>} */ (pulse) }));
      installed.push(route);
    }
    return installed;
  }

  /** Stop this handle's daemon and all scheduled pulse refreshes. */
  async dispose() {
    this.#clearWorkerAuthState();
    this._workerAuthHandoffs.clear();
    this._workerAuthGates.clear();
    this._workerAuthFailures.clear();
    this._coalescedGitReads.clear();
    this._runtimePulseEnvelopes.clear();
    const daemon = this._daemon;
    this._daemon = null;
    if (daemon) await daemon.dispose();
  }

  /**
   * Identify the exact native artifact asking for a heartbeat. A local staged
   * binary is probed with `--version`; remotely selected artifacts already
   * carry their exact version. The path and mtime bind the cache so replacing
   * a binary cannot keep renewing under the previous artifact's identity.
   *
   * @returns {{ package: string, version: string }}
   */
  #nativeHeartbeatIdentity() {
    const packageName = String(nativeBinaryEntry(this.name)?.package || "").trim();
    const binaryPath = this.resolvePath();
    if (!packageName || !binaryPath) {
      throw new Error("native heartbeat requires an available versioned binary");
    }
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(binaryPath).mtimeMs; } catch {
      throw new Error("native heartbeat could not inspect the binary version");
    }
    if (this._nativePulseIdentity?.path === binaryPath
      && this._nativePulseIdentity?.mtimeMs === mtimeMs) {
      return this._nativePulseIdentity.identity;
    }
    let version = String(this.heartbeatVersion || this.exactVersion || "").trim();
    if (!version) {
      const reported = String(this.version() || "").trim();
      const prefix = `${packageName} `;
      if (!reported.startsWith(prefix)) {
        throw new Error("native heartbeat could not determine the binary version");
      }
      version = reported.slice(prefix.length).trim();
    }
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(version) || version.includes("..")) {
      throw new Error("native heartbeat binary version is invalid");
    }
    const identity = Object.freeze({ package: packageName, version });
    this._nativePulseIdentity = { path: binaryPath, mtimeMs, identity };
    return identity;
  }

  /** @param {string} requiredRoute @param {boolean} [refresh] */
  #versionedPulseOptions(requiredRoute, refresh = false) {
    const identity = this.#nativeHeartbeatIdentity();
    return {
      requiredRoute,
      refresh,
      nativePackage: identity.package,
      nativeVersion: identity.version,
    };
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
   * @returns {PulseEnvelopeProvider}
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

  #nativeAuthHandshake() {
    const pulseManager = this.#pulseManager();
    if (!this._nativeAuthHandshake || this._nativeAuthHandshakePulseManager !== pulseManager) {
      this._nativeAuthHandshake = new NativeAuthHandshake({
        pulseManager,
        pulseOptionsForRoute: (route) => this.#versionedPulseOptions(route),
      });
      this._nativeAuthHandshakePulseManager = pulseManager;
    }
    return this._nativeAuthHandshake;
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
   * Mint (or reuse) the route-scoped pulse for an already-parsed protocol
   * request and attach it as `request.pulse`.
   *
   * @param {{ input: Buffer | string | undefined, request: Record<string, unknown> | null, wasBuffer: boolean }} parsed
   * @param {string | undefined} requiredRoute
   * @returns {Promise<{ input: Buffer | string | undefined, request: Record<string, unknown> | null, route: string | null, error?: Error }>}
   */
  async #attachPulseAsync(parsed, requiredRoute) {
    const route = this.#requiredRouteFor(requiredRoute);
    let pulse = this.#runtimePulseFor(route);
    if (!pulse) {
      try {
        pulse = await this.#pulseManager().getPulseEnvelope(this.#versionedPulseOptions(route));
      } catch (error) {
        // Mint failures fail closed below; error details (which never include
        // token material) are not propagated into the child request.
        if (isUnsupportedNativeVersionError(error)) {
          this._workerAuthFailures.set(route, error);
          return {
            input: this.#encodeNativeRequest(/** @type {Record<string, unknown>} */ (parsed.request), parsed.wasBuffer),
            request: parsed.request,
            route,
            error,
          };
        }
        pulse = null;
      }
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
   * @returns {{ input: Buffer | string | undefined, request: Record<string, unknown> | null, route: string | null, pulseCold?: boolean }}
   */
  #inputWithNativeAuthSync(input, requiredRoute) {
    const parsed = this.#parseNativeProtocolInput(input);
    if (!parsed.protocol) return { input: parsed.input, request: parsed.request, route: null, pulseCold: false };
    const route = this.#requiredRouteFor(requiredRoute);
    let pulse = this.#runtimePulseFor(route);
    if (!pulse) {
      try {
        pulse = this.#pulseManager().getCachedPulseEnvelope(this.#versionedPulseOptions(route));
      } catch {
        pulse = null;
      }
    }
    if (!isValidPulseEnvelope(pulse)) {
      this.#warmPulse(route);
      return {
        input: this.#encodeNativeRequest(/** @type {Record<string, unknown>} */ (parsed.request), parsed.wasBuffer),
        request: parsed.request,
        route,
        pulseCold: true,
      };
    }
    const requestWithPulse = { .../** @type {Record<string, unknown>} */ (parsed.request), pulse };
    return {
      input: this.#encodeNativeRequest(requestWithPulse, parsed.wasBuffer),
      request: requestWithPulse,
      route,
      pulseCold: false,
    };
  }

  /** Fire-and-forget background mint so a later sync call finds a cached pulse. */
  #warmPulse(route) {
    try {
      void Promise.resolve(
        this.#pulseManager().getPulseEnvelope(this.#versionedPulseOptions(route)),
      ).catch(() => {});
    } catch { /* fail-closed guard already covers the caller */ }
  }

  #runtimePulseFor(route) {
    const pulse = this._runtimePulseEnvelopes.get(route) || null;
    if (isValidPulseEnvelope(pulse) && String(pulse?.route || "") === route) return pulse;
    if (pulse) this._runtimePulseEnvelopes.delete(route);
    return null;
  }

  // -------------------------------------------------------------------------
  // Rollout-only persistent-worker refresh for binaries that predate daemon
  // pull. New workers request auth at boot and refresh-due, so this scheduler
  // is disabled as soon as a pull request is observed.
  // -------------------------------------------------------------------------

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
    return daemon?.sendControl?.(frame) === true;
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
   * Track the pulse most recently delivered to the live worker for a route and
   * (re)schedule its refresh at `refreshAfter`.
   *
   * @param {string} route
   * @param {Record<string, unknown>} envelope
   */
  #noteWorkerPulse(route, envelope) {
    if (!route || !isValidPulseEnvelope(envelope)) return;
    this._workerAuthFailures.delete(route);
    const existing = this._workerAuthState.get(route);
    if (existing && existing.envelope?.token === envelope.token) {
      if (this._workerPullManaged && existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = null;
      }
      return;
    }
    if (existing?.timer) clearTimeout(existing.timer);
    const state = { envelope, timer: null, expired: existing?.expired === true };
    this._workerAuthState.set(route, state);
    if (!this._workerPullManaged) this.#scheduleWorkerPulseRefresh(route);
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
      envelope = await this.#pulseManager().getPulseEnvelope(
        this.#versionedPulseOptions(route, true),
      );
    } catch (error) {
      if (isUnsupportedNativeVersionError(error)) {
        this._workerAuthFailures.set(route, error);
        state.expired = true;
        const rejectedAt = Math.floor(Date.now() / 1000);
        this.#sendWorkerControlFrame(this.#expiredControlFrame(route, rejectedAt));
        appendRunTelemetry("diagnostics", {
          kind: "native.version_rejected",
          binary: this.name,
          route,
          code: String(error?.code || "POSSE_PULSE_NATIVE_VERSION_UNSUPPORTED"),
          remote_code: String(error?.remoteCode || "unsupported_native_version"),
          status: Number(error?.status) || null,
        });
        return;
      }
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
    this._runtimePulseEnvelopes.clear();
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
    const error = /** @type {NativeBinaryError} */ (
      new Error(`native pulse token heartbeat auth unavailable for ${this.name}; refusing to start key-gated binary`)
    );
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
    const fallback = () => {
      if (child.exitCode != null || child.killed) return;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (this.os === "windows" && child.pid) {
      try {
        const killer = this._spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        // spawn() reports a missing/broken taskkill asynchronously. Without a
        // listener the error is unhandled and, worse, the original native
        // process remains alive after its caller has already timed out.
        killer.once?.("error", fallback);
        killer.once?.("exit", (code) => { if (code !== 0) fallback(); });
        killer.unref?.();
        return;
      } catch { /* fall through to signal */ }
    }
    fallback();
  }

  /** @param {any} source @returns {RunResult} */
  #nativeVersionUnsupportedResult(source) {
    const error = /** @type {NativeBinaryError} */ (
      new Error(`native artifact version for ${this.name} is no longer authorized; artifact reconciliation is required`)
    );
    error.code = "POSSE_NATIVE_VERSION_UNSUPPORTED";
    error.status = source?.status ?? null;
    error.remoteCode = source?.remoteCode || "unsupported_native_version";
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
  #nativePulseColdResult() {
    const error = /** @type {NativeBinaryError} */ (
      new Error(`native pulse token cache cold for ${this.name}; background heartbeat mint requested`)
    );
    error.code = "POSSE_NATIVE_PULSE_COLD";
    return {
      ok: false,
      code: null,
      signal: null,
      stdout: "",
      stderr: error.message,
      error,
    };
  }
}
