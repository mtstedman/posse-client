// @ts-check
//
// ONNX encoder daemon host (thread side). Holds one LocalOnnxEmbeddingEncoder
// warm for the lifetime of the worker and answers encode requests over the
// shared Daemon protocol (runDaemonThread). Unlike the per-ingestView encode
// pool, this is persistent: the ~6s model load is paid once and amortized
// across every ingest, and identity changes (model/version/dim) are handled by
// the client recycling the whole daemon rather than this host reloading.

import { workerData } from "node:worker_threads";
import { runDaemonThread } from "../../../../../classes/tools/daemon/thread-host.js";
import { nativeBinaries } from "../../../../../classes/tools/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../../../shared/native/classes/HeartbeatAuthManager.js";

const config = workerData?.config || {};

if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
  nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth));
}

/** @type {Promise<any> | null} */
let encoderPromise = null;
/** @type {Map<string, AbortController>} */
const activeEncodeAborts = new Map();

function loadEncoder() {
  if (!encoderPromise) {
    encoderPromise = (async () => {
      const { LocalOnnxEmbeddingEncoder } = await import("../../../classes/v2/LocalOnnxEmbeddingEncoder.js");
      return new LocalOnnxEmbeddingEncoder(config);
    })();
  }
  return encoderPromise;
}

runDaemonThread(async (payload) => {
  const op = String(payload?.op || "");
  switch (op) {
    case "info":
      // Cheap identity probe — does not load the model.
      return {
        modelId: config.modelId ?? null,
        modelName: config.modelName ?? null,
        modelVersion: config.modelVersion ?? null,
        dim: config.dim ?? null,
        loaded: encoderPromise != null,
      };
    case "warm":
      await loadEncoder();
      return { ready: true };
    case "encode": {
      const texts = Array.isArray(payload.texts) ? payload.texts : [];
      const abortId = typeof payload.abortId === "string" && payload.abortId ? payload.abortId : null;
      const abortController = abortId ? new AbortController() : null;
      if (abortId && abortController) activeEncodeAborts.set(abortId, abortController);
      // Float32Array[] survives structured clone as typed arrays — no copy to
      // plain arrays needed.
      try {
        throwIfAborted(abortController?.signal);
        const encoder = await loadEncoder();
        throwIfAborted(abortController?.signal);
        const vectors = await encoder.encode(texts, abortController?.signal);
        return { vectors };
      } finally {
        if (abortId) activeEncodeAborts.delete(abortId);
      }
    }
    case "abort": {
      const abortId = typeof payload.abortId === "string" && payload.abortId ? payload.abortId : null;
      const controller = abortId ? activeEncodeAborts.get(abortId) : null;
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error("encode aborted"));
      }
      return { aborted: !!controller };
    }
    case "dispose": {
      if (encoderPromise) {
        try { await (await encoderPromise).dispose?.(); } catch { /* best effort */ }
        encoderPromise = null;
      }
      try { await nativeBinaries.disposeAll(); } catch { /* best effort */ }
      return { disposed: true };
    }
    default:
      throw new Error(`unknown onnx op: ${op || "(none)"}`);
  }
});

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("encode aborted");
}
