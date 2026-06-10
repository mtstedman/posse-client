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

const config = workerData?.config || {};

/** @type {Promise<any> | null} */
let encoderPromise = null;

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
      const encoder = await loadEncoder();
      const texts = Array.isArray(payload.texts) ? payload.texts : [];
      // Float32Array[] survives structured clone as typed arrays — no copy to
      // plain arrays needed.
      const vectors = await encoder.encode(texts);
      return { vectors };
    }
    case "dispose": {
      if (encoderPromise) {
        try { await (await encoderPromise).dispose?.(); } catch { /* best effort */ }
        encoderPromise = null;
      }
      return { disposed: true };
    }
    default:
      throw new Error(`unknown onnx op: ${op || "(none)"}`);
  }
});
