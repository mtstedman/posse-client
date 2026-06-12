// @ts-check
//
// ONNX encoder daemon (client side) on the shared Daemon primitive. Keeps the
// transformers.js model warm in a persistent worker thread and recycles it when
// the embedding identity (backend:model:version:dim) changes — the lifecycle
// the per-ingestView encode pool deliberately punted on.

import { Daemon, ThreadTransport } from "../../../../../classes/tools/daemon/index.js";

const HOST_URL = new URL("./onnx-host.mjs", import.meta.url);
// Generous ceiling: first request pays the ~6s model load, and a big batch can
// take a while. A wedged encode still can't hang forever.
const ENCODE_TIMEOUT_MS = 300_000;

/**
 * The recycle key — when this changes the daemon tears down the warm model and
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
  const daemon = new Daemon({
    key: () => onnxModelKey(getConfig()),
    transportFactory: () => ThreadTransport({ moduleUrl: HOST_URL, workerData: { config: getConfig() } }),
    timeoutMs: ENCODE_TIMEOUT_MS,
  });

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

// Process-global persistent encoder. Unlike the per-ingestView pool (which tears
// the model down each call), this keeps one warm model for the whole session;
// the Daemon recycles it automatically when the embedding identity changes.
//
// IDLE EVICTION — same constraint as the shared conductor: the worker's
// communication MessagePort stays an active libuv handle until terminate()
// resolves, so `unref()` alone does NOT let a process that encoded once exit.
// The shared daemon self-disposes after an idle window with no in-flight
// encodes; a long-lived run pins it warm via setOnnxDaemonKeepWarm(true) so
// the ~6s model load is paid once per session, not once per quiet gap.
const DEFAULT_IDLE_MS = 30_000;
const KEEPWARM_IDLE_MS = 900_000; // 15 min backstop while pinned
const SHARED_CLOSE_DRAIN_MS = 10_000;
let _idleMs = DEFAULT_IDLE_MS;
let _keepWarm = false;
/** @type {{ daemon: Daemon, encode: Function, warm: Function, info: Function, dispose?: Function } | null} */
let _shared = null;
/** @type {Record<string, any>} */
let _sharedConfig = {};
let _sharedInflight = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let _sharedIdleTimer = null;
/** @type {Promise<void> | null} guards re-entrant closeSharedOnnxDaemon calls. */
let _sharedClosing = null;

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
 * Pin the shared encoder warm for the duration of a long-lived run (the
 * session sets true at boot, false in ATLAS cleanup). No-op-safe.
 * @param {boolean} on
 */
export function setOnnxDaemonKeepWarm(on) {
  _keepWarm = !!on;
  if (_shared) _armIdle();
}

/** Test hook: override the idle-eviction window. Pass nothing to restore. */
export function setOnnxDaemonIdleMsForTests(ms = DEFAULT_IDLE_MS) {
  const n = Number(ms);
  _idleMs = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_IDLE_MS;
}

/**
 * Get the process-global ONNX encoder daemon, updating the live config it reads
 * (a model/version/dim change recycles the warm model on the next request).
 *
 * @param {Record<string, any>} config
 */
export function getSharedOnnxDaemon(config = {}) {
  _sharedConfig = config;
  if (!_shared) {
    const base = createOnnxDaemon(() => _sharedConfig);
    _shared = {
      daemon: base.daemon,
      info: base.info,
      dispose: base.dispose,
      encode: _tracked(base.encode),
      warm: _tracked(base.warm),
    };
    _armIdle();
  }
  return _shared;
}

/**
 * Tear down the shared encoder daemon (terminate the worker thread). Safe to
 * call when none exists. Awaiting it guarantees the worker's MessagePort is
 * released so the process can exit.
 */
export async function closeSharedOnnxDaemon() {
  if (_sharedClosing) return _sharedClosing;
  _disarmIdle();
  const shared = _shared;
  _shared = null;
  if (!shared) return;
  _sharedClosing = (async () => {
    await _waitForSharedIdle();
    try { await shared.dispose?.(); } catch { /* best effort */ }
    try { await shared.daemon.dispose(); } catch { /* best effort */ }
  })();
  try { await _sharedClosing; } finally { _sharedClosing = null; }
}

/**
 * Encode texts on the shared warm daemon. Drop-in for the pool's text->vector
 * call, minus the per-call model reload.
 *
 * @param {string[]} texts
 * @param {Record<string, any>} config
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Float32Array[]>}
 */
export function encodeViaSharedOnnxDaemon(texts, config, opts = {}) {
  return getSharedOnnxDaemon(config).encode(texts, opts);
}
