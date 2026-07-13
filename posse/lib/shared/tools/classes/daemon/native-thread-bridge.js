// @ts-check
//
// Native thread bridge.
//
// Worker-thread daemon hosts sometimes need async native helper calls. If they
// call nativeBinaries directly, each worker thread gets its own BinaryManager
// singleton and therefore its own process-backed native daemon. This bridge
// routes async calls through the parent for supervision and auth. ATLAS bridge
// ports share one parent-owned native daemon; that Rust daemon owns request
// threading and read/write admission internally.

/** @type {import("node:worker_threads").MessagePort | null} */
let workerBridgePort = null;
let nextBridgeRequestId = 1;
export const DEFAULT_BRIDGE_REQUEST_TIMEOUT_MS = 300_000;
/** @type {Map<number, { resolve: (value: unknown) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout> | null, onAbort: (() => void) | null, signal: AbortSignal | null }>} */
const pendingBridgeRequests = new Map();
/** @type {null | (() => unknown | Promise<unknown>)} */
let atlasManagerFactoryForTests = null;
let sharedAtlasManager = null;
let sharedAtlasManagerPromise = null;
let sharedAtlasManagerOwned = false;
let sharedAtlasManagerDisposal = null;
let atlasBridgeUsers = 0;

/** Test hook: override creation of the one shared parent ATLAS manager. */
export function __setNativeBridgeAtlasManagerFactoryForTests(factory = null) {
  atlasManagerFactoryForTests = typeof factory === "function" ? factory : null;
}

async function atlasManagerForBridges(options = {}) {
  if (!sharedAtlasManagerPromise) {
    sharedAtlasManagerPromise = (async () => {
      const invoke = await import("../../../../domains/atlas/functions/v2/native/invoke.js");
      const injected = invoke.__atlasNativeManagerForTests?.();
      const factory = options.atlasManagerFactory || atlasManagerFactoryForTests;
      sharedAtlasManagerOwned = !!factory;
      if (factory) return factory();
      if (injected) return injected;
      const { nativeBinaries } = await import("../BinaryManager.js");
      return nativeBinaries;
    })().then((manager) => {
      sharedAtlasManager = manager;
      return manager;
    });
  }
  return sharedAtlasManagerPromise;
}

