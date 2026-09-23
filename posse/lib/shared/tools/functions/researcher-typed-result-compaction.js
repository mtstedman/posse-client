// @ts-check

import { CODE_CONTENT_KINDS } from "../../../catalog/source-display.js";
import { camelToSnakeKey } from "../../../catalog/field-case.js";

const CANONICAL_SYMBOL_ID = /^[0-9a-f]{64}:[0-9]+$/u;
const SYMBOL_HANDLE = /^s[1-9][0-9]{0,5}$/u;

// Cardinality is useful only for content the caller has not received. Keep
// this at the presentation boundary: stored results still serve pagination,
// evidence custody, and other internal consumers with their original fields.
function compactResultCardinality(parsed, action) {
  if (!action || parsed.ok === false || parsed.error) return 0;
  let removed = 0;
  const drop = (value, key) => {
    if (!Object.hasOwn(value, key)) return;
    delete value[key];
    removed += 1;
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "args" && key !== "_meta" && key !== "meta") visit(child);
    }
    // Edge.count is multiplicity, not redundant result-size metadata.
    for (const [total, rows, omitted] of [
      ["symbolCount", "symbols", "omittedSymbols"],
      ["totalSymbols", "symbols", "omittedSymbols"],
      ["filesTotal", "files", "omittedFiles"],
      ["candidateFilesTotal", "candidateFiles", "omittedFiles"],
      ["total", "items", "omitted"],
      ["count", "rows", "omitted"],
      ["callSiteCount", "callSites", "callSitesTruncated"],
      ["observedCallerCount", "callers", "omittedCallers"],
    ]) {
      if (!Array.isArray(value[rows]) || typeof value[total] !== "number") continue;
      // For offset pages, earlier results are already delivered, not missing.
      const offset = rows === "items" || rows === "callers" ? Math.max(0, Number(value.offset) || 0) : 0;
      const missing = Math.max(0, value[total] - offset - value[rows].length);
      if (missing > 0) {
        value[omitted] = missing;
        if (!omitted.endsWith("Truncated")) value.truncated = true;
      }
      drop(value, total);
    }
    for (const key of Object.keys(value)) {
      if ((key === "truncated" || key.endsWith("Truncated")) && (value[key] === false || value[key] === 0)) drop(value, key);
      if ((key === "omitted" || key.startsWith("omitted")) && value[key] === 0) drop(value, key);
    }
    if (Array.isArray(value.callers)) drop(value, "observedCallSiteCount");
    if (value.usage === "fetch_missing_content") drop(value, "count");
    if (value.pagination && typeof value.pagination === "object") {
      const page = value.pagination;
      if (typeof page.pages === "number" && typeof page.page === "number") {
        const missing = Math.max(0, page.pages - page.page);
        if (missing > 0) { page.omittedPages = missing; value.truncated = true; }
        drop(page, "pages");
        drop(page, "page");
      }
      for (const key of ["returned", "filesOnPage"]) drop(page, key);
      if (Object.keys(page).length === 0) drop(value, "pagination");
    }
  };
  const data = parsed.data || parsed;
  if (action === "code.survey" || parsed.action === "code.survey.page") {
    const survey = data.survey || data;
    const metrics = survey.metrics;
    if (survey.callMap) {
      for (const kind of ["edges", "inbound", "outbound"]) {
        const omitted = survey.callMap[`${kind}Omitted`];
        if (typeof omitted === "number") survey.callMap[`${kind}Truncated`] = omitted;
        drop(survey.callMap, `${kind}Omitted`);
      }
    }
    if (survey.callMap && metrics) {
      const missing = Math.max(0, (metrics.unresolvedCount || 0) - (survey.callMap.unresolved?.length || 0));
      if (missing > 0) survey.callMap.unresolvedTruncated = missing;
      // Modern native results count omitted aggregated rows directly. Older
      // boolean flags remain truthful when an exact row count is unavailable;
      // raw-call totals cannot be subtracted from grouped-row counts.
      drop(survey, "metrics");
    }
    const files = data.files || [];
    const hiddenSymbols = files.some((file) => file.truncated === true || file.symbolCount > (file.symbols?.length || 0));
    if (!hiddenSymbols && data.traversal_ref?.kind === "survey_page") drop(data, "traversal_ref");
    const cursor = data.pagination?.cursor;
    if (cursor?.traversal_ref) data.traversal_ref = cursor.traversal_ref;
    if (data.pagination && Array.isArray(data.files)) {
      const total = data.pagination.totalFiles;
      const end = Number(String(data.pagination.current?.ranks || "").split("-").at(-1));
      const missing = Math.max(0, (Number(total) || 0) - (end || files.length));
      if (missing > 0) { data.omittedFiles = missing; data.truncated = true; }
      // Keep unfamiliar cursor shapes usable, even from an older backend.
      if (!cursor || cursor.traversal_ref) drop(data, "pagination");
    }
  }
  if (action === "code.structure") {
    // These summarize the same visible inventory. They are not completeness
    // bounds: file-represented symbols and grouped edges use different units.
    if (data.summary) {
      for (const key of ["fileCount", "declaredSymbols", "fileRepresentedRows", "indexedSymbols"]) drop(data.summary, key);
      if (Object.keys(data.summary).length === 0) drop(data, "summary");
    }
    if (data.edges?.counts) drop(data.edges, "counts");
    if (data.incomplete) {
      for (const key of ["selectedFiles", "maxFiles"]) drop(data.incomplete, key);
    }
  }
  visit(parsed);
  return removed;
}

