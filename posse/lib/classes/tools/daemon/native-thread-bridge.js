// @ts-check
//
// Native thread bridge.
//
// Worker-thread daemon hosts sometimes need async native helper calls. If they
// call nativeBinaries directly, each worker thread gets its own BinaryManager
// singleton and therefore its own process-backed native daemon. This bridge
// lets those async calls route back to the parent process, where the native
// daemons are already supervised and share one auth authority.

/** @type {import("node:worker_threads").MessagePort | null} */
let workerBridgePort = null;
let nextBridgeRequestId = 1;
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (err: Error) => void }>} */
const pendingBridgeRequests = new Map();

/**
 * Install the worker-side bridge port from workerData.
 *
 * @param {unknown} port
 * @returns {boolean}
 */
export function installNativeThreadBridge(port) {
  if (!port || typeof /** @type {any} */ (port).postMessage !== "function") return false;
  workerBridgePort = /** @type {import("node:worker_threads").MessagePort} */ (port);
  workerBridgePort.on("message", (message) => {
    const id = Number(/** @type {any} */ (message)?.id);
    const pending = pendingBridgeRequests.get(id);
    if (!pending) return;
    pendingBridgeRequests.delete(id);
    if (/** @type {any} */ (message)?.ok === false) {
      pending.reject(new Error(String(/** @type {any} */ (message)?.error?.message || "native bridge request failed")));
      return;
    }
    pending.resolve(/** @type {any} */ (message)?.data);
  });
  workerBridgePort.start?.();
  workerBridgePort.unref?.();
  return true;
}

export function hasNativeThreadBridge() {
  return !!workerBridgePort;
}

export function __resetNativeThreadBridgeForTest() {
  workerBridgePort = null;
  nextBridgeRequestId = 1;
  for (const pending of pendingBridgeRequests.values()) {
    pending.reject(new Error("native bridge reset"));
  }
  pendingBridgeRequests.clear();
}

/**
 * @param {"atlas" | "git"} tool
 * @param {string} method
 * @param {unknown} payload
 * @param {Record<string, unknown>} [opts]
 * @returns {Promise<unknown>}
 */
export function nativeThreadBridgeRequest(tool, method, payload, opts = {}) {
  if (!workerBridgePort) throw new Error("native thread bridge is not installed");
  const id = nextBridgeRequestId++;
  return new Promise((resolve, reject) => {
    pendingBridgeRequests.set(id, { resolve, reject });
    try {
      workerBridgePort?.postMessage({ id, tool, method, payload, opts });
    } catch (err) {
      pendingBridgeRequests.delete(id);
      reject(/** @type {Error} */ (err));
    }
  });
}

/**
 * Parent-side bridge handler. Kept dynamic-import based to avoid making the
 * generic daemon transport own static dependencies on ATLAS/Git native modules.
 *
 * @param {import("node:worker_threads").MessagePort} port
 */
export function attachNativeThreadBridge(port) {
  port.on("message", async (message) => {
    const id = Number(/** @type {any} */ (message)?.id);
    const tool = String(/** @type {any} */ (message)?.tool || "");
    const method = String(/** @type {any} */ (message)?.method || "");
    const payload = /** @type {any} */ (message)?.payload;
    const opts = /** @type {Record<string, unknown>} */ (/** @type {any} */ (message)?.opts || {});
    try {
      let data;
      if (tool === "atlas") {
        const { runAtlasNativeMethodAsync } = await import("../../../domains/atlas/functions/v2/native/invoke.js");
        data = await runAtlasNativeMethodAsync(method, payload, { ...opts, bypassNativeBridge: true });
      } else if (tool === "git") {
        const { runGitNativeMethodAsync } = await import("../../../domains/git/functions/native/invoke.js");
        data = await runGitNativeMethodAsync(method, payload, { ...opts, bypassNativeBridge: true });
      } else {
        throw new Error(`Unknown native bridge tool: ${tool || "(none)"}`);
      }
      port.postMessage({ id, ok: true, data });
    } catch (err) {
      port.postMessage({ id, ok: false, error: { message: String(/** @type {any} */ (err)?.message || err) } });
    }
  });
  port.start?.();
  port.unref?.();
}
