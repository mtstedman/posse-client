// @ts-check
//
// Worker-thread entry point for scheduler boot DB maintenance. These queue
// repairs use better-sqlite3, which is synchronous, so keeping them off the
// parent thread prevents boot indicators and lock renewal from freezing.

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { closeDb } from "../../../shared/storage/functions/index.js";
import { setRuntimePathOverrides } from "../../runtime/functions/paths.js";
import { getSchedulerLockInfo } from "../../queue/functions/locks.js";
import {
  cleanupStaleFileLocks,
  expireStaleSessionLeases,
  listJobs,
  reconcileOrphanedAgentCalls,
  reconcileOrphanedAttempts,
  requeueOrphanedJobs,
} from "../../queue/functions/index.js";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent is gone */ }
}

function serializeError(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err || "unknown"),
    stack: err?.stack || null,
    code: err?.code || null,
  };
}

// The force-requeue below assumes exclusivity: "we hold the scheduler lock, so
// any leased/running row belongs to a dead process." That premise breaks if a
// shutdown-during-boot released the lock while this worker was still spawning
// and a restarted instance took it. Confirm the lock is still ours (or absent)
// before force-requeuing; if a *different* owner now holds it, downgrade to a
// non-forcing pass so we never clobber the new owner's fresh leases.
export function shouldForceRequeue(ownerId, lockName) {
  if (!ownerId) return true;
  try {
    const info = getSchedulerLockInfo(lockName);
    if (!info || !info.owner_id) return true;
    return String(info.owner_id) === String(ownerId);
  } catch {
    // If we cannot read the lock, prefer the conservative non-forcing pass.
    return false;
  }
}

async function main() {
  const dbPath = typeof workerData?.dbPath === "string" ? workerData.dbPath : "";
  if (dbPath) setRuntimePathOverrides({ dbPath });

  const ownerId = typeof workerData?.ownerId === "string" ? workerData.ownerId : null;
  const lockName = typeof workerData?.lockName === "string" ? workerData.lockName : "main";
  const force = shouldForceRequeue(ownerId, lockName);

  const orphaned = requeueOrphanedJobs({ force });
  const reconciledAttempts = reconcileOrphanedAttempts();
  // Runs after job/attempt reconciliation so requeued jobs have already shed
  // their leases — any agent_call still 'running' is now a confirmed orphan.
  const reconciledAgentCalls = reconcileOrphanedAgentCalls();
  const staleLocks = cleanupStaleFileLocks();
  const staleSessionLeases = expireStaleSessionLeases();
  const awaitingAssessmentCount = listJobs(["awaiting_assessment"]).length;

  post({
    type: "result",
    result: {
      orphaned,
      reconciledAttempts,
      reconciledAgentCalls,
      staleLocks,
      staleSessionLeases,
      awaitingAssessmentCount,
    },
  });
}

// Guard the side-effecting entry so it runs ONLY when actually spawned as a
// worker. Without this, importing the module (directly or via the scheduler
// functions barrel, which re-exports it) would execute the queue maintenance —
// force-requeuing jobs and closing the importer's shared DB handle — as a
// module load side effect.
if (!isMainThread) {
  main()
    .catch((err) => {
      post({ type: "error", error: serializeError(err) });
    })
    .finally(() => {
      try { closeDb(); } catch { /* best effort */ }
    });
}
