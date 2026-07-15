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
 * @typedef {Object} OnnxDocumentSource
 * @property {string} [document_id]
 * @property {string} [repo_rel_path]
 * @property {string} content_hash
 * @property {OnnxSymbol[]} symbols
 */

/**
 * One complete document boundary for streaming intake. When both source
 * layers are present, mergeDocument is responsible for the domain merge after
 * this runner verifies that both layers identify the same immutable document.
 *
 * @typedef {Object} OnnxDocument
 * @property {string} [document_id]
 * @property {string} [repo_rel_path]
 * @property {string} content_hash
 * @property {OnnxSymbol[]} [symbols]
 * @property {OnnxDocumentSource} [treeSitter]
 * @property {OnnxDocumentSource} [scip]
 */

/**
 * Start a derived ONNX refresh over merged A+B symbols. When wait=false, the
 * returned object includes a `done` promise and the caller is not blocked.
 * `documents` is the bounded streaming path; `symbols` remains the one-shot
 * rollback path.
 *
 * @param {{
 *   mode?: string,
 *   symbols?: OnnxSymbol[],
 *   documents?: Iterable<OnnxDocument> | AsyncIterable<OnnxDocument>,
 *   existingFingerprints?: Map<string, string> | Record<string, string>,
 *   modelId: string,
 *   modelVersion: string,
 *   batchSize?: number,
 *   documentWindow?: number,
 *   wait?: boolean,
 *   signal?: AbortSignal,
 *   getDocumentTotal?: () => number | null,
 *   mergeDocument?: (document: OnnxDocument, signal?: AbortSignal) => Promise<OnnxSymbol[]> | OnnxSymbol[],
 *   buildSymbolText?: (symbol: OnnxSymbol, document: OnnxDocument) => string,
 *   embedSymbols: (symbols: OnnxSymbol[], signal?: AbortSignal, onProgress?: (event: Record<string, unknown>) => void) => Promise<Array<{ symbol_key: string, vector: Buffer | Uint8Array | ArrayBufferView }>>,
 *   commitBatch: (rows: Array<{ symbol_key: string, model_id: string, model_version: string, merged_fingerprint: string, vector: Buffer | Uint8Array | ArrayBufferView }>) => Promise<void> | void,
 *   persistWatermark?: (watermark: Record<string, unknown>) => Promise<void> | void,
 *   onDocumentProcessed?: (document: OnnxDocument) => Promise<void> | void,
 *   onEvent?: (event: Record<string, unknown>) => void,
 * }} opts
 */
export function startOnnxRefresh(opts) {
  const mode = opts.mode || "changed";
  const batchSize = Math.max(1, Math.floor(Number(opts.batchSize) || 128));
  const documentWindow = Math.max(1, Math.floor(Number(opts.documentWindow) || 8));
  const existing = normalizeExistingFingerprints(opts.existingFingerprints);
  const streaming = opts.documents != null;
  if (streaming && opts.symbols != null) {
    throw new TypeError("ONNX refresh accepts either documents or symbols, not both");
  }
  if (!streaming && !Array.isArray(opts.symbols)) {
    throw new TypeError("ONNX refresh requires documents or symbols");
  }
  const symbols = streaming ? [] : (opts.symbols || []);
  const changed = streaming ? [] : symbols.filter((symbol) => shouldIndexSymbol(symbol, existing));

  const run = async () => {
    const startedAt = Date.now();
    emitOnnxEvent(opts.onEvent, {
      kind: "atlas.parse.onnx.started",
      mode,
      totalSymbols: streaming ? null : changed.length,
      streaming,
      ...(streaming ? { documentWindow, totalDocuments: documentTotal(opts) } : {}),
    });
    const result = streaming
      ? await runStreamingRefresh(opts, { mode, batchSize, documentWindow, existing })
      : await runOneShotRefresh(opts, { mode, batchSize, symbols, changed });
    emitOnnxEvent(opts.onEvent, {
      kind: "atlas.parse.onnx.completed",
      mode,
      ...result,
      ...(streaming ? { totalDocuments: documentTotal(opts), unit: "documents" } : {}),
      durationMs: Date.now() - startedAt,
    });
    return result;
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
    streaming,
    totalSymbols: streaming ? null : symbols.length,
    changedSymbols: streaming ? null : changed.length,
    done,
  };
}

