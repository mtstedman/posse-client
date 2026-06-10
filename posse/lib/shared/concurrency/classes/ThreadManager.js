// @ts-check
//
// Thin lifecycle wrapper around worker_threads. It keeps the common worker
// protocol in one place: progress messages, structured error hydration,
// timeout/abort termination, and listener cleanup.

import { Worker as NodeWorker } from "node:worker_threads";
import { sanitizeWorkerExecArgv } from "../../../domains/runtime/functions/worker-exec-argv.js";

/**
 * @typedef {{
 *   type?: string,
 *   result?: unknown,
 *   event?: Record<string, unknown>,
 *   error?: Record<string, unknown>,
 * }} ThreadMessage
 */

/**
 * @param {Record<string, unknown>} payload
 * @param {string} fallbackMessage
 * @returns {Error}
 */
export function errorFromThreadPayload(payload = {}, fallbackMessage = "Worker thread failed") {
  const err = new Error(String(payload?.message || fallbackMessage));
  err.name = String(payload?.name || "Error");
  if (payload?.stack) err.stack = String(payload.stack);
  for (const key of ["code", "errno", "syscall", "path", "spawnargs", "status", "signal", "killed", "timeoutMs"]) {
    if (payload?.[key] != null) {
      try { /** @type {any} */ (err)[key] = payload[key]; } catch { /* best effort */ }
    }
  }
  return err;
}

/**
 * @param {Error} err
 * @param {Record<string, unknown>} extra
 * @returns {Error}
 */
export function decorateThreadError(err, extra = {}) {
  for (const [key, value] of Object.entries(extra)) {
    try { /** @type {any} */ (err)[key] = value; } catch { /* best effort */ }
  }
  return err;
}

function abortReasonToError(signal, label) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(`${label} aborted`);
  err.name = "AbortError";
  try { /** @type {any} */ (err).code = "ABORT_ERR"; } catch { /* best effort */ }
  if (reason != null) {
    try { /** @type {any} */ (err).reason = reason; } catch { /* best effort */ }
  }
  return err;
}

export class ThreadManager {
  /**
   * @param {{ WorkerClass?: typeof NodeWorker }} [opts]
   */
  constructor({ WorkerClass = NodeWorker } = {}) {
    this.WorkerClass = WorkerClass;
  }

  /**
   * Run a module worker using Posse's standard `{type,result,event,error}`
   * message protocol. The returned promise does not settle on timeout/abort
   * until termination has been requested, so callers can safely hold resource
   * gates around the whole worker lifetime.
   *
   * @template T
   * @param {string | URL} workerUrl
   * @param {{
   *   workerData?: Record<string, unknown>,
   *   label?: string,
   *   timeoutMs?: number | null,
   *   signal?: AbortSignal | null,
 *   onProgress?: ((event: Record<string, unknown>) => void) | null,
 *   onLifecycle?: ((event: Record<string, unknown>) => void) | null,
 *   workerOptions?: Record<string, unknown>,
 *   unref?: boolean,
 * }} [opts]
   * @returns {Promise<T>}
   */
  run(workerUrl, {
    workerData = {},
    label = "worker thread",
    timeoutMs = null,
    signal = null,
    onProgress = null,
    onLifecycle = null,
    workerOptions = {},
    unref = false,
  } = {}) {
    const maxMs = Number(timeoutMs);
    return new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      let settled = false;
      const execArgv = Array.isArray(workerOptions?.execArgv)
        ? /** @type {string[]} */ (workerOptions.execArgv)
        : undefined;
      const sanitizedWorkerOptions = {
        ...workerOptions,
        execArgv: sanitizeWorkerExecArgv(execArgv),
      };
      const worker = new this.WorkerClass(workerUrl, /** @type {any} */ ({
        type: "module",
        workerData,
        ...sanitizedWorkerOptions,
      }));
      emitLifecycle(onLifecycle, {
        kind: "start",
        label,
        worker_url: String(workerUrl),
        worker_thread_id: worker.threadId,
        timeout_ms: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : null,
        unref: !!unref,
      });
      if (unref) {
        try { worker.unref?.(); } catch { /* detached workers are best effort */ }
      }

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener?.("abort", onAbort);
        worker.removeAllListeners("message");
        worker.removeAllListeners("error");
        worker.removeAllListeners("exit");
      };

