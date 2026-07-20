// @ts-check
//
// Embedding ingest — walk a view's symbols, encode them in batches, and
// add the resulting vectors to an EmbeddingIndex. Idempotent per
// (content_hash, local_id) via EmbeddingIndex.add semantics.
//
// Ingest is INTENTIONALLY decoupled from view building: building the
// view doesn't touch embeddings (3.3 says views are rebuildable; we
// don't want embedding work blocking the view path). Callers that want
// embeddings invoke `ingestView` after the view has been built.

import { performance } from "node:perf_hooks";

import { hasLanguageSemantics } from "../resolver/adapters/registry.js";
import { documentationEmbeddingKey } from "./documentation-channel.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeRows,
  summarizeSymbols,
  summarizeTexts,
} from "./forensics.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIngest} EmbeddingIngest */

const DEFAULT_BATCH_SIZE = 64;

/**
 * @typedef {Object} IngestReport
 * @property {number} candidates         Symbols eligible for embedding.
 * @property {number} indexed            Code vectors actually inserted into the index.
 * @property {number} skipped            Symbols the encoder declined to embed (empty text).
 * @property {number} skippedUnsupportedLanguage Symbols skipped because ATLAS has no language semantics for them.
 * @property {number} alreadyIndexed     Symbols already present in the vector index.
 * @property {number} indexedSymbols     Symbols for which at least one missing channel was inserted.
 * @property {number} documentationCandidates Symbols with non-empty documentation.
 * @property {number} documentationIndexed Documentation vectors actually inserted.
 * @property {number} documentationAlreadyIndexed Documentation vectors already present.
 * @property {number} batches            Encoder invocations issued.
 */

/**
 * Encode and insert every symbol in `view` into `index`. Symbols already
 * in the index are skipped via `EmbeddingIndex.add` idempotency. Pulls
 * symbols in batches of up to `batchSize` to keep encoder request size
 * bounded.
 *
 * @param {{
 *   view: View,
 *   index: EmbeddingIndex,
 *   encoder: EmbeddingEncoder,
 *   batchSize?: number,
 *   signal?: AbortSignal,
 *   limit?: number,
 *   repoRoot?: string,
 *   onlySymbols?: ViewSymbol[],
 *   onProgress?: ((event: {
 *     kind: string,
 *     current: number,
 *     total: number,
 *     percent: number,
 *     batches: number,
 *     indexedThisRun: number,
 *     alreadyIndexed: number,
 *     skipped: number,
 *     languageCurrent: Map<string, number>,
 *     languageTotal: Map<string, number>,
 *     batchSize?: number,
 *     timingsMs?: Record<string, any>,
 *     batchTimingMs?: Record<string, any> | null,
 *   }) => void) | null,
 * }} args
 * @returns {Promise<IngestReport>}
 */
