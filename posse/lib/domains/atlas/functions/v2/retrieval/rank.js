// @ts-check
//
// Ranking utilities for retrieval handlers. Pluggable so that semantic
// reranking (Workstream H) can layer on top without changing the
// dispatch surface.
//
// Scoring and ordering are owned by the native posse-atlas binary; these
// wrappers are the only path (the Node implementations were deleted at
// cutover).

import { runAtlasNativeOperation } from "../native/invoke.js";

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */

/**
 * Score a symbol for relevance to a query. Pure-string heuristic:
 *   - exact name match: 1.0
 *   - case-insensitive equal: 0.9
 *   - prefix match: 0.85
 *   - substring match in name: 0.6
 *   - substring match in qualified_name: 0.4
 *   - otherwise: 0.0
 *
 * Used to give symbol.search results a default score field even when
 * FTS doesn't expose one.
 *
 * @param {string} query
 * @param {ViewSymbol} sym
 * @returns {number}
 */
export function lexicalScore(query, sym) {
  return /** @type {number} */ (runAtlasNativeOperation({ op: "lexical_score", query, symbol: sym }));
}

/**
 * Order a list of symbols by lexical score descending, then by name.
 *
 * @param {string} query
 * @param {ViewSymbol[]} symbols
 * @returns {Array<ViewSymbol & { __score: number }>}
 */
export function rankSymbols(query, symbols) {
  return /** @type {any} */ (runAtlasNativeOperation({ op: "rank_symbols", query, symbols }));
}
