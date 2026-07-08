// @ts-check
//
// code.survey — bulk cross-file intake: per-file skeletons plus a call map
// for a directory prefix or explicit file list, in one call. Two modes:
// without `symbols` a file-level wiring map (which file calls which), with
// `symbols` a symbol-level dig restricted to those names' neighborhoods —
// the structured replacement for grep-digging a symbol across files.
// Boundary edges (inbound callers from outside the surveyed set, outbound
// dependencies) always report at symbol granularity: the doors matter more
// than the rooms. Node reads the view rows; Rust owns assembly, aggregation,
// caps, and truncation flags (survey.rs, method "code-survey").

import { errorEnvelope, okEnvelope } from "./envelope.js";
import { runAtlasNativeMethod } from "../native/invoke.js";
import { isDefaultVisibleSymbol } from "./hygiene.js";
import { nativePathEvidence } from "./native-evidence.js";
import { recordCodeLadderAreaCoverage } from "./code-ladder.js";

const MAX_SURVEY_FILES = 64;
const MAX_RAW_EDGES = 20_000;
const MAX_DIG_TERMS = 16;

/**
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").CodeSurveyParams,
 *   repoRoot?: string,
 * }} args
 */
export function codeSurvey({ view, versionId, params = {}, repoRoot }) {
  const action = "code.survey";
  // `paths` accepts one string or an array; each entry may be an indexed file
  // or a directory prefix (resolved in that order). `path` stays as an alias.
  const raw = params.paths ?? params.path;
  const requested = (Array.isArray(raw) ? raw : [raw])
    .map((value) => String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean);
  if (requested.length === 0) {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_params",
      message: "code.survey requires `paths`: a directory prefix or file path, or an array of them.",
    });
  }

  const maxFiles = clampInt(params.maxFiles, MAX_SURVEY_FILES, 1, MAX_SURVEY_FILES);
  const { paths, prefixTruncated } = collectSurveyPaths({ view, requested, maxFiles });
  if (paths.length === 0) {
    return okEnvelope({
      action,
      versionId,
      data: {
        granularity: "file",
        files: [],
        callMap: { edges: [], inbound: [], outbound: [], unresolved: [], edgesTruncated: false, inboundTruncated: false, outboundTruncated: false },
        metrics: { fileCount: 0, symbolCount: 0, internalEdgeCount: 0, inboundCount: 0, outboundCount: 0, unresolvedCount: 0 },
        truncated: prefixTruncated,
        warnings: [`No indexed files matched: ${requested.slice(0, 5).join(", ")}.`],
      },
    });
  }

  const digTerms = (Array.isArray(params.symbols) ? params.symbols : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, MAX_DIG_TERMS);

  const surveyed = new Set(paths);
  const files = [];
  /** @type {Map<number, import("../contracts/api.js").ViewSymbol>} */
  const surveyedSymbols = new Map();
  for (const path of paths) {
    const symbols = view.query.symbolsInFile(path).filter(isDefaultVisibleSymbol);
    for (const symbol of symbols) {
      if (symbol.global_id != null) surveyedSymbols.set(symbol.global_id, symbol);
    }
    files.push({ path, symbols });
  }

  // Callers of surveyed symbols cover internal + inbound edges exactly once;
  // callees are only needed where the target leaves the surveyed set.
  const edges = [];
  let edgeBudget = MAX_RAW_EDGES;
  outer:
  for (const symbol of surveyedSymbols.values()) {
    for (const edge of view.query.callers(symbol.global_id)) {
      const from = view.query.getSymbol(edge.from_global_id);
      if (!from || !isDefaultVisibleSymbol(from)) continue;
      edges.push(surveyEdge(edge, from, symbol, surveyed));
      if (--edgeBudget <= 0) break outer;
    }
    for (const edge of view.query.callees(symbol.global_id)) {
      if (edge.to_global_id == null) continue;
      const to = view.query.getSymbol(edge.to_global_id);
      if (!to || !isDefaultVisibleSymbol(to)) continue;
      if (surveyed.has(String(to.repo_rel_path || "").replace(/\\/g, "/"))) continue; // internal: already covered via callers
      edges.push(surveyEdge(edge, symbol, to, surveyed));
      if (--edgeBudget <= 0) break outer;
    }
  }

  // Grep parity: unresolved name references for dig terms — string dispatch
  // and dynamic lookups that never resolved to a symbol.
  const unresolved = [];
  if (typeof view.query.unresolvedReferencesTo === "function") {
    for (const term of digTerms) {
      const sites = [];
      for (const edge of view.query.unresolvedReferencesTo(term)) {
        sites.push(`${edge.repo_rel_path}:${edge.range_start_line || 1}`);
        if (sites.length >= 32) break;
      }
      if (sites.length > 0) unresolved.push({ name: term, sites });
    }
  }

  const result = /** @type {Record<string, unknown>} */ (runAtlasNativeMethod("code-survey", {
    files,
    edges,
    unresolved,
    symbols_filter: digTerms,
    max_files: maxFiles,
    max_symbols_per_file: params.maxSymbolsPerFile,
    max_edges: params.maxEdges,
  }));
  if (prefixTruncated) result.truncated = true;
  const evidence = nativePathEvidence({ view, repoRoot, paths, requested, terms: digTerms });
  const pathAmbiguity = /** @type {Record<string, unknown> | null} */ (evidence.pathAmbiguity || null);
  if (pathAmbiguity) {
    result.pathAmbiguity = pathAmbiguity;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (Array.isArray(evidence.warnings)) warnings.push(.../** @type {string[]} */ (evidence.warnings));
    result.warnings = warnings;
  }
  recordCodeLadderAreaCoverage({ sessionId: params.sessionId, files: paths });
  return okEnvelope({ action, versionId, data: result });
}

