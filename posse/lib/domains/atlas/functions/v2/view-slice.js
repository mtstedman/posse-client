// @ts-check
//
// Compatibility adapters for Rust-owned view graph results. SQLite traversal,
// ranking, limits, and deterministic ordering live in atlas_storage queries.

import { restoreRankedSymbols } from "./native/view-read.js";

/**
 * @param {{ symbols?: Array<{ symbol: any, score: number }>, frontier?: any[] }} value
 */
export function hydrateNativeSlice(value) {
  return {
    symbols: restoreRankedSymbols(value?.symbols || [], "_sliceImpact"),
    frontier: Array.isArray(value?.frontier) ? value.frontier : [],
  };
}

/**
 * @param {Array<{ symbol: any, score: number }>} value
 */
export function hydrateNativeBlastRadius(value) {
  return restoreRankedSymbols(value, "_impact");
}
