// @ts-check
//
// Atlas-Conductor daemon (client side) on the shared Daemon primitive. A
// persistent thread daemon owns the Ledger + View writers and the merge
// contract; the main thread posts stage/merge/reindex jobs and awaits. Warm DB
// handles + the serial write queue live for the whole session, so steady-state
// incremental reindex pays no reopen cost.
//
// Lanes (docs/specs/CONDUCTOR-THREAD-BUNDLE-SPEC.md): the writer thread and one
// reader orchestration thread remain separate so Node-side indexing cannot
// block request routing. Native concurrency no longer lives in a Node reader
// pool: both bridge ports share one posse-atlas daemon, whose Rust executor and
// Atlas gate own parallel read/write admission.

import { Daemon, ThreadTransport, daemonSupervisor } from "../../../../../shared/tools/classes/daemon/index.js";
import { heartbeatAuthManager } from "../../../../../shared/native/classes/HeartbeatAuthManager.js";
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
const READER_WRITE_OP_TIMEOUT_MS = 70_000;
const READER_POOL_SIZE = 1;
let CONDUCTOR_SUPERVISOR_SEQ = 0;

function registerAtlasThreadDaemon(kind, daemon, label) {
  const key = `${kind}#${++CONDUCTOR_SUPERVISOR_SEQ}`;
  daemonSupervisor.register(key, daemon, { label });
  const dispose = daemon.dispose.bind(daemon);
  daemon.dispose = async (...args) => {
    try {
      return await dispose(...args);
    } finally {
      daemonSupervisor.unregister(key);
    }
  };
  return daemon;
}

