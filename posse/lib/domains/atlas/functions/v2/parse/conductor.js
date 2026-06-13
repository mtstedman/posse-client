// @ts-check
//
// Atlas-Conductor daemon (client side) on the shared Daemon primitive. A
// persistent thread daemon owns the Ledger + View writers and the merge
// contract; the main thread posts stage/merge/reindex jobs and awaits. Warm DB
// handles + the serial write queue live for the whole session, so steady-state
// incremental reindex pays no reopen cost.
//
// Lanes (CONDUCTOR-THREAD-BUNDLE-SPEC.md): the writer thread above is one lane
// of a bundle. `retrieve` routes to a separate READER lane — its own thread
// with request-scoped readonly WAL connections — so reads never queue behind
// the writer's long synchronous sections (SCIP ingest transactions, view
// merges). The reader spawns lazily on first retrieve; warm-only consumers
// (post-commit hooks, most tests) never pay the second thread.

import { Daemon, ThreadTransport } from "../../../../../classes/tools/daemon/index.js";
import { log } from "../../../../../shared/telemetry/functions/logging/logger.js";

const HOST_URL = new URL("./conductor-host.mjs", import.meta.url);
const READER_HOST_URL = new URL("./reader-host.mjs", import.meta.url);
const STAGE_TIMEOUT_MS = 600_000; // the indexer can be slow; bound it generously.
// Reads are interactive: callers pass their own per-request budget (the
// embedded timeout); this is only the ceiling when they don't.
const RETRIEVE_TIMEOUT_MS = 60_000;
// Reader housekeeping (invalidate/close) must never stall a warm's completion
// behind a wedged reader — short fuse, best-effort.
const READER_OP_TIMEOUT_MS = 5_000;

