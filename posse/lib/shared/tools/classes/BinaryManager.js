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
// Git, ATLAS, ML, and vector are fully cut over: enabled is hardwired true, so
// shouldUse reduces to availability and there is no JS fallback path. The migration
// recipe for remaining tools: mirror in Rust, A/B against the Node oracle,
// switch the call site to the binary, then delete the replaced Node function.

import path from "node:path";
import {
  ATLAS_VECTOR_NATIVE_PROTOCOL,
  ATLAS_VECTOR_NATIVE_ROUTE,
  BINARY_NAMES,
  REQUIRED_ATLAS_BINARY_NAMES,
  VALID_BINARY_NAMES,
  nativeBinaryEntry,
  nativeBinaryExactVersion,
  nativeBinaryRequiresIssuedVersion,
} from "../../../catalog/binary.js";
import { getNativeBinaryEnabled } from "../../../domains/settings/functions/tunables.js";
import { heartbeatAuthManager } from "../../native/classes/HeartbeatAuthManager.js";
import { PulseTokenManager } from "../../native/classes/PulseTokenManager.js";
import {
  ensureNativeBinaryArtifact,
  findVerifiedNativeBinaryArtifact,
  invalidateNativeArtifactCache,
} from "../../native/functions/artifact-download.js";
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
   *   nativeAuthManager?: import("../../native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager,
   *   artifactInstaller?: typeof ensureNativeBinaryArtifact,
   *   artifactCacheRoot?: string,
   *   artifactFetchImpl?: typeof fetch,
   *   artifactPulseTokens?: import("../../native/classes/PulseTokenManager.js").PulseTokenManager,
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
    this._artifactInstaller = opts.artifactInstaller || ensureNativeBinaryArtifact;
    this._artifactCacheRoot = opts.artifactCacheRoot || null;
    this._artifactFetchImpl = opts.artifactFetchImpl || globalThis.fetch;
    this._artifactPulseTokens = opts.artifactPulseTokens || null;
    /** @type {Map<string, Promise<Record<string, unknown>>>} */
    this._artifactEnsures = new Map();
    /** @type {Map<string, NativeBinary>} */
    this._handles = new Map();
  }

  /**
   * The native-auth authority backing every handle. Leaf invoke boundaries read
   * the heartbeat envelope from here so auth is resolved once per runtime.
   *
   * @returns {import("../../native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager}
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
   * @param {import("../../native/classes/HeartbeatAuthManager.js").HeartbeatAuthManager} manager
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
      handle = this._createHandle(name, this._opts.binRoot);
      this._handles.set(name, handle);
    }
    return handle;
  }

  _createHandle(name, binRoot, exactVersion = undefined) {
    return new NativeBinary({
      name,
      binRoot,
      platform: this._opts.platform,
      arch: this._opts.arch,
      spawnImpl: this._opts.spawnImpl,
      spawnSyncImpl: this._opts.spawnSyncImpl,
      // Previously dropped on the floor: a manager-scoped env (and the auth
      // authority) now reach the handle so key/heartbeat resolution honors it.
      env: this._opts.env,
      nativeAuthManager: this.nativeAuthManager,
      exactVersion,
    });
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
   * Ensure a remotely distributed native binary is present for this host.
   * A locally valid handle is reused for the lifetime of the process. Passing
   * `refresh` asks the heartbeat for the current issued version and may replace
   * that handle; boot and explicit install/update commands are the only callers
   * that should do so. Concurrent callers share one synchronization per binary.
   *
   * @param {string} name
   * @param {{ refresh?: boolean, dryRun?: boolean, onProgress?: ((event: Record<string, unknown>) => void) | null }} [opts]
   * @returns {Promise<Record<string, unknown>>}
   */
  async ensureAvailable(name, { refresh = false, dryRun = false, onProgress = null } = {}) {
    if (!VALID_BINARY_NAMES.has(name)) {
      return { available: false, name, reason: "unknown_binary" };
    }
    this.binary(name);
    if (this._opts.binRoot && this._artifactInstaller === ensureNativeBinaryArtifact) {
      return { available: false, name, reason: "explicit_bin_root_missing" };
    }
    // Boot refreshes exact issued versions while Git/daemon readiness checks
    // consume those artifacts. Let a cached consumer join the per-binary
    // refresh already in flight instead of racing it with a second install or
    // observing the old process-local handle. This also removes the boot-wide
    // artifact barrier: each daemon can start as soon as its own refresh lands.
    if (!refresh) {
      const refreshing = this._artifactEnsures.get(`${name}:refresh:${dryRun ? "plan" : "install"}`);
      if (refreshing) return refreshing;
    }
    const ensureKey = `${name}:${refresh ? "refresh" : "cached"}:${dryRun ? "plan" : "install"}`;
    const inFlight = this._artifactEnsures.get(ensureKey);
    if (inFlight) return inFlight;
    const promise = this._ensureRemoteArtifact(name, { refresh, dryRun, onProgress }).finally(() => {
      if (this._artifactEnsures.get(ensureKey) === promise) this._artifactEnsures.delete(ensureKey);
    });
    this._artifactEnsures.set(ensureKey, promise);
    return promise;
  }

  /**
   * Ensure a required worker binary is version-valid, starts successfully,
   * and answers through its persistent worker transport. There is no one-shot
   * fallback on this readiness probe.
   *
   * @param {string} name
   * @returns {Promise<Record<string, unknown>>}
   */
  async ensureActive(name) {
    const available = await this.ensureAvailable(name);
    if (!available?.available) return available;
    try {
      const protocol = name === "atlas"
        ? "posse.atlas.native.v1"
        : name === "vector"
          ? ATLAS_VECTOR_NATIVE_PROTOCOL
          : `posse.${name}.native.v1`;
      const requiredRoute = name === "atlas"
        ? "atlas:methods"
        : name === "git"
          ? "git:read"
          : name === "vector"
            ? ATLAS_VECTOR_NATIVE_ROUTE
            : `${name}:methods`;
      // Git classifies every unknown application method as mutating. Probe it
      // with a real deterministic read method so readiness stays on git:read;
      // an application-level daemon.ping would correctly fail closed.
      const method = name === "git" ? "git.commitScope.isWildcard" : "daemon.ping";
      const payload = name === "git"
        ? { files: [], roots: ["*"], unknown: true }
        : {};
      const result = await this.binary(name).run(method, [], {
        input: `${JSON.stringify({ protocol, method, payload })}\n`,
        json: true,
        timeoutMs: 15_000,
        worker: true,
        workerFallback: false,
        idempotent: true,
        requiredRoute,
      });
      if (!result?.ok || result?.json?.ok === false) {
        return {
          ...available,
          available: false,
          active: false,
          reason: String(result?.error?.code || "worker_unresponsive"),
        };
      }
      return { ...available, active: true };
    } catch (error) {
      return {
        ...available,
        available: false,
        active: false,
        reason: String(error?.code || "worker_start_failed"),
        error,
      };
    }
  }

  /**
   * Ensure selected binaries are activated in this process, then export the
   * exact validated roots a worker thread must use. Worker module graphs have
   * their own BinaryManager singleton, so a main-thread cache activation is
   * otherwise invisible to them.
   *
   * @param {readonly string[]} [names]
   * @param {{ routesByBinary?: Record<string, string[]> }} [options]
   * @returns {Promise<{ version: 1, binaries: Record<string, { bundleRoot: string, binaryPath: string, exactVersion: string | null, os: string, arch: string, pulses?: Record<string, Record<string, unknown>> }> }>}
   */
  async prepareWorkerRuntime(names = BINARY_NAMES, { routesByBinary = {} } = {}) {
    const selected = [...new Set(names.filter((name) => VALID_BINARY_NAMES.has(name)))];
    const results = await Promise.all(selected.map((name) => this.ensureAvailable(name, { refresh: false })));
    const unavailable = results.filter((result) => result?.available !== true);
    if (unavailable.length > 0) {
      const error = new Error(
        `Native worker runtime unavailable: ${unavailable.map((result) => `${result?.name || "unknown"} (${result?.reason || "unavailable"})`).join(", ")}`,
      );
      /** @type {any} */ (error).code = "NATIVE_WORKER_RUNTIME_UNAVAILABLE";
      /** @type {any} */ (error).results = results;
      throw error;
    }
    const capability = this.workerRuntimeCapability(selected);
    for (const name of selected) {
      const entry = capability.binaries[name];
      if (!entry) continue;
      const routes = Array.isArray(routesByBinary?.[name]) ? routesByBinary[name] : [];
      entry.pulses = await this.binary(name).workerPulseCapability(routes);
    }
    return capability;
  }

  /**
   * Export already-validated handles for structured-clone workerData.
   *
   * @param {readonly string[]} [names]
   */
  workerRuntimeCapability(names = BINARY_NAMES) {
    const binaries = {};
    for (const name of [...new Set(names)]) {
      if (!VALID_BINARY_NAMES.has(name)) continue;
      const handle = this.binary(name);
      const binaryPath = handle.resolvePath();
      if (!binaryPath || !handle.isAvailable()) continue;
      binaries[name] = {
        bundleRoot: handle.binRoot,
        binaryPath,
        exactVersion: handle.exactVersion || null,
        os: handle.os,
        arch: handle.arch,
      };
    }
    return { version: 1, binaries };
  }

  /**
   * Hydrate this thread-local manager from a capability issued by its parent.
   * Every entry is re-resolved and version-checked locally before activation;
   * the supplied binaryPath must exactly match the catalog-derived path.
   * Call this before the worker performs any native operation.
   *
   * @param {unknown} capability
   * @returns {string[]} activated binary names
   */
  installWorkerRuntime(capability) {
    if (!capability || typeof capability !== "object" || /** @type {any} */ (capability).version !== 1) return [];
    const entries = /** @type {any} */ (capability).binaries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return [];
    const installed = [];
    for (const [name, entry] of Object.entries(entries)) {
      if (!VALID_BINARY_NAMES.has(name) || !entry || typeof entry !== "object") continue;
      const bundleRoot = String(/** @type {any} */ (entry).bundleRoot || "").trim();
      const declaredPath = String(/** @type {any} */ (entry).binaryPath || "").trim();
      const exactVersionRaw = /** @type {any} */ (entry).exactVersion;
      const exactVersion = exactVersionRaw == null ? null : String(exactVersionRaw).trim();
      if (!path.isAbsolute(bundleRoot) || !path.isAbsolute(declaredPath)) continue;
      if (exactVersion && !/^[a-zA-Z0-9._-]{1,64}$/.test(exactVersion)) continue;
      const candidate = this._createHandle(name, bundleRoot, exactVersion);
      if (String(/** @type {any} */ (entry).os || "") !== candidate.os) continue;
      if (String(/** @type {any} */ (entry).arch || "") !== candidate.arch) continue;
      const resolved = candidate.resolvePath();
      if (!resolved || !sameRuntimePath(resolved, declaredPath) || !candidate.isAvailable()) continue;
      candidate.installWorkerPulseCapability(/** @type {any} */ (entry).pulses);
      this._handles.set(name, candidate);
      installed.push(name);
    }
    return installed;
  }

  async ensureRequiredAtlasBinariesActive() {
    const results = await Promise.all(REQUIRED_ATLAS_BINARY_NAMES.map((name) => this.ensureActive(name)));
    const unavailable = results.filter((result) => result?.available !== true || result?.active !== true);
    if (unavailable.length > 0) {
      const error = new Error(
        `Required native binaries unavailable: ${unavailable.map((result) => `${result?.name || "unknown"} (${result?.reason || "unavailable"})`).join(", ")}`,
      );
      /** @type {any} */ (error).code = "REQUIRED_NATIVE_BINARY_UNAVAILABLE";
      /** @type {any} */ (error).results = results;
      throw error;
    }
    return results;
  }

  async _ensureRemoteArtifact(name, { refresh = false, dryRun = false, onProgress = null } = {}) {
    const handle = this.binary(name);
    let version = nativeBinaryExactVersion(name);
    try {
      // Do not replace a valid binary during a live run. Boot performs one
      // explicit refresh before work starts; after that, default ensures only
      // recover a missing/invalid artifact and let the run finish on its
      // already-validated version.
      if (!refresh && handle.isAvailable()
        && (!nativeBinaryRequiresIssuedVersion(name) || handle.exactVersion)) {
        return {
          available: true,
          name,
          version: handle.exactVersion || null,
          path: handle.resolvePath(),
          source: "existing",
          downloaded: false,
        };
      }
      if (!refresh) {
        const cached = await this._activateCachedFallback(name, handle);
        if (cached) return cached;
      }
      let pulseTokens = this._artifactPulseTokens;
      if (this._artifactInstaller === ensureNativeBinaryArtifact || pulseTokens) {
        pulseTokens ||= new PulseTokenManager({
          authManager: this.nativeAuthManager,
          fetchImpl: this._artifactFetchImpl,
        });
        this._artifactPulseTokens = pulseTokens;
        const pulse = await pulseTokens.getPulseEnvelope({
          refresh,
          requiredRoute: "artifacts:read",
        });
        const issuedVersion = String(pulse?.nativeArtifacts?.[nativeBinaryEntry(name)?.package] || "").trim();
        if (issuedVersion) version = issuedVersion;
        if (version && handle.exactVersion === version && handle.isAvailable()) {
          return {
            available: true,
            name,
            version,
            path: handle.resolvePath(),
            source: "existing",
            downloaded: false,
          };
        }
        const stagedHandle = version ? this._createHandle(name, this._opts.binRoot, version) : null;
        if (stagedHandle?.isAvailable()) {
          await this._replaceHandle(name, stagedHandle);
          return {
            available: true,
            name,
            version,
            path: stagedHandle.resolvePath(),
            source: "staged",
            downloaded: false,
          };
        }
        const cachedCurrent = version
          ? await this._activateCachedVersion(name, handle, version)
          : null;
        if (cachedCurrent) return cachedCurrent;
      }
      if (dryRun) {
        return version
          ? {
            available: false,
            name,
            version,
            reason: "artifact_download_required",
            planned: true,
            downloaded: false,
          }
          : {
            available: false,
            name,
            reason: "version_not_issued",
            planned: false,
            downloaded: false,
          };
      }
      const installed = await this._artifactInstaller({
        name,
        version,
        os: handle.os,
        arch: handle.arch,
        authManager: this.nativeAuthManager,
        pulseTokens,
        fetchImpl: this._artifactFetchImpl,
        ...(typeof onProgress === "function" ? { onProgress } : {}),
        ...(this._artifactCacheRoot ? { cacheRoot: this._artifactCacheRoot } : {}),
      });
      const expectedVersion = String(installed.version || version || "").trim() || null;
      if (!expectedVersion) {
        return { available: false, name, reason: "version_not_issued" };
      }
      const cachedHandle = this._createHandle(name, installed.bundleRoot, expectedVersion);
      if (!cachedHandle.isAvailable()) {
        await invalidateNativeArtifactCache(installed);
        return { available: false, name, reason: "downloaded_version_mismatch" };
      }
      await this._replaceHandle(name, cachedHandle);
      return {
        available: true,
        name,
        path: cachedHandle.resolvePath(),
        source: installed.source,
        downloaded: installed.downloaded === true,
        size: installed.size,
        sha256: installed.sha256,
        version: expectedVersion,
      };
    } catch (error) {
      const fallback = await this._activateCachedFallback(name, handle);
      if (fallback) return fallback;
      return {
        available: false,
        name,
        reason: String(error?.code || "artifact_download_failed"),
        error,
      };
    }
  }

  async _activateCachedFallback(name, handle) {
    if (handle.isAvailable()
      && (!nativeBinaryRequiresIssuedVersion(name) || handle.exactVersion)) {
      return {
        available: true,
        name,
        version: handle.exactVersion || null,
        path: handle.resolvePath(),
        source: "existing",
        downloaded: false,
      };
    }
    const cached = await findVerifiedNativeBinaryArtifact({
      ...(this._artifactCacheRoot ? { cacheRoot: this._artifactCacheRoot } : {}),
      name,
      os: handle.os,
      arch: handle.arch,
    });
    if (!cached) return null;
    const cachedHandle = this._createHandle(name, cached.bundleRoot, cached.version);
    if (!cachedHandle.isAvailable()) return null;
    await this._replaceHandle(name, cachedHandle);
    return {
      available: true,
      name,
      version: cached.version,
      path: cachedHandle.resolvePath(),
      source: cached.source,
      downloaded: false,
      sha256: cached.sha256,
    };
  }

  async _activateCachedVersion(name, handle, version) {
    const cached = await findVerifiedNativeBinaryArtifact({
      ...(this._artifactCacheRoot ? { cacheRoot: this._artifactCacheRoot } : {}),
      name,
      version,
      os: handle.os,
      arch: handle.arch,
    });
    if (!cached) return null;
    const cachedHandle = this._createHandle(name, cached.bundleRoot, cached.version);
    if (!cachedHandle.isAvailable()) return null;
    await this._replaceHandle(name, cachedHandle);
    return {
      available: true,
      name,
      version: cached.version,
      path: cachedHandle.resolvePath(),
      source: cached.source,
      downloaded: false,
      sha256: cached.sha256,
    };
  }

  /**
   * Whether native invocation is enabled for a tool. Git, ATLAS, ML, and vector
   * are hard-migrated: the native binary is the only implementation path, so
   * neither settings nor env overrides can turn them off. Remaining tools
   * still honor the persisted tunable and legacy env overrides.
   *
   * @param {string} name
   * @returns {boolean}
   */
  enabled(name) {
    if (!VALID_BINARY_NAMES.has(name)) return false;
    if (name === "git" || name === "atlas" || name === "ml" || name === "vector") return true;
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
      waits.push((async () => { try { await handle.dispose(); } catch { /* best effort */ } })());
    }
    await Promise.all(waits);
  }

  async _replaceHandle(name, nextHandle) {
    const previous = this._handles.get(name);
    this._handles.set(name, nextHandle);
    if (previous && previous !== nextHandle) {
      try { await previous.dispose(); } catch { /* replacement remains usable */ }
    }
  }
}

/**
 * Shared process-wide manager. Most callers want this singleton; construct a
 * fresh BinaryManager with overrides only in tests.
 */
export const nativeBinaries = new BinaryManager();

function sameRuntimePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ""));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
