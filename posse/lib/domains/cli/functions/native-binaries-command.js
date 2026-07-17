// Machine-facing native artifact reconciliation for Bossy's boot window.
// One JSON object is emitted per line so progress remains streamable while all
// catalog binaries reconcile concurrently inside the shared manager.
import { BINARY_NAMES, nativeBinaryEntry } from "../../../catalog/binary.js";
import { reconcileNativeBinaries } from "../../../shared/native/functions/binary-reconciliation.js";

function writeEvent(event, log) {
  log(JSON.stringify({ protocol: "posse.native_update.v1", ...event }));
}

export async function cmdNativeBinaries({
  reconcile = reconcileNativeBinaries,
  names = BINARY_NAMES,
  log = console.log,
} = {}) {
  for (const name of names) {
    writeEvent({ type: "binary", phase: "checking", name, package: nativeBinaryEntry(name)?.package || name }, log);
  }
  const results = await reconcile({
    names,
    refresh: true,
    onBinaryProgress: (event) => writeEvent({
      type: "binary",
      phase: event.type === "native-artifact-settled" ? "settled" : event.phase,
      name: event.name,
      package: event.package,
      loaded_bytes: event.loadedBytes ?? 0,
      total_bytes: event.totalBytes ?? null,
      result: event.result ?? null,
    }, log),
  });
  for (const result of results) {
    writeEvent({
      type: "binary", phase: "done", name: result.name, package: result.package,
      status: result.status, message: result.message, downloaded: result.downloaded === true,
    }, log);
  }
  const failed = results.filter((result) => result.ok === false).length;
  writeEvent({ type: "complete", ok: failed === 0, failed }, log);
  return results;
}