/**
 * @param {import("../contracts/api.js").ViewEdge} edge
 * @param {import("../contracts/api.js").ViewSymbol} from
 * @param {import("../contracts/api.js").ViewSymbol} to
 * @param {Set<string>} surveyed
 */
function surveyEdge(edge, from, to, surveyed) {
  const fromPath = String(from.repo_rel_path || "").replace(/\\/g, "/");
  const toPath = String(to.repo_rel_path || "").replace(/\\/g, "/");
  return {
    from_path: fromPath,
    from_name: from.name || "",
    to_path: toPath,
    to_name: to.name || "",
    kind: edge.kind || "calls",
    site: `${edge.repo_rel_path}:${edge.range_start_line || 1}`,
    from_in_survey: surveyed.has(fromPath),
    to_in_survey: surveyed.has(toPath),
  };
}

/**
 * Resolve requested entries to indexed files: an entry that is itself an
 * indexed file is taken as-is; otherwise it is treated as a directory prefix
 * and expanded from the view's path table.
 *
 * @param {{ view: import("../contracts/api.js").View, requested: string[], maxFiles: number }} args
 */
export function collectSurveyPaths({ view, requested, maxFiles }) {
  const seen = new Set();
  const paths = [];
  let prefixTruncated = false;
  const db = typeof (/** @type {any} */ (view))._unsafeDb === "function" ? /** @type {any} */ (view)._unsafeDb() : null;
  const push = (path) => {
    if (seen.has(path)) return true;
    if (paths.length >= maxFiles) {
      prefixTruncated = true;
      return false;
    }
    seen.add(path);
    paths.push(path);
    return true;
  };
  for (const entry of requested) {
    const isFile = db
      ? !!db.prepare("SELECT 1 FROM path_to_blob WHERE repo_rel_path = ?").get(entry)
      : view.query.symbolsInFile(entry).length > 0;
    if (isFile) {
      if (!push(entry)) break;
      continue;
    }
    if (!db) continue;
    const rows = db.prepare(
      "SELECT repo_rel_path FROM path_to_blob WHERE repo_rel_path LIKE ? ORDER BY repo_rel_path LIMIT ?",
    ).all(`${entry}/%`, maxFiles + 1);
    for (const row of rows) {
      if (!push(String(row.repo_rel_path))) break;
    }
    if (prefixTruncated) break;
  }
  return { paths, prefixTruncated };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
