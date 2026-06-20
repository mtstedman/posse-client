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
//
// Cached DB handles are also owned by this lane. Indexing writers coordinate
// with `beginWrite` / `endWrite`: the begin call drains active reads, closes
// cached handles for the affected view/ledger key, then holds a writer-priority
// gate until the indexing op is done.

import { workerData } from "node:worker_threads";
import { runDaemonThread } from "../../../../../classes/tools/daemon/thread-host.js";
import { installNativeThreadBridge } from "../../../../../classes/tools/daemon/native-thread-bridge.js";
import { nativeBinaries } from "../../../../../classes/tools/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../../../shared/native/classes/HeartbeatAuthManager.js";
import { setOnnxDaemonKeepWarm, closeSharedOnnxDaemon } from "../embeddings/onnx-daemon.js";

if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
  nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth));
}
installNativeThreadBridge(workerData?.nativeBridgePort);

// Same lifetime argument as the conductor host: this thread's nested ONNX
// encoder daemon dies with the thread, so an idle window here would only
// thrash the ~6s model load between retrieval bursts.
setOnnxDaemonKeepWarm(true);

// Telemetry counters surfaced via `info` — tests assert invalidation delivery
// through these, and field diagnostics can confirm reads route here.
let retrieves = 0;
let invalidations = 0;
let writeBegins = 0;
let writeEnds = 0;
let activeWriteHolds = 0;
let invalidationsDuringWrite = 0;

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
      if (activeWriteHolds > 0) invalidationsDuringWrite++;
      const { invalidateConductorRetrieveResources } = await import("./retrieve-runner.js");
      await invalidateConductorRetrieveResources();
      return { invalidated: true };
    }

    case "beginWrite": {
      writeBegins++;
      const { beginConductorRetrieveWrite } = await import("./retrieve-runner.js");
      const result = await beginConductorRetrieveWrite(/** @type {any} */ (payload));
      if (result?.held) activeWriteHolds++;
      return result;
    }

    case "endWrite": {
      writeEnds++;
      const { endConductorRetrieveWrite } = await import("./retrieve-runner.js");
      const result = await endConductorRetrieveWrite(/** @type {any} */ (payload));
      if (activeWriteHolds > 0 && (result?.released === true || typeof result?.count === "number")) {
        activeWriteHolds--;
      }
      return result;
    }

    case "info":
      return { lane: "reader", retrieves, invalidations, writeBegins, writeEnds, activeWriteHolds, invalidationsDuringWrite };

    case "close": {
      try {
        const { disposeConductorRetrieveResources } = await import("./retrieve-runner.js");
        await disposeConductorRetrieveResources();
      } catch { /* best effort */ }
      // Safety net for any native daemon hosts this thread's module graph
      // spawned (ANN children) and the nested warm ONNX encoder used to encode
      // query text; dispose before the parent terminates the thread or they
      // outlive it as orphaned threads/processes.
      try {
        await closeSharedOnnxDaemon();
      } catch { /* best effort */ }
      try {
        await nativeBinaries.disposeAll();
      } catch { /* best effort */ }
      return { closed: true };
    }

    default:
      throw new Error(`reader lane is read-only; refusing op: ${op || "(none)"}`);
  }
});
