// @ts-check
//
// Worker-thread runner for the local-ONNX encoder warm. The
// @huggingface/transformers `pipeline()` init parses the model file on the
// calling thread and blocks for many seconds; running it in the main thread
// freezes the boot panel/TUI and stalls every scheduler interval. This worker
// isolates that cost so the main loop keeps responding while the model loads.
//
// Protocol matches ThreadManager: `{ type: "progress", event }` for status
// updates and `{ type: "result", result }` on completion. Errors propagate
// via worker `error`/`exit` events.

import { parentPort, workerData } from "node:worker_threads";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
} from "../../atlas/functions/v2/embeddings/forensics.js";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* parent already gone */ }
}

function emit(event) {
  post({ type: "progress", event });
}

let stopRequested = false;
parentPort?.on("message", (message = {}) => {
  if (message?.type !== "stop") return;
  stopRequested = true;
  emit({ stage: "stopping", reason: message.reason || "stop requested" });
});

process.on("uncaughtException", (err) => {
  recordEmbeddingForensics("onnx.warm_worker.uncaught_exception", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(err),
  });
  post({ type: "error", error: errorForTelemetry(err) });
  throw err;
});

process.on("unhandledRejection", (reason) => {
  recordEmbeddingForensics("onnx.warm_worker.unhandled_rejection", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(reason),
  });
  post({ type: "error", error: errorForTelemetry(reason) });
});

async function run() {
  const { cacheDir, modelName, modelId, dim } = workerData || {};
  if (!cacheDir || !modelName || !modelId || !dim) {
    throw new Error("onnx-warm-worker: missing cacheDir/modelName/modelId/dim");
  }
  emit({ stage: "loading" });
  recordEmbeddingForensics("onnx.warm_worker.start", {
    worker_data: publicWorkerData(),
  });
  const { LocalOnnxEmbeddingEncoder } = await import("../../atlas/classes/v2/LocalOnnxEmbeddingEncoder.js");
  const encoder = new LocalOnnxEmbeddingEncoder({ cacheDir, modelName, modelId, dim });
  try {
    if (stopRequested) throw new Error("ONNX warm stopped before encode");
    // encode() triggers the lazy _pipeline() — that's the blocking step we
    // wanted off the main thread.
    await encoder.encode(["ping"]);
    if (stopRequested) throw new Error("ONNX warm stopped after encode");
    emit({ stage: "ready" });
    recordEmbeddingForensics("onnx.warm_worker.ready", {
      worker_data: publicWorkerData(),
    });
    return { ok: true };
  } finally {
    await encoder.dispose?.();
    recordEmbeddingForensics("onnx.warm_worker.dispose.done", {
      worker_data: publicWorkerData(),
    });
  }
}

run().then(
  (result) => post({ type: "result", result }),
  (err) => {
    recordEmbeddingForensics("onnx.warm_worker.error", {
      worker_data: publicWorkerData(),
      error: errorForTelemetry(err),
    });
    post({
      type: "error",
      error: {
        name: err?.name || "Error",
        message: err?.message || String(err || "onnx warm failed"),
        stack: err?.stack || null,
      },
    });
    process.exit(1);
  },
);

function publicWorkerData() {
  return {
    model_name: workerData?.modelName || null,
    model_id: workerData?.modelId || null,
    dim: workerData?.dim || null,
    cache_dir: workerData?.cacheDir || null,
  };
}
