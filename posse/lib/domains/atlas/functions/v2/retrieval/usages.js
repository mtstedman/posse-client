// @ts-check

import { parseSymbolId, symbolIdOf, symbolHit } from "./cards.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { isDefaultVisibleSymbol } from "./hygiene.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewEdge} ViewEdge */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").SymbolUsagesParams} SymbolUsagesParams */
/** @typedef {import("../contracts/tool-results.js").SymbolUsagesData} SymbolUsagesData */

/**
 * Compact "where is this symbol used?" surface. Unlike symbol.card callers,
 * this emits just edge sites and source symbols, which is the shape agents need
 * before deciding whether to spend tokens on full cards.
 *
 * @param {{ view: View, versionId: string, params: SymbolUsagesParams }} args
 * @returns {ReturnType<typeof okEnvelope<SymbolUsagesData>> | ReturnType<typeof errorEnvelope>}
 */
export function symbolUsages({ view, versionId, params }) {
  const parsed = parseSymbolId(params.symbolId);
  if (!parsed) {
    return errorEnvelope({
      action: "symbol.overview",
      versionId,
      code: "invalid_symbol_id",
      message: "symbol.overview requires a valid symbolId",
    });
  }
  const target = view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
  if (!target) {
    return errorEnvelope({
      action: "symbol.overview",
      versionId,
      code: "symbol_not_found",
      message: `No symbol found for ${params.symbolId}`,
    });
  }

  const limit = clampInt(params.limit, 50, 1, 500);
  const minConfidence = normalizeConfidence(params.minConfidence);
  const kindFilter = Array.isArray(params.kind) && params.kind.length > 0
    ? new Set(params.kind.map(String))
    : null;
  const rows = [];
  for (const edge of view.query.callers(target.global_id)) {
    if (kindFilter && !kindFilter.has(edge.kind)) continue;
    if ((Number(edge.confidence) || 0) / 100 < minConfidence) continue;
    const from = view.query.getSymbol(edge.from_global_id);
    if (!from || !isDefaultVisibleSymbol(from)) continue;
    rows.push(usageFromEdge(edge, from, true));
  }
  if (params.includeUnresolved) {
    for (const edge of view.query.unresolvedReferencesTo(target.name)) {
      if (kindFilter && !kindFilter.has(edge.kind)) continue;
      if ((Number(edge.confidence) || 0) / 100 < minConfidence) continue;
      const from = view.query.getSymbol(edge.from_global_id);
      if (!from || !isDefaultVisibleSymbol(from)) continue;
      rows.push(usageFromEdge(edge, from, false));
    }
  }
  rows.sort((a, b) =>
    a.repo_rel_path.localeCompare(b.repo_rel_path)
    || a.startLine - b.startLine
    || a.fromName.localeCompare(b.fromName)
    || a.kind.localeCompare(b.kind)
  );
  const total = rows.length;
  const usages = rows.slice(0, limit);
  const warnings = usageWarnings(view, total);
  return okEnvelope({
    action: "symbol.overview",
    versionId,
    data: {
      symbolId: params.symbolId,
      name: target.name,
      qualifiedName: target.qualified_name,
      usages,
      total,
      truncated: total > usages.length,
    },
    meta: warnings.length > 0 ? { warnings } : undefined,
  });
}

/**
 * @param {ViewEdge} edge
 * @param {ViewSymbol} from
 * @param {boolean} resolved
 */
function usageFromEdge(edge, from, resolved) {
  return {
    repo_rel_path: edge.repo_rel_path,
    startLine: Number.isInteger(edge.range_start_line) ? edge.range_start_line : 1,
    endLine: Number.isInteger(edge.range_end_line) ? edge.range_end_line : 1,
    startByte: edge.range_start,
    endByte: edge.range_end,
    fromSymbolId: symbolIdOf(from),
    fromName: from.name,
    fromQualifiedName: from.qualified_name,
    fromSymbol: symbolHit(from),
    kind: edge.kind,
    confidence: edge.confidence,
    resolved,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeConfidence(value) {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * @param {View} view
 * @param {number} total
 * @returns {string[]}
 */
function usageWarnings(view, total) {
  if (total > 0) return [];
  const db = typeof /** @type {any} */ (view)._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!db) return [];
  try {
    const row = /** @type {{ total?: number, unresolved?: number } | undefined} */ (
      db.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN to_global_id IS NULL AND to_external_id IS NULL THEN 1 ELSE 0 END) AS unresolved
         FROM edges`,
      ).get()
    );
    const edgeTotal = Number(row?.total || 0);
    const unresolved = Number(row?.unresolved || 0);
    if (edgeTotal <= 0) return [];
    const ratio = unresolved / edgeTotal;
    if (ratio <= 0.25) return [];
    return [
      `No usages found, but ${Math.round(ratio * 100)}% of edges are unresolved; usage results may be incomplete.`,
    ];
  } catch {
    return [];
  }
}
