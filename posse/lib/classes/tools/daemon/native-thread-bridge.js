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
const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 120000;
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> | null, onAbort: (() => void) | null, signal: AbortSignal | null }>} */
const pendingBridgeRequests = new Map();

function rejectPendingBridgeRequests(err) {
  for (const [id, pending] of pendingBridgeRequests) {
    pendingBridgeRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener?.("abort", pending.onAbort);
    pending.reject(err instanceof Error ? err : new Error(String(err || "native bridge closed")));
  }
}

/**
 * Install the worker-side bridge port from workerData.
 *
 * @param {unknown} port
 * @returns {boolean}
 */
export function installNativeThreadBridge(port) {
  if (!port || typeof /** @type {any} */ (port).postMessage !== "function") return false;
  if (workerBridgePort && workerBridgePort !== port) {
    rejectPendingBridgeRequests(new Error("native bridge port replaced"));
  }
  workerBridgePort = /** @type {import("node:worker_threads").MessagePort} */ (port);
  workerBridgePort.on("message", (message) => {
    const id = Number(/** @type {any} */ (message)?.id);
    const pending = pendingBridgeRequests.get(id);
    if (!pending) return;
    pendingBridgeRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener?.("abort", pending.onAbort);
    if (/** @type {any} */ (message)?.ok === false) {
      pending.reject(new Error(String(/** @type {any} */ (message)?.error?.message || "native bridge request failed")));
      return;
    }
    pending.resolve(/** @type {any} */ (message)?.data);
  });
  workerBridgePort.on?.("close", () => {
    workerBridgePort = null;
    rejectPendingBridgeRequests(new Error("native bridge port closed"));
  });
  workerBridgePort.on?.("error", (err) => {
    workerBridgePort = null;
    rejectPendingBridgeRequests(err instanceof Error ? err : new Error(String(err || "native bridge port error")));
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
  rejectPendingBridgeRequests(new Error("native bridge reset"));
}

export function __testNativeThreadBridgePendingCount() {
  return pendingBridgeRequests.size;
}

/**
 * @param {"atlas" | "git"} tool
 * @param {string} method
 * @param {unknown} payload
 * @param {Record<string, unknown>} [opts]
 * @returns {Promise<unknown>}
 */
export function nativeThreadBridgeRequest(tool, method, payload, opts = {}, control = {}) {
  if (!workerBridgePort) throw new Error("native thread bridge is not installed");
  const id = nextBridgeRequestId++;
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(control.timeoutMs ?? opts.timeoutMs ?? DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS);
    const signal = control.signal || null;
    const onAbort = signal
      ? () => {
        const pending = pendingBridgeRequests.get(id);
        if (!pending) return;
        pendingBridgeRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        if (onAbort) signal.removeEventListener?.("abort", onAbort);
        const err = signal.reason instanceof Error ? signal.reason : new Error("native bridge request aborted");
        reject(err);
      }
      : null;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        pendingBridgeRequests.delete(id);
        if (signal && onAbort) signal.removeEventListener?.("abort", onAbort);
        reject(new Error(`native bridge request timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : null;
    timer?.unref?.();
    if (signal?.aborted) {
      if (timer) clearTimeout(timer);
      const err = signal.reason instanceof Error ? signal.reason : new Error("native bridge request aborted");
      reject(err);
      return;
    }
    if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
    pendingBridgeRequests.set(id, { resolve, reject, timer, onAbort, signal });
    try {
      workerBridgePort?.postMessage({ id, tool, method, payload, opts });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener?.("abort", onAbort);
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