/** @returns {{ stage, ingest, warm, merge, retrieve, executeTool, reindex, reindexLanguage, info, readerInfo, close, daemon: Daemon }} */
export function createConductorDaemon(opts = {}) {
  const nativeAuth = heartbeatAuthManager.getCapability();
  const readerHostUrl = opts.readerHostUrl || READER_HOST_URL;
  const readerOpTimeoutMs = Number.isFinite(Number(opts.readerOpTimeoutMs))
    ? Math.max(1, Number(opts.readerOpTimeoutMs))
    : READER_OP_TIMEOUT_MS;
  const readerWriteOpTimeoutMs = Number.isFinite(Number(opts.readerWriteOpTimeoutMs))
    ? Math.max(1, Number(opts.readerWriteOpTimeoutMs))
    : READER_WRITE_OP_TIMEOUT_MS;
  const daemon = registerAtlasThreadDaemon("atlas-conductor", new Daemon({
    transportFactory: () => ThreadTransport({ moduleUrl: HOST_URL, workerData: { nativeAuth }, nativeBridge: true, retirePayload: { op: "close" } }),
    timeoutMs: STAGE_TIMEOUT_MS,
    label: "atlas-conductor",
  }), "atlas-conductor");

  /** @type {Array<{ slot: number, daemon: Daemon, inFlight: number } | null>} */
  const readerEntries = Array.from({ length: READER_POOL_SIZE }, () => null);
  let readerCursor = 0;
  let readerWriteDepth = 0;
  /** @type {null | (() => void)} */
  let readerWriteIdleResolve = null;
  let readerWriteIdle = Promise.resolve();
  let readerInFlight = 0;
  /** @type {null | (() => void)} */
  let readerReadIdleResolve = null;
  let readerReadIdle = Promise.resolve();

  const createReaderEntry = (slot) => ({
    slot,
    inFlight: 0,
    daemon: registerAtlasThreadDaemon(`atlas-reader-${slot + 1}`, new Daemon({
        transportFactory: () => ThreadTransport({ moduleUrl: readerHostUrl, workerData: { nativeAuth }, nativeBridge: true, retirePayload: { op: "close" } }),
        timeoutMs: RETRIEVE_TIMEOUT_MS,
        label: `atlas-reader-${slot + 1}`,
        onLifecycle: (event) => {
          if (event?.kind === "spawn") log.debug("atlas", "Conductor reader lane spawned", { slot: slot + 1 });
        },
      }), `atlas-reader-${slot + 1}`),
  });

  const getReaderEntry = (slot) => {
    let entry = readerEntries[slot] || null;
    if (!entry) {
      entry = createReaderEntry(slot);
      readerEntries[slot] = entry;
    }
    return entry;
  };

  const aliveReaderEntries = () => readerEntries
    .filter((entry) => entry?.daemon?.isHostAlive());

  const noteReaderWriteStart = () => {
    if (readerWriteDepth === 0) {
      readerWriteIdle = new Promise((resolve) => { readerWriteIdleResolve = resolve; });
    }
    readerWriteDepth++;
  };

  const noteReaderWriteEnd = () => {
    readerWriteDepth = Math.max(0, readerWriteDepth - 1);
    if (readerWriteDepth !== 0) return;
    const resolve = readerWriteIdleResolve;
    readerWriteIdleResolve = null;
    readerWriteIdle = Promise.resolve();
    try { resolve?.(); } catch { /* observational */ }
  };

  const noteReaderReadStart = () => {
    if (readerInFlight === 0) {
      readerReadIdle = new Promise((resolve) => { readerReadIdleResolve = resolve; });
    }
    readerInFlight++;
  };

  const noteReaderReadEnd = () => {
    readerInFlight = Math.max(0, readerInFlight - 1);
    if (readerInFlight !== 0) return;
    const resolve = readerReadIdleResolve;
    readerReadIdleResolve = null;
    readerReadIdle = Promise.resolve();
    try { resolve?.(); } catch { /* observational */ }
  };

  const disposeReaderEntry = async (entry) => {
    if (!entry) return;
    if (readerEntries[entry.slot] === entry) readerEntries[entry.slot] = null;
    try { await entry.daemon.dispose(); } catch { /* best effort */ }
  };

  const pickReaderEntry = () => {
    const alive = aliveReaderEntries();
    if (readerWriteDepth === 0) {
      const allAliveBusy = alive.length === 0 || alive.every((entry) => entry.inFlight > 0);
      if (allAliveBusy && alive.length < READER_POOL_SIZE) {
        for (let i = 0; i < READER_POOL_SIZE; i += 1) {
          const slot = (readerCursor + i) % READER_POOL_SIZE;
          const entry = readerEntries[slot];
          if (!entry || !entry.daemon.isHostAlive()) {
            readerCursor = (slot + 1) % READER_POOL_SIZE;
            return getReaderEntry(slot);
          }
        }
      }
    }
    const candidates = alive.length > 0 ? alive : [getReaderEntry(readerCursor)];
    let best = candidates[0];
    for (const entry of candidates) {
      if (entry.inFlight < best.inFlight) best = entry;
    }
    readerCursor = (best.slot + 1) % READER_POOL_SIZE;
    return best;
  };

  const callReader = async (payload, reqOpts) => {
    // A queued writer closes reader admission at this boundary. Do not rely on
    // daemon liveness here: an allocated lane may still be spawning, and that
    // already-admitted request must drain before the writer can bind.
    while (readerWriteDepth > 0) {
      await readerWriteIdle;
    }
    const entry = pickReaderEntry();
    noteReaderReadStart();
    entry.inFlight++;
    try {
      return await call(entry.daemon, payload, reqOpts);
    } catch (err) {
      if (err?.code === "DAEMON_TRANSPORT_GONE") await disposeReaderEntry(entry);
      throw err;
    } finally {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      noteReaderReadEnd();
    }
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
    const readers = aliveReaderEntries();
    await Promise.all(readers.map(async (entry) => {
      try {
        await call(entry.daemon, { op: "invalidate" }, { timeoutMs: READER_OP_TIMEOUT_MS });
      } catch {
        await disposeReaderEntry(entry);
      }
    }));
  };

  /**
   * @param {Record<string, any>} [opts]
   * @returns {Array<{ viewPath?: string, ledgerPath?: string }>}
   */
  const readerWriteTargets = (opts = {}) => {
    const ledgerPath = opts?.ledgerPath ? String(opts.ledgerPath) : "";
    const candidates = [
      opts?.job?.out_view_path,
      opts?.viewPath,
      opts?.dbPath,
    ];
    const seen = new Set();
    const targets = [];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const viewPath = String(candidate);
      const key = `${viewPath}\0${ledgerPath}`.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ viewPath, ...(ledgerPath ? { ledgerPath } : {}) });
    }
    return targets;
  };

  const releaseHeldReader = async (heldReader) => {
    const entry = heldReader?.entry;
    if (!entry?.daemon?.isHostAlive()) return false;
    let failed = false;
    const embRoot = heldReader.embRoot || null;
    const dbTargets = Array.isArray(heldReader.dbTargets) ? heldReader.dbTargets : [];
    if (embRoot) {
      try { await call(entry.daemon, { op: "endEmbeddingWrite", readRoot: embRoot }, { timeoutMs: readerOpTimeoutMs }); } catch { failed = true; }
    }
    for (const target of [...dbTargets].reverse()) {
      try {
        await call(entry.daemon, { op: "endWrite", ...target }, { timeoutMs: readerOpTimeoutMs });
      } catch {
        failed = true;
      }
    }
    if (failed) await disposeReaderEntry(entry);
    return failed;
  };

  const releaseHeldReaders = async (heldReaders) => {
    for (const heldReader of heldReaders) await releaseHeldReader(heldReader);
  };

  /**
   * Drain the reader lane before a writer mutates ATLAS DB files. This is a
   * no-op until the lazy reader has actually spawned; if the reader wedges,
   * dispose only that lane so the writer can proceed without a stale handle.
   *
   * @param {Record<string, any>} [opts]
   */
  const beginReaderWrite = async (opts = {}, { holdEmbeddings = false } = {}) => {
    noteReaderWriteStart();
    const heldReaders = [];
    try {
      // Drain every request admitted before the writer latch, including a
      // reader whose daemon transport is still spawning. Only after this
      // resolves may the writer acquire the host-side holds and bind.
      await readerReadIdle;
      const readers = aliveReaderEntries();
      if (readers.length === 0) return { readers: [] };
      const targets = readerWriteTargets(opts);
      const embRoot = holdEmbeddings && opts?.repoRoot ? String(opts.repoRoot) : null;
      if (targets.length === 0 && !embRoot) return { readers: [] };
      for (const entry of readers) {
        const held = [];
        let heldEmb = null;
        let phase = "db";
        try {
          for (const target of targets) {
            await call(entry.daemon, { op: "beginWrite", ...target }, { timeoutMs: readerWriteOpTimeoutMs });
            held.push(target);
          }
          if (embRoot) {
            // Confirmed-close barrier: drain semantic reads and close (confirmed)
            // the reader's cached ANN child — releasing index.usearch — before the
            // conductor renames it. A failed embedding barrier must abort the ANN
            // writer instead of falling through to a Windows sharing violation.
            phase = "embedding";
            await call(entry.daemon, { op: "beginEmbeddingWrite", readRoot: embRoot }, { timeoutMs: readerWriteOpTimeoutMs });
            heldEmb = embRoot;
          }
          heldReaders.push({ entry, dbTargets: held, embRoot: heldEmb });
        } catch (err) {
          if (heldEmb) {
            try { await call(entry.daemon, { op: "endEmbeddingWrite", readRoot: heldEmb }, { timeoutMs: readerOpTimeoutMs }); } catch { /* best effort */ }
          }
          for (const target of held.reverse()) {
            try { await call(entry.daemon, { op: "endWrite", ...target }, { timeoutMs: readerOpTimeoutMs }); } catch { /* best effort */ }
          }
          await disposeReaderEntry(entry);
          if (embRoot && phase === "embedding") {
            const message = String(err?.message || err || "unknown error");
            throw new Error(`reader embedding write barrier failed before ANN write: ${message}`);
          }
        }
      }
      return { readers: heldReaders };
    } catch (err) {
      await releaseHeldReaders(heldReaders);
      noteReaderWriteEnd();
      throw err;
    }
  };

  /**
   * @param {{ readers?: Array<{ entry: { slot: number, daemon: Daemon, inFlight: number }, dbTargets?: Array<{ viewPath?: string, ledgerPath?: string }>, embRoot?: string | null }> }} held
   */
  const endReaderWrite = async (held) => {
    try {
      const readers = Array.isArray(held?.readers) ? held.readers : [];
      for (const heldReader of readers) {
        await releaseHeldReader(heldReader);
      }
    } finally {
      noteReaderWriteEnd();
    }
  };

  const writesWithReaderHold = (fn, holdOpts = {}) => async (/** @type {any[]} */ ...args) => {
    const held = await beginReaderWrite(/** @type {any} */ (args[0]) || {}, holdOpts);
    try {
      return await fn(...args);
    } finally {
      await invalidateReaders();
      await endReaderWrite(held);
    }
  };

  const stage = (opts, reqOpts) => call(daemon, { op: "stage", ...opts }, reqOpts);
  const ingest = writesWithReaderHold((opts, reqOpts) => call(daemon, { op: "ingest", ...opts }, reqOpts));
  const warm = writesWithReaderHold((opts, reqOpts) => call(daemon, { op: "warm", ...opts }, reqOpts), { holdEmbeddings: true });
  const merge = writesWithReaderHold((opts, reqOpts) => call(daemon, { op: "merge", ...opts }, reqOpts));
  const retrieve = (opts, reqOpts) => callReader({ op: "retrieve", ...opts }, reqOpts);
  const executeTool = (opts, reqOpts) => callReader({ op: "executeTool", ...opts }, reqOpts);

  const aggregateReaderInfo = async ({ ensurePool = false } = {}) => {
    if (ensurePool) {
      for (let slot = 0; slot < READER_POOL_SIZE; slot += 1) getReaderEntry(slot);
      await Promise.all(readerEntries.filter(Boolean).map(async (entry) => {
        try { await call(entry.daemon, { op: "info" }, { timeoutMs: readerOpTimeoutMs }); }
        catch { await disposeReaderEntry(entry); }
      }));
    }
    const readers = aliveReaderEntries();
    if (readers.length === 0) return null;
    const results = await Promise.allSettled(readers.map((entry) => call(entry.daemon, { op: "info" }, { timeoutMs: readerOpTimeoutMs })));
    const infos = [];
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      const entry = readers[i];
      if (result.status === "fulfilled") infos.push({ slot: entry.slot + 1, inFlight: entry.inFlight, ...result.value });
      else await disposeReaderEntry(entry);
    }
    if (infos.length === 0) return null;
    const sum = (field) => infos.reduce((total, info) => total + Number(info?.[field] || 0), 0);
    return {
      lane: "reader",
      parallel: true,
      readers: infos.length,
      poolSize: READER_POOL_SIZE,
      retrieves: sum("retrieves"),
      invalidations: sum("invalidations"),
      writeBegins: sum("writeBegins"),
      writeEnds: sum("writeEnds"),
      activeWriteHolds: sum("activeWriteHolds"),
      invalidationsDuringWrite: sum("invalidationsDuringWrite"),
      storageCache: {
        opens: infos.reduce((total, info) => total + Number(info?.storageCache?.opens || 0), 0),
        hits: infos.reduce((total, info) => total + Number(info?.storageCache?.hits || 0), 0),
        invalidations: infos.reduce((total, info) => total + Number(info?.storageCache?.invalidations || 0), 0),
        evictions: infos.reduce((total, info) => total + Number(info?.storageCache?.evictions || 0), 0),
        read_timing: {
          requests: infos.reduce((total, info) => total + Number(info?.storageCache?.read_timing?.requests || 0), 0),
          gate_wait_us: infos.reduce((total, info) => total + Number(info?.storageCache?.read_timing?.gate_wait_us || 0), 0),
          storage_total_us: infos.reduce((total, info) => total + Number(info?.storageCache?.read_timing?.storage_total_us || 0), 0),
          query_execute_us: infos.reduce((total, info) => total + Number(info?.storageCache?.read_timing?.query_execute_us || 0), 0),
        },
      },
      lanes: infos,
    };
  };

  return {
    daemon,
    stage,
    ingest,
    warm,
    merge,
    retrieve,
    executeTool,
    info: async () => {
      const data = await call(daemon, { op: "info" });
      return { ...data, readerAlive: aliveReaderEntries().length > 0, readerAliveCount: aliveReaderEntries().length };
    },
    /** Reader-lane counters (`{ lane, retrieves, invalidations, writeBegins, writeEnds }`), null when never spawned. */
    readerInfo: aggregateReaderInfo,
    close: async () => {
      // Tear reader lanes down WITH the writer: close drains cached embedding
      // resources, dispose releases threads + MessagePorts. The pool is lazy,
      // so later retrieves simply respawn lanes.
      const readers = readerEntries.filter(Boolean);
      readerEntries.fill(null);
      await Promise.all(readers.map(async (entry) => {
        if (entry.daemon.isHostAlive()) {
          try { await call(entry.daemon, { op: "close" }, { timeoutMs: READER_OP_TIMEOUT_MS }); } catch { /* best effort */ }
        }
        try { await entry.daemon.dispose(); } catch { /* best effort */ }
      }));
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
      executeTool: _tracked(base.executeTool),
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
  if (!conductor) return;
  _sharedClosing = (async () => {
    await _waitForSharedIdle();
    if (_sharedConductor === conductor) _sharedConductor = null;
    try { await conductor.close(); } catch { /* best effort */ }
    // Await full transport termination — `stop()`/unref leaves the worker's
    // MessagePort as an active handle, so a short-lived process wouldn't exit.
    try { await conductor.daemon.dispose(); } catch { /* best effort */ }
  })();
  try { await _sharedClosing; } finally { _sharedClosing = null; }
}
