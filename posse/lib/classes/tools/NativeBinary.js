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
// Invocation wrapping mirrors lib/classes/tools/McpServer.js: injected spawn
// impls for testability, windowsHide, and taskkill-based termination on win32.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { nativeBinaryPlatform, nativeBinaryIsKeyGated } from "../../catalog/binary.js";
import { osKey, archKey } from "../../shared/platform/functions/native-platform.js";
import { buildRuntimeEnv } from "../../domains/runtime/functions/paths.js";
import { signalAbortError } from "../../domains/runtime/functions/yield.js";
import { Daemon, ProcessTransport, daemonSupervisor } from "./daemon/index.js";
import { resolvePosseKey } from "../../domains/remote/functions/client.js";
import { POSSE_REMOTE_DEFAULT_URL } from "../../domains/remote/functions/mode.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// lib/classes/tools -> lib/bin
const DEFAULT_BIN_ROOT = path.resolve(THIS_DIR, "..", "..", "bin");
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Resolve the heartbeat URL the key-gated Posse binaries authenticate against.
 * They all talk to the same central server, so default to it. Precedence (from
 * the provided child env): explicit POSSE_HEARTBEAT_URL -> POSSE_REMOTE_URL base
 * -> central default. Reads only the passed env so callers/tests stay in control.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveHeartbeatUrl(env) {
  const explicit = String(env?.POSSE_HEARTBEAT_URL || "").trim();
  if (explicit) return explicit;
  const base = String(env?.POSSE_REMOTE_URL || POSSE_REMOTE_DEFAULT_URL).trim().replace(/\/+$/, "");
  return base ? `${base}/heartbeat` : "";
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
   *   posseKey?: string,
   *   env?: NodeJS.ProcessEnv,
   *   keyResolver?: () => string | null,
   *   spawnImpl?: typeof spawn,
   *   spawnSyncImpl?: typeof spawnSync,
   * }} args
   */
  constructor({ name, binRoot, platform, arch, posseKey, env, keyResolver, spawnImpl = spawn, spawnSyncImpl = spawnSync } = /** @type {any} */ ({})) {
    if (!name) throw new TypeError("NativeBinary: name is required");
    this.name = name;
    this._binRoot = binRoot || null;
    this._posseKey = posseKey || null;
    this._env = env || null;
    this._keyResolver = keyResolver || null;
    this.keyGated = nativeBinaryIsKeyGated(name);
    // posse-git and posse-atlas implement the `worker --stdio` persistent loop.
    this.workerCapable = name === "git" || name === "atlas";
    /** @type {import("./daemon/index.js").Daemon | null} */
    this._daemon = null;
    /**
     * Worker→per-call fallback visibility: every time a worker-eligible
     * request degrades to a per-call spawn the daemon layer is unhealthy, and
     * the transparent fallback would otherwise hide it completely. Counted
     * here, surfaced once per run at closeout (and via BinaryManager stats).
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

  /** Args to launch this binary's `worker --stdio` host (key first, like #buildArgs). */
  #buildWorkerArgs() {
    const out = [];
    if (this.keyGated) {
      const key = this.#resolveKey();
      if (key) out.push("--posse-key", key);
    }
    out.push("worker", "--stdio");
    return out;
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
    }
    return this._daemon;
  }

  /** @param {string} reason */
  #noteWorkerFallback(reason) {
    this.workerFallbacks.count += 1;
    this.workerFallbacks.byReason[reason] = (this.workerFallbacks.byReason[reason] || 0) + 1;
  }

  /**
   * After a request timeout: decide whether the host is wedged instead of
   * inferring it. Any reply to the probe — even an "unknown method" error from
   * hosts that predate daemon.ping — proves the request loop is alive, so the
   * slow request stays an isolated abandon. Only silence retires the host
   * (gracefully: EOF + drain window, never a mid-call kill). Single-flight so
   * a burst of timeouts can't stack probes.
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
      if (verdict === "silent") daemon.retire({});
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
   * @param {{ input?: Buffer | string, json?: boolean, timeoutMs?: number, key?: string, signal?: AbortSignal }} opts
   * @returns {Promise<RunResult>}
   */
  async #runViaWorker(subcommand, args, opts) {
    let envelope;
    try {
      envelope = JSON.parse(String(opts.input));
    } catch {
      return this.#runPerCall(subcommand, args, opts);
    }
    let response = await this.#daemon().request(envelope, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
    if (response?._transportGone === true && opts.signal?.aborted !== true) {
      // Host died/retired under this request. Everything routed through the
      // worker is read-only/idempotent by the WORKER_ELIGIBLE contract
      // (invoke.js), so one transparent retry on the replacement host is safe
      // and keeps the fast path instead of degrading to a per-call spawn.
      response = await this.#daemon().request(envelope, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      });
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
      this.#noteWorkerFallback(reason);
      return this.#runPerCall(subcommand, args, opts);
    }
    if (response?._aborted === true) {
      // Rebuild a real AbortError from the signal so callers preserve abort
      // identity (a cancelled native call must not read as a git failure).
      return {
        ok: false, code: null, signal: null, stdout: "", stderr: "aborted",
        error: opts.signal ? signalAbortError(opts.signal) : new Error("aborted"),
      };
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
    return this.resolvePath() != null;
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
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, key?: string, worker?: boolean }} [opts]
   * @returns {RunResult}
   */
  runSync(subcommand, args = [], opts = {}) {
    // Sync invocations are always per-call spawns. The Atomics SyncBridge that
    // used to serve `worker: true` here was removed: the sync method twins are
    // production-caller-less (async variants own the live paths), and the
    // bridge both wedged for the full wait timeout when its broker failed to
    // boot and stranded its host child on stop(). `opts.worker` is accepted
    // and ignored so shared call sites (invoke.js) need no sync/async forks.
    return this.#runSyncPerCall(subcommand, args, opts);
  }

  /**
   * Synchronous per-call spawn (one process per invocation).
   *
   * @param {string | null} subcommand
   * @param {string[]} [args]
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, key?: string }} [opts]
   * @returns {RunResult}
   */
  #runSyncPerCall(subcommand, args = [], opts = {}) {
    const bin = this.resolvePath();
    if (!bin) return this.#unavailableResult();
    const fullArgs = this.#buildArgs(subcommand, args, opts.key);
    const res = this._spawnSync(bin, fullArgs, {
      cwd: opts.cwd || process.cwd(),
      env: this.#childEnv(opts.env),
      input: opts.input,
      encoding: "utf8",
      windowsHide: true,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
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
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, key?: string, signal?: AbortSignal, worker?: boolean }} [opts]
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
   * @param {{ input?: Buffer | string, json?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, key?: string, signal?: AbortSignal }} [opts]
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
    const fullArgs = this.#buildArgs(subcommand, args, opts.key);
    return new Promise((resolve) => {
      let settled = false;
      const child = this._spawn(bin, fullArgs, {
        cwd: opts.cwd || process.cwd(),
        env: this.#childEnv(opts.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      child.stdout?.on("data", (d) => stdoutChunks.push(d));
      child.stderr?.on("data", (d) => stderrChunks.push(d));

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
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          code,
          signal,
          error,
        }, opts.json === true));
      };

      child.on("error", (err) => finish(null, null, err));
      child.on("close", (code, signal) => finish(code, signal, null));

      if (opts.input != null) {
        try {
          child.stdin?.end(opts.input);
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
   * Resolve the Posse key for a key-gated invocation: explicit option, then the
   * constructor value, then the POSSE_KEY env (read at call time).
   *
   * @param {string} [optKey]
   * @returns {string | null}
   */
  #resolveKey(optKey) {
    if (optKey) return optKey;
    if (this._posseKey) return this._posseKey;
    if (this._keyResolver) return this._keyResolver() || null;
    // POSSE_KEY only (env then Windows-persisted). NOT the remote API key —
    // these are distinct credentials and the binary is gated on POSSE_KEY.
    return resolvePosseKey(this._env || process.env) || null;
  }

  /**
   * Build the argv: for key-gated binaries, inject `--posse-key <key>` BEFORE
   * the positional command (clap consumes options ahead of the subcommand),
   * when a key is available. Stdin payloads are passed via spawn `input`, which
   * matches the binaries' default `-i -`.
   *
   * @param {string | null} subcommand
   * @param {string[]} args
   * @param {string} [optKey]
   * @returns {string[]}
   */
  #buildArgs(subcommand, args, optKey) {
    /** @type {string[]} */
    const out = [];
    if (this.keyGated) {
      const key = this.#resolveKey(optKey);
      if (key) out.push("--posse-key", key);
    }
    if (subcommand) out.push(subcommand);
    for (const a of args) out.push(a);
    return out;
  }

  /**
   * Build the child env. Starts from the caller's env or the runtime env, and
   * for key-gated Posse binaries injects POSSE_HEARTBEAT_URL (central server)
   * when it isn't already present — these binaries require it for heartbeat
   * auth and shouldn't depend on ambient shell setup.
   *
   * @param {NodeJS.ProcessEnv} [optsEnv]
   * @returns {NodeJS.ProcessEnv}
   */
  #childEnv(optsEnv) {
    const base = optsEnv || buildRuntimeEnv();
    if (!this.keyGated) return base;
    if (String(base.POSSE_HEARTBEAT_URL || "").trim()) return base;
    const url = resolveHeartbeatUrl(base);
    return url ? { ...base, POSSE_HEARTBEAT_URL: url } : base;
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