/**
 * Replace internal skeleton row addresses with the owner's existing session
 * handles. Only generated maps are eligible; source text stays byte-for-byte.
 * @param {string} text
 * @param {(symbolId: string, file: string) => string | null} issueHandle
 * @returns {{text: string, issued: number} | null}
 */
export function compactSkeletonSymbolHandles(text, issueHandle) {
  const suffixAt = text.indexOf("\n\n[");
  const jsonText = suffixAt >= 0 ? text.slice(0, suffixAt) : text;
  const suffix = suffixAt >= 0 ? text.slice(suffixAt) : "";
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return null; }
  const map = parsed?.data || parsed;
  if (!map || typeof map.content !== "string"
    || ![CODE_CONTENT_KINDS.SUMMARY, CODE_CONTENT_KINDS.INDEXED_SIGNATURES].includes(map.contentKind)) return null;
  const file = String(map.repo_rel_path || map.path || "");
  let issued = 0;
  const content = map.content.replace(/  \[symbolId=([0-9a-f]{64}:[0-9]+)\]$/gmu, (_match, id) => {
    const handle = issueHandle(id, file);
    // Exhausted sessions omit the selector rather than exposing an internal ID.
    if (!handle || !SYMBOL_HANDLE.test(handle)) return "";
    issued += 1;
    return `  [symbol_id=${handle}]`;
  });
  if (content === map.content) return null;
  map.content = content;
  return { text: `${JSON.stringify(parsed)}${suffix}`, issued };
}

/**
 * Remove transport-only or invariant fields from one typed Atlas JSON result.
 * Exact source, relationships, identifiers found, non-empty exceptions, short
 * handles, and the model-control suffix remain intact.
 *
 * @param {string} text
 * @param {{ action?: string | null, args?: Record<string, unknown> | null, metadataOnly?: boolean }} [options]
 * @returns {{
 *   text: string,
 *   removedCanonicalSymbolIds: number,
 *   removedDigestFields: number,
 *   removedDefaultFields: number,
 * } | null}
 */