/** @returns {{ stage, ingest, warm, merge, retrieve, reindex, reindexLanguage, info, readerInfo, close, daemon: Daemon }} */
export function createConductorDaemon() {
  const daemon = new Daemon({
    transportFactory: () => ThreadTransport({ moduleUrl: HOST_URL }),
    timeoutMs: STAGE_TIMEOUT_MS,
    label: "atlas-conductor",
  });

  /** @type {Daemon | null} reader lane; lazy so warm-only consumers skip it. */
  let readerDaemon = null;
  const getReaderDaemon = () => {
    if (!readerDaemon) {
      readerDaemon = new Daemon({
        transportFactory: () => ThreadTransport({ moduleUrl: READER_HOST_URL }),
        timeoutMs: RETRIEVE_TIMEOUT_MS,
        label: "atlas-reader",
        onLifecycle: (event) => {
          if (event?.kind === "spawn") log.debug("atlas", "Conductor reader lane spawned");
        },
      });
    }
    return readerDaemon;
  };

  // daemon.request never rejects — it RESOLVES with { ok:false, error, _flag }
  // on timeout/abort/overload/transport-loss. Surface those as a thrown Error
  // that carries a `code`, so callers can distinguish a genuine abort/timeout
  // (must propagate — e.g. honor a worker kill or runtime budget) from a plain
  // op failure (safe to treat as "not ready" and fall back).
  const call = async (target, payload, opts = {}) => {
    const res = await target.request(payload, opts);
    if (res?.ok === true) return res.data;
    const r = /** @type {any} */ (res);
    const err = new Error(String(r?.error?.message || "conductor call failed"));
    if (r?._aborted) /** @type {any} */ (err).code = "DAEMON_ABORTED";
    else if (r?._timedOut) /** @type {any} */ (err).code = "DAEMON_TIMEOUT";
    else if (r?._overloaded) /** @type {any} */ (err).code = "DAEMON_OVERLOADED";
    else if (r?._transportGone) /** @type {any} */ (err).code = "DAEMON_TRANSPORT_GONE";
    throw err;
  };

  // The reader lane caches embedding resources (ANN child process + encoder)
  // per-thread, so the writer host's own in-thread invalidation cannot reach
  // them. After any op that rewrites the on-disk ANN, tell the reader to drop
  // its handles — mirroring the writer host's `finally` invalidation.
  const invalidateReaders = async () => {
    if (!readerDaemon?.isHostAlive()) return;
    try {
      await call(readerDaemon, { op: "invalidate" }, { timeoutMs: READER_OP_TIMEOUT_MS });
    } catch { /* best effort — a wedged reader recycles via its own breaker */ }
  };
  const invalidatesReaders = (fn) => async (/** @type {any[]} */ ...args) => {
    try {
      return await fn(...args);
    } finally {
      await invalidateReaders();
    }
  };

  const stage = (opts, reqOpts) => call(daemon, { op: "stage", ...opts }, reqOpts);
  const ingest = (opts, reqOpts) => call(daemon, { op: "ingest", ...opts }, reqOpts);
  const warm = invalidatesReaders((opts, reqOpts) => call(daemon, { op: "warm", ...opts }, reqOpts));
  const merge = invalidatesReaders((opts, reqOpts) => call(daemon, { op: "merge", ...opts }, reqOpts));
  const retrieve = (opts, reqOpts) => call(getReaderDaemon(), { op: "retrieve", ...opts }, reqOpts);

  return {
    daemon,
    stage,
    ingest,
    warm,
    merge,
    retrieve,
    info: async () => {
      const data = await call(daemon, { op: "info" });
      return { ...data, readerAlive: readerDaemon?.isHostAlive() ?? false };
    },
    /** Reader-lane counters (`{ lane, retrieves, invalidations }`), null when never spawned. */
    readerInfo: () => (readerDaemon?.isHostAlive()
      ? call(readerDaemon, { op: "info" }, { timeoutMs: READER_OP_TIMEOUT_MS })
      : Promise.resolve(null)),
    close: async () => {
      // Tear the reader lane down WITH the writer: close drains its cached
      // embedding resources, dispose releases the thread + MessagePort. The
      // lane is lazy, so a later retrieve on this client simply respawns it.
      if (readerDaemon) {
        const reader = readerDaemon;
        readerDaemon = null;
        if (reader.isHostAlive()) {
          try { await call(reader, { op: "close" }, { timeoutMs: READER_OP_TIMEOUT_MS }); } catch { /* best effort */ }
        }
        try { await reader.dispose(); } catch { /* best effort */ }
      }
      return call(daemon, { op: "close" });
    },
    /**
     * Full reindex via the hosted ParseEngine: warm (parse tree-sitter + SCIP
     * and ingest both layers into the ledger) then merge ("zip") the view,
     * scoped by contentHashes (null = full/boot). This is the high-level path;
     * stage/ingest/merge remain available for fine-grained scip-only control.
     */
    async reindex({ repoRoot, scipDir, ledgerPath, dbPath, paths = [], scipMode, config, branch = null, lang = null, contentHashes = null }) {
      const warmed = await warm({ ledgerPath, dbPath, repoRoot, scipDir, scipMode, config, branch, job: { paths } });
      const merged = await merge({ ledgerPath, dbPath, lang, contentHashes });
      return { warmed, merged };
    },
    /**
     * Reindex one language: hold the inputs as a co-promise, then run the scip
     * write cycle — ingest each staged .scip into the ledger, then "zip"
     * (merge), scoped by contentHashes (null = full/boot). The atlas-stage
     * promise slots into the Promise.all alongside scip-stage once the atlas
     * parse half is wired.
     */
    async reindexLanguage({ repoRoot, scipDir, ledgerPath, dbPath, lang, mode, config, branch = null, contentHashes = null }) {
      const [staged] = await Promise.all([
        stage({ repoRoot, scipDir, lang, mode, config }),
        // atlasStage({ ... })  ← second co-promise lands here
      ]);
      const ingested = [];
      for (const scipPath of (staged?.files || [])) {
        ingested.push(await ingest({ ledgerPath, dbPath, scipPath, repoRoot, branch, lang }));
      }
      const merged = await merge({ ledgerPath, dbPath, lang, contentHashes });
      return { staged, ingested, merged };
    },
  };
}

