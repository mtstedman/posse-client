// @ts-check
//
// Reciprocal Rank Fusion. Each backend produces a ranked list of items;
// we fuse them into a single ranking with score = sum(1 / (k + rank_i))
// across all backends that placed the item.
//
// Why RRF rather than score-normalizing and adding: backends produce
// scores on incompatible scales (FTS rank vs cosine similarity). RRF
// only uses rank position, which is uniformly comparable.

import { runAtlasNativeOperation } from "../../native/invoke.js";

/**
 * The k constant. 60 matches atlas-mcp and the original Cormack et al.
 * paper; tuning it across our corpus is future work.
 */
export const RRF_K = 60;

/**
 * Each entry in a ranked list — a stable identifier plus its 1-based
 * rank position within the list. We carry an arbitrary `payload` so the
 * fuser doesn't need to know what the item is (ViewSymbol, SymbolHit,
 * etc.).
 *
 * @template P
 * @typedef {Object} RankedEntry
 * @property {string} id
 * @property {number} rank             1-based.
 * @property {P} payload
 */

/**
 * @template P
 * @typedef {Object} FusedEntry
 * @property {string} id
 * @property {number} score            Sum of 1/(k+rank) across contributing backends.
 * @property {P} payload
 * @property {Record<string, number>} contributions  Per-backend rank (1-based) for debugging.
 */

/**
 * Convert one backend's ordered list into RankedEntry[]. The id function
 * pulls a stable identifier from each payload.
 *
 * @template P
 * @param {P[]} items
 * @param {(p: P) => string} idOf
 * @returns {RankedEntry<P>[]}
 */
export function toRanked(items, idOf) {
  /** @type {RankedEntry<P>[]} */
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const id = idOf(items[i]);
    if (!id) continue;
    out.push({ id, rank: i + 1, payload: items[i] });
  }
  return out;
}

/**
 * Fuse N ranked lists with RRF.
 *
 * Inputs are a map from backend name → ranked entries. The backend name
 * is preserved on each fused entry's `contributions` for telemetry. If
 * two backends produce a payload for the same id, the first backend's
 * payload wins on the fused result — the assumption is that all backends
 * agree on the underlying entity (they're all looking at the same view).
 *
 * @template P
 * @param {Record<string, RankedEntry<P>[]>} listsByBackend
 * @param {{ k?: number }} [opts]
 * @returns {FusedEntry<P>[]}
 */
export function rrfFuse(listsByBackend, opts) {
  // Fusion is owned by the native posse-atlas binary — the only path.
  const k = typeof opts?.k === "number" && opts.k > 0 ? opts.k : RRF_K;
  return /** @type {any} */ (runAtlasNativeOperation({ op: "rrf_fuse", lists_by_backend: listsByBackend, k }));
}
