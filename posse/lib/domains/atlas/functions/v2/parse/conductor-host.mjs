// @ts-check
//
// Atlas-Conductor daemon host (thread side). Owns the write side of the intake
// DBs — Ledger (atlas + scip intake) and View (merged) — for the lifetime of
// the worker, and serializes all durable mutation through a job-keyed write
// queue (the existing dbWriteSemaphore, relocated intact). SCIP staging fans
// out in parallel (scipStageSemaphore); the merge "zip" runs on the serial
// write queue when a language's inputs are ready.
//
// SQLite handles are thread-bound, so the conductor MUST open the DBs itself
// here rather than receive them. Reads stay concurrent elsewhere via separate
// WAL read-only connections — the conductor owns only the writers.
//
// Steady state is incremental: merge is scoped by `contentHashes`. A full
// (unscoped) merge is the cold-boot case.

import { workerData } from "node:worker_threads";
import { runDaemonThread } from "../../../../../classes/tools/daemon/thread-host.js";
import { installNativeThreadBridge } from "../../../../../classes/tools/daemon/native-thread-bridge.js";
import { nativeBinaries } from "../../../../../classes/tools/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../../../shared/native/classes/HeartbeatAuthManager.js";
import { createDbWriteSemaphore, createScipStageSemaphore } from "./semaphore.js";
import { SCIP_INDEXER_COUNT } from "../scip/indexers.js";
import { setOnnxDaemonKeepWarm, closeSharedOnnxDaemon } from "../embeddings/onnx-daemon.js";

if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
  nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth));
}
installNativeThreadBridge(workerData?.nativeBridgePort);

// This thread's nested ONNX encoder daemon (spawned on first daemon-backed
// encode) stays warm for the conductor's lifetime: the conductor itself is
// idle-evicted/terminated by its owner, which tears the nested worker down
// with it, so a short idle window here would only thrash the ~6s model load
// between retrieval bursts.
setOnnxDaemonKeepWarm(true);

// One handle entry per (ledger, view) target, reused across requests. The
// ledger and view connections are opened lazily and independently: the `warm`
// op needs only the ledger (ParseEngine owns its own View writer internally and
// rewrites the view file itself), so opening a second readwrite View handle on
// that same file here would be a needless double-open on the file warm is about
// to recreate. `merge` is the only op that uses the conductor-owned View.
/** @type {Map<string, { ledgerPath: string, dbPath: string, ledger: any, view: any }>} */
const handles = new Map();
const dbWrite = createDbWriteSemaphore();
// Embedding ANN writes run OUTSIDE dbWrite.run() (the encode is read-only w.r.t.
// the ledger/view writers, so it's flushed after the write-queue slot releases),
// and this host services warm requests concurrently — so two warms for the same
// repo could otherwise save/rename index.usearch at once. Serialize embedding
// flushes per repo so there is a single in-host ANN writer.
const embeddingWriteChains = new Map();
function runEmbeddingWriteExclusive(key, fn) {
  const k = String(key || "");
  const prev = embeddingWriteChains.get(k) || Promise.resolve();
  const run = prev.then(() => {}, () => {}).then(fn);
  const tail = run.then(() => {}, () => {});
  embeddingWriteChains.set(k, tail);
  void tail.finally(() => { if (embeddingWriteChains.get(k) === tail) embeddingWriteChains.delete(k); });
  return run;
}
// Generation fans out: one slot per known indexer so concurrent per-language
// stage ops never queue behind the valve. Correctness does not depend on this
// width — the stager's per-(cwd,output) gate serializes same-language runs and
// re-checks freshness inside the gate, so duplicates collapse to skips.
const scipStage = createScipStageSemaphore(SCIP_INDEXER_COUNT);

function getEntry(ledgerPath, dbPath) {
  const key = `${ledgerPath}|${dbPath}`;
  let entry = handles.get(key);
  if (!entry) {
    entry = { ledgerPath, dbPath, ledger: null, view: null };
    handles.set(key, entry);
  }
  return entry;
}

async function getLedger(ledgerPath, dbPath) {
  const entry = getEntry(ledgerPath, dbPath);
  if (!entry.ledger) {
    const { Ledger } = await import("../../../classes/v2/Ledger.js");
    entry.ledger = Ledger.open({ dbPath: ledgerPath });
  }
  return entry.ledger;
}

async function getView(ledgerPath, dbPath) {
  const entry = getEntry(ledgerPath, dbPath);
  if (!entry.view) {
    const { View } = await import("../../../classes/v2/View.js");
    entry.view = new View({ dbPath, mode: "readwrite" });
  }
  return entry.view;
}

