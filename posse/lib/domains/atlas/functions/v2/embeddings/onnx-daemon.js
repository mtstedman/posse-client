// @ts-check
//
// ONNX encoder (client side) on the shared Daemon primitive. Keeps the
// transformers.js model warm in persistent worker threads and recycles them
// when the embedding identity (backend:model:version:dim) changes. Generalizes
// the former single warm daemon to a set of up to N daemon-backed workers so
// bulk ingest gets data-parallel encode on the same warm, supervised lifecycle
// search uses — replacing the per-ingestView encode pool that paid the ~6s
// model load on every warm.

import { Daemon, ThreadTransport, daemonSupervisor } from "../../../../../classes/tools/daemon/index.js";
import { heartbeatAuthManager } from "../../../../../shared/native/classes/HeartbeatAuthManager.js";

const HOST_URL = new URL("./onnx-host.mjs", import.meta.url);
// Generous ceiling: first request pays the ~6s model load, and a big batch can
// take a while. A wedged encode still can't hang forever.
const ENCODE_TIMEOUT_MS = 300_000;
let ONNX_SUPERVISOR_SEQ = 0;

function registerOnnxThreadDaemon(daemon) {
  const key = `atlas-onnx#${++ONNX_SUPERVISOR_SEQ}`;
  daemonSupervisor.register(key, daemon, { label: "atlas-onnx" });
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

/**
 * The recycle key — when this changes each worker tears down the warm model and
 * rebuilds, so a settings/model swap can never serve stale vectors.
 * @param {Record<string, any>} config
 */
export function onnxModelKey(config = {}) {
  const backend = config.backend || "local-onnx";
  const model = config.modelId || config.modelName || "?";
  return `${backend}:${model}:${config.modelVersion ?? "?"}:${config.dim ?? "?"}`;
}

/**
 * @param {() => Record<string, any>} getConfig  current encoder config (live, so
 *   a settings change is observed on the next request and triggers a recycle).
 * @returns {{ encode: (texts: string[], opts?: { signal?: AbortSignal }) => Promise<Float32Array[]>, warm: () => Promise<void>, info: () => Promise<any>, dispose: () => Promise<void>, daemon: Daemon }}
 */
export function createOnnxDaemon(getConfig) {
  const nativeAuth = heartbeatAuthManager.getCapability();
  const daemon = registerOnnxThreadDaemon(new Daemon({
    key: () => onnxModelKey(getConfig()),
    transportFactory: () => ThreadTransport({ moduleUrl: HOST_URL, workerData: { config: getConfig(), nativeAuth } }),
    timeoutMs: ENCODE_TIMEOUT_MS,
  }));

  const call = async (payload, opts = {}) => {
    const res = await daemon.request(payload, opts);
    if (res?.ok === true) return res.data;
    const message = String(/** @type {any} */ (res?.error)?.message || "onnx daemon call failed");
    throw new Error(message);
  };

  return {
    daemon,
    async encode(texts, opts = {}) {
      const data = await call({ op: "encode", texts }, opts);
      return /** @type {Float32Array[]} */ (data?.vectors || []);
    },
    async warm() { await call({ op: "warm" }); },
    info() { return call({ op: "info" }); },
    async dispose() { await call({ op: "dispose" }, { timeoutMs: 30_000 }); },
  };
}

// Process-global persistent encoder set. One warm model per worker; the batch is
// split across the workers and reassembled in order, so bulk ingest gets
// data-parallel encode AND persistence on a single supervised lifecycle. Width 1
// (search / on-demand) is the old single-worker path. Each underlying Daemon
// keeps its own crash-restart, recycle-on-identity, and clean MessagePort
// termination — this layer only fans out and owns the shared idle/keep-warm
// lifecycle.
//
// IDLE EVICTION — same constraint as the shared conductor: a worker's comm
// MessagePort stays an active libuv handle until terminate() resolves, so
// unref() alone won't let a process that encoded once exit. The set self-
// disposes after an idle window with no in-flight encodes; a long-lived run pins
// it warm via setOnnxDaemonKeepWarm(true) so the ~6s model load is paid once per
// session per worker, not once per quiet gap.
const DEFAULT_IDLE_MS = 30_000;
const KEEPWARM_IDLE_MS = 900_000; // 15 min backstop while pinned
const SHARED_CLOSE_DRAIN_MS = 10_000;
const MAX_ENCODE_WORKERS = 8;
let _idleMs = DEFAULT_IDLE_MS;
let _keepWarm = false;
/** @type {ReturnType<typeof createOnnxDaemon>[]} The warm worker set (one model each). */
let _workers = [];
/** @type {{ encode: Function, warm: Function, info: Function } | null} Stable client over _workers. */
let _client = null;
/** @type {Record<string, any>} */
let _sharedConfig = {};
let _sharedInflight = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let _sharedIdleTimer = null;
/** @type {Promise<void> | null} guards re-entrant closeSharedOnnxDaemon calls. */
let _sharedClosing = null;

/**
 * Clamp a requested encode width to [1, MAX_ENCODE_WORKERS]. (Re-homed from the
 * retired local-onnx-encode-pool so ingest keeps one import surface.)
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeEmbeddingThreads(value, fallback = 2) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(MAX_ENCODE_WORKERS, base));
}

// Indirection so tests can seed fake workers (no ~6s model load / real thread).
let _workerFactory = createOnnxDaemon;

/** Grow the warm set to at least `n` workers (lazy; only shrinks on close). */
function _ensureWorkers(n) {
  const want = normalizeEmbeddingThreads(n, 1);
  while (_workers.length < want) {
    _workers.push(_workerFactory(() => _sharedConfig));
  }
}

function _disarmIdle() {
  if (_sharedIdleTimer) { clearTimeout(_sharedIdleTimer); _sharedIdleTimer = null; }
}

function _armIdle() {
  _disarmIdle();
  if (_sharedInflight > 0) return;
  _sharedIdleTimer = setTimeout(() => {
    _sharedIdleTimer = null;
    if (_sharedInflight === 0) closeSharedOnnxDaemon().catch(() => { /* best effort */ });
  }, _keepWarm ? KEEPWARM_IDLE_MS : _idleMs);
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

/** Wrap an op so the idle timer is held off while it runs. */
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

/**
 * Encode `texts` across up to `opts.workers` warm workers, splitting the batch
 * into contiguous chunks and reassembling in order. A single worker (or a single
 * text) takes the whole batch — the former single-daemon path.
 * @param {string[]} texts
 * @param {{ signal?: AbortSignal, workers?: number }} [opts]
 * @returns {Promise<Float32Array[]>}
 */
async function _encode(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  _ensureWorkers(opts.workers ?? 1);
  const reqOpts = { signal: opts.signal };
  const n = Math.min(normalizeEmbeddingThreads(opts.workers ?? 1, 1), texts.length, _workers.length);
  if (n <= 1) return _workers[0].encode(texts, reqOpts);
  const chunkSize = Math.ceil(texts.length / n);
  /** @type {Promise<Float32Array[]>[]} */
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const start = i * chunkSize;
    if (start >= texts.length) break;
    jobs.push(_workers[i].encode(texts.slice(start, start + chunkSize), reqOpts));
  }
  const results = await Promise.all(jobs);
  /** @type {Float32Array[]} */
  const out = [];
  for (const vecs of results) for (const v of vecs) out.push(v);
  return out;
}

async function _warm(opts = {}) {
  _ensureWorkers(opts.workers ?? 1);
  const n = Math.min(normalizeEmbeddingThreads(opts.workers ?? 1, 1), _workers.length);
  await Promise.all(_workers.slice(0, n).map((w) => w.warm()));
}

async function _info() {
  const perWorker = await Promise.all(_workers.map((w) => w.info()));
  return { workers: _workers.length, perWorker };
}

/**
 * Pin the shared encoder set warm for a long-lived run (the session/host sets
 * true at boot, false in cleanup). No-op-safe to call when no set exists.
 * @param {boolean} on
 */
export function setOnnxDaemonKeepWarm(on) {
  _keepWarm = !!on;
  if (_client) _armIdle();
}

/** Test hook: override the idle-eviction window. Pass nothing to restore. */
export function setOnnxDaemonIdleMsForTests(ms = DEFAULT_IDLE_MS) {
  const n = Number(ms);
  _idleMs = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

/** Test hook: current warm worker count. */
export function __onnxEncoderWorkerCountForTests() {
  return _workers.length;
}

/**
 * Test hook: replace the worker factory (default `createOnnxDaemon`) so a test
 * can seed fake workers that return vectors without loading the real model or
 * spawning a thread. Pass nothing to restore. Call after closeSharedOnnxDaemon().
 * @param {((getConfig: () => Record<string, any>) => any) | null} [factory]
 */
export function __setOnnxEncoderWorkerFactoryForTests(factory = null) {
  _workerFactory = factory || createOnnxDaemon;
}

/**
 * Get the process-global ONNX encoder, updating the live config it reads (a
 * model/version/dim change recycles each warm worker on its next request) and
 * growing the warm set to `opts.workers` (default 1 — search/on-demand).
 * @param {Record<string, any>} config
 * @param {{ workers?: number }} [opts]
 */
export function getSharedOnnxDaemon(config = {}, opts = {}) {
  _sharedConfig = config;
  _ensureWorkers(opts.workers ?? 1);
  if (!_client) {
    _client = {
      encode: _tracked(_encode),
      warm: _tracked(_warm),
      info: _info,
    };
    _armIdle();
  }
  return _client;
}

/**
 * Tear down every warm worker (terminate their threads). Safe to call when none
 * exist. Awaiting it guarantees each worker's MessagePort is released so the
 * process can exit.
 */
export async function closeSharedOnnxDaemon() {
  if (_sharedClosing) return _sharedClosing;
  _disarmIdle();
  const workers = _workers;
  _workers = [];
  _client = null;
  if (workers.length === 0) return;
  _sharedClosing = (async () => {
    await _waitForSharedIdle();
    await Promise.all(workers.map(async (w) => {
      try { await w.dispose?.(); } catch { /* best effort */ }
      try { await w.daemon.dispose(); } catch { /* best effort */ }
    }));
  })();
  try { await _sharedClosing; } finally { _sharedClosing = null; }
}

/**
 * Encode texts on the shared warm worker set. Drop-in for an inline encode,
 * minus the per-call model reload; `opts.workers` requests data-parallel fanout.
 * @param {string[]} texts
 * @param {Record<string, any>} config
 * @param {{ signal?: AbortSignal, workers?: number }} [opts]
 * @returns {Promise<Float32Array[]>}
 */
export function encodeViaSharedOnnxDaemon(texts, config, opts = {}) {
  return getSharedOnnxDaemon(config, { workers: opts.workers ?? 1 }).encode(texts, opts);
}