async function runOneShotRefresh(opts, { mode, batchSize, symbols, changed }) {
  let indexed = 0;
  let batchNumber = 0;
  for (let offset = 0; offset < changed.length; offset += batchSize) {
    const batch = changed.slice(offset, offset + batchSize);
    const rows = await embedAndCommitBatch(opts, batch, {
      mode,
      offset,
      totalSymbols: changed.length,
    });
    indexed += rows.length;
    batchNumber++;
    await persistOnnxWatermark(opts, {
      mode,
      batchNumber,
      indexedSymbols: indexed,
      skippedSymbols: symbols.length - changed.length,
      processedDocuments: null,
      lastDocument: null,
    });
    emitOnnxEvent(opts.onEvent, {
      kind: "atlas.parse.onnx.progress",
      mode,
      current: indexed,
      total: changed.length,
      symbol: batch[batch.length - 1]?.symbol_key || null,
    });
  }
  return { indexedSymbols: indexed, skippedSymbols: symbols.length - changed.length };
}

async function runStreamingRefresh(opts, { mode, batchSize, documentWindow, existing }) {
  const state = {
    indexedSymbols: 0,
    skippedSymbols: 0,
    processedDocuments: 0,
    batchNumber: 0,
    lastDocument: null,
  };
  const source = asyncIteratorFor(opts.documents);
  const queue = [];
  const itemWaiters = [];
  const spaceWaiters = [];
  let sourceDone = false;
  let sourceError = null;
  let cancelled = false;

  // Read ahead independently while ONNX works, but never retain more than the
  // configured N+1 document capacity. Processing below starts as soon as the
  // first complete document arrives; the window is not a batching delay.
  const producer = (async () => {
    try {
      while (!cancelled) {
        while (!cancelled && queue.length >= documentWindow) {
          await new Promise((resolve) => spaceWaiters.push(resolve));
        }
        if (cancelled) break;
        const next = await source.next();
        if (next.done) break;
        queue.push(next.value);
        wakeOne(itemWaiters);
      }
    } catch (err) {
      sourceError = err;
    } finally {
      sourceDone = true;
      wakeAll(itemWaiters);
    }
  })();

  const documentHashes = new Map();
  let receivedDocuments = 0;
  try {
    while (true) {
      throwIfAborted(opts.signal);
      while (queue.length === 0 && !sourceDone) {
        await new Promise((resolve) => itemWaiters.push(resolve));
      }
      if (sourceError) throw sourceError;
      if (queue.length === 0 && sourceDone) break;
      const available = [];
      while (queue.length > 0 && available.length < documentWindow) {
        available.push(queue.shift());
        wakeOne(spaceWaiters);
      }
      const documents = available.map((value) => normalizeOnnxDocument(value, receivedDocuments++));
      for (const document of documents) {
        const priorHash = documentHashes.get(document.document_id);
        if (priorHash != null) {
          throw new Error(
            `ONNX refresh received duplicate document '${document.document_id}'`
            + (priorHash === document.content_hash ? "" : " with conflicting content hashes"),
          );
        }
        documentHashes.set(document.document_id, document.content_hash);
      }
      await processDocumentWindow(opts, documents, state, { mode, batchSize, existing });
    }
  } finally {
    cancelled = true;
    wakeAll(spaceWaiters);
    try { await source.return?.(); } catch { /* original stream result wins */ }
    await producer;
  }
  return {
    indexedSymbols: state.indexedSymbols,
    skippedSymbols: state.skippedSymbols,
    processedDocuments: state.processedDocuments,
  };
}

function asyncIteratorFor(value) {
  const asyncIterator = value?.[Symbol.asyncIterator]?.();
  if (asyncIterator) return asyncIterator;
  const iterator = value?.[Symbol.iterator]?.();
  if (!iterator) throw new TypeError("ONNX documents must be iterable or async iterable");
  return {
    next: () => Promise.resolve(iterator.next()),
    return: typeof iterator.return === "function"
      ? () => Promise.resolve(iterator.return())
      : undefined,
  };
}

function wakeOne(waiters) {
  const wake = waiters.shift();
  if (wake) wake();
}

function wakeAll(waiters) {
  for (const wake of waiters.splice(0)) wake();
}

