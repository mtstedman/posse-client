// @ts-check
//
// Tiny worker pool for local ONNX text embedding. The pool is deliberately
// scoped to one ingestView call: model sessions are expensive, but keeping them
// process-global complicates shutdown and stale-setting handling. The caller
// still owns persistence; workers only return vectors.

import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { sanitizeWorkerExecArgv } from "../../../../runtime/functions/worker-exec-argv.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeTexts,
} from "./forensics.js";

const LOCAL_ONNX_ENCODE_WORKER_URL = new URL("./local-onnx-encode-worker.js", import.meta.url);

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeEmbeddingThreads(value, fallback = 2) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(8, base));
}

/**
 * @param {any} encoder
 * @param {number} workerCount
 * @returns {boolean}
 */
export function shouldUseLocalOnnxEncodePool(encoder, workerCount) {
  return normalizeEmbeddingThreads(workerCount, 1) > 1
    && encoder?.model === "local-onnx"
    && typeof encoder?.cacheDir === "string"
    && typeof encoder?.modelName === "string"
    && typeof encoder?.modelId === "string"
    && Number.isInteger(encoder?.dim)
    && typeof Worker === "function";
}

export class LocalOnnxEncodePool {
  /** @type {any} */
  #encoder;
  /** @type {number} */
  #workerCount;
  /** @type {Worker[]} */
  #workers = [];
  /** @type {Promise<void> | null} */
  #ready = null;
  /** @type {number} */
  #nextId = 1;
  /** @type {boolean} */
  #closed = false;
  /** @type {((event: Record<string, any>) => void) | null} */
  #onTiming = null;

  /**
   * @param {any} encoder
   * @param {number} workerCount
   * @param {{ onTiming?: ((event: Record<string, any>) => void) | null }} [options]
   */
  constructor(encoder, workerCount, options = {}) {
    this.#encoder = encoder;
    this.#workerCount = normalizeEmbeddingThreads(workerCount);
    this.#onTiming = typeof options.onTiming === "function" ? options.onTiming : null;
  }

