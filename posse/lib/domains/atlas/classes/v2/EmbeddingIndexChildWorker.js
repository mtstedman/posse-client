// @ts-check

import { EmbeddingIndex } from "./EmbeddingIndex.js";
import { setRuntimePathOverrides } from "../../../runtime/functions/paths.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeRows,
} from "../../functions/v2/embeddings/forensics.js";

/** @type {EmbeddingIndex | null} */
let index = null;

function post(message) {
  try { process.send?.(message); } catch { /* parent is gone */ }
}

function errorPayload(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err),
    stack: err?.stack || null,
    code: err?.code || null,
  };
}

process.on("uncaughtException", (err) => {
  recordEmbeddingForensics("child_index_worker.uncaught_exception", {
    index: indexTelemetry(),
    error: errorForTelemetry(err),
  });
  post({ type: "error", id: null, error: errorPayload(err) });
  throw err;
});

process.on("unhandledRejection", (reason) => {
  recordEmbeddingForensics("child_index_worker.unhandled_rejection", {
    index: indexTelemetry(),
    error: errorForTelemetry(reason),
  });
  post({ type: "error", id: null, error: errorPayload(reason) });
});

function normalizeRows(rows, dim) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    content_hash: row?.content_hash,
    local_id: row?.local_id,
    vector: normalizeVector(row?.vector, dim),
  }));
}

function normalizeVector(vector, dim) {
  if (vector instanceof Float32Array) return vector;
  if (Array.isArray(vector)) return Float32Array.from(vector);
  if (vector && typeof vector === "object" && ArrayBuffer.isView(vector)) {
    return new Float32Array(vector.buffer, vector.byteOffset, vector.byteLength / 4);
  }
  if (vector?.buffer instanceof ArrayBuffer) {
    return new Float32Array(vector.buffer, vector.byteOffset || 0, vector.length || dim);
  }
  throw new TypeError("EmbeddingIndex child: vector must be Float32Array-compatible");
}

function normalizeSearchOptions(opts = {}) {
  const out = { ...(opts && typeof opts === "object" ? opts : {}) };
  if (Array.isArray(out.restrictToContentHashes)) {
    out.restrictToContentHashes = new Set(out.restrictToContentHashes.map(String));
  }
  return out;
}

async function handle(op, args = {}) {
  switch (op) {
    case "init": {
      setRuntimePathOverrides(args.runtimePathOverrides || null);
      if (index) {
        try { index.close(); } catch { /* best effort */ }
      }
      index = EmbeddingIndex.open({
        model: String(args.model || ""),
        model_version: String(args.model_version || ""),
        dim: Number(args.dim),
        embeddingsRoot: String(args.embeddingsRoot || ""),
        annSaveEveryBatches: args.annSaveEveryBatches,
        annSaveEveryMs: args.annSaveEveryMs,
      });
      return {
        model: index.model,
        model_version: index.model_version,
        dim: index.dim,
        backend: index.backend,
        count: index.count(),
      };
    }
    case "add": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      index.add(normalizeRows(args.rows, index.dim));
      return { ok: true, lastAddTiming: index.getLastAddTiming?.() || null };
    }
    case "removeByContentHash": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.removeByContentHash(Array.isArray(args.content_hashes) ? args.content_hashes : []);
    }
    case "pruneToKeys": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.pruneToKeys(Array.isArray(args.keys) ? args.keys : []);
    }
    case "contains": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.contains(String(args.content_hash || ""), Number(args.local_id));
    }
    case "containsMany": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      const result = index.containsMany(Array.isArray(args.keys) ? args.keys : []);
      return Array.from(result || []).map(String);
    }
    case "nearest": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.nearest(normalizeVector(args.vector, index.dim), normalizeSearchOptions(args.opts));
    }
    case "count": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.count();
    }
    case "getLastAddTiming": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.getLastAddTiming?.() || null;
    }
    case "markEncoding": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      index.markEncoding(Array.isArray(args.keys) ? args.keys : [], args.meta || {});
      return true;
    }
    case "clearEncoding": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      index.clearEncoding();
      return true;
    }
    case "readInflight": {
      if (!index) throw new Error("EmbeddingIndex child: not initialized");
      return index.readInflight();
    }
    case "close": {
      try { index?.close(); } finally { index = null; }
      return true;
    }
    case "ping":
      return true;
    default:
      throw new Error(`EmbeddingIndex child: unknown op '${op}'`);
  }
}

process.on("message", (message = {}) => {
  const payload = /** @type {{ id?: unknown, op?: unknown, args?: unknown }} */ (
    message && typeof message === "object" ? message : {}
  );
  const id = payload.id;
  const op = String(payload.op || "");
  recordEmbeddingForensics("child_index_worker.request.start", {
    request_id: id,
    op,
    args: summarizeArgs(op, payload.args || {}),
    index: indexTelemetry(),
  });
  const startedAt = Date.now();
  Promise.resolve()
    .then(() => handle(op, payload.args || {}))
    .then(
      (result) => {
        recordEmbeddingForensics("child_index_worker.request.done", {
          request_id: id,
          op,
          elapsed_ms: Date.now() - startedAt,
          result: summarizeResult(result),
          index: indexTelemetry(),
        });
        post({ type: "result", id, result });
      },
      (err) => {
        recordEmbeddingForensics("child_index_worker.request.error", {
          request_id: id,
          op,
          elapsed_ms: Date.now() - startedAt,
          error: errorForTelemetry(err),
          index: indexTelemetry(),
        });
        post({ type: "error", id, error: errorPayload(err) });
      },
    );
});

function closeForExit() {
  recordEmbeddingForensics("child_index_worker.close_for_exit.start", {
    index: indexTelemetry(),
  });
  try { index?.close(); } catch { /* best effort */ }
  index = null;
  recordEmbeddingForensics("child_index_worker.close_for_exit.done", {});
}

process.on("disconnect", closeForExit);
process.on("exit", closeForExit);

function indexTelemetry() {
  return index ? {
    model: index.model,
    model_version: index.model_version,
    dim: index.dim,
    backend: index.backend,
  } : null;
}

function summarizeArgs(op, args = {}) {
  if (op === "add") {
    return { rows: summarizeRows(Array.isArray(args?.rows) ? args.rows : []) };
  }
  if (op === "containsMany" || op === "pruneToKeys" || op === "markEncoding") {
    const keys = Array.isArray(args?.keys) ? args.keys : [];
    return { key_count: keys.length, first: keyIdentity(keys[0]), last: keyIdentity(keys[keys.length - 1]) };
  }
  if (op === "removeByContentHash") {
    return { content_hashes: Array.isArray(args?.content_hashes) ? args.content_hashes.length : 0 };
  }
  if (op === "nearest") {
    return { vector_dim: Number.isInteger(args?.vector?.length) ? args.vector.length : null };
  }
  return {};
}

function summarizeResult(result) {
  if (Array.isArray(result)) return { array_length: result.length };
  if (result && typeof result === "object") {
    return {
      ok: /** @type {any} */ (result).ok ?? null,
      count: /** @type {any} */ (result).count ?? null,
      model: /** @type {any} */ (result).model || null,
      backend: /** @type {any} */ (result).backend || null,
      last_add_timing: /** @type {any} */ (result).lastAddTiming || null,
    };
  }
  return { value: result ?? null };
}

function keyIdentity(key) {
  if (!key || typeof key !== "object") return null;
  return {
    local_id: Number.isInteger(key.local_id) ? key.local_id : null,
    content_hash: typeof key.content_hash === "string" ? key.content_hash.slice(0, 16) : null,
  };
}
