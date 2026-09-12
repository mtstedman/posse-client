// @ts-check

const CANONICAL_SYMBOL_ID = /^[0-9a-f]{64}:[0-9]+$/u;
const SYMBOL_HANDLE = /^s[1-9][0-9]{0,5}$/u;

/**
 * Remove transport-only or invariant fields from one typed Atlas JSON result.
 * Exact source, relationships, identifiers found, non-empty exceptions, short
 * handles, and the model-control suffix remain intact.
 *
 * @param {string} text
 * @param {{ action?: string | null, args?: Record<string, unknown> | null }} [options]
 * @returns {{
 *   text: string,
 *   removedCanonicalSymbolIds: number,
 *   removedDigestFields: number,
 *   removedDefaultFields: number,
 * } | null}
 */
export function compactResearcherTypedAtlasText(text, { action = null, args = null } = {}) {
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
  visit(parsed);

  let removedDefaultFields = 0;
  if (action === "symbol.search") {
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
  if (action === "code.window" || action === "symbol.get") {
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

  const compacted = `${JSON.stringify(parsed)}${suffix}`;
  if (compacted === text) return null;
  return {
    text: compacted,
    removedCanonicalSymbolIds,
    removedDigestFields,
    removedDefaultFields,
  };
}

const TYPED_OUTPUT_FIELD_ALIASES = Object.freeze([
  ["repo_rel_path", "path"],
  ["repoRelPath", "path"],
  ["file", "path"],
  ["content_block", "contentBlock"],
  ["content_line_format", "contentLineFormat"],
  ["content_next_block", "contentInNextBlock"],
  ["source_blocks_follow", "sourceBlocksFollow"],
  ["next_traversal_ref", "nextTraversalRef"],
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
  };
  visit(parsed);

  if (renamedFields === 0) return null;
  return { text: `${JSON.stringify(parsed)}${suffix}`, renamedFields };
}
