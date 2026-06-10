// @ts-check
//
// Worker-thread entry point for scheduler boot DB maintenance. These queue
// repairs use better-sqlite3, which is synchronous, so keeping them off the
// parent thread prevents boot indicators and lock renewal from freezing.

import { parentPort, workerData } from "node:worker_threads";
import { closeDb } from "../../../shared/storage/functions/index.js";
import { setRuntimePathOverrides } from "../../runtime/functions/paths.js";
import {
  cleanupStaleFileLocks,
  expireStaleSessionLeases,
  listJobs,
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

async function main() {
  const dbPath = typeof workerData?.dbPath === "string" ? workerData.dbPath : "";
  if (dbPath) setRuntimePathOverrides({ dbPath });

  const orphaned = requeueOrphanedJobs({ force: true });
  const reconciledAttempts = reconcileOrphanedAttempts();
  const staleLocks = cleanupStaleFileLocks();
  const staleSessionLeases = expireStaleSessionLeases();
  const awaitingAssessmentCount = listJobs(["awaiting_assessment"]).length;

  post({
    type: "result",
    result: {
      orphaned,
      reconciledAttempts,
      staleLocks,
      staleSessionLeases,
      awaitingAssessmentCount,
    },
  });
}

main()
  .catch((err) => {
    post({ type: "error", error: serializeError(err) });
  })
  .finally(() => {
    try { closeDb(); } catch { /* best effort */ }
  });