function disposeOwnedSharedAtlasManager() {
  if (!sharedAtlasManagerOwned || atlasBridgeUsers > 0) return Promise.resolve();
  if (sharedAtlasManagerDisposal) return sharedAtlasManagerDisposal;
  const manager = sharedAtlasManager;
  const pending = sharedAtlasManagerPromise;
  sharedAtlasManager = null;
  sharedAtlasManagerPromise = null;
  sharedAtlasManagerOwned = false;
  sharedAtlasManagerDisposal = Promise.resolve(pending || manager)
    .then((resolved) => resolved?.disposeAll?.())
    .catch(() => {})
    .finally(() => { sharedAtlasManagerDisposal = null; });
  return sharedAtlasManagerDisposal;
}

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
    try { workerBridgePort.close?.(); } catch { /* stale port */ }
  }
  const installedPort = /** @type {import("node:worker_threads").MessagePort} */ (port);
  workerBridgePort = installedPort;
  installedPort.on("message", (message) => {
    if (workerBridgePort !== installedPort) return;
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
  installedPort.on?.("close", () => {
    if (workerBridgePort !== installedPort) return;
    workerBridgePort = null;
    rejectPendingBridgeRequests(new Error("native bridge port closed"));
  });
  installedPort.on?.("error", (err) => {
    if (workerBridgePort !== installedPort) return;
    workerBridgePort = null;
    rejectPendingBridgeRequests(err instanceof Error ? err : new Error(String(err || "native bridge port error")));
  });
  installedPort.start?.();
  installedPort.unref?.();
  return true;
}

export function hasNativeThreadBridge() {
  return !!workerBridgePort;
}

export function __resetNativeThreadBridgeForTest() {
  try { workerBridgePort?.close?.(); } catch { /* best effort */ }
  workerBridgePort = null;
  nextBridgeRequestId = 1;
  atlasManagerFactoryForTests = null;
  if (atlasBridgeUsers === 0) void disposeOwnedSharedAtlasManager();
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
    const cancelParentRequest = () => {
      try { workerBridgePort?.postMessage({ id, cancel: true }); } catch { /* parent already gone */ }
    };
    const onAbort = signal
      ? () => {
        const pending = pendingBridgeRequests.get(id);
        if (!pending) return;
        pendingBridgeRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        if (onAbort) signal.removeEventListener?.("abort", onAbort);
        cancelParentRequest();
        const err = signal.reason instanceof Error ? signal.reason : new Error("native bridge request aborted");
        reject(err);
      }
      : null;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        pendingBridgeRequests.delete(id);
        if (signal && onAbort) signal.removeEventListener?.("abort", onAbort);
        cancelParentRequest();
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
 * @param {{ atlasManagerFactory?: () => unknown | Promise<unknown> }} [options]
 */
export function attachNativeThreadBridge(port, options = {}) {
  atlasBridgeUsers++;
  let released = false;
  /** @type {Map<number, AbortController>} */
  const activeRequests = new Map();
  const abortActiveRequests = (reason) => {
    for (const controller of activeRequests.values()) {
      try { controller.abort(reason); } catch { /* best effort */ }
    }
    activeRequests.clear();
  };
  const releaseSharedAtlasManager = async () => {
    if (released) return;
    released = true;
    abortActiveRequests(new Error("native bridge closed"));
    atlasBridgeUsers = Math.max(0, atlasBridgeUsers - 1);
    await disposeOwnedSharedAtlasManager();
  };

  port.on("message", async (message) => {
    const id = Number(/** @type {any} */ (message)?.id);
    if (/** @type {any} */ (message)?.cancel === true) {
      const controller = activeRequests.get(id);
      if (controller) {
        activeRequests.delete(id);
        try { controller.abort(new Error("native bridge request canceled")); } catch { /* best effort */ }
      }
      return;
    }
    const tool = String(/** @type {any} */ (message)?.tool || "");
    const method = String(/** @type {any} */ (message)?.method || "");
    const payload = /** @type {any} */ (message)?.payload;
    const opts = /** @type {Record<string, unknown>} */ (/** @type {any} */ (message)?.opts || {});
    const controller = new AbortController();
    activeRequests.set(id, controller);
    try {
      let data;
      if (tool === "atlas") {
        const { runAtlasNativeMethodAsync } = await import("../../../../domains/atlas/functions/v2/native/invoke.js");
        const manager = await atlasManagerForBridges(options);
        data = await runAtlasNativeMethodAsync(method, payload, {
          ...opts,
          manager,
          bypassNativeBridge: true,
          signal: controller.signal,
        });
      } else if (tool === "git") {
        const { runGitNativeMethodAsync } = await import("../../../../domains/git/functions/native/invoke.js");
        data = await runGitNativeMethodAsync(method, payload, { ...opts, bypassNativeBridge: true, signal: controller.signal });
      } else {
        throw new Error(`Unknown native bridge tool: ${tool || "(none)"}`);
      }
      if (!controller.signal.aborted) {
        try { port.postMessage({ id, ok: true, data }); } catch { /* worker gone */ }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        try { port.postMessage({ id, ok: false, error: { message: String(/** @type {any} */ (err)?.message || err) } }); } catch { /* worker gone */ }
      }
    } finally {
      if (activeRequests.get(id) === controller) activeRequests.delete(id);
    }
  });
  port.on?.("close", () => {
    try { void releaseSharedAtlasManager(); } catch { /* best effort */ }
  });
  port.on?.("error", (err) => {
    abortActiveRequests(err instanceof Error ? err : new Error(String(err || "native bridge port error")));
    try { void releaseSharedAtlasManager(); } catch { /* best effort */ }
  });
  port.start?.();
  port.unref?.();
  return releaseSharedAtlasManager;
}
