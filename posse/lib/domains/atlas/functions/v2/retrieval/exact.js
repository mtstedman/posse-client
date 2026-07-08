// @ts-check
//
// Deterministic exact-code retrieval helpers. These are intentionally cheaper
// than semantic search/slice flows for questions that ask for inventory,
// structure maps, or fan-in.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { isDefaultVisibleSymbol } from "./hygiene.js";
import { nativePathEvidence } from "./native-evidence.js";
import { collectSurveyPaths } from "./survey.js";
import { recordCodeLadderAreaCoverage } from "./code-ladder.js";

const MAX_STRUCTURE_FILES = 128;
const MAX_SITES_PER_FILE_EDGE = 4;
const STRUCTURE_EDGE_KINDS = new Set(["imports", "calls", "references", "extends", "implements", "uses_type"]);
const DEFAULT_STRUCTURE_EDGE_KINDS = Object.freeze(["imports"]);

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").CodeStructureParams,
 *   repoRoot?: string,
 * }} args
 */
export function codeStructure({ view, versionId, params = {}, repoRoot }) {
  const action = "code.structure";
  const requested = normalizeRequested(params.paths ?? params.path);
  if (requested.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "code.structure requires `paths`: a directory prefix or file path, or an array of them.",
    });
  }

  const maxFiles = clampInt(params.maxFiles, 64, 1, MAX_STRUCTURE_FILES);
  const { paths, prefixTruncated } = collectSurveyPaths({ view, requested, maxFiles });
  if (paths.length === 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        files: [],
        internalEdges: [],
        inboundEdges: [],
        outboundEdges: [],
        fileEdges: [],
        metrics: emptyStructureMetrics([]),
        truncated: prefixTruncated,
        warnings: [`No indexed files matched: ${requested.slice(0, 5).join(", ")}.`],
      },
    });
  }

  const includeSymbols = params.includeSymbols !== false;
  const includeEdges = params.includeEdges !== false;
  const edgeKinds = normalizeStructureEdgeKinds(params.edgeKinds);
  const selected = new Set(paths);
  const symbolById = new Map();
  const symbolsByPath = new Map();

  for (const repoPath of paths) {
    const symbols = view.query.symbolsInFile(repoPath).filter(isDefaultVisibleSymbol);
    symbolsByPath.set(repoPath, symbols);
    for (const symbol of symbols) {
      if (symbol.global_id != null) symbolById.set(symbol.global_id, symbol);
    }
  }

  const internalEdges = [];
  const inboundEdges = [];
  const outboundEdges = [];
  const seenEdges = new Set();
  if (includeEdges) {
    for (const symbol of symbolById.values()) {
      for (const edge of view.query.callees(symbol.global_id)) {
        if (!edgeKinds.has(edge.kind) || edge.to_global_id == null) continue;
        const to = view.query.getSymbol(edge.to_global_id);
        if (!to || !isDefaultVisibleSymbol(to)) continue;
        const entry = structureEdge(edge, symbol, to, selected);
        pushUniqueStructureEdge(entry, seenEdges, selected.has(entry.toPath) ? internalEdges : outboundEdges);
      }
      for (const edge of view.query.callers(symbol.global_id)) {
        if (!edgeKinds.has(edge.kind)) continue;
        const from = view.query.getSymbol(edge.from_global_id);
        if (!from || !isDefaultVisibleSymbol(from)) continue;
        const entry = structureEdge(edge, from, symbol, selected);
        pushUniqueStructureEdge(entry, seenEdges, selected.has(entry.fromPath) ? internalEdges : inboundEdges);
      }
    }
  }

  const fileEdges = aggregateFileEdges(internalEdges);
  const fanInByPath = countDistinctFiles(fileEdges, "toPath", "fromPath");
  const fanOutByPath = countDistinctFiles(fileEdges, "fromPath", "toPath");
  const inboundByPath = countDistinctRawEdges(inboundEdges, "toPath", "fromPath");
  const outboundByPath = countDistinctRawEdges(outboundEdges, "fromPath", "toPath");
  const files = paths.map((repoPath) => {
    const symbols = symbolsByPath.get(repoPath) || [];
    const row = {
      path: repoPath,
      symbolCount: symbols.length,
      topLevelSymbols: symbols.filter((symbol) => symbol.qualified_name == null).map(symbolSummary),
      internalFanIn: fanInByPath.get(repoPath) || 0,
      internalFanOut: fanOutByPath.get(repoPath) || 0,
      inboundFanIn: inboundByPath.get(repoPath) || 0,
      outboundFanOut: outboundByPath.get(repoPath) || 0,
    };
    if (includeSymbols) row.symbols = symbols.map(symbolSummary);
    return row;
  });

  const metrics = {
    fileCount: files.length,
    symbolCount: [...symbolsByPath.values()].reduce((sum, symbols) => sum + symbols.length, 0),
    edgeKinds: [...edgeKinds].sort(),
    internalEdgeCount: internalEdges.length,
    inboundEdgeCount: inboundEdges.length,
    outboundEdgeCount: outboundEdges.length,
    distinctInternalFileEdgeCount: fileEdges.length,
    highestInternalFanIn: [...files]
      .filter((file) => file.internalFanIn > 0)
      .sort((a, b) => b.internalFanIn - a.internalFanIn || a.path.localeCompare(b.path))
      .slice(0, 10)
      .map((file) => ({ path: file.path, count: file.internalFanIn })),
  };

  const evidence = nativePathEvidence({ view, repoRoot, paths, requested, symbolsByPath });
  const pathAmbiguity = /** @type {Record<string, unknown> | null} */ (evidence.pathAmbiguity || null);
  const negativeEvidence = /** @type {Record<string, unknown> | null} */ (evidence.negativeEvidence || null);
  const warnings = prefixTruncated ? [`Path expansion reached the ${maxFiles}-file cap.`] : [];
  if (Array.isArray(evidence.warnings)) warnings.push(.../** @type {string[]} */ (evidence.warnings));
  const data = {
    files,
    internalEdges,
    inboundEdges,
    outboundEdges,
    fileEdges,
    metrics,
    truncated: prefixTruncated,
    warnings,
  };
  if (pathAmbiguity) data.pathAmbiguity = pathAmbiguity;
  if (negativeEvidence) data.negativeEvidence = negativeEvidence;
  // Area-coverage credit: code.structure's per-file symbol rows (name, kind,
  // signature, line) satisfy the card+skeleton rungs for every covered file,
  // exactly like code.survey — later lens/window calls must not re-warn.
  recordCodeLadderAreaCoverage({ sessionId: params.sessionId, files: paths });
  return okEnvelope({ action, versionId, data });
}

