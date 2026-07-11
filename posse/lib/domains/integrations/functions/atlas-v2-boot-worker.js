// @ts-check
//
// Worker-thread entry point for ATLAS v2 boot warming. Tree-sitter and
// better-sqlite3 are synchronous/native enough to monopolize the event loop
// while they run; keeping this work in a worker lets the CLI parent keep
// rendering heartbeat progress.

import { parentPort, workerData } from "node:worker_threads";
import { Ledger } from "../../atlas/classes/v2/Ledger.js";
import { Warmer } from "../../atlas/classes/v2/Warmer.js";
import { sharedParserAdapter } from "../../atlas/classes/v2/ParserAdapter.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
} from "../../atlas/functions/v2/embeddings/forensics.js";

if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
  nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth));
}

/**
 * @param {Record<string, unknown>} message
 */
function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent is gone */ }
}

/**
 * @param {Record<string, unknown>} event
 */
function progress(event) {
  recordEmbeddingForensics("atlas.boot_worker.progress", {
    worker_data: publicWorkerData(),
    // Not `event:` — appendPersistentTelemetry spreads this payload over its
    // own `event` name field, and the collision left every one of these
    // records unnamed in the JSONL.
    progress_event: event,
  });
  post({ type: "progress", event });
}

const stopController = new AbortController();
let stopRequested = false;

parentPort?.on("message", (message = {}) => {
  if (message?.type !== "stop") return;
  stopRequested = true;
  const reason = String(message.reason || "ATLAS boot worker stop requested");
  progress({
    kind: "line",
    stream: "system",
    stage: "stopping",
    text: reason,
  });
  if (!stopController.signal.aborted) stopController.abort(new Error(reason));
});

process.on("uncaughtException", (err) => {
  recordEmbeddingForensics("atlas.boot_worker.uncaught_exception", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(err),
  });
  post({ type: "error", error: errorForTelemetry(err) });
  throw err;
});

process.on("unhandledRejection", (reason) => {
  recordEmbeddingForensics("atlas.boot_worker.unhandled_rejection", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(reason),
  });
  post({ type: "error", error: errorForTelemetry(reason) });
});

/**
 * Test-only knob used by the parent-process heartbeat regression test. It
 * intentionally blocks only this worker thread, never the CLI event loop.
 *
 * @param {number} ms
 */
function blockWorkerFor(ms) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    // Busy wait by design: this simulates a synchronous native call.
  }
}

async function main() {
  const {
    ledgerDbPath,
    repoRoot,
    defaultBranch = "main",
    mainViewDbPath,
    config = {},
    testBlockMs = 0,
    purpose = "main-full",
  } = workerData || {};
  if (!ledgerDbPath) throw new TypeError("ATLAS v2 boot worker: ledgerDbPath is required");
  if (!repoRoot) throw new TypeError("ATLAS v2 boot worker: repoRoot is required");
  if (!mainViewDbPath) throw new TypeError("ATLAS v2 boot worker: mainViewDbPath is required");
  recordEmbeddingForensics("atlas.boot_worker.start", {
    worker_data: publicWorkerData(),
  });

  if (testBlockMs > 0) {
    progress({
      kind: "line",
      stream: "system",
      stage: "worker",
      text: `worker busy for ${testBlockMs}ms`,
    });
    blockWorkerFor(testBlockMs);
  }

  /** @type {Ledger | null} */
  let ledger = null;
  /** @type {Record<string, unknown> | null} */
  let result = null;
  try {
    progress({
      kind: "line",
      stream: "system",
      stage: "initializing",
      text: `opening ATLAS ledger for ${defaultBranch}`,
    });
    ledger = await Ledger.open({ dbPath: ledgerDbPath });

    progress({
      kind: "line",
      stream: "system",
      stage: "initializing",
      text: "constructing ATLAS warmer",
    });
    const warmer = new Warmer({
      ledger,
      parserAdapter: sharedParserAdapter,
      repoRoot,
      defaultBranch: String(defaultBranch || "main").trim() || "main",
      config: config && typeof config === "object" ? config : {},
      onProgress: progress,
      signal: stopController.signal,
    });

    const warmPurpose = purpose === "main-incremental" ? "main-incremental" : "main-full";
    progress({
      kind: "line",
      stream: "system",
      stage: "initializing",
      text: `starting ${warmPurpose} ATLAS warm for ${defaultBranch}`,
    });
    result = await warmer.handleWarmJob({
      purpose: warmPurpose,
      paths: [],
      branch: String(defaultBranch || "main").trim() || "main",
      out_view_path: mainViewDbPath,
      trigger_event: "boot",
    });
    if (stopRequested && stopController.signal.aborted) {
      throw stopController.signal.reason || new Error("ATLAS boot worker stopped");
    }
    recordEmbeddingForensics("atlas.boot_worker.done", {
      worker_data: publicWorkerData(),
      result,
    });
  } finally {
    try { ledger?.close?.(); } catch { /* ignore */ }
    // This worker thread has its own module graph, so any native daemon hosts
    // it spawned (posse-git/posse-atlas via its thread-local BinaryManager)
    // are invisible to the main thread's supervisor. Dispose them here or
    // they outlive the thread as orphaned processes.
    try { await nativeBinaries.disposeAll(); } catch { /* best effort */ }
  }
  post({ type: "result", result });
}

main().catch((err) => {
  recordEmbeddingForensics("atlas.boot_worker.error", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(err),
  });
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

function publicWorkerData() {
  const data = workerData || {};
  return {
    ledger_db_path: data.ledgerDbPath || null,
    repo_root: data.repoRoot || null,
    default_branch: data.defaultBranch || null,
    main_view_db_path: data.mainViewDbPath || null,
    purpose: data.purpose || null,
    test_block_ms: data.testBlockMs || 0,
  };
}
