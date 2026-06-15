// @ts-check
//
// Per-`.scip` in-memory cache. Read-only — never writes to the ledger.
//
// Built once per warm-phase invocation:
//   - document by relative_path
//   - per-document occurrences with parsed symbols + JS-string positions
//   - per-document SymbolInformation by SCIP symbol string
//   - per-document content_hash (computed from the indexer-emitted Document.text)
//
// The cache is the cheapest way to keep all of `to-rows.js` synchronous;
// the warmer reads it once, then dispatches per-file without going back
// to the protobuf.

import { sha256Hex } from "../hash.js";
import { buildLineStarts, scipRangeToJs } from "./position.js";
import { externalDisplayName, parseScipSymbol } from "./symbol-parser.js";
import { scipRoleIsDefinition, scipRoleIsImport } from "./decode.js";

/** @typedef {import("./decode.js").ScipIndex} ScipIndex */
/** @typedef {import("./decode.js").ScipDocument} ScipDocument */
/** @typedef {import("./decode.js").ScipOccurrence} ScipOccurrence */
/** @typedef {import("./decode.js").ScipSymbolInformation} ScipSymbolInformation */
/** @typedef {import("./symbol-parser.js").ScipParsedSymbol} ScipParsedSymbol */

/**
 * @typedef {Object} CachedOccurrence
 * @property {ScipOccurrence} raw
 * @property {ScipParsedSymbol | null} parsed   // null when the symbol string fails to parse
 * @property {number} start
 * @property {number} end
 * @property {number} range_start_line
 * @property {number} range_end_line
 * @property {number} enclosing_start
 * @property {number} enclosing_end
 * @property {boolean} range_clamped
 * @property {boolean} enclosing_range_clamped
 */

/**
 * @typedef {Object} CachedDocument
 * @property {string} relative_path
 * @property {string} language
 * @property {string} text
 * @property {string} content_hash
 * @property {number} byte_size
 * @property {CachedOccurrence[]} occurrences
 * @property {Map<string, ScipSymbolInformation>} symbolsBySymbol  // local SymbolInformation, keyed by SCIP symbol string
 * @property {Map<string, number>} definitionLocalIds
 * @property {{ start: number, end: number, local_id: number }[]} definitionIntervals
 * @property {number[]} lineStarts
 * @property {number} range_clamp_count
 * @property {string} [skip_reason]
 * @property {string} [skip_message]
 */

/**
 * @typedef {Object} ScipIndexCache
 * @property {ScipIndex} raw
 * @property {Map<string, CachedDocument>} documentsByPath
 * @property {Map<string, ScipSymbolInformation>} externalSymbolsBySymbol
 * @property {Map<string, { content_hash: string, local_id: number, repo_rel_path: string }>} definitionBySymbol
 * @property {(repo_rel_path: string) => CachedDocument | null} get
 * @property {() => Iterable<CachedDocument>} documents
 * @property {() => string} filesetHash
 */

/**
 * Build the cache from a decoded SCIP index.
 *
 * @param {ScipIndex} index
 * @returns {ScipIndexCache}
 */
