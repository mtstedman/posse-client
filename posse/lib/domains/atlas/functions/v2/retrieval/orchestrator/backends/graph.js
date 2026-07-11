// @ts-check
//
// Graph retrieval backend. Seeds from exact query-plan identifiers, expands
// through the view's slice API, and returns ranked symbols for RRF fusion.

import { symbolIdOf } from "../../cards.js";
import { toRanked } from "../rrf.js";

/** @typedef {import("../../../contracts/api.js").View} View */
/** @typedef {import("../../../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../query-planner-types.js").QueryPlan} QueryPlan */

const GRAPH_EDGE_KINDS = Object.freeze([
  "calls",
  "references",
  "imports",
  "extends",
  "implements",
  "uses_type",
]);

/**
 * @param {{ view: View, limit: number, plan: QueryPlan }} args
 * @returns {Promise<{ ok: boolean, entries: ReturnType<typeof toRanked<ViewSymbol>>, raw: ViewSymbol[], total: number, reason?: string }>}
 */
export async function runGraphBackend({ view, limit, plan }) {
  try {
    if (!view?.query?.findSymbol) {
      return { ok: false, entries: [], raw: [], total: 0, reason: "unavailable" };
    }
    const identifiers = graphSeedIdentifiers(plan);
    if (!plan?.raw && identifiers.length === 0) {
      return { ok: false, entries: [], raw: [], total: 0, reason: "query_error" };
    }
    if (identifiers.length === 0) {
      return { ok: true, entries: [], raw: [], total: 0 };
    }
    const seeds = await collectSeedSymbols(view, identifiers, Math.max(1, Math.min(limit, 20)));
    if (seeds.length === 0) {
      return { ok: true, entries: [], raw: [], total: 0 };
    }
    const seedIds = uniqueNumbers(seeds.map((symbol) => symbol.global_id));
    const maxSymbols = Math.max(limit * 3, limit, seedIds.length);
    const slice = view.query.sliceWithMetadata
      ? (await view.query.sliceWithMetadata(seedIds, {
          depth: 2,
          maxSymbols,
          minConfidence: 0.5,
          edgeKinds: GRAPH_EDGE_KINDS,
        })).symbols
      : view.query.slice
        ? await view.query.slice(seedIds, {
            depth: 2,
            maxSymbols,
            minConfidence: 0.5,
            edgeKinds: GRAPH_EDGE_KINDS,
          })
        : null;
    if (!slice) {
      return { ok: false, entries: [], raw: [], total: 0, reason: "unavailable" };
    }
    const symbols = uniqueSymbols(slice)
      .sort((a, b) => sliceImpact(b) - sliceImpact(a) || a.name.localeCompare(b.name));
    return {
      ok: true,
      entries: toRanked(symbols, symbolIdOf),
      raw: symbols,
      total: symbols.length,
    };
  } catch {
    return { ok: false, entries: [], raw: [], total: 0, reason: "backend_error" };
  }
}

/**
 * @param {QueryPlan} plan
 * @returns {string[]}
 */
function graphSeedIdentifiers(plan) {
  return uniqueStrings((Array.isArray(plan?.identifiers) ? plan.identifiers : [])
    .map((identifier) => String(identifier || "").trim())
    .filter((identifier) => identifier.length > 0));
}

/**
 * @param {View} view
 * @param {string[]} identifiers
 * @param {number} perIdentifierLimit
 * @returns {Promise<ViewSymbol[]>}
 */
async function collectSeedSymbols(view, identifiers, perIdentifierLimit) {
  const out = [];
  const seen = new Set();
  for (const identifier of identifiers) {
    for (const name of exactSeedNames(identifier)) {
      const matches = await view.query.findSymbol(name, { fuzzy: false, limit: perIdentifierLimit });
      for (const symbol of matches) {
        const key = symbolIdOf(symbol);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(symbol);
      }
      if (matches.length > 0) break;
    }
  }
  return out;
}

/**
 * @param {string} identifier
 * @returns {string[]}
 */
function exactSeedNames(identifier) {
  const cleaned = identifier.replace(/^new\s+/, "").trim();
  const parts = cleaned.split(/::|\.|#/).filter(Boolean);
  return uniqueStrings([cleaned, parts[parts.length - 1]]);
}

/**
 * @param {ViewSymbol[]} symbols
 * @returns {ViewSymbol[]}
 */
function uniqueSymbols(symbols) {
  const out = [];
  const seen = new Set();
  for (const symbol of symbols) {
    const key = symbolIdOf(symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol);
  }
  return out;
}

/**
 * @param {ViewSymbol} symbol
 * @returns {number}
 */
function sliceImpact(symbol) {
  const impact = Number(/** @type {any} */ (symbol)._sliceImpact);
  return Number.isFinite(impact) ? impact : 0;
}

/**
 * @param {number[]} values
 * @returns {number[]}
 */
function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value)))];
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}