      /**
       * @param {(value: any) => void} fn
       * @param {unknown} value
       * @param {{ terminate?: boolean }} [settleOpts]
       */
      const finish = (fn, value, settleOpts = {}) => {
        if (settled) return;
        settled = true;
        const terminate = settleOpts.terminate === true;
        if (timer) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener?.("abort", onAbort);
        worker.removeAllListeners("message");
        worker.removeAllListeners("error");
        worker.removeAllListeners("exit");
        if (!terminate) {
          fn(value);
          return;
        }
        worker.terminate()
          .catch(() => undefined)
          .finally(() => {
            cleanup();
            fn(value);
          });
      };

      /** @param {ThreadMessage} message */
      const onMessage = (message = {}) => {
        if (message?.type === "progress") {
          if (typeof onProgress === "function") {
            try { onProgress(message.event || {}); } catch { /* progress is observational */ }
          }
          return;
        }
        if (message?.type === "result") {
          emitLifecycle(onLifecycle, {
            kind: "result",
            label,
            worker_url: String(workerUrl),
            worker_thread_id: worker.threadId,
          });
          finish(resolve, /** @type {T} */ (message.result));
          return;
        }
        if (message?.type === "error") {
          const err = errorFromThreadPayload(message.error || {}, `${label} failed`);
          emitLifecycle(onLifecycle, {
            kind: "message_error",
            label,
            worker_url: String(workerUrl),
            worker_thread_id: worker.threadId,
            error: threadErrorTelemetry(err),
          });
          finish(reject, err);
        }
      };

      const onError = (err) => {
        const decorated = decorateThreadError(err instanceof Error ? err : new Error(String(err)), {
          code: "THREAD_ERROR",
          threadLabel: label,
        });
        emitLifecycle(onLifecycle, {
          kind: "error",
          label,
          worker_url: String(workerUrl),
          worker_thread_id: worker.threadId,
          error: threadErrorTelemetry(decorated),
        });
        finish(reject, decorated);
      };

      const onExit = (code) => {
        if (settled) return;
        const message = code === 0
          ? `${label} exited before returning a result`
          : `${label} exited with code ${code}`;
        const decorated = decorateThreadError(new Error(message), {
          code: "THREAD_EXIT",
          exitCode: code,
          threadLabel: label,
        });
        emitLifecycle(onLifecycle, {
          kind: "exit",
          label,
          worker_url: String(workerUrl),
          worker_thread_id: worker.threadId,
          exit_code: code,
          error: threadErrorTelemetry(decorated),
        });
        finish(reject, decorated);
      };

      function onAbort() {
        const decorated = decorateThreadError(abortReasonToError(signal, label), {
          code: "THREAD_ABORTED",
          threadLabel: label,
        });
        emitLifecycle(onLifecycle, {
          kind: "abort",
          label,
          worker_url: String(workerUrl),
          worker_thread_id: worker.threadId,
          error: threadErrorTelemetry(decorated),
        });
        finish(reject, decorated, { terminate: true });
      }

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });

      if (Number.isFinite(maxMs) && maxMs > 0) {
        timer = setTimeout(() => {
          const err = decorateThreadError(new Error(`${label} timed out after ${maxMs}ms`), {
            code: "THREAD_TIMEOUT",
            timeoutMs: maxMs,
            threadLabel: label,
          });
          emitLifecycle(onLifecycle, {
            kind: "timeout",
            label,
            worker_url: String(workerUrl),
            worker_thread_id: worker.threadId,
            timeout_ms: maxMs,
            error: threadErrorTelemetry(err),
          });
          finish(reject, err, { terminate: true });
        }, maxMs);
        timer.unref?.();
      }
    });
  }
}

/**
 * @param {((event: Record<string, unknown>) => void) | null | undefined} fn
 * @param {Record<string, unknown>} event
 */
function emitLifecycle(fn, event) {
  if (typeof fn !== "function") return;
  try { fn(event); } catch { /* lifecycle telemetry is observational */ }
}

/**
 * @param {Error} err
 */
function threadErrorTelemetry(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err),
    code: /** @type {any} */ (err)?.code || null,
    exit_code: /** @type {any} */ (err)?.exitCode ?? null,
    signal: /** @type {any} */ (err)?.signal ?? null,
    timeout_ms: /** @type {any} */ (err)?.timeoutMs ?? null,
    stack: typeof err?.stack === "string" ? err.stack.slice(0, 8000) : null,
  };
}
