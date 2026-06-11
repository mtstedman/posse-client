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

import { runDaemonThread } from "../../../../../classes/tools/daemon/thread-host.js";
import { createDbWriteSemaphore, createScipStageSemaphore } from "./semaphore.js";

// One handle entry per (ledger, view) target, reused across requests. The
// ledger and view connections are opened lazily and independently: the `warm`
// op needs only the ledger (ParseEngine owns its own View writer internally and
// rewrites the view file itself), so opening a second readwrite View handle on
// that same file here would be a needless double-open on the file warm is about
// to recreate. `merge` is the only op that uses the conductor-owned View.
/** @type {Map<string, { ledgerPath: string, dbPath: string, ledger: any, view: any }>} */
const handles = new Map();
const dbWrite = createDbWriteSemaphore();
const scipStage = createScipStageSemaphore(1);

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
      // Parallel SCIP generation, gated by the stage semaphore.
      const { ensureScipStaged } = await import("../scip/stager.js");
      return scipStage.run(() => ensureScipStaged({
        repoRoot: payload.repoRoot,
        scipDir: payload.scipDir,
        mode: payload.mode,
        config: payload.config,
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
      const { sharedParserAdapter } = await import("../parser/adapter.js");
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
      });
      try {
        return await dbWrite.run(() => engine.handleWarmJob(payload.job ?? { paths: payload.paths ?? [] }));
      } finally {
        // The warm may have rewritten the on-disk ANN; cached retrieval-side
        // embedding handles hold the old index in memory.
        const { invalidateConductorRetrieveResources } = await import("./retrieve-runner.js");
        await invalidateConductorRetrieveResources();
      }
    }

    case "retrieve": {
      // Read-only tool dispatch with request-scoped handles; deliberately NOT
      // on the write queue — WAL readers run concurrently with the writers
      // this thread owns.
      const { runConductorRetrieve } = await import("./retrieve-runner.js");
      return runConductorRetrieve(payload);
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
      return { closed: true };
    }

    default:
      throw new Error(`unknown conductor op: ${op || "(none)"}`);
  }
});