export function compactResearcherTypedAtlasText(text, { action = null, args = null, metadataOnly = false } = {}) {
  if (typeof text !== "string") return null;
  const suffixAt = text.indexOf("\n\n[");
  const jsonText = suffixAt >= 0 ? text.slice(0, suffixAt) : text;
  const suffix = suffixAt >= 0 ? text.slice(suffixAt) : "";
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const compactCardinality = action !== "code.skeleton"
    || [CODE_CONTENT_KINDS.SUMMARY, CODE_CONTENT_KINDS.INDEXED_SIGNATURES].includes((parsed.data || parsed).contentKind);

  let removedCanonicalSymbolIds = 0;
  let removedDigestFields = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) visit(child);
    if (
      typeof value.symbolId === "string"
      && CANONICAL_SYMBOL_ID.test(value.symbolId)
      && SYMBOL_HANDLE.test(String(value.symbolHandle || ""))
    ) {
      delete value.symbolId;
      removedCanonicalSymbolIds += 1;
    }
    for (const field of ["contentSha256", "content_hash"]) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      delete value[field];
      removedDigestFields += 1;
    }
  };
  if (!metadataOnly) visit(parsed);

  let removedDefaultFields = 0;
  if (action === "code.skeleton" && parsed.ok !== false && !parsed.error) {
    const map = parsed.data || parsed;
    // Only generated outlines lose their map-row coordinates and provenance.
    // Legacy exact-source responses still need those fields for source display.
    if ([CODE_CONTENT_KINDS.SUMMARY, CODE_CONTENT_KINDS.INDEXED_SIGNATURES].includes(map.contentKind)) {
      const truncated = map.truncated === true || map.outputTruncated === true
        || map.omittedSymbols > 0
        || (map.complete === false && !map.degradedReason)
        || !!map.next_traversal_ref || !!map.nextTraversalRef;  // legacy stored payloads
      for (const field of [
        "contentKind", "startLine", "endLine", "matchStatus", "complete",
        "totalSymbols", "returnedSymbols", "etag", "outputTruncated",
      ]) {
        if (!Object.hasOwn(map, field)) continue;
        delete map[field];
        removedDefaultFields += 1;
      }
      if (truncated) map.truncated = true;
      else if (Object.hasOwn(map, "truncated")) {
        delete map.truncated;
        removedDefaultFields += 1;
      }
      if (Object.hasOwn(map, "omittedSymbols") && !(map.omittedSymbols > 0)) {
        delete map.omittedSymbols;
        removedDefaultFields += 1;
      }
      for (const [owner, key] of [[map, "_meta"], [parsed, "meta"]]) {
        const meta = owner[key];
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
        if (Object.hasOwn(meta, "etag")) {
          delete meta.etag;
          removedDefaultFields += 1;
        }
        if (Object.keys(meta).length === 0) {
          delete owner[key];
          removedDefaultFields += 1;
        }
      }
    }
  }
  if (!metadataOnly && action === "symbol.search") {
    const query = String(args?.query || "").trim();
    const exactNameRequest = String(args?.scope || "").trim().toLowerCase() === "name"
      && args?.semantic !== true
      && /^[A-Za-z_$][A-Za-z0-9_$.:#-]*$/u.test(query)
      && Array.isArray(parsed.items)
      && parsed.items.length > 0;
    if (exactNameRequest && Array.isArray(parsed.beam)) {
      delete parsed.beam;
      removedDefaultFields += 1;
    }
    const meta = parsed._meta;
    if (exactNameRequest && meta && typeof meta === "object" && !Array.isArray(meta)) {
      for (const field of [
        "backendHealth",
        "retrievalPolicy",
        "candidateDepth",
        "separation",
        "prefetch",
        "scopeBeam",
      ]) {
        if (!Object.prototype.hasOwnProperty.call(meta, field)) continue;
        delete meta[field];
        removedDefaultFields += 1;
      }
      if (Object.keys(meta).length === 0) {
        delete parsed._meta;
        removedDefaultFields += 1;
      }
    }
  }
  if (!metadataOnly && (action === "code.window" || action === "symbol.get")) {
    if (parsed.bodyKind === "implementation") {
      delete parsed.bodyKind;
      removedDefaultFields += 1;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "estimatedTokens")) {
      delete parsed.estimatedTokens;
      removedDefaultFields += 1;
    }
    for (const field of ["truncated", "outputTruncated"]) {
      if (parsed[field] !== false) continue;
      delete parsed[field];
      removedDefaultFields += 1;
    }
    const identifiersComplete = (
      Array.isArray(parsed.identifiersReturned)
      && Array.isArray(parsed.identifiersFound)
      && JSON.stringify(parsed.identifiersReturned) === JSON.stringify(parsed.identifiersFound)
      && Array.isArray(parsed.identifiersMissing)
      && parsed.identifiersMissing.length === 0
      && Array.isArray(parsed.identifiersOmitted)
      && parsed.identifiersOmitted.length === 0
    );
    if (identifiersComplete) {
      delete parsed.identifiersReturned;
      delete parsed.identifiersMissing;
      delete parsed.identifiersOmitted;
      parsed.identifiersComplete = true;
      removedDefaultFields += 3;
    } else {
      for (const field of ["identifiersMissing", "identifiersOmitted"]) {
        if (!Array.isArray(parsed[field]) || parsed[field].length !== 0) continue;
        delete parsed[field];
        removedDefaultFields += 1;
      }
    }
    if (parsed.map && typeof parsed.map === "object" && parsed.map.version === 2) {
      delete parsed.map.version;
      removedDefaultFields += 1;
    }
  }

  // Unknown/source skeletons retain their exact-source completeness contract.
  if (compactCardinality) removedDefaultFields += compactResultCardinality(parsed, action);
  const compacted = `${JSON.stringify(parsed)}${suffix}`;
  if (compacted === text) return null;
  return {
    text: compacted,
    removedCanonicalSymbolIds,
    removedDigestFields,
    removedDefaultFields,
  };
}

