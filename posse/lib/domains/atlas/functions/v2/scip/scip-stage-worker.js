// @ts-check
//
// Worker-thread entry point for boot SCIP staging (.scip generation). The
// indexer subprocess spawn inside ensureScipStaged is already async, but its
// plan resolution (synchronous repo walk via resolveScipStagePlans) and the
// stager-meta reads/decisions run synchronously and must not sit on the CLI
// event loop during boot warm. Running them here keeps the scheduler's
// lock-renew heartbeat alive. Uses the ThreadManager {type,result,event,error}
// message protocol.

import { parentPort, workerData } from "node:worker_threads";
import { ensureScipStaged } from "./stager.js";

/** @param {Record<string, unknown>} message */
function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent is gone */ }
}

async function main() {
  const result = await ensureScipStaged({
    repoRoot: workerData?.repoRoot,
    scipDir: workerData?.scipDir,
    mode: workerData?.mode,
    config: workerData?.config || {},
    timeoutMs: workerData?.timeoutMs ?? null,
    posseRoot: workerData?.posseRoot ?? null,
    onProgress: (event) => post({ type: "progress", event }),
  });
  // Return only the cloneable subset the boot caller consumes. The full
  // result carries nested decision/meta objects we don't need across the
  // thread boundary.
  post({
    type: "result",
    result: {
      enabled: result?.enabled ?? null,
      dir: result?.dir ?? null,
      files: Array.isArray(result?.files) ? result.files : [],
      staged: result?.staged ?? null,
      reason: result?.reason ?? null,
      error: result?.error ?? null,
      orphanStagingRemoved: result?.orphanStagingRemoved ?? 0,
    },
  });
}

main().catch((err) => {
  post({
    type: "error",
    error: {
      name: err?.name || "Error",
      message: err?.message || String(err),
      stack: err?.stack || null,
      code: err?.code || null,
    },
  });
});
