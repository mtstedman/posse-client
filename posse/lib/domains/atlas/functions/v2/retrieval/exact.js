// @ts-check
//
// code.structure orchestration. Node materializes view rows and attaches
// evidence/ladder metadata; Rust owns path traversal, visibility, edge
// classification, aggregation, metrics, caps, warnings, and ordering.

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { nativePathEvidence } from "./native-evidence.js";
import { recordCodeLadderAreaCoverage } from "./code-ladder.js";
import { runAtlasNativeMethodAsync } from "../native/invoke.js";

const MAX_STRUCTURE_FILES = 128;

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: Partial<import("../contracts/tool-params.js").CodeStructureParams>,
 *   repoRoot?: string,
 * }} args
 */
export async function codeStructure({ view, versionId, params = {}, repoRoot }) {
  const action = "code.structure";
  const requested = requestedPaths(params.paths ?? params.path);
  if (requested.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "code.structure requires `paths`: a directory prefix or file path, or an array of them.",
    });
  }

  const maxFiles = clampInt(params.maxFiles, 64, 1, MAX_STRUCTURE_FILES);
  const indexedPaths = await materializedIndexedPaths(view);
  const selection = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("repository-paths", {
    requestedPaths: requested,
    indexedPaths,
    maxFiles,
  }));
  const paths = Array.isArray(selection.paths) ? selection.paths : [];
  const files = [];
  for (const repoPath of paths) {
    files.push({ path: repoPath, symbols: await view.query.symbolsInFile(repoPath) });
  }
  const symbolsByPath = new Map(files.map((file) => [file.path, file.symbols]));
  const edgeKinds = normalizedStructureEdgeKinds(params.edgeKinds);
  const edges = await materializedStructureEdges(view, files, new Set(edgeKinds));
  const data = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("code-structure", {
    selectedPaths: paths,
    requestedPaths: requested,
    files,
    edges,
    edgeKinds,
    maxFiles,
    includeSymbols: params.includeSymbols,
    includeEdges: params.includeEdges,
    prefixTruncated: selection.prefixTruncated === true,
  }));

  const evidence = await nativePathEvidence({ view, repoRoot, paths, requested, symbolsByPath });
  const pathAmbiguity = /** @type {Record<string, unknown> | null} */ (evidence.pathAmbiguity || null);
  const negativeEvidence = /** @type {Record<string, unknown> | null} */ (evidence.negativeEvidence || null);
  const warnings = Array.isArray(data.warnings) ? [...data.warnings] : [];
  if (Array.isArray(evidence.warnings)) warnings.push(.../** @type {string[]} */ (evidence.warnings));
  data.warnings = warnings;
  if (pathAmbiguity) data.pathAmbiguity = pathAmbiguity;
  if (negativeEvidence) data.negativeEvidence = negativeEvidence;

  recordCodeLadderAreaCoverage({ sessionId: params.sessionId, files: paths });
  return okEnvelope({ action, versionId, data });
}

function requestedPaths(raw) {
  return (Array.isArray(raw) ? raw : [raw])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

async function materializedIndexedPaths(view) {
  return typeof view?.query?.indexedPaths === "function"
    ? await view.query.indexedPaths({ limit: 100_000 })
    : [];
}

async function materializedStructureEdges(view, files, edgeKinds) {
  const byGlobalId = new Map();
  for (const file of files) {
    for (const symbol of file.symbols) {
      if (symbol.global_id != null) byGlobalId.set(symbol.global_id, symbol);
    }
  }
  const rows = [];
  for (const symbol of byGlobalId.values()) {
    const neighborhood = await view.query.symbolNeighborhood(symbol.global_id);
    for (const { edge, symbol: to } of neighborhood.callees) {
      if (edge.to_global_id == null) continue;
      if (!edgeKinds.has(String(edge.kind || ""))) continue;
      if (!to) continue;
      rows.push(structureEdgeInput(edge, symbol, to));
    }
    for (const { edge, symbol: from } of neighborhood.callers) {
      if (!edgeKinds.has(String(edge.kind || ""))) continue;
      if (!from) continue;
      rows.push(structureEdgeInput(edge, from, symbol));
    }
  }
  return rows;
}

function normalizedStructureEdgeKinds(value) {
  const allowed = new Set(["imports", "calls", "references", "extends", "implements", "uses_type"]);
  const selected = arrayValue(value)
    .map((kind) => String(kind || "").trim())
    .filter((kind) => allowed.has(kind));
  return [...new Set(selected.length > 0 ? selected : ["imports"])].sort();
}

function structureEdgeInput(edge, from, to) {
  return {
    from,
    to,
    kind: edge.kind,
    sitePath: edge.repo_rel_path || from.repo_rel_path,
    siteLine: edge.range_start_line,
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
