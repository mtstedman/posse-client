// @ts-check

import { runAtlasNativeMethodAsync } from "./invoke.js";

const CONTRACT_VERSION = 1;
const UNIT_QUERIES = new Set(["meta", "stats", "edge_stats", "symbol_metrics", "edge_taxonomy_input"]);
const RESULT_BY_QUERY = Object.freeze({
  meta: "meta",
  stats: "stats",
  edge_stats: "edge_stats",
  symbol_metrics: "symbol_metrics",
  edge_taxonomy_input: "edge_taxonomy_input",
  find_symbol: "symbols",
  get_symbol: "symbol",
  symbols_in_file: "symbols",
  callers: "edges",
  callees: "edges",
  unresolved_references_to: "edges",
  slice: "slice",
  blast_radius: "ranked_symbols",
  get_by_content_local: "symbol",
  has_content_hash: "boolean",
  content_hash_for_path: "string",
  has_snapshot_content_hash: "boolean",
  indexed_paths: "paths",
  all_symbols: "symbols",
});

/**
 * Execute one bounded Rust-owned view read through the persistent worker and
 * return its tagged result value. Node intentionally does not inspect or
 * query the SQLite database here.
 *
 * @param {string} viewPath
 * @param {string} query
 * @param {Record<string, unknown>} [params]
 * @returns {Promise<any>}
 */
export async function runNativeViewRead(viewPath, query, params = {}) {
  const response = /** @type {any} */ (await runAtlasNativeMethodAsync("view-read", {
    contract_version: CONTRACT_VERSION,
    view_path: viewPath,
    query,
    ...(!UNIT_QUERIES.has(query) ? { params } : {}),
  }));
  if (!response || response.contract_version !== CONTRACT_VERSION || typeof response.result !== "string") {
    throw new Error(`ATLAS view-read returned an invalid ${query} contract`);
  }
  if (RESULT_BY_QUERY[query] !== response.result || typeof response.truncated !== "boolean") {
    throw new Error(`ATLAS view-read returned ${response.result} for ${query}`);
  }
  return response;
}

/** @param {Array<{ symbol: any, score: number }>} entries @param {string} property */
export function restoreRankedSymbols(entries, property) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const symbol = entry?.symbol;
    if (!symbol || typeof symbol !== "object") return null;
    Object.defineProperty(symbol, property, {
      value: Number(entry.score) || 0,
      enumerable: false,
      configurable: true,
    });
    return symbol;
  }).filter(Boolean);
}