function emptyStructureMetrics(edgeKinds) {
  return {
    fileCount: 0,
    symbolCount: 0,
    edgeKinds,
    internalEdgeCount: 0,
    inboundEdgeCount: 0,
    outboundEdgeCount: 0,
    distinctInternalFileEdgeCount: 0,
    highestInternalFanIn: [],
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

function normalizeStructureEdgeKinds(raw) {
  const values = (Array.isArray(raw) ? raw : [raw])
    .map((value) => String(value || "").trim())
    .filter((value) => STRUCTURE_EDGE_KINDS.has(value));
  const fallback = values.length > 0 ? values : DEFAULT_STRUCTURE_EDGE_KINDS;
  return new Set(fallback);
}

function structureEdge(edge, from, to, selected) {
  const fromPath = normalizeRepoPath(from.repo_rel_path);
  const toPath = normalizeRepoPath(to.repo_rel_path);
  const sitePath = normalizeRepoPath(edge.repo_rel_path) || fromPath;
  const siteLine = Number.isFinite(edge.range_start_line) ? Number(edge.range_start_line) : 1;
  return {
    fromPath,
    fromName: from.name || "",
    fromSymbolId: symbolIdFor(from),
    toPath,
    toName: to.name || edge.to_name || "",
    toSymbolId: symbolIdFor(to),
    kind: edge.kind || "references",
    site: `${sitePath}:${siteLine || 1}`,
    fromInScope: selected.has(fromPath),
    toInScope: selected.has(toPath),
  };
}

function pushUniqueStructureEdge(edge, seen, bucket) {
  const key = `${edge.kind}|${edge.fromSymbolId}|${edge.toSymbolId}|${edge.site}`;
  if (seen.has(key)) return;
  seen.add(key);
  bucket.push(edge);
}

function aggregateFileEdges(edges) {
  const byPair = new Map();
  for (const edge of edges) {
    if (!edge.fromPath || !edge.toPath || edge.fromPath === edge.toPath) continue;
    const key = `${edge.fromPath}\0${edge.toPath}`;
    let entry = byPair.get(key);
    if (!entry) {
      entry = { fromPath: edge.fromPath, toPath: edge.toPath, kinds: new Set(), count: 0, sites: [] };
      byPair.set(key, entry);
    }
    entry.count += 1;
    entry.kinds.add(edge.kind);
    if (entry.sites.length < MAX_SITES_PER_FILE_EDGE && !entry.sites.includes(edge.site)) entry.sites.push(edge.site);
  }
  return [...byPair.values()]
    .map((entry) => ({
      fromPath: entry.fromPath,
      toPath: entry.toPath,
      kinds: [...entry.kinds].sort(),
      count: entry.count,
      sites: entry.sites,
    }))
    .sort((a, b) => a.fromPath.localeCompare(b.fromPath) || a.toPath.localeCompare(b.toPath));
}

function countDistinctFiles(edges, targetKey, sourceKey) {
  const map = new Map();
  for (const edge of edges) {
    const target = edge[targetKey];
    const source = edge[sourceKey];
    if (!target || !source) continue;
    if (!map.has(target)) map.set(target, new Set());
    map.get(target).add(source);
  }
  return new Map([...map.entries()].map(([key, set]) => [key, set.size]));
}

function countDistinctRawEdges(edges, targetKey, sourceKey) {
  return countDistinctFiles(edges, targetKey, sourceKey);
}

function symbolSummary(symbol) {
  return {
    symbolId: symbolIdFor(symbol),
    name: symbol.name || "",
    qualifiedName: symbol.qualified_name || null,
    kind: symbol.kind || "",
    line: symbol.range_start_line || 1,
    visibility: symbol.visibility || null,
    signature: symbol.signature_text || null,
  };
}

function symbolIdFor(symbol) {
  return `${symbol.content_hash}:${symbol.local_id}`;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