async function processDocumentWindow(opts, documents, state, { mode, batchSize, existing }) {
  const entries = [];
  const remainingByDocument = [];
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex++) {
    const document = documents[documentIndex];
    const symbols = await completeOnnxDocument(opts, document);
    let changedInDocument = 0;
    for (const symbol of symbols) {
      if (!shouldIndexSymbol(symbol, existing)) {
        state.skippedSymbols++;
        continue;
      }
      const completeSymbol = opts.buildSymbolText
        ? { ...symbol, text: String(opts.buildSymbolText(symbol, document) || "") }
        : symbol;
      entries.push({ symbol: completeSymbol, documentIndex });
      changedInDocument++;
    }
    remainingByDocument.push(changedInDocument);
  }

  // ONNX packing is independent from SCIP/document boundaries. Sort only the
  // bounded inference pool by text length to reduce padding, then restore the
  // canonical document/symbol order before durable vector commits.
  const packedEntries = [...entries].sort((left, right) => (
    symbolTextLength(left.symbol) - symbolTextLength(right.symbol)
    || left.documentIndex - right.documentIndex
  ));
  const rowByKey = new Map();
  for (let offset = 0; offset < packedEntries.length; offset += batchSize) {
    const packed = packedEntries.slice(offset, offset + batchSize);
    const processedDocuments = state.processedDocuments + countCompletedDocumentPrefix(remainingByDocument);
    const rows = await embedBatchRows(opts, packed.map((entry) => entry.symbol), {
      mode,
      offset: state.indexedSymbols + offset,
      totalSymbols: null,
      onProgress: (nativeProgress) => emitStreamingProgress(opts, state, {
        processedDocuments,
        phase: String(nativeProgress?.phase || "inference"),
        nativeProgress,
        symbol: packed[packed.length - 1]?.symbol?.symbol_key || null,
      }),
    });
    for (const row of rows) rowByKey.set(row.symbol_key, row);
  }
  const canonicalRows = entries.map((entry) => {
    const row = rowByKey.get(String(entry.symbol.symbol_key || ""));
    if (!row) throw new Error(`ONNX refresh lost vector for '${entry.symbol.symbol_key || "<empty>"}'`);
    return row;
  });

  let completedInWindow = countCompletedDocumentPrefix(remainingByDocument);
  for (let offset = 0; offset < canonicalRows.length; offset += batchSize) {
    const rows = canonicalRows.slice(offset, offset + batchSize);
    const committedEntries = entries.slice(offset, offset + batchSize);
    emitStreamingProgress(opts, state, {
      processedDocuments: state.processedDocuments + completedInWindow,
      phase: "committing",
      batchItems: rows.length,
      symbol: rows[rows.length - 1]?.symbol_key || null,
    });
    await commitPreparedRows(opts, rows, {
      mode,
      offset: state.indexedSymbols,
    });
    state.indexedSymbols += rows.length;
    state.batchNumber++;
    for (const entry of committedEntries) remainingByDocument[entry.documentIndex]--;
    completedInWindow = countCompletedDocumentPrefix(remainingByDocument);
    const lastDocument = completedInWindow > 0
      ? documents[completedInWindow - 1]
      : state.lastDocument;
    await persistOnnxWatermark(opts, {
      mode,
      batchNumber: state.batchNumber,
      indexedSymbols: state.indexedSymbols,
      skippedSymbols: state.skippedSymbols,
      processedDocuments: state.processedDocuments + completedInWindow,
      lastDocument,
    });
    emitStreamingProgress(opts, state, {
      processedDocuments: state.processedDocuments + completedInWindow,
      phase: "committed",
      symbol: rows[rows.length - 1]?.symbol_key || null,
    });
  }

  if (entries.length === 0) {
    await persistOnnxWatermark(opts, {
      mode,
      batchNumber: state.batchNumber,
      indexedSymbols: state.indexedSymbols,
      skippedSymbols: state.skippedSymbols,
      processedDocuments: state.processedDocuments + documents.length,
      lastDocument: documents[documents.length - 1],
    });
  }
  if (typeof opts.onDocumentProcessed === "function") {
    for (const document of documents) await opts.onDocumentProcessed(document);
  }
  state.processedDocuments += documents.length;
  state.lastDocument = documents[documents.length - 1] || state.lastDocument;
  emitStreamingProgress(opts, state, {
    processedDocuments: state.processedDocuments,
    phase: "documents_processed",
    document: state.lastDocument?.document_id || null,
  });
}

async function completeOnnxDocument(opts, document) {
  validateOnnxDocumentSource(document, document.treeSitter, "tree-sitter");
  validateOnnxDocumentSource(document, document.scip, "SCIP");
  let symbols;
  if (opts.mergeDocument) {
    symbols = await opts.mergeDocument(document, opts.signal);
  } else if (Array.isArray(document.symbols)) {
    symbols = document.symbols;
  } else {
    const sources = [document.treeSitter, document.scip].filter(Boolean);
    if (sources.length !== 1) {
      throw new Error(
        `ONNX document '${document.document_id}' requires mergeDocument when both source layers are present`,
      );
    }
    symbols = sources[0].symbols;
  }
  if (!Array.isArray(symbols)) {
    throw new Error(`ONNX document '${document.document_id}' did not produce a symbol array`);
  }
  return symbols;
}

