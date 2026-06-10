import { parentPort, workerData } from "worker_threads";
import { setRuntimePathOverrides } from "../../runtime/functions/paths.js";

setRuntimePathOverrides(workerData?.runtimePathOverrides || null);

const { closeDb } = await import("../../../shared/storage/functions/index.js");
const { refreshProjectContext } = await import("./context.js");

try {
  const result = refreshProjectContext(workerData.projectDir, {
    writeDigest: workerData.writeDigest !== false,
  });
  try { closeDb(); } catch { /* best effort */ }
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  try { closeDb(); } catch { /* best effort */ }
  parentPort.postMessage({
    ok: false,
    error: String(err?.message || err || "unknown"),
    stack: err?.stack || null,
  });
}
