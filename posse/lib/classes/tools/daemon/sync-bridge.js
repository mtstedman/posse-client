// @ts-check
//
// SyncBridge — blocking access to a process-backed daemon. Spawns a broker
// worker thread (daemon-sync-broker.mjs) that owns the real Daemon, and blocks
// the calling thread on Atomics.wait over a SharedArrayBuffer until the broker
// answers. Gives execFileSync-style blocking semantics while reusing one
// long-lived daemon process. Reused for any process transport via its spec.

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncChannel, channelArm, channelWait } from "./sync-channel.js";

const BROKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "daemon-sync-broker.mjs");
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Hang guard: a wedged broker/daemon must never block the caller forever.
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export class SyncBridge {
  /**
   * @param {{
   *   transportSpec: { binPath: string, args?: string[], timeoutMs?: number },
   *   maxResponseBytes?: number,
   *   waitTimeoutMs?: number,
   * }} opts
   */
  constructor(opts) {
    this._transportSpec = opts.transportSpec;
    this._waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const channel = createSyncChannel(opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this._shared = channel.shared;
    this._control = channel.control;
    this._data = channel.data;
    /** @type {Worker | null} */
    this._worker = null;
    this._exitHookInstalled = false;
  }

  #ensureWorker() {
    if (this._worker) return true;
    try {
      const worker = new Worker(BROKER_SCRIPT, {
        workerData: { shared: this._shared, transportSpec: this._transportSpec },
      });
      // During a sync call the calling thread is blocked on Atomics.wait, so the
      // process can't exit mid-request; unref so the broker never holds it open.
      worker.unref();
      worker.on("error", () => { this._worker = null; });
      worker.on("exit", () => { this._worker = null; });
      this._worker = worker;
      if (!this._exitHookInstalled) {
        this._exitHookInstalled = true;
        process.once("exit", () => this.stop());
      }
    } catch {
      this._worker = null;
      return false;
    }
    return true;
  }

  /**
   * Send a request and block until the response. Returns the parsed response,
   * or null when unavailable / overflowed / timed out (caller falls back).
   *
   * @param {Record<string, unknown>} payload
   * @returns {Record<string, unknown> | null}
   */
  request(payload) {
    if (!this.#ensureWorker() || !this._worker) return null;
    channelArm(this._control);
    this._worker.postMessage(payload);
    const response = channelWait(this._control, this._data, this._waitTimeoutMs);
    if (response == null) {
      // Timed out or overflowed; drop a possibly-wedged broker so the next call
      // starts fresh, and let the caller fall back to a per-call spawn.
      this.stop();
    }
    return response;
  }

  stop() {
    const worker = this._worker;
    this._worker = null;
    try { worker?.terminate(); } catch { /* ignore */ }
  }
}