  /**
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<Float32Array[]>}
   */
  async encode(texts, signal = undefined) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (signal?.aborted) throw /** @type {any} */ (signal).reason ?? new Error("encode aborted");
    recordEmbeddingForensics("onnx.pool.encode.start", {
      encoder: encoderTelemetry(this.#encoder),
      requested_worker_count: this.#workerCount,
      texts: summarizeTexts(texts),
    });
    const readyStartedAt = performance.now();
    await raceWithAbort(this.#ensureReady(), signal, "encode aborted");
    const readyMs = elapsedSince(readyStartedAt);
    if (signal?.aborted) throw /** @type {any} */ (signal).reason ?? new Error("encode aborted");

    const workers = this.#workers.slice();
    const activeCount = Math.min(workers.length, texts.length);
    if (activeCount <= 1) return this.#encoder.encode(texts, signal);

    /** @type {{ index: number, text: string }[][]} */
    const chunks = Array.from({ length: activeCount }, () => []);
    for (let i = 0; i < texts.length; i++) {
      chunks[i % activeCount].push({ index: i, text: texts[i] });
    }

    /** @type {Float32Array[]} */
    const out = new Array(texts.length);
    const encodeStartedAt = performance.now();
    const abortLink = linkedAbortController(signal);
    const jobs = chunks.map((chunk, workerIndex) => this.#encodeChunk(workers[workerIndex], chunk, out, abortLink.signal));
    try {
      await Promise.all(jobs);
    } catch (err) {
      recordEmbeddingForensics("onnx.pool.encode.error", {
        encoder: encoderTelemetry(this.#encoder),
        texts: summarizeTexts(texts),
        worker_count: workers.length,
        active_count: activeCount,
        elapsed_ms: roundMs(elapsedSince(encodeStartedAt)),
        error: errorForTelemetry(err),
      });
      abortLink.abort(err);
      await Promise.allSettled(jobs);
      throw err;
    } finally {
      abortLink.cleanup();
    }
    this.#emitTiming({
      kind: "atlas.embeddings.local_onnx_pool.encode",
      texts: texts.length,
      workerCount: workers.length,
      activeCount,
      chunkSizes: chunks.map((chunk) => chunk.length),
      readyMs: roundMs(readyMs),
      encodeMs: roundMs(elapsedSince(encodeStartedAt)),
    });
    recordEmbeddingForensics("onnx.pool.encode.done", {
      encoder: encoderTelemetry(this.#encoder),
      text_count: texts.length,
      worker_count: workers.length,
      active_count: activeCount,
      chunk_sizes: chunks.map((chunk) => chunk.length),
      ready_ms: roundMs(readyMs),
      encode_ms: roundMs(elapsedSince(encodeStartedAt)),
    });
    if (signal?.aborted) throw /** @type {any} */ (signal).reason ?? new Error("encode aborted");
    return out;
  }

  /**
   * @returns {Promise<void>}
   */
  async close() {
    this.#closed = true;
    this.#ready = null;
    const workers = this.#workers.splice(0);
    recordEmbeddingForensics("onnx.pool.close.start", {
      encoder: encoderTelemetry(this.#encoder),
      worker_count: workers.length,
    });
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    recordEmbeddingForensics("onnx.pool.close.done", {
      encoder: encoderTelemetry(this.#encoder),
      worker_count: workers.length,
    });
  }

  /**
   * @returns {Promise<void>}
   */
  #ensureReady() {
    if (this.#ready) return this.#ready;
    const needed = Math.max(0, this.#workerCount - this.#workers.length);
    if (needed === 0) return Promise.resolve();
    const ready = Promise.all(Array.from({ length: needed }, () => this.#createWorker()))
      .then(() => {})
      .catch(async (err) => {
        if (this.#ready === ready) this.#ready = null;
        await this.#terminateAllWorkers();
        throw err;
      });
    this.#ready = ready;
    return ready;
  }

  async #terminateAllWorkers() {
    const workers = this.#workers.splice(0);
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
  }

  #removeWorker(worker) {
    const index = this.#workers.indexOf(worker);
    if (index >= 0) this.#workers.splice(index, 1);
    if (!this.#closed && this.#ready) this.#ready = null;
  }

  /**
   * @returns {Promise<void>}
   */
  #createWorker() {
    if (this.#closed) return Promise.reject(new Error("local ONNX encode pool is closed"));
    const encoder = this.#encoder;
    const startedAt = performance.now();
    const worker = new Worker(LOCAL_ONNX_ENCODE_WORKER_URL, {
      execArgv: sanitizeWorkerExecArgv(),
      workerData: {
        cacheDir: encoder.cacheDir,
        modelName: encoder.modelName,
        modelId: encoder.modelId,
        dim: encoder.dim,
        modelVersion: encoder.model_version,
        batchSize: encoder.batchSize,
        maxInputChars: encoder.maxInputChars,
        maxInputTokens: encoder.maxInputTokens,
        dtype: encoder.dtype,
        localFilesOnly: encoder.localFilesOnly,
      },
    });
    this.#workers.push(worker);
    recordEmbeddingForensics("onnx.pool.worker.spawn", {
      encoder: encoderTelemetry(encoder),
      worker_thread_id: worker.threadId,
      requested_worker_count: this.#workerCount,
    });
    const removeWorker = () => this.#removeWorker(worker);
    worker.once("error", removeWorker);
    worker.once("exit", removeWorker);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      const onMessage = (message) => {
        if (message?.type !== "ready") return;
        cleanup();
        this.#emitTiming({
          kind: "atlas.embeddings.local_onnx_worker.ready",
          readyMs: roundMs(elapsedSince(startedAt)),
        });
        recordEmbeddingForensics("onnx.pool.worker.ready", {
          encoder: encoderTelemetry(encoder),
          worker_thread_id: worker.threadId,
          ready_ms: roundMs(elapsedSince(startedAt)),
        });
        resolve();
      };
      const onError = (err) => {
        cleanup();
        recordEmbeddingForensics("onnx.pool.worker.error_before_ready", {
          encoder: encoderTelemetry(encoder),
          worker_thread_id: worker.threadId,
          elapsed_ms: roundMs(elapsedSince(startedAt)),
          error: errorForTelemetry(err),
        });
        reject(err);
      };
      const onExit = (code) => {
        cleanup();
        recordEmbeddingForensics("onnx.pool.worker.exit_before_ready", {
          encoder: encoderTelemetry(encoder),
          worker_thread_id: worker.threadId,
          elapsed_ms: roundMs(elapsedSince(startedAt)),
          exit_code: code,
        });
        reject(new Error(`local ONNX encode worker exited before ready (code ${code})`));
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
  }

  /**
   * @param {Worker} worker
   * @param {{ index: number, text: string }[]} chunk
   * @param {Float32Array[]} out
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<void>}
   */
  #encodeChunk(worker, chunk, out, signal = undefined) {
    if (!this.#workers.includes(worker)) {
      return Promise.reject(new Error("local ONNX encode worker is no longer available"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        signal?.removeEventListener?.("abort", onAbort);
      };
      const onMessage = (message) => {
        if (message?.id !== id) return;
        if (message.type === "error") {
          const err = new Error(message.error?.message || "local ONNX encode worker failed");
          err.name = message.error?.name || "Error";
          if (message.error?.stack) err.stack = message.error.stack;
          recordEmbeddingForensics("onnx.pool.chunk.error", {
            encoder: encoderTelemetry(this.#encoder),
            request_id: id,
            worker_thread_id: worker.threadId,
            chunk_size: chunk.length,
            error: errorForTelemetry(err),
          });
          finish(reject, err);
          return;
        }
        if (message.type !== "result") return;
        const vectors = Array.isArray(message.vectors) ? message.vectors : [];
        if (vectors.length !== chunk.length) {
          finish(reject, new Error(`local ONNX encode worker returned ${vectors.length} vectors for ${chunk.length} texts`));
          return;
        }
        try {
          for (let i = 0; i < vectors.length; i++) {
            out[chunk[i].index] = vectors[i];
          }
          recordEmbeddingForensics("onnx.pool.chunk.done", {
            encoder: encoderTelemetry(this.#encoder),
            request_id: id,
            worker_thread_id: worker.threadId,
            chunk_size: chunk.length,
            vector_count: vectors.length,
          });
          finish(resolve, undefined);
        } catch (err) {
          recordEmbeddingForensics("onnx.pool.chunk.materialize_error", {
            encoder: encoderTelemetry(this.#encoder),
            request_id: id,
            worker_thread_id: worker.threadId,
            chunk_size: chunk.length,
            error: errorForTelemetry(err),
          });
          finish(reject, err);
        }
      };
      const onError = (err) => {
        recordEmbeddingForensics("onnx.pool.worker.error_during_encode", {
          encoder: encoderTelemetry(this.#encoder),
          request_id: id,
          worker_thread_id: worker.threadId,
          chunk_size: chunk.length,
          error: errorForTelemetry(err),
        });
        finish(reject, err);
      };
      const onExit = (code) => {
        recordEmbeddingForensics("onnx.pool.worker.exit_during_encode", {
          encoder: encoderTelemetry(this.#encoder),
          request_id: id,
          worker_thread_id: worker.threadId,
          chunk_size: chunk.length,
          exit_code: code,
        });
        finish(reject, new Error(`local ONNX encode worker exited during encode (code ${code})`));
      };
      const onAbort = () => {
        try { worker.terminate().catch(() => {}); } catch { /* best effort */ }
        finish(reject, abortReasonToError(signal, "encode aborted"));
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        recordEmbeddingForensics("onnx.pool.chunk.dispatch", {
          encoder: encoderTelemetry(this.#encoder),
          request_id: id,
          worker_thread_id: worker.threadId,
          chunk_size: chunk.length,
          texts: summarizeTexts(chunk.map((entry) => entry.text)),
        });
        worker.postMessage({ type: "encode", id, texts: chunk.map((entry) => entry.text) });
      } catch (err) {
        recordEmbeddingForensics("onnx.pool.chunk.dispatch_error", {
          encoder: encoderTelemetry(this.#encoder),
          request_id: id,
          worker_thread_id: worker.threadId,
          chunk_size: chunk.length,
          error: errorForTelemetry(err),
        });
        finish(reject, err);
      }
    }).then(() => {
      if (this.#closed) throw new Error("local ONNX encode pool closed during encode");
    });
  }

  /**
   * @param {Record<string, any>} event
   */
  #emitTiming(event) {
    if (!this.#onTiming) return;
    try { this.#onTiming(event); } catch { /* timing is observational */ }
  }
}

function encoderTelemetry(encoder) {
  return {
    model: encoder?.model || null,
    model_version: encoder?.model_version || null,
    model_name: encoder?.modelName || null,
    model_id: encoder?.modelId || null,
    dim: encoder?.dim || null,
    dtype: encoder?.dtype || null,
    batch_size: encoder?.batchSize || null,
    cache_dir: encoder?.cacheDir || null,
  };
}

function elapsedSince(startedAt) {
  return Math.max(0, performance.now() - Number(startedAt || performance.now()));
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/**
 * @param {Promise<unknown>} promise
 * @param {AbortSignal | undefined} signal
 * @param {string} fallback
 */
function raceWithAbort(promise, signal, fallback) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReasonToError(signal, fallback));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReasonToError(signal, fallback));
    signal.addEventListener?.("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener?.("abort", onAbort);
    });
  });
}

function linkedAbortController(parentSignal = undefined) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (!parentSignal) {
    return { signal: controller.signal, abort, cleanup: () => {} };
  }
  const onAbort = () => abort(parentSignal.reason);
  if (parentSignal.aborted) onAbort();
  else parentSignal.addEventListener?.("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    abort,
    cleanup: () => parentSignal.removeEventListener?.("abort", onAbort),
  };
}

/**
 * @param {AbortSignal | undefined} signal
 * @param {string} fallback
 */
function abortReasonToError(signal, fallback) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(fallback);
  err.name = "AbortError";
  try { /** @type {any} */ (err).code = "ABORT_ERR"; } catch { /* best effort */ }
  return err;
}
