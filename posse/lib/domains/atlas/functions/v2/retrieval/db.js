// @ts-check
//
// code.db - deterministic first-pass inventory of database SQL query sites.
// JS resolves the requested ATLAS paths; Rust owns source scanning and
// DB-query classification.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { symbolIdOf } from "./cards.js";
import { cacheDbAccessForQueries } from "./db-symbol-access.js";
import { nativeCodeDb } from "./native-evidence.js";
import { collectSurveyPaths } from "./survey.js";

const MAX_DB_FILES = 128;
const MAX_QUERY_SYMBOLS = 12;

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").CodeDbParams,
 *   repoRoot?: string,
 * }} args
 */
export function codeDb({ view, versionId, params = {}, repoRoot }) {
  const action = "code.db";
  const requested = normalizeRequested(params.paths ?? params.path);
  if (requested.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "code.db requires `paths`: a directory prefix or file path, or an array of them.",
    });
  }

  const maxFiles = clampInt(params.maxFiles, 64, 1, MAX_DB_FILES);
  const { paths, prefixTruncated } = collectSurveyPaths({ view, requested, maxFiles });
  if (paths.length === 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        files: [],
        queries: [],
        exclusions: [],
        metrics: emptyMetrics(),
        truncated: prefixTruncated,
        warnings: [`No indexed files matched: ${requested.slice(0, 5).join(", ")}.`],
      },
    });
  }

  const data = attachDbQuerySymbols({
    data: nativeCodeDb({
      view,
      repoRoot,
      files: paths,
      selectedPaths: paths,
      requested,
      maxFiles,
      prefixTruncated,
    }),
    view,
  });
  cacheDbAccessForQueries(data?.queries);
  return okEnvelope({ action, versionId, data });
}

function emptyMetrics() {
  return {
    fileCount: 0,
    scannedFileCount: 0,
    queryCount: 0,
    dbReadCount: 0,
    dbWriteCount: 0,
    dbSchemaCount: 0,
    durableResultCount: 0,
    telemetryCount: 0,
    bookkeepingCount: 0,
    cacheCount: 0,
  };
}

function normalizeRequested(raw) {
  return (Array.isArray(raw) ? raw : [raw])
    .map(normalizeRepoPath)
    .filter(Boolean);
}

function normalizeRepoPath(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!text || text === "." || text.startsWith("../") || text.includes("/../") || /^[a-zA-Z]:\//.test(text)) return "";
  return text;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * @param {{
 *   data: Record<string, unknown>,
 *   view: import("../contracts/api.js").View,
 * }} args
 */
function attachDbQuerySymbols({ data, view }) {
  if (!data || typeof data !== "object" || !Array.isArray(data.queries)) return data;
  if (!view?.query || typeof view.query.symbolsInFile !== "function") return data;
  const symbolsByPath = new Map();
  let attributed = 0;
  let multiMatch = 0;
  const queries = data.queries.map((query) => {
    const match = symbolsForDbQuery({ view, query, symbolsByPath });
    if (match.symbols.length === 0) return { ...query, symbolSurface: "none" };
    attributed++;
    if (match.symbolCount > 1) multiMatch++;
    return {
      ...query,
      symbols: match.symbols,
      symbolCount: match.symbolCount,
      symbolsTruncated: match.symbolsTruncated,
      symbolSurface: match.symbolSurface,
      ...(match.sameLineSymbolCount > 1 ? { sameLineSymbolCount: match.sameLineSymbolCount } : {}),
    };
  });
  return {
    ...data,
    queries,
    metrics: {
      ...(data.metrics && typeof data.metrics === "object" ? data.metrics : {}),
      symbolAttributedQueryCount: attributed,
      symbolMultiMatchQueryCount: multiMatch,
    },
  };
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   query: any,
 *   symbolsByPath: Map<string, import("../contracts/api.js").ViewSymbol[]>,
 * }} args
 */