// Process-global persistent Atlas-Conductor. Mirrors getSharedOnnxDaemon: one
// warm thread daemon (Ledger/View writers + the serial write queue) for the
// whole session, so steady-state incremental reindex pays no thread-spawn or
// DB-reopen cost.
//
// Unlike the ONNX daemon, the conductor takes no identity config: ledger/view
// paths and atlas config flow per-request, and the host caches DB handles per
// (ledgerPath|dbPath) target, so a single daemon serves every repo/worktree.
//
// IDLE EVICTION. A worker's communication MessagePort stays an active libuv
// handle until `terminate()` resolves — `unref()` alone does NOT let a process
// that used the daemon exit (Node ≥ 22/25). So instead of leaking that pin for
// the session, the shared conductor self-disposes after SHARED_IDLE_MS with no
// in-flight ops: a long-lived scheduler stays warm across back-to-back reindex
// bursts, while a one-shot CLI / test process drains and exits shortly after its
// last warm. An in-flight counter guarantees we never terminate mid-op.
const DEFAULT_IDLE_MS = 30_000;
const SHARED_CLOSE_DRAIN_MS = 10_000;
let _idleMs = DEFAULT_IDLE_MS;
// A long-lived scheduler run PINS the conductor warm via setConductorKeepWarm(true)
// so per-WI warms reuse one hot ParseEngine instead of re-bootstrapping during the
// multi-minute gaps between a WI's warms (research/dev agents run in between).
// While pinned the idle window stretches to KEEPWARM_IDLE_MS — long enough to never
// evict mid-run, but still a backstop that lets the process exit if explicit
// session cleanup is ever missed. One-shot CLI / test processes never pin, so they
// drain and exit after _idleMs.
const KEEPWARM_IDLE_MS = 900_000; // 15 min
let _keepWarm = false;
/** @type {ReturnType<typeof createConductorDaemon> | null} */
let _sharedConductor = null;
let _sharedInflight = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let _sharedIdleTimer = null;
/** @type {Promise<void> | null} guards re-entrant closeSharedConductor calls. */
let _sharedClosing = null;

/**
 * Override the shared conductor's idle-eviction window. Test hook only — config
 * is not env/admin-tunable (no production reason to change it). Pass nothing to
 * restore the default.
 */