// Result keys that belong to the MCP envelope rather than the payload.
const PROTOCOL_FIELDS = new Set(["isError", "structuredContent", "_meta"]);

const TYPED_OUTPUT_FIELD_ALIASES = Object.freeze([
  ["repo_rel_path", "path"],
  ["repoRelPath", "path"],
  ["file", "path"],
  ["content_block", "contentBlock"],
  ["content_line_format", "contentLineFormat"],
  ["content_next_block", "contentInNextBlock"],
  ["source_blocks_follow", "sourceBlocksFollow"],
  ["object_type", "objectType"],
  ["content_hash", "contentHash"],
  ["size_chars", "sizeChars"],
  ["handoff_line_count", "handoffLineCount"],
  ["handoff_requires_slice", "handoffRequiresSlice"],
  ["start_line", "startLine"],
  ["end_line", "endLine"],
  ["source_start_line", "startLine"],
  ["source_end_line", "endLine"],
  ["materialized_start_line", "materializedStartLine"],
  ["source_ranges", "sourceRanges"],
  ["next_offset", "nextOffset"],
  ["has_more", "hasMore"],
  ["returned_chars", "returnedChars"],
  ["original_returned_chars", "originalReturnedChars"],
  ["full_size_chars", "fullSizeChars"],
  ["emitted_size_chars", "emittedSizeChars"],
  ["original_size_chars", "originalSizeChars"],
  ["serialized_shrunk", "serializedShrunk"],
  ["match_count", "matchCount"],
  ["truncated_match_rows", "truncatedMatchRows"],
  ["search_mode", "searchMode"],
  ["requested_search_mode", "requestedSearchMode"],
  ["search_error", "searchError"],
  ["identifiersFound", "found"],
  ["identifiersFoundInText", "foundInText"],
  ["identifiersReturned", "returned"],
  ["identifiersMissing", "missing"],
  ["identifiersOmitted", "omitted"],
  ["identifiersComplete", "complete"],
]);

