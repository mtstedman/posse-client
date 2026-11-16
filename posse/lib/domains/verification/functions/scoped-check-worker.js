import { parentPort, workerData } from "node:worker_threads";
import { runScopedChecks } from "../../../shared/tools/functions/toolkit/scoped-runners.js";

try {
  const { executedCommitHash, ...options } = workerData;
  const result = runScopedChecks({ ...options, gitCurrentHashImpl: () => executedCommitHash });
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({ type: "error", error: { name: error.name, message: error.message, stack: error.stack } });
} finally {
  parentPort.close();
}
