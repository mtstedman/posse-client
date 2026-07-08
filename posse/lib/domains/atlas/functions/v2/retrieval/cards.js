// @ts-check
//
// Translation between ViewSymbol/ViewEdge rows and the tool-result shapes
// (SymbolHit, SymbolCard, SymbolLocation). Centralized so every handler
// produces identically-shaped outputs.

import { sha256Hex } from "../hash.js";
import { isDefaultVisibleSymbol, isNoisyLocalSymbol } from "./hygiene.js";
import { applyDbAccessToCard } from "./db-symbol-access.js";

/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/api.js").ViewEdge} ViewEdge */
/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../contracts/tool-results.js").SymbolHit} SymbolHit */
/** @typedef {import("../contracts/tool-results.js").SymbolCard} SymbolCard */
/** @typedef {import("../contracts/tool-results.js").SymbolLocation} SymbolLocation */
/** @typedef {import("../contracts/tool-results.js").SymbolId} SymbolId */
/** @typedef {import("../contracts/tool-params.js").CardDetail} CardDetail */

/**
 * Opaque symbol identifier used in tool results. Always built from a
 * (content_hash, local_id) pair so the same symbol gets the same ID
 * across views.
 *
 * @param {{ content_hash: string, local_id: number }} args
 * @returns {SymbolId}
 */
export function symbolIdOf({ content_hash, local_id }) {
  return `${content_hash}:${local_id}`;
}

/**
 * Inverse of symbolIdOf. Returns null for malformed IDs rather than
 * throwing — callers can decide whether to error or skip.
 *
 * @param {string} id
 * @returns {{ content_hash: string, local_id: number } | null}
 */
export function parseSymbolId(id) {
  if (typeof id !== "string") return null;
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) return null;
  const ch = id.slice(0, idx);
  const lid = Number(id.slice(idx + 1));
  if (!/^[0-9a-f]{64}$/.test(ch) || !Number.isInteger(lid) || lid < 0) return null;
  return { content_hash: ch, local_id: lid };
}

/**
 * Build a SymbolLocation from a ViewSymbol's persisted byte and line
 * ranges. Parsers compute `range_start_line` / `range_end_line` at
 * ingest time (see `attachLineRanges` in parser/languages/common.js), so
 * the typical path needs no source string.
 *
 * `opts.source` is used for the buffer-overlay path, where the symbol
 * comes from an in-memory ParseResult that may not yet carry stored
 * lines (or the caller wants to recompute against an edited buffer).
 *
 * @param {ViewSymbol} sym
 * @param {{ source?: string }} [opts]
 * @returns {SymbolLocation}
 */
export function locationOf(sym, opts = {}) {
  const { source } = opts;
  // Prefer persisted line columns when present. Legacy rows / overlays
  // that don't carry them fall through to source-driven computation.
  const persistedStart = Number.isInteger(sym.range_start_line) && sym.range_start_line > 0
    ? sym.range_start_line
    : null;
  const persistedEnd = Number.isInteger(sym.range_end_line) && sym.range_end_line > 0
    ? sym.range_end_line
    : null;
  if (persistedStart != null && persistedEnd != null) {
    return {
      repo_rel_path: sym.repo_rel_path,
      startLine: persistedStart,
      endLine: persistedEnd,
      startByte: sym.range_start,
      endByte: sym.range_end,
    };
  }
  if (!source) {
    return {
      repo_rel_path: sym.repo_rel_path,
      startLine: 1,
      endLine: 1,
      startByte: sym.range_start,
      endByte: sym.range_end,
    };
  }
  // Source-driven fallback: walk newlines once.
  let startLine = 1;
  let endLine = 1;
  const startOff = Math.max(0, sym.range_start || 0);
  // For the end line we want the line of the LAST char in the range,
  // not the line of the char immediately after, so an end exactly on a
  // newline doesn't over-count.
  const endProbe = sym.range_end > startOff ? sym.range_end - 1 : startOff;
  const limit = Math.min(Math.max(endProbe, startOff) + 1, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10) {
      if (i < startOff) startLine++;
      if (i < endProbe + 1) endLine++;
    }
  }
  return {
    repo_rel_path: sym.repo_rel_path,
    startLine,
    endLine,
    startByte: sym.range_start,
    endByte: sym.range_end,
  };
}

/**
 * Cheap etag derived from the structural fields we know the consumer
 * cares about. Stable across view rebuilds so long as the underlying
 * content is unchanged. Accepts either ViewSymbol or the raw SymbolRow
 * since the inputs (content_hash, local_id, signature_hash) are on both.
 *
 * @param {ViewSymbol | SymbolRow} sym
 * @returns {string}
 */