export function buildScipIndexCache(index) {
  /** @type {Map<string, CachedDocument>} */
  const documentsByPath = new Map();
  /** @type {Map<string, { content_hash: string, local_id: number, repo_rel_path: string }>} */
  const definitionBySymbol = new Map();

  for (const doc of mergeScipDocuments(index.documents)) {
    const text = doc.text || "";
    const positionEncoding = doc.position_encoding || 2;
    const hasSourceBytes = doc.source_bytes != null;
    const sourceBytes = hasSourceBytes
      ? Buffer.from(doc.source_bytes.buffer, doc.source_bytes.byteOffset, doc.source_bytes.byteLength)
      : Buffer.from(text, "utf-8");
    const contentHash = hasSourceBytes || text ? sha256Hex(sourceBytes) : "";
    if (doc.atlas_skip_reason) {
      documentsByPath.set(doc.relative_path, {
        relative_path: doc.relative_path,
        language: doc.language,
        text,
        content_hash: contentHash,
        byte_size: sourceBytes.length,
        occurrences: [],
        symbolsBySymbol: new Map(),
        definitionLocalIds: new Map(),
        definitionIntervals: [],
        lineStarts: [],
        range_clamp_count: 0,
        skip_reason: doc.atlas_skip_reason,
        skip_message: doc.atlas_skip_message,
      });
      continue;
    }
    const lineStarts = buildLineStarts(text);
    /** @type {CachedOccurrence[]} */
    const occurrences = [];
    let rangeClampCount = 0;
    for (const occ of doc.occurrences) {
      /** @type {ScipParsedSymbol | null} */
      let parsed = null;
      try {
        parsed = parseScipSymbol(occ.symbol);
      } catch {
        // Unparseable symbol strings are silently dropped; the ingester
        // still emits an event so operators can audit if needed. We do
        // not throw on bad SCIP because indexer output is third-party.
      }
      const { start, end, range_start_line, range_end_line, clamped } = scipRangeToJs(occ.range, text, lineStarts, positionEncoding);
      const enclosing = scipRangeToJs(occ.enclosing_range, text, lineStarts, positionEncoding);
      if (clamped || (Array.isArray(occ.enclosing_range) && occ.enclosing_range.length > 0 && enclosing.clamped)) {
        rangeClampCount++;
      }
      occurrences.push({
        raw: occ,
        parsed,
        start,
        end,
        range_start_line,
        range_end_line,
        enclosing_start: enclosing.start,
        enclosing_end: enclosing.end,
        range_clamped: clamped,
        enclosing_range_clamped: enclosing.clamped,
      });
    }
    /** @type {Map<string, ScipSymbolInformation>} */
    const symbolsBySymbol = new Map();
    for (const sym of doc.symbols) {
      if (sym.symbol) symbolsBySymbol.set(sym.symbol, sym);
    }
    const definitionLocalIds = computeDefinitionLocalIds(occurrences, symbolsBySymbol);
    const definitionIntervals = computeDefinitionIntervals(occurrences, definitionLocalIds);
    for (const occ of occurrences) {
      if (!occ.parsed || occ.parsed.local) continue;
      const localId = definitionLocalIds.get(occ.raw.symbol);
      if (localId == null) continue;
      if (contentHash && !definitionBySymbol.has(occ.raw.symbol)) {
        definitionBySymbol.set(occ.raw.symbol, {
          content_hash: contentHash,
          local_id: localId,
          repo_rel_path: doc.relative_path,
        });
      }
    }
    documentsByPath.set(doc.relative_path, {
      relative_path: doc.relative_path,
      language: doc.language,
      text,
      content_hash: contentHash,
      byte_size: sourceBytes.length,
      occurrences,
      symbolsBySymbol,
      definitionLocalIds,
      definitionIntervals,
      lineStarts,
      range_clamp_count: rangeClampCount,
      skip_reason: doc.atlas_skip_reason,
      skip_message: doc.atlas_skip_message,
    });
  }

  /** @type {Map<string, ScipSymbolInformation>} */
  const externalSymbolsBySymbol = new Map();
  for (const sym of index.external_symbols) {
    if (sym.symbol) externalSymbolsBySymbol.set(sym.symbol, sym);
  }

  let filesetHashCached = "";

  return {
    raw: index,
    documentsByPath,
    externalSymbolsBySymbol,
    definitionBySymbol,
    get(repo_rel_path) {
      return documentsByPath.get(repo_rel_path) || null;
    },
    documents() {
      return documentsByPath.values();
    },
    filesetHash() {
      if (filesetHashCached) return filesetHashCached;
      /** @type {[string, string][]} */
      const pairs = [];
      for (const doc of documentsByPath.values()) {
        pairs.push([doc.relative_path, doc.content_hash]);
      }
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const payload = pairs.map(([p, h]) => `${p}\0${h}`).join("\n");
      filesetHashCached = sha256Hex(Buffer.from(payload, "utf-8"));
      return filesetHashCached;
    },
  };
}

/**
 * Some SCIP producers emit one Document per compilation unit, which can repeat
 * the same relative_path. ATLAS stores blobs by content hash/path, so merge
 * same-path documents before building the path-keyed cache.
 *
 * @param {ScipDocument[]} documents
 * @returns {ScipDocument[]}
 */
