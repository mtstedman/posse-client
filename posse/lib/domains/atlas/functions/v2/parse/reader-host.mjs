// @ts-check
//
// Atlas reader-lane daemon host (thread side). The first lane of the conductor
// thread bundle (CONDUCTOR-THREAD-BUNDLE-SPEC.md v0): read-only retrieval
// dispatch runs here, on an event loop the writer lane's long synchronous
// sections (SCIP ingest transactions, view merges) can never occupy. View and
// Ledger handles are request-scoped readonly WAL connections (see
// retrieve-runner.js), so reads always see the writer's last-committed
// snapshot — concurrency with the writer is structural, not scheduled.
//
// The op surface is an allowlist. This lane owns NOTHING durable; routing a
// write op here is a programming error and fails loudly rather than acquiring
// write handles a second thread must never hold (single-writer rule).
//
// Cached embedding resources (ANN child process + encoder) live per-thread, so
// the writer host's in-thread invalidation cannot reach them — the conductor
// client sends the `invalidate` op after every indexing op that rewrites the
// on-disk ANN (see invalidateReaders in conductor.js).

import { runDaemonThread } from "../../../../../classes/tools/daemon/thread-host.js";
import { setOnnxDaemonKeepWarm } from "../embeddings/onnx-daemon.js";

// Same lifetime argument as the conductor host: this thread's nested ONNX
// encoder daemon dies with the thread, so an idle window here would only
// thrash the ~6s model load between retrieval bursts.
setOnnxDaemonKeepWarm(true);

// Telemetry counters surfaced via `info` — tests assert invalidation delivery
// through these, and field diagnostics can confirm reads route here.
let retrieves = 0;
let invalidations = 0;

runDaemonThread(async (payload) => {
  const op = String(/** @type {any} */ (payload)?.op || "");
  switch (op) {
    case "retrieve": {
      retrieves++;
      const { runConductorRetrieve } = await import("./retrieve-runner.js");
      return runConductorRetrieve(/** @type {any} */ (payload));
    }

    case "invalidate": {
      // An indexing op rewrote the on-disk ANN; drop cached embedding
      // resources so the next semantic retrieve reopens the fresh index.
      invalidations++;
      const { invalidateConductorRetrieveResources } = await import("./retrieve-runner.js");
      await invalidateConductorRetrieveResources();
      return { invalidated: true };
    }

    case "info":
      return { lane: "reader", retrieves, invalidations };

    case "close": {
      try {
        const { disposeConductorRetrieveResources } = await import("./retrieve-runner.js");
        await disposeConductorRetrieveResources();
      } catch { /* best effort */ }
      // Safety net for any native daemon hosts this thread's module graph
      // spawned (ANN children); dispose before the parent terminates the
      // thread or they outlive it as orphaned processes.
      try {
        const { nativeBinaries } = await import("../../../../../classes/tools/BinaryManager.js");
        await nativeBinaries.disposeAll();
      } catch { /* best effort */ }
      return { closed: true };
    }

    default:
      throw new Error(`reader lane is read-only; refusing op: ${op || "(none)"}`);
  }
});
