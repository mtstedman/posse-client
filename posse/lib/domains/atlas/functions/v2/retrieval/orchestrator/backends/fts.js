// @ts-check
//
// Lexical FTS backend. Wraps View.query.findSymbol and emits one ranked
// list. We oversample (limit * 2) so RRF has room to find consensus
// hits before the orchestrator trims to the caller's requested limit.
//
// Probe ordering is driven by a QueryPlan: identifiers first (exact-name
// hits dominate), then file/path hints, then keyword combinations. The
// raw query is only added as a final lexical fallback when the plan
// didn't yield enough probes — the previous "whole sentence as FTS
// phrase" path is gone because it almost never matched.

/** @typedef {import("../../../contracts/api.js").View} View */
/** @typedef {import("../../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../query-planner-types.js").QueryPlan} QueryPlan */

import { symbolIdOf } from "../../cards.js";
import { rankSymbols } from "../../rank.js";
import { isDefaultVisibleSymbol, isExplicitLiteralSymbolQuery, isLiteralSymbolName, pathSymbolPriority } from "../../hygiene.js";
import { toRanked } from "../rrf.js";
import { planQuery } from "../query-planner.js";
import { isCanonicalRepoPath } from "../../../paths.js";

/**
 * @typedef {Object} FtsBackendResult
 * @property {boolean} ok
 * @property {ReturnType<typeof toRanked<ViewSymbol>>} entries
 * @property {ViewSymbol[]} raw
 * @property {number} total
 * @property {string} [reason]   Set when ok=false; one of "unavailable" | "query_error".
 * @property {QueryPlan} [plan]  Plan actually used for probing — included so the orchestrator can pass it on without re-planning.
 */

/**
 * @param {{ view: View, query: string, limit: number, plan?: QueryPlan, scope?: "name" | "body" | "either" }} args
 * @returns {FtsBackendResult}
 */
export function runFtsBackend({ view, query, limit, plan, scope = "either" }) {
  if (!view || !view.query || typeof view.query.findSymbol !== "function") {
    return { ok: false, entries: [], raw: [], total: 0, reason: "unavailable" };
  }
  if (typeof query !== "string" || query.length === 0) {
    return { ok: false, entries: [], raw: [], total: 0, reason: "query_error" };
  }
  const usedPlan = plan ?? planQuery(query);
  try {
    const raw = collectFtsHits({ view, query, limit, plan: usedPlan, scope });
    // Lexical rerank — FTS returns rows in MATCH-rank order, but we want
    // identifier-exact hits first so the fused ranking favors them.
    const ranked = rankSymbols(query, raw);
    return {
      ok: true,
      entries: toRanked(ranked, (s) => symbolIdOf(s)),
      raw: ranked,
      total: raw.length,
      plan: usedPlan,
    };
  } catch {
    return { ok: false, entries: [], raw: [], total: 0, reason: "query_error", plan: usedPlan };
  }
}

/**
 * @param {{ view: View, query: string, limit: number, plan: QueryPlan, scope: "name" | "body" | "either" }} args
 * @returns {ViewSymbol[]}
 */
