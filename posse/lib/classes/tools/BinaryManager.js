// @ts-check
//
// BinaryManager — entry point for the OS/arch-aware native binary wrappers.
//
// Reads the catalog registry (lib/catalog/binary.js), resolves one
// NativeBinary handle per tool for the current host, and exposes the single
// predicate call sites use to decide whether a native method may be invoked:
//
//   if (nativeBinaries.shouldUse("atlas")) { ...call binary... }
//
// `shouldUse` = enabled AND available (build is staged for this os/arch).
// Git and ATLAS are fully cut over: enabled is hardwired true, so shouldUse
// reduces to availability and there is no JS fallback path. The migration
// recipe for remaining tools: mirror in Rust, A/B against the Node oracle,
// switch the call site to the binary, then delete the replaced Node function.

import { BINARY_NAMES, VALID_BINARY_NAMES } from "../../catalog/binary.js";
import { getNativeBinaryEnabled } from "../../domains/settings/functions/tunables.js";
import { heartbeatAuthManager } from "../../shared/native/classes/HeartbeatAuthManager.js";
import { NativeBinary } from "./NativeBinary.js";

/**
 * Parse an env override into a tri-state: `true`, `false`, or `null` (unset).
 *
 * @param {string | undefined} raw
 * @returns {boolean | null}
 */