export function setConductorIdleMsForTests(ms = DEFAULT_IDLE_MS) {
  const n = Number(ms);
  _idleMs = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

/**
 * Pin the shared conductor warm (idle-eviction disabled) for the duration of a
 * long-lived run, or release the pin. The scheduler sets this true for a whole
 * session so per-WI warms reuse one hot ParseEngine instead of re-bootstrapping;
 * the session's ATLAS cleanup sets it false and disposes the conductor, so the
 * process still exits promptly. No-op-safe to call when no conductor exists.
 */
export function setConductorKeepWarm(on) {
  _keepWarm = !!on;
  _armIdle(); // re-arm with the keep-warm window (or the short window once released)
}

function _disarmIdle() {
  if (_sharedIdleTimer) { clearTimeout(_sharedIdleTimer); _sharedIdleTimer = null; }
}

function _armIdle() {
  _disarmIdle();
  if (_sharedInflight > 0) return;
  _sharedIdleTimer = setTimeout(() => {
    _sharedIdleTimer = null;
    if (_sharedInflight === 0) closeSharedConductor().catch(() => { /* best effort */ });
  }, _keepWarm ? KEEPWARM_IDLE_MS : _idleMs);
  // The timer must not itself pin the loop — it only fires if the (port-pinned)
  // loop is already alive; once it disposes the daemon, the loop drains.
  _sharedIdleTimer.unref?.();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _waitForSharedIdle(maxMs = SHARED_CLOSE_DRAIN_MS) {
  const deadline = Date.now() + Math.max(0, Number(maxMs) || 0);
  while (_sharedInflight > 0 && Date.now() < deadline) {
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

/** Wrap a conductor op so the idle timer is held off while it runs. */
function _tracked(fn) {
  return async (/** @type {any[]} */ ...args) => {
    _sharedInflight++;
    _disarmIdle();
    try {
      return await fn(...args);
    } finally {
      _sharedInflight--;
      _armIdle();
    }
  };
}

// Indexing-activity counter, separate from the idle tracking: retrieval-side
// transient-retry logic uses this to recognize "the view is mid-rebuild;
// wait for the warm to land" instead of failing or falling back.
let _indexingInflight = 0;

// Success listeners for indexing ops. Read-side caches keyed by git HEAD
// (e.g. the shared tree.overview/repo.status cache) subscribe here because a
// drift reindex can land NEW view content under the SAME HEAD — version-keyed
// entries alone would serve stale results across it.
const _indexingSuccessListeners = new Set();

/**
 * Subscribe to "an indexing op (warm/merge/ingest/stage/reindex) completed
 * successfully". Listeners must not throw; failures are swallowed so a bad
 * subscriber cannot break the indexing pipeline. Returns an unsubscribe fn.
 * @param {() => void} listener
 */
export function onConductorIndexingSuccess(listener) {
  if (typeof listener !== "function") return () => {};
  _indexingSuccessListeners.add(listener);
  return () => _indexingSuccessListeners.delete(listener);
}

function _notifyIndexingSuccess() {
  for (const listener of _indexingSuccessListeners) {
    try { listener(); } catch { /* subscriber errors must not break indexing */ }
  }
}

function _indexTracked(fn) {
  const tracked = _tracked(fn);
  return async (/** @type {any[]} */ ...args) => {
    _indexingInflight++;
    try {
      const result = await tracked(...args);
      _notifyIndexingSuccess();
      return result;
    } finally {
      _indexingInflight--;
    }
  };
}

/** True while any warm/merge/ingest/stage/reindex op is running in the conductor. */
export function isConductorIndexingInFlight() {
  return _indexingInflight > 0;
}

/**
 * Get the process-global Atlas-Conductor daemon, creating it on first use. The
 * returned client's request ops are idle-tracked (see SHARED_IDLE_MS).
 * @returns {ReturnType<typeof createConductorDaemon>}
 */
export function getSharedConductor() {
  if (!_sharedConductor) {
    const base = createConductorDaemon();
    _sharedConductor = {
      daemon: base.daemon,
      info: base.info,
      readerInfo: base.readerInfo,
      close: base.close,
      stage: _indexTracked(base.stage),
      ingest: _indexTracked(base.ingest),
      warm: _indexTracked(base.warm),
      merge: _indexTracked(base.merge),
      reindex: _indexTracked(base.reindex),
      reindexLanguage: _indexTracked(base.reindexLanguage),
      retrieve: _tracked(base.retrieve),
    };
  }
  return _sharedConductor;
}

/**
 * Tear down the shared conductor (close DB handles + terminate the thread).
 * Safe to call when none exists. Invoked by idle eviction, graceful shutdown,
 * and tests. Awaiting it guarantees the worker's MessagePort is released so the
 * process can exit.
 */
export async function closeSharedConductor() {
  // Re-entrancy guard: idle eviction and a graceful shutdown can both call this
  // in the same tick. Without it, both read the same non-null _sharedConductor
  // before either awaits, then double-close / double-dispose the same daemon
  // (a second close message races worker.terminate(), risking un-closed SQLite
  // handles). Collapse concurrent callers onto one teardown promise.
  if (_sharedClosing) return _sharedClosing;
  _disarmIdle();
  const conductor = _sharedConductor;
  _sharedConductor = null;
  if (!conductor) return;
  _sharedClosing = (async () => {
    await _waitForSharedIdle();
    try { await conductor.close(); } catch { /* best effort */ }
    // Await full transport termination — `stop()`/unref leaves the worker's
    // MessagePort as an active handle, so a short-lived process wouldn't exit.
    try { await conductor.daemon.dispose(); } catch { /* best effort */ }
  })();
  try { await _sharedClosing; } finally { _sharedClosing = null; }
}
