// @ts-check
//
// Best-effort on-demand embedding fill for WI views. Main warms keep their
// vector index current; WI views default to lazy indexing so ordinary warm jobs
// stay cheap and semantic search pays only for missing symbols.

import { ingestView } from "./ingest.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeSymbols,
} from "./forensics.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */

/** @type {Map<string, Promise<{ skipped: boolean, reason?: string, missing?: number, encoded?: number | null, incomplete?: boolean }>>} */
const IN_FLIGHT_BY_VIEW = new Map();

/**
 * @param {{
 *   view: View,
 *   index: EmbeddingIndex,
 *   encoder: EmbeddingEncoder,
 *   repoRoot?: string,
 *   limit?: number,
 *   timeoutMs?: number,
 * }} args
 * @returns {Promise<{ skipped: boolean, reason?: string, missing?: number, encoded?: number | null, incomplete?: boolean }>}
 */
export async function ensureEmbeddingsForView({
  view,
  index,
  encoder,
  repoRoot,
  limit = 5000,
  timeoutMs = 30000,
}) {
  if (!view || !index || !encoder) {
    return { skipped: true, reason: "unavailable" };
  }
  if (encoder.dim !== index.dim) {
    return { skipped: true, reason: "dim_mismatch" };
  }

  const symbolsLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100_000) : 5000;
  const symbols = view.query.allSymbols({ limit: symbolsLimit });
  const guardKey = inFlightKey({ view, index, encoder });
  const existing = IN_FLIGHT_BY_VIEW.get(guardKey);
  if (existing) {
    recordEmbeddingForensics("on_demand.join_existing", {
      guard_key_hash: hashString(guardKey),
      symbols_limit: symbolsLimit,
    });
    return existing;
  }
  recordEmbeddingForensics("on_demand.start", {
    guard_key_hash: hashString(guardKey),
    symbols_limit: symbolsLimit,
    symbol_count: symbols.length,
    encoder: encoderTelemetry(encoder),
    index: indexTelemetry(index),
  });

  const run = ensureMissingSymbolsEncoded({
    view,
    index,
    encoder,
    repoRoot,
    symbols,
    timeoutMs,
  }).finally(() => {
    if (IN_FLIGHT_BY_VIEW.get(guardKey) === run) IN_FLIGHT_BY_VIEW.delete(guardKey);
  });
  IN_FLIGHT_BY_VIEW.set(guardKey, run);
  return run;
}

/**
 * Deliberate reconciliation pass: close any embedding gap for a view and clear
 * the durable in-flight breadcrumb. Unlike ensureEmbeddingsForView (lazy, small
 * default limit, for WI search), this is the recovery entry point — run it on
 * boot or after a warm reported `incomplete`, or whenever a crash may have left
 * keys.db short. It reuses the same missing-symbols fill, but:
 *   - reads the breadcrumb first, so an interrupted encode is a KNOWN signal
 *     (not inferred), surfaced in the result + forensics;
 *   - defaults to the full symbol limit (not the 5k on-demand cap);
 *   - clears the breadcrumb once the gap is filled.
 * The ANN (index.usearch) rebuilds from keys.db on load, so this only needs to
 * make keys.db whole — a subsequent rebuild is then complete, not silently gappy.
 *
 * @param {{
 *   view: View, index: EmbeddingIndex, encoder: EmbeddingEncoder,
 *   repoRoot?: string, limit?: number, timeoutMs?: number,
 * }} args
 * @returns {Promise<{ skipped: boolean, reason?: string, missing?: number, encoded?: number | null, incomplete?: boolean, hadInterruptedBatch: boolean, interruptedKeys: number }>}
 */
export async function reconcileEmbeddings({ view, index, encoder, repoRoot, limit = 100_000, timeoutMs = 120_000 }) {
  // Awaited because the production (child-process) index returns promises;
  // the in-process index returns plain values and awaits through unchanged.
  const inflight = typeof index?.readInflight === "function" ? await index.readInflight() : null;
  const hadInterruptedBatch = !!inflight;
  const interruptedKeys = Array.isArray(inflight?.keys) ? inflight.keys.length : 0;
  if (hadInterruptedBatch) {
    recordEmbeddingForensics("reconcile.interrupted_batch", {
      started_at: inflight?.started_at ?? null,
      branch: inflight?.branch ?? null,
      batch: inflight?.batch ?? null,
      interrupted_keys: interruptedKeys,
      encoder: encoderTelemetry(encoder),
      index: indexTelemetry(index),
    });
  }
  const res = await ensureEmbeddingsForView({ view, index, encoder, repoRoot, limit, timeoutMs });
  // The gap (if any) is filled; the interrupted batch's keys were re-checked by
  // missingSymbols and re-encoded if absent. Safe to drop the breadcrumb — but
  // only if we didn't bail out incomplete (else keep it as a recovery signal).
  if (!res.incomplete && typeof index?.clearEncoding === "function") {
    await index.clearEncoding();
  }
  return { ...res, hadInterruptedBatch, interruptedKeys };
}

/**
 * @param {{
 *   view: View,
 *   index: EmbeddingIndex,
 *   encoder: EmbeddingEncoder,
 *   repoRoot?: string,
 *   symbols: ViewSymbol[],
 *   timeoutMs?: number,
 * }} args
 * @returns {Promise<{ skipped: boolean, reason?: string, missing?: number, encoded?: number | null, incomplete?: boolean }>}
 */