export async function ingestView({ view, index, encoder, batchSize, signal, limit, repoRoot, onlySymbols, onProgress = null }) {
  const startedAt = performance.now();
  if (!view) throw new TypeError("ingestView: view is required");
  if (!index) throw new TypeError("ingestView: index is required");
  if (!encoder) throw new TypeError("ingestView: encoder is required");
  if (encoder.dim !== index.dim) {
    throw new RangeError(
      `ingestView: encoder dim ${encoder.dim} != index dim ${index.dim}`,
    );
  }
  const size = resolveEmbeddingIngestBatchSize({
    batchSize: batchSize ?? /** @type {any} */ (encoder).batchSize,
  });
  const symbolsLimit = Number.isInteger(limit) && /** @type {number} */ (limit) > 0
    ? /** @type {number} */ (limit)
    : 100_000;
  const timings = createEmbeddingIngestTimings();
  const queryStartedAt = performance.now();
  const rawSymbols = Array.isArray(onlySymbols)
    ? onlySymbols.slice(0, symbolsLimit)
    : await view.query.allSymbols({ limit: symbolsLimit });
  timings.symbolQueryMs += elapsedSince(queryStartedAt);
  const filterStartedAt = performance.now();
  const symbols = rawSymbols.filter((symbol) => hasLanguageSemantics(symbol?.lang));
  timings.filterMs += elapsedSince(filterStartedAt);
  recordEmbeddingForensics("ingest.start", {
    view_path: viewPathForTelemetry(view),
    repo_root: repoRoot || null,
    encoder: encoderTelemetry(encoder),
    index: indexTelemetry(index),
    batch_size: size,
    raw_symbol_count: rawSymbols.length,
    candidate_symbol_count: symbols.length,
    skipped_unsupported_language: rawSymbols.length - symbols.length,
    only_symbols: Array.isArray(onlySymbols),
  });

  /** @type {IngestReport} */
  const report = {
    candidates: symbols.length,
    indexed: 0,
    skipped: 0,
    skippedUnsupportedLanguage: rawSymbols.length - symbols.length,
    alreadyIndexed: 0,
    indexedSymbols: 0,
    documentationCandidates: 0,
    documentationIndexed: 0,
    documentationAlreadyIndexed: 0,
    batches: 0,
  };

  // Per-language totals for the display row matrix. Symbols carry `lang` from
  // the view; bucket counts so each progress event can show e.g.
  // "python 420/1820, php 0/1210".
  /** @type {Map<string, number>} */
  const languageTotal = new Map();
  for (const s of symbols) {
    const lang = String(s?.lang || "").trim().toLowerCase() || "unknown";
    languageTotal.set(lang, (languageTotal.get(lang) || 0) + 1);
  }
  /** @type {Map<string, number>} */
  const languageCurrent = new Map();
  let processed = 0;
  let lastEmitAt = 0;
  const emitProgress = (force = false) => {
    if (typeof onProgress !== "function") return;
    const now = Date.now();
    if (!force && now - lastEmitAt < 150) return;
    lastEmitAt = now;
    try {
      onProgress({
        kind: "atlas.embeddings.ingest.progress",
        current: processed,
        total: symbols.length,
        percent: symbols.length > 0 ? (processed / symbols.length) * 100 : 100,
        batches: report.batches,
        indexedThisRun: report.indexed,
        alreadyIndexed: report.alreadyIndexed,
        skipped: report.skipped,
        languageCurrent: new Map(languageCurrent),
        languageTotal: new Map(languageTotal),
        batchSize: size,
        timingsMs: timingSnapshot(timings, startedAt),
        batchTimingMs: currentBatchTiming ? timingSnapshot(currentBatchTiming) : null,
      });
    } catch { /* progress is observational */ }
  };
  /** @type {Record<string, any> | null} */
  let currentBatchTiming = null;
  emitProgress(true);

  // Atlas owns document encoding and batches against its resident Jina session.
  const encodeTexts = async (texts) => typeof encoder.encodeDocuments === "function"
    ? encoder.encodeDocuments(texts, signal)
    : encoder.encode(texts, signal);

  try {
    for (let i = 0; i < symbols.length; i += size) {
      const batchStartedAt = performance.now();
      const batchNumber = i / size + 1;
      currentBatchTiming = createEmbeddingBatchTimings(batchNumber);
      if (signal?.aborted) {
        throw /** @type {any} */ (signal).reason ?? new Error("ingest aborted");
      }
      const batch = symbols.slice(i, i + size);
      recordEmbeddingForensics("ingest.batch.start", {
        view_path: viewPathForTelemetry(view),
        batch: batchNumber,
        offset: i,
        batch_size: batch.length,
        symbols: summarizeSymbols(batch),
      });
      const supportsStructuredSymbols = typeof encoder.encodeSymbols === "function";
      /** @type {Array<{ symbol: ViewSymbol, key: { content_hash: string, local_id: number }, text: string | null }>} */
      const codeInputs = [];
      /** @type {Array<{ symbol: ViewSymbol, key: { content_hash: string, local_id: number }, text: string }>} */
      const documentationInputs = [];
      /** @type {Map<string, ViewSymbol>} */
      const keptBySymbolKey = new Map();
      let batchAlreadyIndexed = 0;
      let batchSkipped = 0;
      const containsStartedAt = performance.now();
      /** @type {Map<string, ReturnType<typeof documentationEmbeddingKey>>} */
      const documentationBySymbolKey = new Map();
      const requiredKeys = [];
      for (const symbol of batch) {
        requiredKeys.push({ content_hash: symbol.content_hash, local_id: symbol.local_id });
        const documentation = documentationEmbeddingKey(symbol);
        documentationBySymbolKey.set(symbolKey(symbol), documentation);
        if (documentation) requiredKeys.push(documentation);
      }
      const alreadyIndexedKeys = await embeddingKeysAlreadyIndexed(index, requiredKeys);
      const containsMs = elapsedSince(containsStartedAt);
      currentBatchTiming.containsMs += containsMs;
      timings.containsMs += containsMs;
      for (const s of batch) {
        const codeKey = { content_hash: s.content_hash, local_id: s.local_id };
        const documentation = documentationBySymbolKey.get(symbolKey(s)) || null;
        if (documentation) {
          report.documentationCandidates++;
          if (alreadyIndexedKeys.has(embeddingKeyString(documentation))) {
            report.documentationAlreadyIndexed++;
          }
        }
        const codePresent = alreadyIndexedKeys.has(embeddingKeyString(codeKey));
        const documentationPresent = !documentation
          || alreadyIndexedKeys.has(embeddingKeyString(documentation));
        if (codePresent && documentationPresent) {
          report.alreadyIndexed++;
          batchAlreadyIndexed++;
          continue;
        }
        if (!codePresent) {
          let text = null;
          if (!supportsStructuredSymbols) {
            const textStartedAt = performance.now();
            text = encoder.buildSymbolText(s);
            currentBatchTiming.textBuildMs += elapsedSince(textStartedAt);
            if (!text || text.length === 0) {
              report.skipped++;
              batchSkipped++;
            } else {
              codeInputs.push({ symbol: s, key: codeKey, text });
              keptBySymbolKey.set(symbolKey(s), s);
            }
          } else {
            codeInputs.push({ symbol: s, key: codeKey, text });
            keptBySymbolKey.set(symbolKey(s), s);
          }
        }
        if (documentation && !documentationPresent) {
          documentationInputs.push({ symbol: s, key: documentation, text: documentation.text });
          keptBySymbolKey.set(symbolKey(s), s);
        }
      }
      // Count the WHOLE batch toward per-language progress up front — every
      // symbol is accounted for whether it gets newly encoded below or was
      // already indexed. Otherwise a language whose symbols are all already
      // indexed (the common case on a re-boot) hits the `continue` below and
      // its progress bar sticks at 0/N forever even though there's nothing left
      // to do — which read as "that language never finished, then it jumped to
      // the view/zip merge".
      for (const s of batch) {
        const lang = String(s?.lang || "").trim().toLowerCase() || "unknown";
        languageCurrent.set(lang, (languageCurrent.get(lang) || 0) + 1);
      }
      processed += batch.length;
      const expectedCount = codeInputs.length + documentationInputs.length;
      timings.sourceReadMs += currentBatchTiming.sourceReadMs;
      timings.textBuildMs += currentBatchTiming.textBuildMs;
      currentBatchTiming.symbols = batch.length;
      currentBatchTiming.missing = expectedCount;
      currentBatchTiming.alreadyIndexed = batchAlreadyIndexed;
      currentBatchTiming.skipped = batchSkipped;
      if (expectedCount === 0) {
        currentBatchTiming.totalMs += elapsedSince(batchStartedAt);
        recordEmbeddingForensics("ingest.batch.noop", {
          view_path: viewPathForTelemetry(view),
          batch: batchNumber,
          offset: i,
          batch_size: batch.length,
          already_indexed: batchAlreadyIndexed,
          skipped: batchSkipped,
        });
        emitProgress(true);
        continue;
      }
      // Durable breadcrumb: record the batch about to be encoded BEFORE the
      // expensive encode + atomic keys.db commit, so a crash mid-encode leaves a
      // known (not silent) gap for reconciliation. Cleared after add() commits.
      // Best-effort — never let the breadcrumb break ingest.
      try {
        await index.markEncoding?.(
          [...codeInputs, ...documentationInputs].map((input) => input.key),
          { batch: batchNumber },
        );
      } catch { /* best effort */ }
      const encodeStartedAt = performance.now();
      recordEmbeddingForensics("ingest.batch.encode.start", {
        view_path: viewPathForTelemetry(view),
        batch: batchNumber,
        offset: i,
        supports_structured_symbols: supportsStructuredSymbols,
        expected_count: expectedCount,
        code_count: codeInputs.length,
        documentation_count: documentationInputs.length,
        kept: summarizeSymbols([...keptBySymbolKey.values()]),
        texts: supportsStructuredSymbols
          ? summarizeTexts(documentationInputs.map((input) => input.text))
          : summarizeTexts([
              ...codeInputs.map((input) => String(input.text || "")),
              ...documentationInputs.map((input) => input.text),
            ]),
        encoder: encoderTelemetry(encoder),
      });
      /** @type {Float32Array[]} */
      let codeVectors = [];
      /** @type {Float32Array[]} */
      let documentationVectors = [];
      try {
        if (supportsStructuredSymbols && codeInputs.length > 0) {
          // Structured encoders receive an explicitly blank documentation field:
          // canonical code vectors must not silently absorb JSDoc again.
          codeVectors = await encoder.encodeSymbols(
            codeInputs.map((input) => ({ ...input.symbol, doc: null })),
            signal,
          );
          report.batches++;
        }
        if (supportsStructuredSymbols && documentationInputs.length > 0) {
          documentationVectors = await encodeTexts(documentationInputs.map((input) => input.text));
          report.batches++;
        }
        if (!supportsStructuredSymbols) {
          const vectors = await encodeTexts([
            ...codeInputs.map((input) => String(input.text || "")),
            ...documentationInputs.map((input) => input.text),
          ]);
          codeVectors = vectors.slice(0, codeInputs.length);
          documentationVectors = vectors.slice(codeInputs.length);
          report.batches++;
        }
      } catch (err) {
        recordEmbeddingForensics("ingest.batch.encode.error", {
          view_path: viewPathForTelemetry(view),
          batch: batchNumber,
          offset: i,
          expected_count: expectedCount,
          elapsed_ms: roundMs(elapsedSince(encodeStartedAt)),
          error: errorForTelemetry(err),
        });
        throw err;
      }
      currentBatchTiming.encodeMs += elapsedSince(encodeStartedAt);
      timings.encodeMs += currentBatchTiming.encodeMs;
      recordEmbeddingForensics("ingest.batch.encode.done", {
        view_path: viewPathForTelemetry(view),
        batch: batchNumber,
        offset: i,
        expected_count: expectedCount,
        vector_count: codeVectors.length + documentationVectors.length,
        code_vector_count: codeVectors.length,
        documentation_vector_count: documentationVectors.length,
        elapsed_ms: roundMs(currentBatchTiming.encodeMs),
      });
      if (codeVectors.length !== codeInputs.length || documentationVectors.length !== documentationInputs.length) {
        throw new Error(
          `ingestView: encoder returned ${codeVectors.length + documentationVectors.length} vectors for ${expectedCount} inputs`,
        );
      }
      /** @type {EmbeddingIngest[]} */
      const rows = [];
      for (let k = 0; k < codeInputs.length; k++) {
        rows.push({
          content_hash: codeInputs[k].key.content_hash,
          local_id: codeInputs[k].key.local_id,
          vector: codeVectors[k],
        });
      }
      for (let k = 0; k < documentationInputs.length; k++) {
        rows.push({
          content_hash: documentationInputs[k].key.content_hash,
          local_id: documentationInputs[k].key.local_id,
          vector: documentationVectors[k],
        });
      }
      const indexAddStartedAt = performance.now();
      recordEmbeddingForensics("ingest.batch.index_add.start", {
        view_path: viewPathForTelemetry(view),
        batch: batchNumber,
        offset: i,
        rows: summarizeRows(rows),
        index: indexTelemetry(index),
      });
      try {
        await index.add(rows);
      } catch (err) {
        recordEmbeddingForensics("ingest.batch.index_add.error", {
          view_path: viewPathForTelemetry(view),
          batch: batchNumber,
          offset: i,
          rows: summarizeRows(rows),
          elapsed_ms: roundMs(elapsedSince(indexAddStartedAt)),
          error: errorForTelemetry(err),
        });
        throw err;
      }
      // Batch durably committed to keys.db — clear the in-flight breadcrumb.
      try { await index.clearEncoding?.(); } catch { /* best effort */ }
      currentBatchTiming.indexAddMs += elapsedSince(indexAddStartedAt);
      const indexTiming = getLastAddTiming(index);
      if (indexTiming) currentBatchTiming.indexTiming = indexTiming;
      recordEmbeddingForensics("ingest.batch.index_add.done", {
        view_path: viewPathForTelemetry(view),
        batch: batchNumber,
        offset: i,
        rows: summarizeRows(rows),
        elapsed_ms: roundMs(currentBatchTiming.indexAddMs),
        index_timing: indexTiming,
      });
      timings.indexAddMs += currentBatchTiming.indexAddMs;
      report.indexed += codeInputs.length;
      report.documentationIndexed += documentationInputs.length;
      report.indexedSymbols += keptBySymbolKey.size;
      currentBatchTiming.totalMs += elapsedSince(batchStartedAt);
      emitProgress(true);
    }
  } finally {
    // Reset the per-batch timing scratch on every exit path. Encode now runs on
    // the process-global warm ONNX worker set, so there is no per-ingest pool to
    // tear down here.
    currentBatchTiming = null;
  }

  emitProgress(true);
  // Reached only on full success (a throw/abort skips this and the finally above
  // re-throws), so the in-flight breadcrumb should be clear. Belt-and-suspenders
  // in case the last batch's per-batch clear was missed.
  try { await index.clearEncoding?.(); } catch { /* best effort */ }
  recordEmbeddingForensics("ingest.done", {
    view_path: viewPathForTelemetry(view),
    report,
    timings_ms: timingSnapshot(timings, startedAt),
  });
  return report;
}

