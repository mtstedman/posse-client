// @ts-check
//
// Worker-thread entry point for per-layer readiness inspection. The readiness
// pass runs synchronous better-sqlite3 COUNT(*) scans over the view's symbols
// and the active embedding model's vectors table — on a large repo that blocks the
// CLI event loop (TUI rendering, scheduler lock-renew heartbeat) when invoked
// mid-run, e.g. from the backgrounded-boot failure handlers. Running it here
// keeps the main thread responsive; the caller enqueues repair warms from the
// returned layers on the main thread (the outbox writes are cheap). Uses the
// ThreadManager {type,result,error} message protocol.

import { parentPort, workerData } from "node:worker_threads";
import { computeAtlasLayerReadiness } from "./readiness.js";

/** @param {Record<string, unknown>} message */
function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent is gone */ }
}

try {
  const { repoRoot, config = {}, parity } = workerData || {};
  const result = computeAtlasLayerReadiness({
    repoRoot,
    config,
    ...(Number.isFinite(Number(parity)) ? { parity: Number(parity) } : {}),
  });
  post({ type: "result", result });
} catch (err) {
  post({
    type: "error",
    error: {
      name: err?.name || "Error",
      message: err?.message || String(err),
      stack: err?.stack || null,
      code: err?.code || null,
    },
  });
}