function symbolsForDbQuery({ view, query, symbolsByPath }) {
  const path = normalizeRepoPath(query?.path);
  const line = Number(query?.line);
  if (!path || !Number.isFinite(line) || line < 1) {
    return emptySymbolMatch();
  }
  const fileSymbols = getFileSymbols({ view, path, symbolsByPath });
  if (fileSymbols.length === 0) return emptySymbolMatch();

  const sameLine = fileSymbols.filter((symbol) => symbolStartLine(symbol) === line);
  const enclosing = fileSymbols.filter((symbol) => symbolStartLine(symbol) <= line && symbolEndLine(symbol) >= line);
  const useSameLine = sameLine.length > 1 || enclosing.length === 0;
  const selected = useSameLine
    ? mergeSymbols(enclosing, sameLine)
    : enclosing;
  const relation = useSameLine ? "same_line" : "enclosing";
  const ordered = selected.sort(compareSymbolsForLine(line));
  const limited = ordered.slice(0, MAX_QUERY_SYMBOLS).map((symbol) => dbQuerySymbol(symbol, relation));
  return {
    symbols: limited,
    symbolCount: ordered.length,
    symbolsTruncated: ordered.length > MAX_QUERY_SYMBOLS,
    symbolSurface: useSameLine ? "same_line" : "range",
    sameLineSymbolCount: sameLine.length,
  };
}

function emptySymbolMatch() {
  return {
    symbols: [],
    symbolCount: 0,
    symbolsTruncated: false,
    symbolSurface: "none",
    sameLineSymbolCount: 0,
  };
}

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   path: string,
 *   symbolsByPath: Map<string, import("../contracts/api.js").ViewSymbol[]>,
 * }} args
 */
function getFileSymbols({ view, path, symbolsByPath }) {
  if (symbolsByPath.has(path)) return symbolsByPath.get(path) || [];
  let symbols = [];
  try {
    symbols = view.query.symbolsInFile(path) || [];
  } catch {
    symbols = [];
  }
  symbolsByPath.set(path, symbols);
  return symbols;
}

/**
 * @param {import("../contracts/api.js").ViewSymbol[]} first
 * @param {import("../contracts/api.js").ViewSymbol[]} second
 */
function mergeSymbols(first, second) {
  const byId = new Map();
  for (const symbol of first.concat(second)) {
    byId.set(symbolIdOf(symbol), symbol);
  }
  return [...byId.values()];
}

/**
 * @param {number} line
 */
function compareSymbolsForLine(line) {
  return (a, b) => {
    const aWidth = Math.abs(symbolEndLine(a) - symbolStartLine(a));
    const bWidth = Math.abs(symbolEndLine(b) - symbolStartLine(b));
    const aDistance = Math.abs(symbolStartLine(a) - line);
    const bDistance = Math.abs(symbolStartLine(b) - line);
    return aDistance - bDistance
      || aWidth - bWidth
      || String(a.name || "").localeCompare(String(b.name || ""));
  };
}

/**
 * @param {import("../contracts/api.js").ViewSymbol} symbol
 * @param {"enclosing" | "same_line"} relation
 */
function dbQuerySymbol(symbol, relation) {
  return {
    symbolId: symbolIdOf(symbol),
    name: symbol.name,
    qualifiedName: symbol.qualified_name || null,
    kind: symbol.kind,
    path: symbol.repo_rel_path,
    startLine: symbolStartLine(symbol),
    endLine: symbolEndLine(symbol),
    relation,
  };
}

/**
 * @param {import("../contracts/api.js").ViewSymbol} symbol
 */
function symbolStartLine(symbol) {
  const line = Number(symbol.range_start_line);
  return Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
}

/**
 * @param {import("../contracts/api.js").ViewSymbol} symbol
 */
function symbolEndLine(symbol) {
  const start = symbolStartLine(symbol);
  const line = Number(symbol.range_end_line);
  return Number.isFinite(line) && line > 0 ? Math.max(start, Math.floor(line)) : start;
}
