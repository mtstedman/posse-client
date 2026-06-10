// @ts-check
//
// Worker-thread endpoint for local ONNX embedding batches. Each worker owns
// its own LocalOnnxEmbeddingEncoder/session; the parent keeps all DB/vector
// index writes serialized and only fans out pure text -> vector inference.

import { parentPort, workerData } from "node:worker_threads";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeTexts,
} from "./forensics.js";

function post(message, transferList = undefined) {
  try { parentPort?.postMessage(message, transferList); } catch { /* parent already gone */ }
}

process.on("uncaughtException", (err) => {
  recordEmbeddingForensics("onnx.worker_thread.uncaught_exception", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(err),
  });
  post({ type: "error", error: errorForTelemetry(err) });
  throw err;
});

process.on("unhandledRejection", (reason) => {
  recordEmbeddingForensics("onnx.worker_thread.unhandled_rejection", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(reason),
  });
  post({ type: "error", error: errorForTelemetry(reason) });
});

recordEmbeddingForensics("onnx.worker_thread.init.start", {
  worker_data: publicWorkerData(),
});

let encoder;
try {
  const { LocalOnnxEmbeddingEncoder } = await import("../../../classes/v2/LocalOnnxEmbeddingEncoder.js");
  encoder = new LocalOnnxEmbeddingEncoder({
    cacheDir: workerData.cacheDir,
    modelName: workerData.modelName,
    modelId: workerData.modelId,
    dim: workerData.dim,
    textShapeVersion: workerData.textShapeVersion,
    modelVersion: workerData.modelVersion,
    batchSize: workerData.batchSize,
    maxInputChars: workerData.maxInputChars,
    maxInputTokens: workerData.maxInputTokens,
    dtype: workerData.dtype,
    localFilesOnly: workerData.localFilesOnly,
  });
} catch (err) {
  recordEmbeddingForensics("onnx.worker_thread.init.error", {
    worker_data: publicWorkerData(),
    error: errorForTelemetry(err),
  });
  post({ type: "error", error: errorForTelemetry(err) });
  throw err;
}
recordEmbeddingForensics("onnx.worker_thread.init.done", {
  encoder: encoderTelemetry(),
});

let _disposing = false;

async function disposeEncoder() {
  if (_disposing) return;
  _disposing = true;
  try { await encoder.dispose?.(); } catch { /* best-effort worker cleanup */ }
}

post({ type: "ready" });

parentPort?.on("message", async (message = {}) => {
  if (message.type === "close") {
    await disposeEncoder();
    post({ type: "closed", id: message.id });
    return;
  }
  if (message.type !== "encode") return;
  try {
    const texts = Array.isArray(message.texts) ? message.texts : [];
    recordEmbeddingForensics("onnx.worker_thread.encode.start", {
      encoder: encoderTelemetry(),
      request_id: message.id,
      texts: summarizeTexts(texts),
    });
    const vectors = await encoder.encode(texts);
    recordEmbeddingForensics("onnx.worker_thread.encode.done", {
      encoder: encoderTelemetry(),
      request_id: message.id,
      text_count: texts.length,
      vector_count: vectors.length,
    });
    post(
      { type: "result", id: message.id, vectors },
      vectors.map((vector) => vector.buffer),
    );
  } catch (err) {
    recordEmbeddingForensics("onnx.worker_thread.encode.error", {
      encoder: encoderTelemetry(),
      request_id: message.id,
      error: errorForTelemetry(err),
    });
    post({
      type: "error",
      id: message.id,
      error: {
        name: err?.name || "Error",
        message: err?.message || String(err || "local ONNX encode failed"),
        stack: err?.stack || null,
      },
    });
  }
});

function publicWorkerData() {
  return {
    model_name: workerData?.modelName || null,
    model_id: workerData?.modelId || null,
    model_version: workerData?.modelVersion || null,
    dim: workerData?.dim || null,
    dtype: workerData?.dtype || null,
    batch_size: workerData?.batchSize || null,
    max_input_chars: workerData?.maxInputChars || null,
    max_input_tokens: workerData?.maxInputTokens || null,
    local_files_only: workerData?.localFilesOnly !== false,
    cache_dir: workerData?.cacheDir || null,
  };
}

function encoderTelemetry() {
  return {
    model: encoder?.model || null,
    model_version: encoder?.model_version || null,
    model_name: encoder?.modelName || null,
    model_id: encoder?.modelId || null,
    dim: encoder?.dim || null,
    dtype: encoder?.dtype || null,
    batch_size: encoder?.batchSize || null,
    cache_dir: encoder?.cacheDir || null,
  };
}