async function ensureMissingSymbolsEncoded({ view, index, encoder, repoRoot, symbols, timeoutMs }) {
  const missing = await missingSymbols({ index, symbols });
  if (missing.length === 0) {
    recordEmbeddingForensics("on_demand.fully_indexed", {
      symbol_count: symbols.length,
      encoder: encoderTelemetry(encoder),
      index: indexTelemetry(index),
    });
    return { skipped: true, reason: "fully_indexed", missing: 0 };
  }
  recordEmbeddingForensics("on_demand.missing", {
    symbol_count: symbols.length,
    missing_count: missing.length,
    missing: summarizeSymbols(missing.slice(0, 128)),
    encoder: encoderTelemetry(encoder),
    index: indexTelemetry(index),
  });
  return encodeMissingSymbols({ view, index, encoder, repoRoot, missing, timeoutMs });
}

/**
 * @param {{
 *   view: View,
 *   index: EmbeddingIndex,
 *   encoder: EmbeddingEncoder,
 *   repoRoot?: string,
 *   missing: ViewSymbol[],
 *   timeoutMs?: number,
 * }} args
 * @returns {Promise<{ skipped: boolean, reason?: string, missing?: number, encoded?: number | null, incomplete?: boolean }>}
 */
async function encodeMissingSymbols({ view, index, encoder, repoRoot, missing, timeoutMs }) {
  const controller = new AbortController();
  const timeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.max(1, Math.floor(Number(timeoutMs)))
    : 30000;
  const timer = setTimeout(() => controller.abort(new Error("on_demand_timeout")), timeout);
  try {
    recordEmbeddingForensics("on_demand.encode.start", {
      missing_count: missing.length,
      timeout_ms: timeout,
      missing: summarizeSymbols(missing.slice(0, 128)),
      encoder: encoderTelemetry(encoder),
      index: indexTelemetry(index),
    });
    const result = await ingestView({
      view,
      index,
      encoder,
      repoRoot,
      signal: controller.signal,
      onlySymbols: missing,
      limit: missing.length,
    });
    recordEmbeddingForensics("on_demand.encode.done", {
      missing_count: missing.length,
      indexed: result.indexed,
      report: result,
    });
    return { skipped: false, missing: missing.length, encoded: result.indexed };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const reason = aborted
      ? "on_demand_timeout"
      : String(err?.code || err?.message || err || "encode_error");
    recordEmbeddingForensics("on_demand.encode.error", {
      missing_count: missing.length,
      timeout_ms: timeout,
      aborted,
      reason,
      error: errorForTelemetry(err),
    });
    return {
      skipped: false,
      reason,
      missing: missing.length,
      encoded: null,
      incomplete: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ view: View, index: EmbeddingIndex, encoder: EmbeddingEncoder }}
 */
function inFlightKey({ view, index, encoder }) {
  const viewKey = typeof /** @type {any} */ (view)._dbPath === "function"
    ? /** @type {any} */ (view)._dbPath()
    : fallbackViewKey(view);
  const model = String(index?.model || encoder?.model || "unknown");
  const modelVersion = String(index?.model_version || encoder?.model_version || "unknown");
  return `${viewKey}\0${model}\0${modelVersion}\0${index.dim}`;
}

/**
 * @param {View} view
 */
function fallbackViewKey(view) {
  try {
    const meta = typeof view?.meta === "function" ? view.meta() : null;
    return `view:${meta?.branch || "unknown"}:${meta?.ledger_seq ?? "unknown"}`;
  } catch {
    return "view:unknown:unknown";
  }
}

/**
 * @param {{ index: EmbeddingIndex, symbols: ViewSymbol[] }} args
 * @returns {Promise<ViewSymbol[]>}
 */
async function missingSymbols({ index, symbols }) {
  if (typeof index?.containsMany === "function") {
    const keys = [];
    const candidates = [];
    for (const symbol of symbols) {
      if (!symbol?.content_hash || !Number.isInteger(symbol.local_id)) {
        continue;
      }
      keys.push({ content_hash: symbol.content_hash, local_id: symbol.local_id });
      candidates.push(symbol);
    }
    try {
      const result = await index.containsMany(keys);
      const present = result instanceof Set
        ? result
        : Array.isArray(result)
          ? new Set(result.map(String))
          : new Set();
      return candidates.filter((symbol) => !present.has(symbolKey(symbol)));
    } catch {
      // Fall back to per-symbol checks below.
    }
  }
  if (typeof index?.contains !== "function") {
    return symbols.slice();
  }
  /** @type {ViewSymbol[]} */
  const missing = [];
  for (const symbol of symbols) {
    if (!symbol?.content_hash || !Number.isInteger(symbol.local_id)) {
      continue;
    }
    let present = false;
    try {
      present = !!(await index.contains(symbol.content_hash, symbol.local_id));
    } catch {
      present = false;
    }
    if (!present) missing.push(symbol);
  }
  return missing;
}

/**
 * @param {ViewSymbol} symbol
 * @returns {string}
 */
function symbolKey(symbol) {
  return `${symbol.content_hash}\0${symbol.local_id}`;
}

function encoderTelemetry(encoder) {
  return {
    model: encoder?.model || null,
    model_version: encoder?.model_version || null,
    dim: encoder?.dim || null,
    model_name: /** @type {any} */ (encoder)?.modelName || null,
    model_id: /** @type {any} */ (encoder)?.modelId || null,
    dtype: /** @type {any} */ (encoder)?.dtype || null,
  };
}

function indexTelemetry(index) {
  return {
    model: index?.model || null,
    model_version: index?.model_version || null,
    dim: index?.dim || null,
    backend: /** @type {any} */ (index)?.backend || null,
    gate_key: /** @type {any} */ (index)?.gateKey || null,
    async_index: !!/** @type {any} */ (index)?.asyncIndex,
    child_index: !!/** @type {any} */ (index)?.childIndex,
    protected_async_index: !!/** @type {any} */ (index)?.protectedAsyncIndex,
  };
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}