function createEmbeddingIngestTimings() {
  return {
    symbolQueryMs: 0,
    filterMs: 0,
    containsMs: 0,
    sourceReadMs: 0,
    textBuildMs: 0,
    encodeMs: 0,
    indexAddMs: 0,
  };
}

function createEmbeddingBatchTimings(batch) {
  return {
    batch,
    symbols: 0,
    missing: 0,
    alreadyIndexed: 0,
    containsMs: 0,
    sourceReadMs: 0,
    textBuildMs: 0,
    encodeMs: 0,
    indexAddMs: 0,
    totalMs: 0,
  };
}

function getLastAddTiming(index) {
  const fn = index && /** @type {any} */ (index).getLastAddTiming;
  if (typeof fn !== "function") return null;
  try {
    return fn.call(index);
  } catch {
    return null;
  }
}

function elapsedSince(startedAt) {
  return Math.max(0, performance.now() - Number(startedAt || performance.now()));
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function timingSnapshot(timings = {}, startedAt = null) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(timings)) {
    if (Array.isArray(value)) {
      out[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.round(value * 10) / 10;
    } else {
      out[key] = value;
    }
  }
  if (startedAt != null) out.elapsedMs = Math.round(elapsedSince(startedAt) * 10) / 10;
  return out;
}

/**
 * @param {EmbeddingIndex} index
 * @param {Array<{ content_hash: string, local_id: number }>} keys
 * @returns {Promise<Set<string>>}
 */
