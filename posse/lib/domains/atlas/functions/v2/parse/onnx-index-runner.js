// @ts-check

import { emitParseEvent } from "./events.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
} from "../embeddings/forensics.js";

/**
 * @typedef {Object} OnnxSymbol
 * @property {string} symbol_key
 * @property {string} merged_fingerprint
 * @property {string} [text]
 */

/**
 * Start a derived ONNX refresh over merged A+B symbols. When wait=false, the
 * returned object includes a `done` promise and the caller is not blocked.
 *
 * @param {{
 *   mode?: string,
 *   symbols: OnnxSymbol[],
 *   existingFingerprints?: Map<string, string> | Record<string, string>,
 *   modelId: string,
 *   modelVersion: string,
 *   batchSize?: number,
 *   wait?: boolean,
 *   signal?: AbortSignal,
 *   embedSymbols: (symbols: OnnxSymbol[], signal?: AbortSignal) => Promise<Array<{ symbol_key: string, vector: Buffer | Uint8Array | ArrayBufferView }>>,
 *   commitBatch: (rows: Array<{ symbol_key: string, model_id: string, model_version: string, merged_fingerprint: string, vector: Buffer | Uint8Array | ArrayBufferView }>) => Promise<void> | void,
 *   onEvent?: (event: Record<string, unknown>) => void,
 * }} opts
 */
