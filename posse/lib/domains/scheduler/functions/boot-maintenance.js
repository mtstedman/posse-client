import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";

const WORKER_URL = new URL("./boot-maintenance-worker.js", import.meta.url);
const THREAD_MANAGER = new ThreadManager();

export function runSchedulerBootMaintenanceInWorker({ ownerId = null, lockName = "main" } = {}) {
  return THREAD_MANAGER.run(WORKER_URL, {
    label: "Scheduler boot DB maintenance",
    timeoutMs: 120_000,
    workerData: {
      dbPath: getRuntimeDbPath(),
      // The worker checks lock ownership again under queue recovery's writer
      // transaction before it can force-requeue active leases.
      lockName,
      ownerId,
    },
  });
}
