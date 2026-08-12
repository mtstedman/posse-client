// @ts-check

import { isMainThread, MessageChannel } from "node:worker_threads";
import { Daemon, ThreadTransport, daemonSupervisor } from "../../../../shared/tools/classes/daemon/index.js";

const TELEMETRY_HOST_URL = new URL("../../functions/v2/parse/telemetry-host.mjs", import.meta.url);
const DEFAULT_MAX_QUEUED = 512;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const TELEMETRY_REQUEST_TIMEOUT_MS = 5_000;
const BATCH_MESSAGE = "atlas_usage_batch_v1";
const BARRIER_MESSAGE = "atlas_usage_barrier_v1";
const BARRIER_ACK = "atlas_usage_barrier_ack_v1";

/** Bounded, non-blocking batch queue. Stateful ownership belongs in classes/. */
export class UsageTelemetryQueue {
  #sendBatch;
  #maxQueued;
  #batchSize;
  #flushIntervalMs;
  #queue = [];
  #timer = null;
  #flushPromise = null;
  #enqueued = 0;
  #flushed = 0;
  #persisted = 0;
  #malformed = 0;
  #droppedOverflow = 0;
  #droppedDelivery = 0;
  #lastError = null;

  /**
   * @param {{
   *   sendBatch: (entries: unknown[]) => any | Promise<any>,
   *   maxQueued?: number,
   *   batchSize?: number,
   *   flushIntervalMs?: number,
   * }} args
   */
  constructor({
    sendBatch,
    maxQueued = DEFAULT_MAX_QUEUED,
    batchSize = DEFAULT_BATCH_SIZE,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  }) {
    if (typeof sendBatch !== "function") throw new TypeError("UsageTelemetryQueue requires sendBatch");
    this.#sendBatch = sendBatch;
    this.#maxQueued = Math.max(1, Number(maxQueued) || DEFAULT_MAX_QUEUED);
    this.#batchSize = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
    this.#flushIntervalMs = Math.max(1, Number(flushIntervalMs) || DEFAULT_FLUSH_INTERVAL_MS);
  }

  enqueue(entry) {
    if (this.#queue.length >= this.#maxQueued) {
      this.#queue.shift();
      this.#droppedOverflow++;
    }
    this.#queue.push(entry);
    this.#enqueued++;
    this.#schedule(this.#queue.length >= this.#batchSize ? 0 : this.#flushIntervalMs);
    return true;
  }

