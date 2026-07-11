// @ts-check

import { parseSymbolId, symbolIdOf, symbolHit } from "./cards.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { isDefaultVisibleSymbol } from "./hygiene.js";

const FILE_GROUP_LIMIT = 200;

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
  const usageSummary = summarizeUsageRows(rows);
  return okEnvelope({
    action: "symbol.overview",
    versionId,
    data: {
      symbolId: params.symbolId,
      name: target.name,
      qualifiedName: target.qualified_name,
      rawOccurrenceCount: total,
      distinctFileCount: usageSummary.distinctFileCount,
      distinctResolvedFileCount: usageSummary.distinctResolvedFileCount,
      distinctCallerFileCount: usageSummary.distinctCallerFileCount,
      callerFiles: usageSummary.callerFiles,
      unresolvedFiles: usageSummary.unresolvedFiles,
      usages,
      total,
      truncated: total > usages.length,
    },
    meta: warnings.length > 0 ? { warnings } : undefined,
  });
}

/**
 * Compact "who calls into this" breadcrumbs for read surfaces (skeleton,
 * lens): the top definitions by distinct calling files, each with a small
 * path sample. Graph context rides along on the reads agents already make,
 * so consuming the caller graph does not require issuing graph calls.
 *
 * @param {View} view
 * @param {ViewSymbol[]} symbols
 * @param {{ maxSymbols?: number, examineLimit?: number, sampleLimit?: number }} [opts]
 * @returns {{ symbol: string, calledFromFiles: number, sample: string[] }[]}
 */
export function calledFromBreadcrumbs(view, symbols, { maxSymbols = 6, examineLimit = 24, sampleLimit = 2 } = {}) {
  const rows = [];
  try {
    for (const symbol of (symbols || []).slice(0, examineLimit)) {
      if (symbol?.global_id == null || !isDefaultVisibleSymbol(symbol)) continue;
      const { callerCount, callerPathsSample } = countIncomingCallers(view, symbol, { sampleLimit, distinctPaths: true });
      if (callerCount > 0) {
        rows.push({ symbol: symbol.name, calledFromFiles: callerCount, sample: callerPathsSample });
      }
    }
  } catch {
    // Advisory context; whatever was collected still helps.
  }
  rows.sort((a, b) => b.calledFromFiles - a.calledFromFiles || a.symbol.localeCompare(b.symbol));
  return rows.slice(0, maxSymbols);
}

/**
 * Count resolved, default-visible incoming callers for a symbol and sample a
 * few distinct caller paths. Shares the exact caller-enumeration + visibility
 * filter that {@link symbolUsages} applies (view.query.callers +
 * isDefaultVisibleSymbol) so retrieval reachability signals stay consistent
 * with the symbol.overview surface. Best-effort: returns zero on any error.
 *
 * `distinctPaths` counts distinct caller FILES instead of call-site edges —
 * the hub measure for "how much of the codebase routes through this": a
 * helper invoked 30 times from inside one test file is one calling file, not
 * a 30-edge hub.
 *
 * @param {View} view
 * @param {ViewSymbol} target
 * @param {{ sampleLimit?: number, distinctPaths?: boolean }} [opts]
 * @returns {{ callerCount: number, callerPathsSample: string[] }}
 */
export function countIncomingCallers(view, target, { sampleLimit = 3, distinctPaths = false } = {}) {
  const result = { callerCount: 0, callerPathsSample: /** @type {string[]} */ ([]) };
  try {
    if (!view?.query || target?.global_id == null) return result;
    const seenPaths = new Set();
    const distinct = distinctPaths ? new Set() : null;
    for (const edge of view.query.callers(target.global_id)) {
      const from = view.query.getSymbol(edge.from_global_id);
      if (!from || !isDefaultVisibleSymbol(from)) continue;
      const p = String(edge.repo_rel_path || from.repo_rel_path || "").replace(/\\/g, "/") || null;
      if (distinct) {
        if (p) distinct.add(p);
      } else {
        result.callerCount += 1;
      }
      if (p && !seenPaths.has(p) && result.callerPathsSample.length < sampleLimit) {
        seenPaths.add(p);
        result.callerPathsSample.push(p);
      }
    }
    if (distinct) result.callerCount = distinct.size;
  } catch {
    // Reachability is an advisory signal; degrade to whatever we counted.
  }
  return result;
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

function summarizeUsageRows(rows) {
  const allFiles = new Set();
  const resolvedFiles = new Set();
  const callerFiles = groupUsageFiles(rows, (row) => row.resolved && row.kind === "calls");
  const unresolvedFiles = groupUsageFiles(rows, (row) => !row.resolved);
  for (const row of rows) {
    const path = String(row.repo_rel_path || "").replace(/\\/g, "/");
    if (!path) continue;
    allFiles.add(path);
    if (row.resolved) resolvedFiles.add(path);
  }
  return {
    distinctFileCount: allFiles.size,
    distinctResolvedFileCount: resolvedFiles.size,
    distinctCallerFileCount: callerFiles.length,
    callerFiles,
    unresolvedFiles,
  };
}

function groupUsageFiles(rows, predicate) {
  const byPath = new Map();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const path = String(row.repo_rel_path || "").replace(/\\/g, "/");
    if (!path) continue;
    const group = byPath.get(path) || {
      repo_rel_path: path,
      occurrenceCount: 0,
      firstLine: Number.isInteger(row.startLine) ? row.startLine : 1,
      kinds: new Set(),
      fromNames: new Set(),
    };
    group.occurrenceCount += 1;
    if (Number.isInteger(row.startLine)) group.firstLine = Math.min(group.firstLine, row.startLine);
    if (row.kind) group.kinds.add(String(row.kind));
    if (row.fromName) group.fromNames.add(String(row.fromName));
    byPath.set(path, group);
  }
  return [...byPath.values()]
    .sort((a, b) => a.repo_rel_path.localeCompare(b.repo_rel_path))
    .slice(0, FILE_GROUP_LIMIT)
    .map((group) => ({
      repo_rel_path: group.repo_rel_path,
      occurrenceCount: group.occurrenceCount,
      firstLine: group.firstLine,
      kinds: [...group.kinds].sort(),
      fromNames: [...group.fromNames].sort().slice(0, 12),
    }));
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
  try {
    if (typeof view?.query?.edgeStats !== "function") return [];
    const stats = view.query.edgeStats();
    const edgeTotal = Number(stats.total || 0);
    const unresolved = Math.max(0, edgeTotal - Number(stats.resolved || 0));
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