export function startOnnxRefresh(opts) {
  const mode = opts.mode || "changed";
  const batchSize = Math.max(1, Math.floor(Number(opts.batchSize) || 128));
  const existing = normalizeExistingFingerprints(opts.existingFingerprints);
  const changed = (opts.symbols || []).filter((symbol) => {
    const key = String(symbol.symbol_key || "");
    const fp = String(symbol.merged_fingerprint || "");
    return key && fp && existing.get(key) !== fp;
  });

  const run = async () => {
    const startedAt = Date.now();
    emitOnnxEvent(opts.onEvent, {
      kind: "atlas.parse.onnx.started",
      mode,
      totalSymbols: changed.length,
    });
    let indexed = 0;
    for (let offset = 0; offset < changed.length; offset += batchSize) {
      throwIfAborted(opts.signal);
      const batch = changed.slice(offset, offset + batchSize);
      recordEmbeddingForensics("parse_onnx.batch.embed.start", {
        mode,
        offset,
        batch_size: batch.length,
        total_symbols: changed.length,
        model_id: opts.modelId,
        model_version: opts.modelVersion,
        symbols: summarizeOnnxSymbols(batch),
      });
      let vectors;
      const embedStartedAt = Date.now();
      try {
        vectors = await opts.embedSymbols(batch, opts.signal);
      } catch (err) {
        recordEmbeddingForensics("parse_onnx.batch.embed.error", {
          mode,
          offset,
          batch_size: batch.length,
          elapsed_ms: Date.now() - embedStartedAt,
          error: errorForTelemetry(err),
        });
        throw err;
      }
      recordEmbeddingForensics("parse_onnx.batch.embed.done", {
        mode,
        offset,
        batch_size: batch.length,
        vector_count: Array.isArray(vectors) ? vectors.length : null,
        elapsed_ms: Date.now() - embedStartedAt,
      });
      throwIfAborted(opts.signal);
      const rows = commitRowsForBatch({
        vectors,
        batch,
        model_id: opts.modelId,
        model_version: opts.modelVersion,
      });
      recordEmbeddingForensics("parse_onnx.batch.commit.start", {
        mode,
        offset,
        rows: rows.length,
        model_id: opts.modelId,
        model_version: opts.modelVersion,
      });
      const commitStartedAt = Date.now();
      try {
        await opts.commitBatch(rows);
      } catch (err) {
        recordEmbeddingForensics("parse_onnx.batch.commit.error", {
          mode,
          offset,
          rows: rows.length,
          elapsed_ms: Date.now() - commitStartedAt,
          error: errorForTelemetry(err),
        });
        throw err;
      }
      recordEmbeddingForensics("parse_onnx.batch.commit.done", {
        mode,
        offset,
        rows: rows.length,
        elapsed_ms: Date.now() - commitStartedAt,
      });
      indexed += rows.length;
      emitOnnxEvent(opts.onEvent, {
        kind: "atlas.parse.onnx.progress",
        mode,
        current: indexed,
        total: changed.length,
        symbol: batch[batch.length - 1]?.symbol_key || null,
      });
    }
    emitOnnxEvent(opts.onEvent, {
      kind: "atlas.parse.onnx.completed",
      mode,
      indexedSymbols: indexed,
      durationMs: Date.now() - startedAt,
    });
    return { indexedSymbols: indexed, skippedSymbols: (opts.symbols || []).length - changed.length };
  };

  const done = Promise.resolve().then(run).catch((err) => {
    emitOnnxEvent(opts.onEvent, {
      kind: "atlas.parse.onnx.failed",
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
    recordEmbeddingForensics("parse_onnx.failed", {
      mode,
      model_id: opts.modelId,
      model_version: opts.modelVersion,
      error: errorForTelemetry(err),
    });
    throw err;
  });

  if (opts.wait === true) return done;
  done.catch(() => {
    // Fire-and-forget callers still receive the failed event above, but Node
    // should not treat an intentionally backgrounded refresh as unhandled.
  });
  return {
    queued: true,
    background: true,
    totalSymbols: (opts.symbols || []).length,
    changedSymbols: changed.length,
    done,
  };
}

/**
 * @param {((event: Record<string, unknown>) => void) | undefined} onEvent
 * @param {{ kind: string, [k: string]: unknown }} event
 */
function emitOnnxEvent(onEvent, event) {
  try { emitParseEvent(onEvent, event); } catch { /* parse progress is observational */ }
}

/**
 * @param {{
 *   vectors: Array<{ symbol_key: string, vector: Buffer | Uint8Array | ArrayBufferView }>,
 *   batch: OnnxSymbol[],
 *   model_id: string,
 *   model_version: string,
 * }} args
 */
function commitRowsForBatch({ vectors, batch, model_id, model_version }) {
  if (!Array.isArray(vectors)) {
    throw new Error(`ONNX refresh embedSymbols returned ${typeof vectors}, expected an array`);
  }
  const fingerprintByKey = new Map(batch.map((symbol) => [
    String(symbol.symbol_key || ""),
    String(symbol.merged_fingerprint || ""),
  ]));
  const seen = new Set();
  const rows = [];
  for (const row of vectors) {
    const key = String(row?.symbol_key || "");
    if (!fingerprintByKey.has(key)) {
      throw new Error(`ONNX refresh returned vector for unknown symbol_key '${key || "<empty>"}'`);
    }
    if (seen.has(key)) {
      throw new Error(`ONNX refresh returned duplicate vector for symbol_key '${key}'`);
    }
    if (!isVectorLike(row?.vector)) {
      throw new Error(`ONNX refresh returned invalid vector for symbol_key '${key}'`);
    }
    seen.add(key);
    rows.push({
      symbol_key: key,
      model_id,
      model_version,
      merged_fingerprint: fingerprintByKey.get(key) || "",
      vector: row.vector,
    });
  }
  for (const key of fingerprintByKey.keys()) {
    if (!seen.has(key)) {
      throw new Error(`ONNX refresh missing vector for symbol_key '${key}'`);
    }
  }
  return rows;
}

/**
 * @param {unknown} value
 */
function isVectorLike(value) {
  return !!value
    && ArrayBuffer.isView(/** @type {any} */ (value))
    && !(value instanceof DataView)
    && Number(/** @type {ArrayBufferView} */ (value).byteLength) > 0;
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("ONNX refresh aborted");
}

function normalizeExistingFingerprints(value) {
  if (value instanceof Map) return value;
  const out = new Map();
  if (value && typeof value === "object") {
    for (const [key, fingerprint] of Object.entries(value)) {
      out.set(key, String(fingerprint || ""));
    }
  }
  return out;
}

function summarizeOnnxSymbols(symbols = []) {
  const list = Array.isArray(symbols) ? symbols : [];
  return {
    count: list.length,
    first: onnxSymbolIdentity(list[0]),
    last: onnxSymbolIdentity(list[list.length - 1]),
    samples: list.slice(0, 5).map(onnxSymbolIdentity),
  };
}

function onnxSymbolIdentity(symbol) {
  if (!symbol || typeof symbol !== "object") return null;
  return {
    symbol_key: String(symbol.symbol_key || "").slice(0, 200),
    merged_fingerprint: String(symbol.merged_fingerprint || "").slice(0, 16),
    text_length: symbol.text == null ? null : String(symbol.text).length,
  };
}