async function embedAndCommitBatch(opts, batch, { mode, offset, totalSymbols }) {
  const rows = await embedBatchRows(opts, batch, { mode, offset, totalSymbols });
  await commitPreparedRows(opts, rows, { mode, offset });
  return rows;
}

async function embedBatchRows(opts, batch, { mode, offset, totalSymbols, onProgress = null }) {
  throwIfAborted(opts.signal);
  recordEmbeddingForensics("parse_onnx.batch.embed.start", {
    mode,
    offset,
    batch_size: batch.length,
    total_symbols: totalSymbols,
    model_id: opts.modelId,
    model_version: opts.modelVersion,
    symbols: summarizeOnnxSymbols(batch),
  });
  let vectors;
  const embedStartedAt = Date.now();
  let lastNativeProgress = null;
  const stopActivity = startEmbeddingActivityPulse((elapsedMs) => {
    if (typeof onProgress !== "function") return;
    onProgress(lastNativeProgress
      ? {
          ...lastNativeProgress,
          elapsedMs: Math.max(Number(lastNativeProgress.elapsedMs) || 0, elapsedMs),
        }
      : { kind: "ml.embedding.progress", phase: "inference", elapsedMs, source: "harness" });
  });
  try {
    vectors = await opts.embedSymbols(batch, opts.signal, (event) => {
      lastNativeProgress = normalizeNativeEmbeddingProgress(event);
      if (typeof onProgress === "function") onProgress(lastNativeProgress);
    });
  } catch (err) {
    recordEmbeddingForensics("parse_onnx.batch.embed.error", {
      mode,
      offset,
      batch_size: batch.length,
      elapsed_ms: Date.now() - embedStartedAt,
      error: errorForTelemetry(err),
    });
    throw err;
  } finally {
    stopActivity();
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
  return rows;
}

async function commitPreparedRows(opts, rows, { mode, offset }) {
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
}

async function persistOnnxWatermark(opts, {
  mode,
  batchNumber,
  indexedSymbols,
  skippedSymbols,
  processedDocuments,
  lastDocument,
}) {
  if (!opts.persistWatermark) return;
  throwIfAborted(opts.signal);
  await opts.persistWatermark({
    schemaVersion: 1,
    mode,
    modelId: opts.modelId,
    modelVersion: opts.modelVersion,
    batchNumber,
    indexedSymbols,
    skippedSymbols,
    processedDocuments,
    lastDocument: lastDocument ? {
      documentId: lastDocument.document_id,
      contentHash: lastDocument.content_hash,
    } : null,
  });
}

/**
 * @param {((event: Record<string, unknown>) => void) | undefined} onEvent
 * @param {{ kind: string, [k: string]: unknown }} event
 */
function emitOnnxEvent(onEvent, event) {
  try { emitParseEvent(onEvent, event); } catch { /* parse progress is observational */ }
}

function documentTotal(opts) {
  try {
    const value = typeof opts.getDocumentTotal === "function"
      ? opts.getDocumentTotal()
      : opts.documents?.totalDocuments;
    const total = Number(value);
    return Number.isInteger(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}

function emitStreamingProgress(opts, state, {
  processedDocuments,
  phase,
  nativeProgress = null,
  batchItems = null,
  symbol = null,
  document = null,
}) {
  const current = Math.max(0, Number(processedDocuments) || 0);
  const total = documentTotal(opts);
  const native = normalizeNativeEmbeddingProgress(nativeProgress);
  emitOnnxEvent(opts.onEvent, {
    kind: "atlas.parse.onnx.progress",
    mode: opts.mode || "changed",
    phase: String(phase || native.phase || "inference"),
    current,
    total,
    unit: "documents",
    progress_current: current,
    progress_total: total,
    progress_unit: "documents",
    processedDocuments: current,
    totalDocuments: total,
    indexedSymbols: state.indexedSymbols,
    skippedSymbols: state.skippedSymbols,
    ...(batchItems == null ? {} : { batchItems: Number(batchItems) || 0 }),
    ...(symbol ? { symbol } : {}),
    ...(document ? { document } : {}),
    ...(native.phase ? { nativePhase: native.phase } : {}),
    ...(native.current == null ? {} : { nativeCurrent: native.current }),
    ...(native.total == null ? {} : { nativeTotal: native.total }),
    ...(native.unit ? { nativeUnit: native.unit } : {}),
    ...(native.batchCurrent == null ? {} : { nativeBatchCurrent: native.batchCurrent }),
    ...(native.batchTotal == null ? {} : { nativeBatchTotal: native.batchTotal }),
    ...(native.batchItems == null ? {} : { nativeBatchItems: native.batchItems }),
    ...(native.elapsedMs == null ? {} : { elapsedMs: native.elapsedMs }),
    ...(native.source ? { progressSource: native.source } : {}),
  });
}

function normalizeNativeEmbeddingProgress(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return {};
  const source = /** @type {Record<string, unknown>} */ (event);
  return {
    kind: String(source.kind || "ml.embedding.progress"),
    phase: String(source.phase || "inference"),
    current: finiteNumberOrNull(source.current ?? source.completedTexts ?? source.completed_texts),
    total: finiteNumberOrNull(source.total ?? source.totalTexts ?? source.total_texts),
    unit: String(source.unit || "texts"),
    batchCurrent: finiteNumberOrNull(source.batchCurrent ?? source.batch_current),
    batchTotal: finiteNumberOrNull(source.batchTotal ?? source.batch_total),
    batchItems: finiteNumberOrNull(source.batchItems ?? source.batch_items),
    elapsedMs: finiteNumberOrNull(source.elapsedMs ?? source.elapsed_ms),
    source: String(source.source || "native"),
  };
}

function finiteNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function startEmbeddingActivityPulse(onActivity) {
  if (typeof onActivity !== "function") return () => {};
  const startedAt = Date.now();
  try { onActivity(0); } catch { /* progress is observational */ }
  const timer = setInterval(() => {
    try { onActivity(Date.now() - startedAt); } catch { /* progress is observational */ }
  }, 1_000);
  timer.unref?.();
  return () => clearInterval(timer);
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
  const vectorByKey = new Map();
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
    vectorByKey.set(key, row.vector);
  }
  for (const key of fingerprintByKey.keys()) {
    if (!seen.has(key)) {
      throw new Error(`ONNX refresh missing vector for symbol_key '${key}'`);
    }
  }
  // Encoders are allowed to finish their internal work out of order. Durable
  // vector commits are not: normalize back to the caller's batch sequence.
  return batch.map((symbol) => {
    const key = String(symbol.symbol_key || "");
    return {
      symbol_key: key,
      model_id,
      model_version,
      merged_fingerprint: fingerprintByKey.get(key) || "",
      vector: vectorByKey.get(key),
    };
  });
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

function shouldIndexSymbol(symbol, existing) {
  const key = String(symbol?.symbol_key || "");
  const fingerprint = String(symbol?.merged_fingerprint || "");
  return !!key && !!fingerprint && existing.get(key) !== fingerprint;
}

function normalizeOnnxDocument(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`ONNX document ${index} must be an object`);
  }
  const document = /** @type {OnnxDocument} */ (value);
  const document_id = String(document.document_id || document.repo_rel_path || "").trim();
  const content_hash = String(document.content_hash || "").trim();
  if (!document_id) throw new Error(`ONNX document ${index} is missing document identity`);
  if (!content_hash) throw new Error(`ONNX document '${document_id}' is missing content_hash`);
  return { ...document, document_id, content_hash };
}

function validateOnnxDocumentSource(document, source, label) {
  if (!source) return;
  const sourceId = String(source.document_id || source.repo_rel_path || "").trim();
  const sourceHash = String(source.content_hash || "").trim();
  if (!sourceId || !sourceHash) {
    throw new Error(`ONNX ${label} source for '${document.document_id}' is missing document identity or content_hash`);
  }
  if (sourceId !== document.document_id || sourceHash !== document.content_hash) {
    throw new Error(
      `ONNX ${label} source does not match document '${document.document_id}' at '${document.content_hash}'`,
    );
  }
  if (!Array.isArray(source.symbols)) {
    throw new Error(`ONNX ${label} source for '${document.document_id}' is missing symbols`);
  }
}

function symbolTextLength(symbol) {
  return symbol?.text == null ? 0 : String(symbol.text).length;
}

function countCompletedDocumentPrefix(remainingByDocument) {
  let completed = 0;
  while (completed < remainingByDocument.length && remainingByDocument[completed] === 0) {
    completed++;
  }
  return completed;
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
