import { parentPort, workerData } from "worker_threads";
import { installScipLanguageDependenciesSync } from "../../../atlas/functions/v2/scip/dependencies.js";

try {
  const result = installScipLanguageDependenciesSync({
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