function envFlag(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return null;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

export class BinaryManager {
  /**
   * @param {{
   *   binRoot?: string,
   *   platform?: NodeJS.Platform,
   *   arch?: string,
   *   spawnImpl?: import("node:child_process").spawn,
   *   spawnSyncImpl?: import("node:child_process").spawnSync,
   *   env?: NodeJS.ProcessEnv,
   *   enabledResolver?: (name: string) => boolean,
   *   nativeAuthManager?: import("../../shared/native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager,
   * }} [opts]
   */
  constructor(opts = {}) {
    this._opts = opts;
    this._env = opts.env || process.env;
    this._enabledResolver = opts.enabledResolver || getNativeBinaryEnabled;
    // The single native-auth authority for every handle this manager owns.
    // Lazily falls back to the shared singleton (see the nativeAuthManager
    // getter): referencing it here would hit a temporal-dead-zone error during
    // the BinaryManager <-> HeartbeatAuthManager <-> remote-client import cycle
    // at module load. Child runtimes swap in a capability-seeded manager via
    // setNativeAuthManager().
    this._nativeAuthManager = opts.nativeAuthManager || null;
    /** @type {Map<string, NativeBinary>} */
    this._handles = new Map();
  }

  /**
   * The native-auth authority backing every handle. Leaf invoke boundaries read
   * the heartbeat envelope from here so auth is resolved once per runtime.
   *
   * @returns {import("../../shared/native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager}
   */
  get nativeAuthManager() {
    if (!this._nativeAuthManager) this._nativeAuthManager = heartbeatAuthManager;
    return this._nativeAuthManager;
  }

  /**
   * The cached, non-secret heartbeat auth envelope (or null). Leaf boundaries
   * default `request.auth` to this instead of re-reading settings per call.
   *
   * @param {{ refresh?: boolean }} [opts]
   * @returns {Record<string, unknown> | null}
   */
  nativeAuthEnvelope(opts) {
    return this.nativeAuthManager.getNativeAuthEnvelope(opts);
  }

  /**
   * Replace the native-auth authority and propagate it to already-created
   * handles. Child runtimes call this at boot with a manager rebuilt from the
   * parent's non-secret capability, so native calls use the same heartbeat
   * envelope everywhere.
   *
   * @param {import("../../shared/native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager} manager
   * @returns {void}
   */
  setNativeAuthManager(manager) {
    this._nativeAuthManager = manager || heartbeatAuthManager;
    for (const handle of this._handles.values()) {
      handle._nativeAuthManager = this._nativeAuthManager;
    }
  }

  /** @returns {readonly string[]} */
  names() {
    return BINARY_NAMES;
  }

  /**
   * Cached NativeBinary handle for a tool. Throws on unknown name.
   *
   * @param {string} name
   * @returns {NativeBinary}
   */
  binary(name) {
    if (!VALID_BINARY_NAMES.has(name)) {
      throw new RangeError(`Unknown native binary: ${name}`);
    }
    let handle = this._handles.get(name);
    if (!handle) {
      handle = new NativeBinary({
        name,
        binRoot: this._opts.binRoot,
        platform: this._opts.platform,
        arch: this._opts.arch,
        spawnImpl: this._opts.spawnImpl,
        spawnSyncImpl: this._opts.spawnSyncImpl,
        // Previously dropped on the floor: a manager-scoped env (and the auth
        // authority) now reach the handle so key/heartbeat resolution honors it.
        env: this._opts.env,
        nativeAuthManager: this.nativeAuthManager,
      });
      this._handles.set(name, handle);
    }
    return handle;
  }

  /**
   * Whether a compiled build is staged for this os/arch.
   *
   * @param {string} name
   * @returns {boolean}
   */
  available(name) {
    if (!VALID_BINARY_NAMES.has(name)) return false;
    try {
      return this.binary(name).isAvailable();
    } catch {
      // Unsupported host OS/arch → treat as unavailable rather than throwing.
      return false;
    }
  }

  /**
   * Whether native invocation is enabled for a tool. Git and ATLAS are
   * hard-migrated: the native binary is the only implementation path, so
   * neither settings nor env overrides can turn them off. Remaining tools
   * still honor the persisted tunable and legacy env overrides.
   *
   * @param {string} name
   * @returns {boolean}
   */
  enabled(name) {
    if (!VALID_BINARY_NAMES.has(name)) return false;
    if (name === "git" || name === "atlas") return true;
    const master = envFlag(this._env.POSSE_NATIVE_BINARIES);
    if (master != null) return master;
    const perTool = envFlag(this._env[`POSSE_NATIVE_${name.toUpperCase()}`]);
    if (perTool != null) return perTool;
    try {
      return this._enabledResolver(name) === true;
    } catch {
      return false;
    }
  }

  /**
   * The single predicate call sites use: enabled AND available.
   *
   * @param {string} name
   * @returns {boolean}
   */
  shouldUse(name) {
    return this.enabled(name) && this.available(name);
  }

  /**
   * Aggregated worker→per-call fallback counts across instantiated handles.
   * Nonzero means the daemon layer degraded somewhere this run — surface it.
   *
   * @returns {{ total: number, byBinary: Record<string, { count: number, byReason: Record<string, number> }> }}
   */
  workerFallbackStats() {
    /** @type {Record<string, { count: number, byReason: Record<string, number> }>} */
    const byBinary = {};
    let total = 0;
    for (const [name, handle] of this._handles) {
      const stats = handle.workerFallbacks;
      if (!stats || stats.count === 0) continue;
      byBinary[name] = { count: stats.count, byReason: { ...stats.byReason } };
      total += stats.count;
    }
    return { total, byBinary };
  }

  /**
   * Dispose every daemon this manager's handles created. Worker-thread entry
   * points MUST call this in a finally before the thread exits — module state
   * is per-thread, so a thread's daemons are invisible to the main thread's
   * supervisor registry and would otherwise outlive their creator as orphans
   * (the main supervisor's shutdown ledger sweep is the safety net, not the
   * plan). Safe to call repeatedly; a disposed handle just respawns on the
   * next use.
   *
   * @returns {Promise<void>}
   */
  async disposeAll() {
    const waits = [];
    for (const handle of this._handles.values()) {
      const daemon = handle._daemon;
      if (daemon) {
        handle._daemon = null;
        waits.push((async () => { try { await daemon.dispose(); } catch { /* best effort */ } })());
      }
    }
    await Promise.all(waits);
  }
}

/**
 * Shared process-wide manager. Most callers want this singleton; construct a
 * fresh BinaryManager with overrides only in tests.
 */
export const nativeBinaries = new BinaryManager();