async function embeddingKeysAlreadyIndexed(index, keys) {
  if (typeof index?.containsMany === "function") {
    try {
      const result = await index.containsMany(keys);
      if (result instanceof Set) return result;
      if (Array.isArray(result)) return new Set(result.map(String));
    } catch {
      // Fall back to per-symbol checks below.
    }
  }
  const out = new Set();
  for (const key of keys) {
    if (await embeddingKeyAlreadyIndexed(index, key)) {
      out.add(embeddingKeyString(key));
    }
  }
  return out;
}

async function embeddingKeyAlreadyIndexed(index, key) {
  if (typeof index?.contains !== "function") return false;
  try {
    return !!(await index.contains(key.content_hash, key.local_id));
  } catch {
    return false;
  }
}

function symbolKey(symbol) {
  return `${symbol.content_hash}\0${symbol.local_id}`;
}

function embeddingKeyString(key) {
  return `${key.content_hash}\0${key.local_id}`;
}

function viewPathForTelemetry(view) {
  try {
    const fn = /** @type {any} */ (view)?._dbPath;
    return typeof fn === "function" ? fn.call(view) : null;
  } catch {
    return null;
  }
}

function encoderTelemetry(encoder) {
  return {
    model: encoder?.model || null,
    model_version: encoder?.model_version || null,
    model_name: /** @type {any} */ (encoder)?.modelName || null,
    model_id: /** @type {any} */ (encoder)?.modelId || null,
    dtype: /** @type {any} */ (encoder)?.dtype || null,
    dim: encoder?.dim || null,
    batch_size: /** @type {any} */ (encoder)?.batchSize || null,
  };
}

function indexTelemetry(index) {
  return {
    model: index?.model || null,
    model_version: index?.model_version || null,
    backend: /** @type {any} */ (index)?.backend || null,
    dim: index?.dim || null,
    gate_key: /** @type {any} */ (index)?.gateKey || null,
    async_index: !!/** @type {any} */ (index)?.asyncIndex,
    child_index: !!/** @type {any} */ (index)?.childIndex,
    protected_async_index: !!/** @type {any} */ (index)?.protectedAsyncIndex,
  };
}

/**
 * @param {{ batchSize?: number }} args
 * @returns {number}
 */
export function resolveEmbeddingIngestBatchSize({ batchSize }) {
  if (Number.isInteger(batchSize)) {
    return Math.max(1, Math.min(/** @type {number} */ (batchSize), 512));
  }
  return DEFAULT_BATCH_SIZE;
}