export function etagOf(sym) {
  return `s:${sha256Hex(`${sym.content_hash}:${sym.local_id}:${sym.signature_hash}`).slice(0, 16)}`;
}

/**
 * @param {ViewSymbol} sym
 * @returns {SymbolHit}
 */
export function symbolHit(sym) {
  /** @type {SymbolHit} */
  const hit = {
    symbolId: symbolIdOf(sym),
    name: sym.name,
    kind: sym.kind,
    lang: sym.lang,
    location: locationOf(sym),
  };
  if (sym.qualified_name) hit.qualifiedName = sym.qualified_name;
  return hit;
}

/**
 * Build the SymbolCard skeleton from either a ViewSymbol or a raw
 * SymbolRow. Used both by `buildSymbolCard` (the View-backed path)
 * and by handlers that only have ledger blob data (review.delta,
 * review.analyze).
 *
 * `path` overrides the symbol's own `repo_rel_path`. SymbolRow from
 * the Ledger carries an empty path (the ledger is path-agnostic per
 * blob), so callers using ledger data MUST pass `path`.
 *
 * Detail levels:
 *   - "minimal": only identity + location, signature/summary stay null
 *   - default:   synthesize signature, copy doc as summary
 *
 * @param {{
 *   symbol: ViewSymbol | SymbolRow,
 *   detail?: CardDetail,
 *   path?: string,
 * }} args
 * @returns {SymbolCard}
 */
export function bareSymbolCard({ symbol, detail = "compact", path }) {
  const repoRelPath = path ?? symbol.repo_rel_path;
  // SymbolRow from the Ledger carries `range_start_line` / `range_end_line`
  // when present; legacy rows default to 1. Honor the persisted values so
  // ledger-driven callers (review.delta, review.analyze) emit accurate
  // line anchors instead of the hard-coded (1, 1) placeholder.
  const persistedStart = Number.isInteger(/** @type {any} */ (symbol).range_start_line)
    && /** @type {any} */ (symbol).range_start_line > 0
    ? /** @type {any} */ (symbol).range_start_line
    : 1;
  const persistedEnd = Number.isInteger(/** @type {any} */ (symbol).range_end_line)
    && /** @type {any} */ (symbol).range_end_line > 0
    ? /** @type {any} */ (symbol).range_end_line
    : 1;
  const location = {
    repo_rel_path: repoRelPath,
    startLine: persistedStart,
    endLine: persistedEnd,
    startByte: symbol.range_start,
    endByte: symbol.range_end,
  };
  return applyDbAccessToCard({
    symbolId: symbolIdOf(symbol),
    name: symbol.name,
    qualifiedName: symbol.qualified_name,
    kind: symbol.kind,
    lang: symbol.lang,
    location,
    signature: detail === "minimal" ? null : signatureFromSymbol(symbol),
    summary: detail === "minimal" ? null : summaryFromSymbol(symbol),
    etag: etagOf(symbol),
  });
}

/**
 * Build a SymbolCard from a view symbol. `detail` controls how much we
 * populate; "minimal" / "signature" omit callers/callees, "compact"
 * populates them with caps, "full" loads everything.
 *
 * @param {{
 *   symbol: ViewSymbol,
 *   view: View,
 *   detail?: CardDetail,
 *   minCallConfidence?: number,
 *   includeResolutionMetadata?: boolean,
 * }} args
 * @returns {SymbolCard}
 */
export function buildSymbolCard(args) {
  const {
    symbol,
    view,
    detail = "compact",
    minCallConfidence = 0,
    includeResolutionMetadata = false,
  } = args;
  const card = bareSymbolCard({ symbol, detail });
  // ViewSymbol carries `range_start_line` / `range_end_line` from the
  // view-build path; `locationOf` honors them. Legacy rows fall back to
  // (1, 1), matching pre-line-anchors behavior.
  card.location = locationOf(symbol);

  if (detail !== "minimal" && detail !== "signature") {
    const callerCap = detail === "full" ? 100 : 25;
    const calleeCap = detail === "full" ? 100 : 25;
    const callers = visibleEndpointEdges({
      view,
      endpoint: "from",
      edges: view.query
        .callers(symbol.global_id)
        .filter((e) => e.confidence / 100 >= minCallConfidence),
    }).slice(0, callerCap);
    const callees = visibleEndpointEdges({
      view,
      endpoint: "to",
      edges: view.query
        .callees(symbol.global_id)
        .filter((e) => e.confidence / 100 >= minCallConfidence),
    }).slice(0, calleeCap);
    enrichCardWithEdges(card, symbol, callers, callees, detail);
    // For callers, resolve the FROM endpoint; for callees, resolve the
    // TO endpoint. Without this split, a self-edge in either direction
    // would collapse the wrong side.
    card.callers = callers.map((e) => edgeAsHit(view, e, "from"));
    card.callees = callees.map((e) => edgeAsHit(view, e, "to"));
  } else if (detail !== "minimal") {
    enrichCardWithEdges(card, symbol, [], [], detail);
  }

  if (includeResolutionMetadata) {
    card.resolution = resolutionMetadataFor(symbol);
  }
  return card;
}