function mergeFacadeField(current, incoming) {
  if (current === undefined) return incoming;
  if (Array.isArray(current) && Array.isArray(incoming)) {
    return [...new Set([...current, ...incoming].map(String))];
  }
  return current;
}

/**
 * Canonicalize only the model-visible typed Atlas facade. Native envelopes,
 * source-custody stages, and internal consumers continue to use their pinned
 * version-coupled contracts; this runs after those stages finish.
 *
 * @param {string} text
 * @param {{ action?: string | null }} [options]
 * @returns {{text: string, renamedFields: number} | null}
 */
export function normalizeResearcherTypedAtlasFieldNames(text, { action = null } = {}) {
  if (typeof text !== "string") return null;
  const suffixAt = text.indexOf("\n\n[");
  const jsonText = suffixAt >= 0 ? text.slice(0, suffixAt) : text;
  const suffix = suffixAt >= 0 ? text.slice(suffixAt) : "";
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  let renamedFields = 0;
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    // Embedded calls use the native input contract, not result field names.
    for (const [key, child] of Object.entries(value)) {
      if (key !== "args") visit(child);
    }
    if (typeof value.symbolHandle === "string" && value.symbolHandle) {
      value.symbolId = value.symbolHandle;
      delete value.symbolHandle;
      renamedFields += 1;
    }
    for (const [legacy, canonical] of TYPED_OUTPUT_FIELD_ALIASES) {
      if (!Object.prototype.hasOwnProperty.call(value, legacy)) continue;
      value[canonical] = mergeFacadeField(value[canonical], value[legacy]);
      delete value[legacy];
      renamedFields += 1;
    }
    if (
      typeof value.ref === "string"
      && typeof value.name === "string"
      && typeof value.path === "string"
    ) {
      value.symbolId = mergeFacadeField(value.symbolId, value.ref);
      delete value.ref;
      renamedFields += 1;
    }
    if (Object.prototype.hasOwnProperty.call(value, "outputTruncated")) {
      value.truncated = value.truncated === true || value.outputTruncated === true;
      delete value.outputTruncated;
      renamedFields += 1;
    }
    if (typeof value.text === "string") {
      try {
        const header = JSON.parse(value.text);
        if (header && typeof header === "object" && Array.isArray(header.requestedWindows)) {
          const renamedBeforeHeader = renamedFields;
          visit(header);
          if (renamedFields > renamedBeforeHeader) value.text = JSON.stringify(header);
        }
      } catch {
        // Raw traversal source is intentionally opaque to facade normalization.
      }
    }
    if (
      (action === "symbol.callers"
        || Object.prototype.hasOwnProperty.call(value, "caller")
        || Object.prototype.hasOwnProperty.call(value, "reference"))
      && (Object.prototype.hasOwnProperty.call(value, "caller")
        || Object.prototype.hasOwnProperty.call(value, "reference"))
    ) {
      const calledFrom = value.calledFrom && typeof value.calledFrom === "object" && !Array.isArray(value.calledFrom)
        ? { ...value.calledFrom }
        : {};
      if (Object.prototype.hasOwnProperty.call(value, "caller")) calledFrom.calls = value.caller;
      if (Object.prototype.hasOwnProperty.call(value, "reference")) calledFrom.references = value.reference;
      delete value.caller;
      delete value.reference;
      value.calledFrom = calledFrom;
      renamedFields += 1;
    }
    // One convention on the agent surface: every remaining camelCase key
    // becomes snake_case after the explicit aliases run. MCP protocol fields
    // are not payload data and keep their wire spelling.
    for (const key of Object.keys(value)) {
      if (PROTOCOL_FIELDS.has(key)) continue;
      const snake = camelToSnakeKey(key);
      if (snake === key) continue;
      value[snake] = mergeFacadeField(value[snake], value[key]);
      delete value[key];
      renamedFields += 1;
    }
  };
  visit(parsed);

  if (renamedFields === 0) return null;
  return { text: `${JSON.stringify(parsed)}${suffix}`, renamedFields };
}