  async flush({ drain = false, dropOnFailure = false } = {}) {
    this.#clearTimer();
    if (this.#flushPromise) await this.#flushPromise;
    if (this.#queue.length === 0) return this.stats();

    const run = async () => {
      do {
        const batch = this.#queue.splice(0, this.#batchSize);
        try {
          const result = await this.#sendBatch(batch);
          this.#flushed += batch.length;
          this.#persisted += Math.max(0, Number(result?.persisted) || 0);
          this.#malformed += Math.max(0, Number(result?.malformed) || 0);
          this.#droppedDelivery += Math.max(0, Number(result?.droppedDelivery) || 0);
          this.#lastError = result?.lastError ? String(result.lastError) : null;
        } catch (err) {
          this.#lastError = String(/** @type {any} */ (err)?.message || err);
          if (dropOnFailure) {
            this.#droppedDelivery += batch.length + this.#queue.length;
            this.#queue.length = 0;
          } else {
            this.#queue = [...batch, ...this.#queue];
            while (this.#queue.length > this.#maxQueued) {
              this.#queue.shift();
              this.#droppedOverflow++;
            }
          }
          break;
        }
      } while (this.#queue.length > 0 && (drain || this.#queue.length >= this.#batchSize));
    };

    const current = run();
    this.#flushPromise = current;
    try { await current; } finally {
      if (this.#flushPromise === current) this.#flushPromise = null;
      if (this.#queue.length > 0) this.#schedule(this.#flushIntervalMs);
    }
    return this.stats();
  }

  close() {
    return this.flush({ drain: true, dropOnFailure: true });
  }

  flushSoon() {
    if (this.#queue.length > 0) this.#schedule(0);
  }

  stats() {
    return {
      queued: this.#queue.length,
      enqueued: this.#enqueued,
      flushed: this.#flushed,
      persisted: this.#persisted,
      malformed: this.#malformed,
      droppedOverflow: this.#droppedOverflow,
      droppedDelivery: this.#droppedDelivery,
      lastError: this.#lastError,
    };
  }

  #schedule(delayMs) {
    if (this.#timer) {
      if (delayMs !== 0) return;
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delayMs);
    this.#timer.unref?.();
  }

  #clearTimer() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

class AtlasUsageTelemetry {
  #mainThread;
  #daemon = null;
  #port = null;
  #queue;
  #droppedDisabled = 0;
  #droppedUnavailable = 0;
  #forwardedFromWorkers = 0;
  #host = null;
  #barrierSeq = 0;
  #barrierWaiters = new Map();
  #closing = null;

  constructor({ mainThread = isMainThread } = {}) {
    this.#mainThread = mainThread;
    if (mainThread) {
      this.#daemon = daemonSupervisor.daemon({
        kind: "atlas-usage-telemetry",
        label: "atlas-usage-telemetry",
        create: () => new Daemon({
          transportFactory: () => ThreadTransport({
            moduleUrl: TELEMETRY_HOST_URL,
            retirePayload: { op: "close" },
          }),
          timeoutMs: TELEMETRY_REQUEST_TIMEOUT_MS,
          maxPending: 8,
          label: "atlas-usage-telemetry",
        }),
      });
      this.#queue = new UsageTelemetryQueue({
        sendBatch: (entries) => this.#recordBatch(entries),
      });
      // Short-lived commands may emit directly without ever creating a
      // conductor. beforeExit is the last async-capable drain point; the
      // supervisor's synchronous exit hook remains the hard-stop fallback.
      process.once("beforeExit", () => { void this.close(); });
    } else {
      this.#queue = new UsageTelemetryQueue({
        sendBatch: (entries) => {
          if (!this.#port) throw new Error("Atlas usage telemetry transport is unavailable");
          this.#port.postMessage({ type: BATCH_MESSAGE, entries });
          return { forwarded: entries.length };
        },
      });
    }
  }

  enqueue(entry, { enabled = true } = {}) {
    if (!enabled) {
      this.#droppedDisabled++;
      return false;
    }
    if (!entry?.ledgerPath) {
      this.#droppedUnavailable++;
      return false;
    }
    return this.#queue.enqueue(entry);
  }

  installPort(port) {
    if (this.#mainThread || !port || typeof port.postMessage !== "function") return false;
    this.#port = port;
    this.#port.unref?.();
    this.#port.on?.("message", (message) => {
      if (message?.type !== BARRIER_ACK) return;
      const resolve = this.#barrierWaiters.get(Number(message.id));
      if (!resolve) return;
      this.#barrierWaiters.delete(Number(message.id));
      resolve();
    });
    this.#port.on?.("close", () => {
      if (this.#port === port) this.#port = null;
    });
    return true;
  }

  createWorkerChannel() {
    if (!this.#mainThread) throw new Error("usage telemetry worker channels are main-thread only");
    const channel = new MessageChannel();
    const receivingPort = channel.port1;
    receivingPort.on("message", (message) => {
      if (message?.type === BATCH_MESSAGE && Array.isArray(message.entries)) {
        this.#forwardedFromWorkers += message.entries.length;
        for (const entry of message.entries) this.#queue.enqueue(entry);
        // The source realm already paid its batching interval. Forward its
        // completed batch on the next turn instead of adding a second 250 ms
        // queue-age window in the parent.
        this.#queue.flushSoon();
        return;
      }
      if (message?.type === BARRIER_MESSAGE) {
        try { receivingPort.postMessage({ type: BARRIER_ACK, id: Number(message.id) }); } catch { /* source gone */ }
      }
    });
    receivingPort.on("messageerror", () => { this.#droppedUnavailable++; });
    receivingPort.unref();
    return { port: channel.port2, transferList: [channel.port2] };
  }

  async flush() {
    return this.#queue.flush({ drain: true });
  }

  async close() {
    if (this.#closing) return this.#closing;
    const closing = this.#close();
    this.#closing = closing;
    try { return await closing; } finally {
      if (this.#closing === closing) this.#closing = null;
    }
  }

  async #close() {
    if (!this.#mainThread) {
      await this.#queue.flush({ drain: true, dropOnFailure: true });
      await this.#sourceBarrier();
      try { this.#port?.close?.(); } catch { /* best effort */ }
      this.#port = null;
      return;
    }
    await this.#queue.flush({ drain: true, dropOnFailure: true });
    if (this.#daemon?.isHostAlive()) {
      try {
        const response = await this.#daemon.request({ op: "close" }, { timeoutMs: TELEMETRY_REQUEST_TIMEOUT_MS });
        if (response?.ok === true) this.#host = response.data;
      } catch { /* best effort */ }
    }
    try { await this.#daemon?.dispose?.(); } catch { /* best effort */ }
  }

  stats() {
    return {
      ...this.#queue.stats(),
      droppedReadOnly: 0,
      droppedDisabled: this.#droppedDisabled,
      droppedUnavailable: this.#droppedUnavailable,
      forwardedFromWorkers: this.#forwardedFromWorkers,
      laneAlive: this.#mainThread ? !!this.#daemon?.isHostAlive?.() : !!this.#port,
      host: this.#host,
    };
  }

  async #recordBatch(entries) {
    const response = await this.#daemon.request(
      { op: "record", entries },
      { timeoutMs: TELEMETRY_REQUEST_TIMEOUT_MS },
    );
    if (response?.ok !== true) {
      throw new Error(String(response?.error?.message || "Atlas usage telemetry lane unavailable"));
    }
    this.#host = response.data;
    return {
      persisted: Number(response.data?.inserted || 0),
      malformed: Number(response.data?.malformed || 0),
      droppedDelivery: Number(response.data?.failed || 0),
      lastError: response.data?.lastError || null,
    };
  }

  async #sourceBarrier() {
    if (!this.#port) return;
    const id = ++this.#barrierSeq;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#barrierWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      this.#barrierWaiters.set(id, finish);
      try { this.#port.postMessage({ type: BARRIER_MESSAGE, id }); } catch { finish(); }
    });
  }
}

export const atlasUsageTelemetry = new AtlasUsageTelemetry();

export function installAtlasUsageTelemetryPort(port) {
  return atlasUsageTelemetry.installPort(port);
}

export function createAtlasUsageTelemetryWorkerChannel() {
  return atlasUsageTelemetry.createWorkerChannel();
}

export function enqueueAtlasUsageEvent(entry, options) {
  return atlasUsageTelemetry.enqueue(entry, options);
}

export function getAtlasUsageTelemetryStats() {
  return atlasUsageTelemetry.stats();
}

export function flushAtlasUsageTelemetry() {
  return atlasUsageTelemetry.flush();
}

export function closeAtlasUsageTelemetry() {
  return atlasUsageTelemetry.close();
}