/**
 * Keep low-level parser locals available in the raw graph while filtering
 * them out of card caller/callee presentation.
 *
 * @param {{ view: View, edges: ViewEdge[], endpoint: "from" | "to" }} args
 * @returns {ViewEdge[]}
 */
function visibleEndpointEdges({ view, edges, endpoint }) {
  /** @type {ViewEdge[]} */
  const out = [];
  const seen = new Set();
  for (const edge of edges) {
    const target = edgeEndpointSymbol(view, edge, endpoint);
    if (target) {
      if (!isDefaultVisibleSymbol(target)) continue;
    } else if (endpoint === "to" && isNoisyLocalSymbol(/** @type {any} */ ({
      name: edge.to_name,
      kind: "function",
      lang: "",
      repo_rel_path: edge.repo_rel_path,
    }))) {
      continue;
    }
    const key = edgeEndpointDedupeKey(edge, endpoint, target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/**
 * @param {View} view
 * @param {ViewEdge} edge
 * @param {"from" | "to"} endpoint
 * @returns {import("../contracts/api.js").ViewSymbol | null}
 */
function edgeEndpointSymbol(view, edge, endpoint) {
  const gid = endpoint === "from" ? edge.from_global_id : edge.to_global_id;
  return gid != null ? view.query.getSymbol(gid) : null;
}

/**
 * @param {ViewEdge} edge
 * @param {"from" | "to"} endpoint
 * @param {import("../contracts/api.js").ViewSymbol | null} target
 */
function edgeEndpointDedupeKey(edge, endpoint, target) {
  const id = target
    ? String(target.global_id)
    : `unresolved:${edge.to_name}:${edge.repo_rel_path}:${edge.range_start_line}`;
  return `${endpoint}:${edge.kind}:${id}`;
}

/**
 * Derive a SymbolCard.resolution block from signals actually present on
 * the symbol. We don't have the legacy atlas-mcp confidence rerank yet
 * (Workstream H), so the values here are calibrated off what the parser
 * preserved into the view: a fully-qualified name and a signature hash
 * are the strongest "we know exactly which symbol this is" signals.
 *
 * @param {ViewSymbol} sym
 * @returns {{ confidence: number, method: string }}
 */
function resolutionMetadataFor(sym) {
  const hasQname = !!sym.qualified_name;
  const hasSignature = !!sym.signature_hash;
  if (hasQname && hasSignature) {
    return { confidence: 0.9, method: "ast-qname" };
  }
  if (hasSignature) {
    return { confidence: 0.7, method: "ast-name" };
  }
  return { confidence: 0.5, method: "ast-partial" };
}

/**
 * @param {ViewSymbol | SymbolRow} sym
 * @returns {string}
 */
function signatureFromSymbol(sym) {
  if (typeof sym.signature_text === "string" && sym.signature_text.trim()) {
    return sym.signature_text.trim();
  }
  // Legacy rows may not have raw signature text, so synthesize a compact
  // display string from stable symbol fields.
  const parts = [];
  if (sym.visibility) parts.push(sym.visibility);
  parts.push(sym.kind);
  parts.push(sym.qualified_name || sym.name);
  return parts.join(" ");
}

/**
 * @param {ViewSymbol | SymbolRow} sym
 * @returns {string | null}
 */
function summaryFromSymbol(sym) {
  if (typeof sym.doc === "string" && sym.doc.trim()) return sym.doc.trim();
  const visibility = sym.visibility ? `${sym.visibility} ` : "";
  const qualified = sym.qualified_name || sym.name;
  const lang = languageLabel(sym.lang);
  return `${visibility}${lang} ${sym.kind} ${qualified} in ${sym.repo_rel_path}.`;
}

/**
 * @param {SymbolCard} card
 * @param {ViewSymbol} symbol
 * @param {ViewEdge[]} callers
 * @param {ViewEdge[]} callees
 * @param {CardDetail} detail
 */
function enrichCardWithEdges(card, symbol, callers, callees, detail) {
  /** @type {any} */ (card).detailLevel = detail;
  if (symbol.visibility) /** @type {any} */ (card).visibility = symbol.visibility;

  const deps = depsFromEdges(callees);
  if (Object.keys(deps).length > 0) {
    /** @type {any} */ (card).deps = deps;
  }

  /** @type {any} */ (card).metrics = {
    fanIn: callers.length,
    fanOut: callees.length,
    callFanIn: callers.filter((e) => e.kind === "calls").length,
    callFanOut: callees.filter((e) => e.kind === "calls").length,
    importCount: callees.filter((e) => e.kind === "imports").length,
    unresolvedFanOut: callees.filter((e) => e.to_global_id == null && e.to_external_id == null).length,
  };
}

/**
 * @param {ViewEdge[]} edges
 * @returns {Record<string, string[]>}
 */
function depsFromEdges(edges) {
  /** @type {Record<string, string[]>} */
  const buckets = {};
  for (const edge of edges) {
    const key = depKeyForEdge(edge.kind);
    if (!key) continue;
    const label = depLabel(edge);
    if (!label) continue;
    const list = buckets[key] || [];
    if (!list.includes(label) && list.length < 25) list.push(label);
    buckets[key] = list;
  }
  for (const key of Object.keys(buckets)) {
    if (buckets[key].length === 0) delete buckets[key];
  }
  return buckets;
}

/**
 * @param {string} kind
 * @returns {string | null}
 */
function depKeyForEdge(kind) {
  switch (kind) {
    case "calls": return "calls";
    case "imports": return "imports";
    case "extends": return "extends";
    case "implements": return "implements";
    case "references":
    case "reads":
    case "writes":
    case "uses_type":
      return "references";
    default:
      return null;
  }
}

/**
 * @param {ViewEdge} edge
 * @returns {string}
 */
function depLabel(edge) {
  return edge.external_descriptor || edge.to_name;
}

/**
 * @param {string} lang
 * @returns {string}
 */
function languageLabel(lang) {
  switch (lang) {
    case "ts": return "TypeScript";
    case "tsx": return "TypeScript";
    case "js": return "JavaScript";
    case "py": return "Python";
    case "rs": return "Rust";
    case "go": return "Go";
    case "cs": return "C#";
    case "cpp": return "C++";
    case "c": return "C";
    case "kt": return "Kotlin";
    case "java": return "Java";
    case "php": return "PHP";
    case "sh": return "shell";
    default: return lang || "code";
  }
}

/**
 * Resolve one endpoint of an edge to a SymbolHit. `endpoint === "from"`
 * for caller-list use (look up the source of the edge); `"to"` for
 * callee-list use (look up the target). Falls back to a synthetic
 * placeholder when the chosen endpoint is unresolved.
 *
 * @param {View} view
 * @param {ViewEdge} edge
 * @param {"from" | "to"} endpoint
 * @returns {SymbolHit}
 */
function edgeAsHit(view, edge, endpoint) {
  const gid = endpoint === "from" ? edge.from_global_id : edge.to_global_id;
  if (gid != null) {
    const target = view.query.getSymbol(gid);
    if (target) {
      const hit = symbolHit(target);
      hit.confidence = edge.confidence / 100;
      return hit;
    }
  }
  return {
    symbolId: `unresolved:${edge.to_name}`,
    name: edge.to_name,
    kind: "function",
    lang: "",
    location: edgeLocation(edge),
    confidence: edge.confidence / 100,
  };
}

/**
 * Build a SymbolLocation from a ViewEdge's byte and line ranges. Used
 * for unresolved-callee placeholders so callsite anchors carry real
 * line numbers when the parser persisted them.
 *
 * @param {ViewEdge} edge
 * @returns {SymbolLocation}
 */
function edgeLocation(edge) {
  const startLine = Number.isInteger(/** @type {any} */ (edge).range_start_line)
    && /** @type {any} */ (edge).range_start_line > 0
    ? /** @type {any} */ (edge).range_start_line
    : 1;
  const endLine = Number.isInteger(/** @type {any} */ (edge).range_end_line)
    && /** @type {any} */ (edge).range_end_line > 0
    ? /** @type {any} */ (edge).range_end_line
    : startLine;
  return {
    repo_rel_path: edge.repo_rel_path,
    startLine,
    endLine,
    startByte: edge.range_start,
    endByte: edge.range_end,
  };
}
