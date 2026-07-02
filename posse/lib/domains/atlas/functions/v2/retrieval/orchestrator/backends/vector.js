// @ts-check
//
// Vector / semantic backend. Wraps semanticSearch and emits a ranked
// list aligned to RRF's interface. Async because encoder.encode is
// async; the orchestrator awaits it when present and skips it when not.

/** @typedef {import("../../../contracts/api.js").View} View */
/** @typedef {import("../../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../../../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../../../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */

import { symbolIdOf } from "../../cards.js";
import { semanticSearch } from "../../../embeddings/search.js";
import { toRanked } from "../rrf.js";

/**
 * @typedef {Object} VectorBackendResult
 * @property {boolean} ok
 * @property {ReturnType<typeof toRanked<ViewSymbol>>} entries
 * @property {ViewSymbol[]} raw
 * @property {number} total
 * @property {string} [reason]   "unavailable" | "dim_mismatch" | "index_empty" | "encode_error"
 */

/**
 * @param {{
 *   view: View,
 *   query: string,
 *   limit: number,
 *   embeddingIndex?: EmbeddingIndex,
 *   encoder?: EmbeddingEncoder,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<VectorBackendResult>}
 */
export async function runVectorBackend({ view, query, limit, embeddingIndex, encoder, signal }) {
  if (!embeddingIndex || !encoder) {
    return { ok: false, entries: [], raw: [], total: 0, reason: "unavailable" };
  }
  if (encoder.dim !== embeddingIndex.dim) {
    return { ok: false, entries: [], raw: [], total: 0, reason: "dim_mismatch" };
  }
  try {
    const hits = await semanticSearch({
      query,
      view,
      index: embeddingIndex,
      encoder,
      k: Math.max(limit * 2, limit),
      signal,
    });
    const symbols = hits.map((h) => h.symbol);
    if (symbols.length === 0) {
      // Distinguish "ran and legitimately found nothing" from real
      // unavailability: only a knowably-empty index is a degradation signal.
      // Reporting empty results as ok:false used to flip meta.semantic to
      // unavailable and emit a misleading fell-back-to-lexical warning.
      const indexSize = Number(/** @type {any} */ (embeddingIndex)?.size ?? NaN);
      if (indexSize === 0) {
        return { ok: false, entries: [], raw: [], total: 0, reason: "index_empty" };
      }
      return { ok: true, entries: [], raw: [], total: 0 };
    }
    return {
      ok: true,
      entries: toRanked(symbols, (s) => symbolIdOf(s)),
      raw: symbols,
      total: symbols.length,
    };
  } catch {
    return { ok: false, entries: [], raw: [], total: 0, reason: "encode_error" };
  }
}