function collectFtsHits({ view, query, limit, plan, scope }) {
  const probes = buildProbes(query, plan);
  const cap = Math.max(limit * 2, limit);
  /** @type {ViewSymbol[]} */
  const out = [];
  const seen = new Set();

  // If the query planner found an exact indexed file path, use that file's
  // own symbols before falling back to filename FTS. This keeps generated
  // route constants from outranking the code in the file the user named.
  for (const repoPath of plan.paths || []) {
    if (scope === "body") continue;
    if (typeof view.query.symbolsInFile !== "function") continue;
    if (!isCanonicalRepoPath(repoPath)) continue;
    let rows;
    try {
      rows = view.query.symbolsInFile(repoPath);
    } catch {
      continue;
    }
    rows = rows
      .filter((row) => isSearchVisibleSymbol(query, row))
      .sort((a, b) => pathSymbolPriority(a) - pathSymbolPriority(b) || a.range_start - b.range_start || a.name.localeCompare(b.name));
    for (const row of rows) {
      const id = symbolIdOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      if (out.length >= cap) return out;
    }
  }

  // Identifier-exact probes go first. Exact lookups skip the FTS prefix
  // grammar entirely so a one-token PascalCase query like "Greeter"
  // returns Greeter as the first hit regardless of FTS5 ranking.
  if (scope !== "body") {
    for (const ident of plan.identifiers) {
      const rows = view.query.findSymbol(ident, { limit: cap, fuzzy: false, scope });
      for (const row of rows) {
        if (!isSearchVisibleSymbol(query, row)) continue;
        const id = symbolIdOf(row);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(row);
        if (out.length >= cap) return out;
      }
    }
  }

  // Then fuzzy/prefix probes from the plan + raw fallback.
  for (const ftsQuery of probes) {
    const rows = view.query.findSymbol(ftsQuery, { limit: cap, fuzzy: true, scope });
    for (const row of rows) {
      if (!isSearchVisibleSymbol(query, row)) continue;
      const id = symbolIdOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * @param {string} query
 * @param {ViewSymbol} symbol
 */
function isSearchVisibleSymbol(query, symbol) {
  return isDefaultVisibleSymbol(symbol) || isExplicitLiteralSymbolQuery(query, symbol);
}

/**
 * Assemble the prefix-search probe list from a QueryPlan. Identifiers
 * still appear here (in addition to the exact-lookup pass above) because
 * the FTS5 index also catches partial matches like "Greet*" hitting
 * "Greeter" and "GreeterImpl".
 *
 * Path hints become file-name probes — the FTS5 index is over symbol
 * names, not paths, but the file's bare name (e.g. "greeter.ts" → search
 * "greeter") commonly aligns with the lead symbol in the file.
 *
 * @param {string} query
 * @param {QueryPlan} plan
 * @returns {string[]}
 */
function buildProbes(query, plan) {
  /** @type {Set<string>} */
  const out = new Set();
  const push = (term) => {
    if (!term) return;
    const trimmed = String(term).trim();
    if (!trimmed) return;
    if (trimmed.length < 2) return;
    out.add(trimmed);
  };

  // Identifier hits via fuzzy/prefix too.
  for (const ident of plan.identifiers) push(ident);

  // File-name based probes: drop extension, also probe the stem broken
  // by separators ("user-service.ts" → "user", "service").
  for (const fname of plan.fileNames) {
    const dot = fname.lastIndexOf(".");
    const stem = dot > 0 ? fname.slice(0, dot) : fname;
    push(stem);
    for (const piece of stem.split(/[-_.]/)) {
      if (piece.length >= 3) push(piece);
    }
  }

  // Stack-frame function names (already covered by identifiers when
  // they look code-like, but stack `at fn ...` can yield names that
  // didn't survive the identifier shape filter).
  for (const frame of plan.stackFrames) {
    if (frame.fn && frame.fn.length >= 2 && !frame.fn.startsWith("<")) {
      push(frame.fn);
      // Pull off the trailing method when the frame is qualified.
      const dot = frame.fn.lastIndexOf(".");
      if (dot > 0) {
        push(frame.fn.slice(dot + 1));
        push(frame.fn.slice(0, dot));
      }
    }
  }

  // Keyword combinations: pair the top keywords so FTS5 can match symbol
  // names that include two of them. Singletons come after the pairs so
  // they only run when the combined probe finds nothing new.
  const kws = plan.keywords.filter((k) => k.length >= 3);
  if (kws.length >= 2) push(kws.slice(0, Math.min(4, kws.length)).join(" "));
  for (const kw of kws) push(kw);

  // Bare-identifier queries are added as a single-shot exact probe up
  // top; the lookup pass handles them. Sentence-shaped raw inputs are
  // intentionally NOT added as FTS phrases — that was the brittle path
  // we replaced.
  if (plan.identifierLike) push(plan.raw);
  if (isLiteralSymbolName(query)) push(query);

  return [...out];
}