runDaemonThread(async (payload, _message, emitProgress) => {
  const op = String(payload?.op || "");
  switch (op) {
    case "info":
      return { openTargets: [...handles.keys()], dbWriteDepth: dbWrite.depth?.() ?? null };

    case "stage": {
      // Parallel SCIP generation, gated by the stage semaphore. A `lang`
      // scopes the run to that language's indexer (aliases like `ts`/`py`
      // normalize; unknown values fall back to all detected languages);
      // without it the run covers every detected language.
      const { ensureScipStaged } = await import("../scip/stager.js");
      const lang = String(payload.lang || "").trim();
      const config = lang
        ? { ...(payload.config || {}), scipLanguages: [lang] }
        : payload.config;
      return scipStage.run(() => ensureScipStaged({
        repoRoot: payload.repoRoot,
        scipDir: payload.scipDir,
        mode: payload.mode,
        config,
      }));
    }

    case "ingest": {
      // Write one staged .scip file into the Ledger — serialized on the write
      // queue (the gate), reading the staged output, writing ledger.db here.
      const ledger = await getLedger(payload.ledgerPath, payload.dbPath);
      const { ingestScipFile } = await import("../scip/ingester.js");
      return dbWrite.run(() => ingestScipFile({
        ledger,
        scipPath: payload.scipPath,
        repoRoot: payload.repoRoot,
        branch: payload.branch ?? null,
        lang: payload.lang,
      }));
    }

    case "warm": {
      // Full parse cycle via the existing ParseEngine: parallel tree-sitter +
      // SCIP generation and ledger-layer ingest (both sources), run in-thread
      // owning the ledger. This subsumes stage+ingest; merge ("zip") still runs
      // as a separate write-queue step. ParseEngine's own scip/tree overlap is
      // the co-promise, internalized.
      const ledger = await getLedger(payload.ledgerPath, payload.dbPath);
      const { ParseEngine } = await import("../../../classes/v2/ParseEngine.js");
      const { sharedParserAdapter } = await import("../../../classes/v2/ParserAdapter.js");
      const engine = new ParseEngine({
        ledger,
        parserAdapter: sharedParserAdapter,
        repoRoot: payload.repoRoot,
        defaultBranch: payload.branch ?? "main",
        config: payload.config,
        scipMode: payload.scipMode,
        scipDir: payload.scipDir,
        // Stream ParseEngine's per-stage progress back over the daemon's progress
        // channel so callers (the TUI readiness bars) can render live movement —
        // this is the per-stage progress the strict request/response path dropped.
        onProgress: (event) => emitProgress(event),
        // Embeddings run AFTER the write-queue slot is released (flush below):
        // the encode pass is the longest warm stage and read-only w.r.t. the
        // ledger/view writers, so queued merges/warms must not wait behind it.
        deferEmbeddings: true,
      });
      try {
        const result = await dbWrite.run(() => engine.handleWarmJob(payload.job ?? { paths: payload.paths ?? [] }));
        // Outside dbWrite.run, still inside this request: progress events keep
        // streaming and the response carries the embeddings result fields the
        // flush writes into `result` (captured by reference at defer time).
        // Serialized per repo so this index's ANN save/rename can't race a
        // concurrent warm's in this host (single in-host embedding writer).
        await runEmbeddingWriteExclusive(payload.repoRoot || payload.ledgerPath, () => engine.flushDeferredEmbeddings());
        return result;
      } finally {
        // The warm may have rewritten the on-disk ANN; cached retrieval-side
        // embedding handles hold the old index in memory.
        const { invalidateConductorRetrieveResources } = await import("./retrieve-runner.js");
        await invalidateConductorRetrieveResources();
      }
    }

    case "retrieve": {
      // LEGACY: production reads route to the reader lane (reader-host.mjs)
      // so they never queue behind this thread's long sync sections. Kept for
      // back-compat with direct host callers; same request-scoped handles,
      // deliberately NOT on the write queue.
      const { runConductorRetrieve } = await import("./retrieve-runner.js");
      return runConductorRetrieve(payload);
    }

    case "debug.block": {
      // Test-only: occupy this thread's event loop with a synchronous
      // busy-wait, standing in for a warm's long sync sections (the 19–26s
      // SCIP ingest transaction, view merge). The reader-lane starvation
      // regression test proves retrieves complete while this runs. Throws
      // outside `node --test`.
      const { assertTestContext } = await import("../../../../runtime/functions/test-context.js");
      assertTestContext("conductor debug.block");
      const ms = Math.min(30_000, Math.max(0, Number(/** @type {any} */ (payload)?.ms) || 0));
      const start = Date.now();
      while (Date.now() - start < ms) { /* sync busy-wait */ }
      return { blockedMs: Date.now() - start };
    }

    case "merge": {
      // The "zip" — serialized on the write queue, scoped by contentHashes
      // (null = full/boot). Reads Ledger, writes View, in this thread.
      const ledger = await getLedger(payload.ledgerPath, payload.dbPath);
      const view = await getView(payload.ledgerPath, payload.dbPath);
      try {
        return await dbWrite.run(() => view.mergeLanguageLayers({
          ledger,
          lang: payload.lang,
          contentHashes: payload.contentHashes ?? null,
        }));
      } finally {
        const { invalidateConductorRetrieveResources } = await import("./retrieve-runner.js");
        await invalidateConductorRetrieveResources();
      }
    }

    case "close": {
      try {
        const { disposeConductorRetrieveResources } = await import("./retrieve-runner.js");
        await disposeConductorRetrieveResources();
      } catch { /* best effort */ }
      for (const { ledger, view } of handles.values()) {
        try { ledger?.close?.(); } catch { /* best effort */ }
        try { view?.close?.(); } catch { /* best effort */ }
      }
      handles.clear();
      // This thread's module graph owns any native daemon hosts it spawned
      // (posse-atlas via the parser adapter) and the nested warm ONNX encoder
      // worker set used by embeddings ingest; dispose them before the parent
      // terminates the thread or they outlive it as orphaned threads/processes.
      try {
        await closeSharedOnnxDaemon();
      } catch { /* best effort */ }
      try {
        await nativeBinaries.disposeAll();
      } catch { /* best effort */ }
      return { closed: true };
    }

    default:
      throw new Error(`unknown conductor op: ${op || "(none)"}`);
  }
});
