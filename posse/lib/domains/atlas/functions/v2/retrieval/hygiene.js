// @ts-check
//
// Data-quality helpers for retrieval presentation. These functions keep noisy
// but still useful indexed rows out of default agent-facing surfaces without
// deleting them from the underlying view.

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */

import { isGeneratedPath } from "../path-hygiene.js";

const LOCAL_NAME_RE = /^local(?:[- ]\d+|\d+)$/i;
const QUOTED_LITERAL_RE = /^(['"`]).*\1$/;
const ROUTE_LITERAL_RE = /^['"`]\/.*['"`]$/;
const TEMP_PROP_RE = /^(?:className|children|value|checked|disabled|href|id|name|path|params|queryClient|search|style|title|to)\d+$/;

export { isGeneratedPath };

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isLiteralSymbolName(name) {
  const text = String(name || "").trim();
  return QUOTED_LITERAL_RE.test(text) || ROUTE_LITERAL_RE.test(text);
}

/**
 * @param {ViewSymbol} symbol
 * @returns {boolean}
 */
export function isNoisyLocalSymbol(symbol) {
  const name = String(symbol?.name || "").trim();
  if (!name) return true;
  if (LOCAL_NAME_RE.test(name)) return true;
  if (isLiteralSymbolName(name)) return true;
  return symbol.lang === "ts" && symbol.kind === "var" && TEMP_PROP_RE.test(name);
}

/**
 * Default symbol visibility for search, slices, hotspots, and summaries.
 * Explicit symbolId lookups still work; this only filters discovery surfaces.
 *
 * @param {ViewSymbol} symbol
 * @returns {boolean}
 */
export function isDefaultVisibleSymbol(symbol) {
  return !!symbol && !isNoisyLocalSymbol(symbol);
}

/**
 * Allow an explicitly quoted/string-literal query to retrieve the matching
 * literal symbol while keeping those rows hidden from ordinary discovery.
 *
 * @param {string} query
 * @param {ViewSymbol | { name?: string }} symbol
 * @returns {boolean}
 */
export function isExplicitLiteralSymbolQuery(query, symbol) {
  const q = normalizeLiteralName(String(query || ""));
  const name = normalizeLiteralName(String(symbol?.name || ""));
  return q.length > 0 && q === name && isLiteralSymbolName(String(symbol?.name || ""));
}

/**
 * Stable dedupe key for repeated generated/literal symbols.
 *
 * @param {ViewSymbol | { name?: string, kind?: string, lang?: string, location?: { repo_rel_path?: string }, repo_rel_path?: string }} symbol
 * @returns {string}
 */
export function visibleSymbolDedupeKey(symbol) {
  const path = /** @type {any} */ (symbol).repo_rel_path || /** @type {any} */ (symbol).location?.repo_rel_path || "";
  return [
    String(path),
    String(/** @type {any} */ (symbol).kind || ""),
    normalizeLiteralName(String(/** @type {any} */ (symbol).name || "")),
  ].join("\0");
}

/**
 * @param {ViewSymbol} symbol
 * @param {{ exactPathHit?: boolean }} [opts]
 * @returns {number}
 */
export function symbolRankPenalty(symbol, opts = {}) {
  let penalty = 0;
  if (isNoisyLocalSymbol(symbol)) penalty += 3;
  if (!opts.exactPathHit && isGeneratedPath(symbol.repo_rel_path)) penalty += 1.25;
  if (isLiteralSymbolName(symbol.name)) penalty += 0.75;
  return penalty;
}

/**
 * @param {ViewSymbol} symbol
 * @returns {number}
 */
export function pathSymbolPriority(symbol) {
  if (!isDefaultVisibleSymbol(symbol)) return 100;
  if (symbol.visibility === "private") return 30;
  switch (symbol.kind) {
    case "class": return 0;
    case "interface": return 1;
    case "function": return 2;
    case "method": return 3;
    case "type": return 4;
    case "namespace": return 5;
    case "module": return 20;
    case "const": return isLiteralSymbolName(symbol.name) ? 25 : 8;
    case "var": return 12;
    default: return 10;
  }
}

/**
 * @param {string} name
 * @returns {string}
 */
export function normalizeLiteralName(name) {
  return String(name || "").trim().replace(/^(['"`])(.*)\1$/, "$2").toLowerCase();
}
