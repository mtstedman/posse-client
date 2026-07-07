import { parentPort, workerData } from "worker_threads";
import { installScipLanguageDependencies } from "../../../atlas/functions/v2/scip/dependencies.js";

(async () => {
  try {
    const result = await installScipLanguageDependencies({
      languages: workerData?.languages,
      onProgress: (message) => {
        parentPort?.postMessage({ type: "progress", message });
      },
    });
    parentPort?.postMessage({ type: "done", result });
  } catch (err) {
    parentPort?.postMessage({
      type: "error",
      error: err?.stack || err?.message || String(err),
    });
  }
})();
