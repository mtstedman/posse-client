// @ts-check
//
// Ranking utilities for retrieval handlers. Pluggable so that semantic
// reranking (Workstream H) can layer on top without changing the
// dispatch surface.

import { tokenizeForRanking } from "./orchestrator/tokens.js";
import { isExplicitLiteralSymbolQuery, symbolRankPenalty } from "./hygiene.js";
import { runAtlasNativeOperation } from "../native/invoke.js";
import { nativeBinaries } from "../../../../../classes/tools/BinaryManager.js";

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
  if (nativeBinaries.shouldUse("atlas")) {
    return /** @type {number} */ (runAtlasNativeOperation({ op: "lexical_score", query, symbol: sym }));
  }
  return lexicalScoreNode(query, sym);
}

/** @param {string} query @param {ViewSymbol} sym @returns {number} */
function lexicalScoreNode(query, sym) {
  if (!query) return 0;
  const rawQuery = String(query || "").trim();
  const q = rawQuery.toLowerCase();
  const name = sym.name || "";
  const nameLower = name.toLowerCase();
  if (name === rawQuery) return 1;
  if (nameLower === q) return 0.9;
  if (isIdentifierLike(rawQuery) && nameLower.startsWith(q)) return 0.85;
  if (isIdentifierLike(rawQuery) && nameLower.includes(q)) return 0.6;
  const qn = (sym.qualified_name || "").toLowerCase();
  if (isIdentifierLike(rawQuery) && qn.includes(q)) return 0.4;

  const queryTokens = uniqueTokens(rawQuery);
  if (queryTokens.length === 0) return 0.1;
  const nameTokens = uniqueTokens(sym.name || "");
  const qualifiedTokens = uniqueTokens(sym.qualified_name || "");
  const pathTokens = uniqueTokens(sym.repo_rel_path || "");
  const bodyTokens = uniqueTokens(/** @type {any} */ (sym).body_identifiers || "");
  const nameOverlap = overlapRatio(queryTokens, nameTokens);
  const qualifiedOverlap = overlapRatio(queryTokens, qualifiedTokens);
  const pathOverlap = overlapRatio(queryTokens, pathTokens);
  const bodyOverlap = overlapRatio(queryTokens, bodyTokens);
  const directPrefix = nameTokens.some((token) => queryTokens.some((qToken) => token.startsWith(qToken)));
  const score =
    0.1 +
    nameOverlap * 0.55 +
    qualifiedOverlap * 0.25 +
    pathOverlap * 0.15 +
    bodyOverlap * 0.28 +
    (directPrefix ? 0.08 : 0);
  return Math.max(0.1, Math.min(0.86, score));
}

/**
 * Order a list of symbols by lexical score descending, then by name.
 *
 * @param {string} query
 * @param {ViewSymbol[]} symbols
 * @returns {Array<ViewSymbol & { __score: number }>}
 */
export function rankSymbols(query, symbols) {
  if (nativeBinaries.shouldUse("atlas")) {
    return /** @type {any} */ (runAtlasNativeOperation({ op: "rank_symbols", query, symbols }));
  }
  return rankSymbolsNode(query, symbols);
}

/** @param {string} query @param {ViewSymbol[]} symbols */
function rankSymbolsNode(query, symbols) {
  const scored = symbols.map((s) => {
    const __rawScore = lexicalScore(query, s);
    const explicitLiteral = isExplicitLiteralSymbolQuery(query, s);
    const __penalty = explicitLiteral ? 0 : symbolRankPenalty(s);
    if (explicitLiteral) return { ...s, __score: 1.05, __penalty };
    return { ...s, __score: Math.max(0.01, __rawScore - (__penalty * 0.08)), __penalty };
  });
  scored.sort((a, b) => {
    if (b.__score !== a.__score) return b.__score - a.__score;
    if (a.__penalty !== b.__penalty) return a.__penalty - b.__penalty;
    return a.name.localeCompare(b.name);
  });
  return scored;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isIdentifierLike(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z_$][A-Za-z0-9_$:.#/-]*$/.test(text) && !/\s/.test(text);
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function uniqueTokens(value) {
  return [...new Set(tokenizeForRanking(value))];
}

/**
 * @param {string[]} queryTokens
 * @param {string[]} symbolTokens
 * @returns {number}
 */
function overlapRatio(queryTokens, symbolTokens) {
  if (queryTokens.length === 0 || symbolTokens.length === 0) return 0;
  const symbolSet = new Set(symbolTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (symbolSet.has(token)) overlap += 1;
  }
  return overlap / Math.max(1, Math.min(queryTokens.length, symbolTokens.length));
}