function mergeScipDocuments(documents) {
  /** @type {ScipDocument[]} */
  const out = [];
  /** @type {Map<string, ScipDocument & { _occurrenceKeys?: Set<string> }>} */
  const byPath = new Map();
  for (const doc of Array.isArray(documents) ? documents : []) {
    const rel = String(doc?.relative_path || "");
    const existing = byPath.get(rel);
    if (!existing) {
      const copy = {
        ...doc,
        occurrences: [],
        symbols: [],
      };
      copy._occurrenceKeys = new Set();
      appendOccurrences(copy, doc.occurrences);
      appendSymbols(copy, doc.symbols);
      byPath.set(rel, copy);
      out.push(copy);
      continue;
    }

    appendOccurrences(existing, doc.occurrences);
    appendSymbols(existing, doc.symbols);
    if (!existing.language && doc.language) existing.language = doc.language;
    if (!existing.text && doc.text) {
      existing.text = doc.text;
    } else if (existing.text && doc.text && existing.text !== doc.text) {
      existing.atlas_skip_reason = existing.atlas_skip_reason || "duplicate_path_text_conflict";
      existing.atlas_skip_message = existing.atlas_skip_message
        || `SCIP emitted duplicate document path '${rel}' with conflicting text snapshots`;
    }
    if (existing.source_bytes == null && doc.source_bytes != null) {
      existing.source_bytes = doc.source_bytes;
    } else if (existing.source_bytes != null && doc.source_bytes != null && !sameBytes(existing.source_bytes, doc.source_bytes)) {
      existing.atlas_skip_reason = existing.atlas_skip_reason || "duplicate_path_text_conflict";
      existing.atlas_skip_message = existing.atlas_skip_message
        || `SCIP emitted duplicate document path '${rel}' with conflicting source bytes`;
    }
  }
  for (const doc of out) delete /** @type {any} */ (doc)._occurrenceKeys;
  return out;
}

/**
 * @param {ScipDocument & { _occurrenceKeys?: Set<string> }} target
 * @param {ScipOccurrence[] | undefined} occurrences
 */
function appendOccurrences(target, occurrences) {
  const seen = target._occurrenceKeys || (target._occurrenceKeys = new Set());
  for (const occ of Array.isArray(occurrences) ? occurrences : []) {
    const key = JSON.stringify([
      occ.symbol || "",
      occ.symbol_roles || 0,
      occ.range || [],
      occ.enclosing_range || [],
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    target.occurrences.push(occ);
  }
}

/**
 * @param {ScipDocument} target
 * @param {ScipSymbolInformation[] | undefined} symbols
 */
function appendSymbols(target, symbols) {
  const seen = new Set(target.symbols.map((sym) => sym.symbol).filter(Boolean));
  for (const sym of Array.isArray(symbols) ? symbols : []) {
    if (sym.symbol && seen.has(sym.symbol)) continue;
    if (sym.symbol) seen.add(sym.symbol);
    target.symbols.push(sym);
  }
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * @param {CachedOccurrence[]} occurrences
 * @param {Map<string, ScipSymbolInformation>} symbolsBySymbol
 * @returns {Map<string, number>}
 */
function computeDefinitionLocalIds(occurrences, symbolsBySymbol) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const occ of occurrences) {
    if (!occ.parsed) continue;
    if (!scipRoleIsDefinition(occ.raw.symbol_roles)) continue;
    if (scipRoleIsImport(occ.raw.symbol_roles)) continue;
    if (out.has(occ.raw.symbol)) continue;
    const info = symbolsBySymbol.get(occ.raw.symbol);
    const displayName = info?.display_name || externalDisplayName(occ.parsed) || lastDescriptorName(occ.parsed);
    if (!displayName) continue;
    out.set(occ.raw.symbol, out.size);
  }
  return out;
}

/**
 * @param {CachedOccurrence[]} occurrences
 * @param {Map<string, number>} definitionLocalIds
 * @returns {{ start: number, end: number, local_id: number }[]}
 */
function computeDefinitionIntervals(occurrences, definitionLocalIds) {
  const intervals = [];
  const emitted = new Set();
  for (const occ of occurrences) {
    if (!scipRoleIsDefinition(occ.raw.symbol_roles)) continue;
    if (scipRoleIsImport(occ.raw.symbol_roles)) continue;
    if (emitted.has(occ.raw.symbol)) continue;
    const localId = definitionLocalIds.get(occ.raw.symbol);
    if (localId == null) continue;
    emitted.add(occ.raw.symbol);
    const useEnclosing = occ.enclosing_end > occ.enclosing_start;
    intervals.push({
      start: useEnclosing ? occ.enclosing_start : occ.start,
      end: useEnclosing ? occ.enclosing_end : occ.end,
      local_id: localId,
    });
  }
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);
  return intervals;
}

/**
 * @param {ScipParsedSymbol} parsed
 * @returns {string}
 */
function lastDescriptorName(parsed) {
  const last = parsed.descriptors[parsed.descriptors.length - 1];
  return last ? last.name : "";
}
