// @ts-check
//
// SCIP cached document → ATLAS SymbolRow[] + EdgeRow[].
//
// Producer contract: for each non-local SCIP occurrence in the document,
//   - if the occurrence has Definition role, emit a SymbolRow with
//     source='scip' (and reserve a local_id for that occurrence).
//   - if the occurrence is a reference, emit an EdgeRow with source='scip'.
//     * if the referenced SCIP symbol is local to this document, bind to
//       the local definition's (content_hash, local_id).
//     * if it's a global symbol that has a definition in some OTHER
//       SCIP-covered document, bind directly through the index-wide
//       definition map.
//     * otherwise, the moniker is external — bind via to_external_id.
//
// The producer never bumps a row past tree-sitter once one has been
// ingested for the same blob — `Ledger.ingestBlob` early-returns on a
// known content_hash, and the warmer ensures SCIP runs first on any
// content_hash it covers.

import { sha256Hex } from "../hash.js";
import {
  descriptorsToQualifiedName,
  externalDisplayName,
} from "./symbol-parser.js";
import { scipConfidence } from "./confidence.js";
import { scipRoleIsDefinition, scipRoleIsImport } from "./decode.js";

// Spec version for the SCIP→rows transformation. Bump this whenever a change
// here or in symbol-parser.js (local-symbol suppression, qualified-name
// derivation, kind mapping, …) alters the stored symbol/edge rows. The ingester
// folds it into the SCIP index `config_hash`, so a bump invalidates
// already-ingested SCIP indexes + layers and forces a re-ingest with the new
// mapping — the SCIP analogue of ATLAS_PARSER_SPEC_VERSION for tree-sitter blobs.
//
//   v2: suppress SCIP `local N` symbols (and their graph refs); strip the
//       file-path descriptor prefix from qualified names so they unify with
//       tree-sitter-derived qualified names instead of duplicating.
export const ATLAS_SCIP_ROWS_SPEC_VERSION = "scip-rows-v2";

/** @typedef {import("./cache.js").CachedDocument} CachedDocument */
/** @typedef {import("./cache.js").CachedOccurrence} CachedOccurrence */
/** @typedef {import("./symbol-parser.js").ScipParsedSymbol} ScipParsedSymbol */
/** @typedef {import("../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../contracts/schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("../contracts/schemas.js").ParseResult} ParseResult */

/**
 * @typedef {(parsed: ScipParsedSymbol) => number} ExternalSymbolBinder
 *
 * Called once per unique external-moniker referenced from this document.
 * Implementations should be idempotent (Ledger.upsertExternalSymbol fits).
 */

/**
 * Convert a cached SCIP document into a ParseResult shaped exactly like
 * the tree-sitter adapter would produce.
 *
 * @param {{
 *   cache: import("./cache.js").ScipIndexCache,
 *   document: CachedDocument,
 *   repo_rel_path: string,
 *   bindExternal: ExternalSymbolBinder,
 *   lang?: string,
 * }} args
 * @returns {ParseResult}
 */
