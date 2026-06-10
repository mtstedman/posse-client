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
 * @returns {{ encode: (texts: string[], opts?: { signal?: AbortSignal }) => Promise<Float32Array[]>, warm: () => Promise<void>, info: () => Promise<any>, daemon: Daemon }}
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
  };
}

// Process-global persistent encoder. Unlike the per-ingestView pool (which tears
// the model down each call), this keeps one warm model for the whole session;
// the Daemon recycles it automatically when the embedding identity changes.
/** @type {ReturnType<typeof createOnnxDaemon> | null} */
let _shared = null;
/** @type {Record<string, any>} */
let _sharedConfig = {};

/**
 * Get the process-global ONNX encoder daemon, updating the live config it reads
 * (a model/version/dim change recycles the warm model on the next request).
 *
 * @param {Record<string, any>} config
 */
export function getSharedOnnxDaemon(config = {}) {
  _sharedConfig = config;
  if (!_shared) _shared = createOnnxDaemon(() => _sharedConfig);
  return _shared;
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
