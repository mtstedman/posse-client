import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { recordRunDiagnostic, recordSchedulerShutdownMarker } from "../../../shared/telemetry/functions/run-diagnostics.js";
import { logEvent } from "../../queue/functions/index.js";
import { maybeCompactRuntimeDb } from "../../ui/functions/admin/retention.js";

// Release ownership only after every active worker has stopped using its worktree.
export function coordinateSchedulerStop(scheduler, { activeWorkers = scheduler._activeRunWorkers, reason = "scheduler_stop", fromRunLoop = false } = {}) {
  // An external stop only requests the run loop's shutdown. Its finally
  // block releases the lock after workers have acknowledged their aborts.
  if ((scheduler._activeRunWorkers && !fromRunLoop) || scheduler._deferredStopPromise) {
    scheduler.requestStop();
    return;
  }
  if (activeWorkers?.size > 0) {
    // The bounded shutdown wait may expire while a worker still owns its
    // worktree. Keep the lock until that worker exits (or this process dies).
    scheduler.requestStop();
    scheduler._deferredStopPromise = Promise.allSettled([...activeWorkers.values()].map((entry) => entry.promise))
      .then(() => {
        scheduler._deferredStopPromise = null;
        try { scheduler.stop({ activeWorkers: new Map(), reason }); } catch { /* lock expiry remains the recovery path */ }
      });
    return;
  }
  if (scheduler._stopMarked) {
    scheduler.requestStop();
    return;
  }
  scheduler._stopMarked = true;
  scheduler.requestStop();
  if (scheduler._stopRunHeartbeat) {
    const stopHeartbeat = scheduler._stopRunHeartbeat;
    scheduler._stopRunHeartbeat = null;
    try { stopHeartbeat(reason); } catch { /* observational */ }
  }
  try {
    recordSchedulerShutdownMarker({
      ownerId: scheduler.ownerId,
      reason,
      activeWorkers,
    });
  } catch { /* observational */ }
  // Guarded: releaseSchedulerLock runs a DELETE that can throw SQLITE_BUSY
  // under the same cross-process contention that triggers lock-loss shutdown.
  // Unguarded, that throw escapes stop() out of the run-loop finally, masking
  // the loop's real error and skipping the SCHEDULER_STOPPED event. A stale
  // lock row is self-healing (heartbeat-stale force-steal on next boot).
  try { scheduler.schedulerLock.release(); } catch { /* best-effort; lock self-heals via expiry */ }
  // The run is over and its lock released; compaction re-checks that no
  // other scheduler holds the lock before it VACUUMs.
  try {
    const compaction = maybeCompactRuntimeDb({ lockName: scheduler.schedulerLock?.lockName || "main" });
    if (compaction.attempted) {
      scheduler._log(compaction.ok
        ? `Runtime DB compacted: ${compaction.before.bytes} -> ${compaction.after.bytes} bytes`
        : `Runtime DB compaction failed: ${compaction.error}`, compaction.ok ? "cyan" : "yellow");
    }
  } catch { /* best-effort maintenance */ }

  logEvent({
    event_type: EVENT_TYPES.SCHEDULER_STOPPED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    actor_id: scheduler.ownerId,
    message: "Scheduler stopped",
  });
}

// Drain live dispatch callbacks before the run-loop releases scheduler ownership.
export async function awaitSchedulerWorkersForShutdown(scheduler, activeWorkers, onKillJob) {
      // Wait for any still-running workers to finish (with timeout)
      if (activeWorkers.size > 0) {
        // Normal shutdown must stop mutation before a job becomes runnable
        // again. Workers own the safe interruption path: abort, stash/reset
        // partial work, then release their lease back to queued. Lock-loss
        // handling already sent the same abort earlier.
        if (!scheduler._lockLost && onKillJob) {
          for (const [jobId] of activeWorkers) {
            scheduler._invokeCallback("onKillJob", onKillJob, jobId, "shutdown");
          }
        }
        scheduler._log(`Waiting for ${activeWorkers.size} worker(s) to finish (${scheduler._shutdownWorkerWaitMs}ms timeout)...`);
        const workersDone = Promise.all([...activeWorkers.values()].map((w) => w.promise));
        let shutdownTimer = null;
        const timeout = new Promise((r) => { shutdownTimer = setTimeout(r, scheduler._shutdownWorkerWaitMs); });
        try {
          await Promise.race([workersDone, timeout]);
        } finally {
          if (shutdownTimer) clearTimeout(shutdownTimer);
        }
        if (activeWorkers.size > 0 && scheduler._lockLost) {
          const abandonedIds = [...activeWorkers.keys()];
          scheduler._log(`${activeWorkers.size} worker(s) still running after scheduler lock loss — not requeueing from stale owner. Jobs: ${abandonedIds.join(", ")}`, "red");
          logEvent({
            event_type: EVENT_TYPES.SCHEDULER_WORKERS_LEFT_AFTER_LOCK_LOSS,
            actor_type: EVENT_ACTORS.SCHEDULER,
            actor_id: scheduler.ownerId,
            message: `Lock loss shutdown left ${activeWorkers.size} worker(s) running; stale owner did not requeue. Jobs: ${abandonedIds.join(", ")}`,
          });
        } else if (activeWorkers.size > 0) {
          const abandonedIds = [];
          for (const [jobId] of activeWorkers) {
            abandonedIds.push(jobId);
          }
          scheduler._log(`${activeWorkers.size} worker(s) still running after shutdown abort — left leased for expiry/recovery. Jobs: ${abandonedIds.join(", ")}`);
          logEvent({
            event_type: EVENT_TYPES.SCHEDULER_WORKERS_ABANDONED,
            actor_type: EVENT_ACTORS.SCHEDULER,
            actor_id: scheduler.ownerId,
            message: `Shutdown timeout: ${activeWorkers.size} worker(s) still active after abort; left leased for expiry/recovery to prevent duplicate execution. Jobs: ${abandonedIds.join(", ")}`,
          });
        }
      }

}

// Await the caller's drain of in-flight run work (job-completion auto-merges)
// before the run loop stops the session monitor. Not bounded: the caller
// waits for the same work right after runLoop returns, so a limit here would
// only stop the monitor in the middle of a merge without shortening the exit.
export async function awaitSessionStopDrain(scheduler, drain) {
  if (typeof drain !== "function") return;
  const startedAt = Date.now();
  let drainedMerges = 0;
  let error = null;
  try {
    drainedMerges = Number(await drain()) || 0;
  } catch (err) {
    error = err?.message || String(err);
  }
  try {
    recordRunDiagnostic("scheduler.session_stop_drain", {
      owner_id: scheduler.ownerId,
      drained_merges: drainedMerges,
      waited_ms: Date.now() - startedAt,
      error,
    });
  } catch { /* observational */ }
}