export function scipDocumentToParseResult({ cache, document, repo_rel_path, bindExternal, lang }) {
  const content_hash = document.content_hash;
  const resolvedLang = normalizeLangFromScip(lang || document.language);

  /** @type {SymbolRow[]} */
  const symbols = [];
  /** @type {EdgeRow[]} */
  const edges = [];

  // Pass 1: assign a local_id to every SCIP definition occurrence in
  // document order. Definitions are the only way SCIP produces ATLAS
  // SymbolRow entries.
  /** @type {Map<string, number>} */
  const symbolToLocalId = new Map(document.definitionLocalIds || []);
  const emittedSymbols = new Set();
  const suppressedLocalIds = new Set();

  for (const occ of document.occurrences) {
    if (!occ.parsed) continue;
    if (!scipRoleIsDefinition(occ.raw.symbol_roles)) continue;
    if (scipRoleIsImport(occ.raw.symbol_roles)) continue;
    if (emittedSymbols.has(occ.raw.symbol)) continue;

    const parsed = occ.parsed;
    const local_id = symbolToLocalId.get(occ.raw.symbol);
    if (local_id == null) continue;
    if (parsed.local) {
      suppressedLocalIds.add(local_id);
      emittedSymbols.add(occ.raw.symbol);
      continue;
    }

    const info = document.symbolsBySymbol.get(occ.raw.symbol);
    const displayName = info?.display_name || externalDisplayName(parsed) || lastDescriptorName(parsed);
    if (!displayName) continue;

    emittedSymbols.add(occ.raw.symbol);

    const qualified = descriptorsToQualifiedName(parsed.descriptors, { repoRelPath: repo_rel_path }) || displayName;
    const sigSource = info?.display_name
      ? `${kindGuess(parsed)} ${qualified}`
      : qualified;
    symbols.push({
      content_hash,
      local_id,
      kind: kindGuess(parsed),
      name: displayName,
      qualified_name: qualified || null,
      parent_local_id: null,
      repo_rel_path,
      lang: resolvedLang,
      range_start: occ.start,
      range_end: occ.end,
      range_start_line: occ.range_start_line,
      range_end_line: occ.range_end_line,
      signature_hash: sha256Hex(sigSource),
      signature_text: sigSource,
      visibility: null,
      doc: pickDoc(info?.documentation),
      source: "scip",
    });
  }

  // Pass 2: emit edges. Each non-definition occurrence with a parsed
  // symbol becomes one EdgeRow. Definition occurrences become edges only
  // when they carry the Import role (TS `import { X }` declares a usage).
  let nextEdgeId = 0;
  /** @type {Map<string, number>} */
  const externalIdByMoniker = new Map();
  let fileScopeLocalId = null;

  const ensureFileScopeSymbol = () => {
    if (fileScopeLocalId != null) return fileScopeLocalId;
    let maxLocalId = -1;
    for (const localId of symbolToLocalId.values()) {
      if (Number.isInteger(localId) && localId > maxLocalId) maxLocalId = localId;
    }
    fileScopeLocalId = maxLocalId + 1;
    const displayName = repo_rel_path.split("/").pop() || "__file__";
    const signature = `module ${repo_rel_path}`;
    symbols.push({
      content_hash,
      local_id: fileScopeLocalId,
      kind: "module",
      name: displayName,
      qualified_name: repo_rel_path,
      parent_local_id: null,
      repo_rel_path,
      lang: resolvedLang,
      range_start: 0,
      range_end: 0,
      range_start_line: 1,
      range_end_line: 1,
      signature_hash: sha256Hex(signature),
      signature_text: signature,
      visibility: null,
      doc: null,
      source: "scip",
    });
    return fileScopeLocalId;
  };

  for (const occ of document.occurrences) {
    if (!occ.parsed) continue;
    const parsed = occ.parsed;
    const isDef = scipRoleIsDefinition(occ.raw.symbol_roles);
    if (isDef && !scipRoleIsImport(occ.raw.symbol_roles)) continue;
    if (parsed.local) {
      // SCIP local symbols are document-scoped temporaries. They create a large
      // amount of retrieval noise and are not stable navigation targets, so
      // suppress both unresolved and resolved local-only graph refs.
      continue;
    }

    const fromLocalId = enclosingDefinitionLocalId(document, occ, symbolToLocalId) ?? ensureFileScopeSymbol();
    if (suppressedLocalIds.has(fromLocalId)) continue;

    const refName = displayNameForRef(parsed);
    if (!refName) continue;

    /** @type {EdgeRow} */
    const edge = {
      from_content_hash: content_hash,
      from_local_id: fromLocalId,
      edge_id: nextEdgeId++,
      to_content_hash: null,
      to_local_id: null,
      to_name: refName,
      kind: edgeKindForOccurrence(occ.raw.symbol_roles),
      range_start: occ.start,
      range_end: occ.end,
      range_start_line: occ.range_start_line,
      range_end_line: occ.range_end_line,
      confidence: scipConfidence(false),
      source: "scip",
    };

    // Same-document global symbol — `local 0`-style bindings are local;
    // a global symbol defined in THIS document gets the in-blob local id.
    const lid = symbolToLocalId.get(occ.raw.symbol);
    if (lid != null) {
      edge.to_content_hash = content_hash;
      edge.to_local_id = lid;
      edges.push(edge);
      continue;
    }

    // Cross-document in-repo global symbol. The SCIP index already knows
    // exactly which package symbol is defined by another indexed document, so
    // bind directly instead of downgrading it to an external moniker.
    const indexedTarget = cache.definitionBySymbol.get(occ.raw.symbol);
    if (indexedTarget && indexedTarget.content_hash) {
      edge.to_content_hash = indexedTarget.content_hash;
      edge.to_local_id = indexedTarget.local_id;
      edges.push(edge);
      continue;
    }

    // Otherwise: external moniker. Resolve via the binder, dedup by raw
    // symbol string so we only call bindExternal once per moniker.
    let externalId = externalIdByMoniker.get(occ.raw.symbol);
    if (externalId == null) {
      try {
        externalId = bindExternal(parsed);
        if (externalId != null) externalIdByMoniker.set(occ.raw.symbol, externalId);
      } catch {
        // bindExternal must never fail the whole ingest. Drop the edge.
        externalId = undefined;
      }
    }
    if (externalId != null) {
      edge.to_external_id = externalId;
    }
    edges.push(edge);
  }

  return {
    repo_rel_path,
    content_hash,
    lang: resolvedLang,
    symbols,
    edges,
  };
}

