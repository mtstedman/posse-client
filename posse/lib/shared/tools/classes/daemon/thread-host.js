// @ts-check
//
// Server-side helper for Node worker-thread daemons (ONNX encoder, SCIP
// conductor). A host module calls runDaemonThread(handler) and the rest — the
// message loop, id echo, error wrapping — is handled here, matching the wire
// shape the Daemon/ThreadTransport client expects (`{ id, payload }` in,
// `{ id, ok, data } | { id, ok: false, error }` out).

import { parentPort } from "node:worker_threads";

/**
 * @param {(payload: unknown, message: Record<string, unknown>, emitProgress: (event: unknown) => void) => unknown | Promise<unknown>} handler
 */
export function runDaemonThread(handler) {
  if (!parentPort) throw new Error("runDaemonThread must run inside a worker thread");
  const port = parentPort;
  port.on("message", async (message) => {
    // The Daemon sends `{ ...payload, id }` (flat, so process hosts can read
    // protocol/method/payload at top level). Strip id and hand the handler back
    // exactly the payload the caller passed to Daemon.request.
    const { id, ...payload } = message || {};
    // Optional progress channel: the handler may stream `{ id, progress }`
    // messages mid-request (no terminal `ok`); the Daemon routes them to the
    // caller's onProgress and keeps the request pending. Backward compatible —
    // a handler that ignores this third arg simply never emits progress.
    const emitProgress = (event) => {
      try { port.postMessage({ id, progress: event }); } catch { /* parent gone */ }
    };
    try {
      const data = await handler(payload, message, emitProgress);
      port.postMessage({ id, ok: true, data });
    } catch (err) {
      port.postMessage({ id, ok: false, error: { message: String(/** @type {any} */ (err)?.message || err) } });
    }
  });
}