/**
 * SCIP edges are uniformly `references`-shaped; we mark imports specifically
 * so retrieval can still differentiate. Other ref kinds collapse to "calls"
 * when the source occurrence is in a method-call position and to
 * "references" otherwise. SCIP's syntax_kind COULD tell us more but for
 * v1 we keep this conservative.
 *
 * @param {number} roles
 * @returns {import("../contracts/schemas.js").EdgeKind}
 */
function edgeKindForOccurrence(roles) {
  if (scipRoleIsImport(roles)) return "imports";
  if (roles & 0x4 /* WriteAccess */) return "writes";
  if (roles & 0x8 /* ReadAccess */) return "reads";
  return "references";
}

/**
 * Find the smallest decoded definition interval that encloses this reference.
 * Definition intervals prefer SCIP's `enclosing_range`, which covers the whole
 * declaration body and avoids scanning every non-definition occurrence.
 *
 * @param {CachedDocument} document
 * @param {CachedOccurrence} occ
 * @param {Map<string, number>} symbolToLocalId
 * @returns {number | null}
 */
function enclosingDefinitionLocalId(document, occ, symbolToLocalId) {
  let best = -1;
  let bestStart = -1;
  let bestEnd = Number.POSITIVE_INFINITY;
  for (const candidate of document.definitionIntervals || []) {
    if (candidate.start > occ.start || candidate.end < occ.end) continue;
    if (candidate.start > bestStart || (candidate.start === bestStart && candidate.end < bestEnd)) {
      best = candidate.local_id;
      bestStart = candidate.start;
      bestEnd = candidate.end;
    }
  }
  if (best >= 0) return best;
  void symbolToLocalId;
  return null;
}

/**
 * @param {ScipParsedSymbol} parsed
 * @returns {import("../contracts/schemas.js").SymbolKind}
 */
function kindGuess(parsed) {
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  if (!last) return "var";
  switch (last.kind) {
    case "type": return "class";
    case "method": {
      const hasOwningType = parsed.descriptors
        .slice(0, -1)
        .some((descriptor) => descriptor.kind === "type");
      return hasOwningType ? "method" : "function";
    }
    case "term": return "const";
    case "macro": return "macro";
    case "namespace": return "namespace";
    case "type_parameter": return "type";
    case "parameter": return "var";
    case "meta": return "var";
    default: return "var";
  }
}

/**
 * @param {ScipParsedSymbol} parsed
 * @returns {string}
 */
function lastDescriptorName(parsed) {
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  return last ? last.name : "";
}

/**
 * @param {ScipParsedSymbol} parsed
 * @returns {string}
 */
function displayNameForRef(parsed) {
  if (parsed.local) return `local-${parsed.local_id}`;
  return lastDescriptorName(parsed) || descriptorsToQualifiedName(parsed.descriptors) || parsed.package_name || parsed.scheme;
}

/**
 * @param {string} scipLang
 * @returns {string}
 */
export function normalizeLangFromScip(scipLang) {
  const lower = String(scipLang || "").toLowerCase();
  if (lower === "19") return "php";
  if (lower === "php") return "php";
  if (lower === "typescript") return "ts";
  if (lower === "tsx") return "ts";
  if (lower === "javascript") return "js";
  if (lower === "jsx") return "js";
  if (lower === "python") return "py";
  if (lower === "golang") return "go";
  if (lower === "rust") return "rs";
  if (lower === "kotlin") return "kt";
  if (lower === "csharp" || lower === "c#") return "cs";
  if (lower === "c++") return "cpp";
  if (lower === "shell" || lower === "bash") return "sh";
  return lower || "unknown";
}

/**
 * @param {string[] | undefined} docs
 * @returns {string | null}
 */
function pickDoc(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  return docs.join("\n");
}

/**
 * Compute a stable SHA-256 over the (repo_rel_path, content_hash) input
 * pairs that fed into the SCIP-derived rows. Mirrors the cache helper but
 * lives here so the ingester doesn't need to import cache internals.
 *
 * @param {Iterable<{ repo_rel_path: string, content_hash: string }>} pairs
 * @returns {string}
 */
export function rowsetFilesetHash(pairs) {
  /** @type {[string, string][]} */
  const sorted = [];
  for (const p of pairs) sorted.push([p.repo_rel_path, p.content_hash]);
  sorted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(Buffer.from(sorted.map(([p, h]) => `${p}\0${h}`).join("\n"), "utf-8"));
}
