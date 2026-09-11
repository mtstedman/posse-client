// @ts-check

const RELATIONSHIP_ORDER = Object.freeze(["caller", "reference"]);
const RELATIONSHIP_SET = new Set(RELATIONSHIP_ORDER);

export const COMPACT_RELATIONSHIP_DEFAULT_LIMIT = 20;
export const COMPACT_RELATIONSHIP_MAX_LIMIT = 100;
export const COMPACT_RELATIONSHIP_DEFAULT_MAX_CHARS = 4_000;

/** @typedef {"caller" | "reference"} CompactRelationship */
/** @typedef {CompactRelationship | "all"} CompactRelationshipMode */
/** @typedef {{relationship: CompactRelationship, file: string, symbolId: string, name: string}} CompactRelationshipEntry */
/** @typedef {{file: string, source: unknown}} SymbolGetAmbiguityCandidate */

/** @param {string} left @param {string} right */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {unknown} value @param {number} fallback @param {number} minimum @param {number} maximum */
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

/** @param {string} code @param {string} message */
function presentationError(code, message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/** @param {unknown} value @returns {CompactRelationshipEntry | null} */
function normalizedRelationshipEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = /** @type {Record<string, unknown>} */ (value);
  const relationship = String(entry.relationship || "");
  const file = String(entry.file || "");
  const symbolId = String(entry.symbolId || "");
  const name = String(entry.name || "");
  if (!RELATIONSHIP_SET.has(relationship) || !file || !symbolId || !name) return null;
  return { relationship: /** @type {CompactRelationship} */ (relationship), file, symbolId, name };
}

/** @param {unknown[]} entries @param {CompactRelationshipMode} mode @returns {CompactRelationshipEntry[]} */
function orderedRelationshipEntries(entries, mode) {
  const allowed = mode === "all" ? RELATIONSHIP_SET : new Set([mode]);
  /** @type {CompactRelationshipEntry[]} */
  const normalized = [];
  for (const value of entries) {
    const entry = normalizedRelationshipEntry(value);
    if (entry && allowed.has(entry.relationship)) normalized.push(entry);
  }
  normalized.sort((left, right) => RELATIONSHIP_ORDER.indexOf(left.relationship) - RELATIONSHIP_ORDER.indexOf(right.relationship)
    || compareText(left.file, right.file)
    || compareText(left.symbolId, right.symbolId)
    || compareText(left.name, right.name));
  const seen = new Set();
  return normalized.filter((entry) => {
    const key = `${entry.relationship}\u0000${entry.file}\u0000${entry.symbolId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {CompactRelationshipEntry[]} entries @param {CompactRelationshipMode} mode */
function mapFromEntries(entries, mode) {
  /** @type {Map<CompactRelationship, Map<string, Map<string, string>>>} */
  const byRelationship = new Map([
    ["caller", new Map()],
    ["reference", new Map()],
  ]);
  for (const entry of entries) {
    const files = byRelationship.get(entry.relationship);
    if (!files) continue;
    const symbols = files.get(entry.file) || new Map();
    symbols.set(entry.symbolId, entry.name);
    files.set(entry.file, symbols);
  }
  /** @param {CompactRelationship} relationship */
  const relationshipMap = (relationship) => {
    const files = byRelationship.get(relationship) || new Map();
    return Object.fromEntries(
      [...files].map(([file, symbols]) => [file, Object.fromEntries(symbols)]),
    );
  };
  if (mode !== "all") return relationshipMap(mode);
  return Object.fromEntries(RELATIONSHIP_ORDER.map((relationship) => [
    relationship,
    relationshipMap(/** @type {CompactRelationship} */ (relationship)),
  ]));
}

/** @param {unknown} input */
function unpackRelationshipInput(input) {
  if (Array.isArray(input)) return { entries: input, meta: null };
  if (!input || typeof input !== "object") return { entries: [], meta: null };
  const record = /** @type {Record<string, any>} */ (input);
  return {
    entries: Array.isArray(record.entries) ? record.entries : [],
    meta: record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? record.meta
      : null,
  };
}

/**
 * Convert neutral relationship entries into the compact symbol.callers map.
 *
 * A native result carrying meta.pagination is already paged. Its entries are
 * never offset a second time. A bare entry array is filtered, deduplicated,
 * ordered, and paged here for the Node-local retrieval path.
 *
 * @param {Array<Record<string, unknown>> | {entries?: Array<Record<string, unknown>>, meta?: Record<string, any>}} input
 * @param {{
 *   mode?: "caller" | "reference" | "all",
 *   limit?: number,
 *   offset?: number,
 *   maxChars?: number,
 *   entriesAlreadyPaged?: boolean,
 *   indexVersion?: string | null,
 *   expectedIndexVersion?: string | null,
 *   indexIncomplete?: boolean,
 * }} [options]
 * @returns {{data: Record<string, unknown>, meta?: {pagination: {
 *   offset: number, limit: number, returned: number, hasMore: boolean,
 *   nextOffset: number | null, indexVersion?: string,
 * }, indexIncomplete: boolean}}}
 */
export function projectCompactSymbolRelationships(input, options = {}) {
  const unpacked = unpackRelationshipInput(input);
  const rawPagination = unpacked.meta?.pagination && typeof unpacked.meta.pagination === "object"
    ? unpacked.meta.pagination
    : null;
  const mode = /** @type {CompactRelationshipMode} */ (options.mode ?? "caller");
  if (mode !== "all" && !RELATIONSHIP_SET.has(mode)) {
    throw presentationError("invalid_relationship_mode", `Unsupported compact relationship mode: ${String(mode)}`);
  }
  const entriesAlreadyPaged = options.entriesAlreadyPaged ?? rawPagination != null;
  const limit = boundedInteger(
    options.limit ?? rawPagination?.limit,
    COMPACT_RELATIONSHIP_DEFAULT_LIMIT,
    1,
    COMPACT_RELATIONSHIP_MAX_LIMIT,
  );
  const offset = boundedInteger(options.offset ?? rawPagination?.offset, 0, 0, 100_000);
  const maxChars = boundedInteger(
    options.maxChars,
    COMPACT_RELATIONSHIP_DEFAULT_MAX_CHARS,
    2,
    Number.MAX_SAFE_INTEGER,
  );
  const indexVersion = String(options.indexVersion ?? rawPagination?.indexVersion ?? "").trim() || null;
  const expectedIndexVersion = String(options.expectedIndexVersion ?? "").trim() || null;
  if (offset > 0 && expectedIndexVersion && expectedIndexVersion !== indexVersion) {
    throw presentationError(
      "index_version_changed",
      `Compact relationship page belongs to index ${expectedIndexVersion}, current index is ${indexVersion || "unknown"}`,
    );
  }

  const ordered = orderedRelationshipEntries(unpacked.entries, mode);
  const available = entriesAlreadyPaged
    ? ordered.slice(0, limit)
    : ordered.slice(offset, offset + limit);
  /** @type {CompactRelationshipEntry[]} */
  const returnedEntries = [];
  for (const entry of available) {
    const candidate = [...returnedEntries, entry];
    if (JSON.stringify(mapFromEntries(candidate, mode)).length > maxChars) {
      if (returnedEntries.length === 0) {
        throw presentationError(
          "compact_relationship_entry_too_large",
          `One compact relationship entry cannot fit the ${maxChars}-character presentation bound`,
        );
      }
      break;
    }
    returnedEntries.push(entry);
  }

  const nativeHasMore = entriesAlreadyPaged && rawPagination?.hasMore === true;
  const pageHasUnreturned = returnedEntries.length < available.length
    || (entriesAlreadyPaged ? ordered.length > available.length : offset + available.length < ordered.length);
  const hasMore = nativeHasMore || pageHasUnreturned;
  if (hasMore && returnedEntries.length === 0) {
    throw presentationError(
      "compact_relationship_page_cannot_advance",
      "Compact relationship pagination reported more entries but returned no usable entry",
    );
  }

  const data = mapFromEntries(returnedEntries, mode);
  const indexIncomplete = options.indexIncomplete === true || unpacked.meta?.indexIncomplete === true;
  const needsMeta = entriesAlreadyPaged || offset > 0 || hasMore || indexIncomplete;
  if (!needsMeta) return { data };
  return {
    data,
    meta: {
      pagination: {
        offset,
        limit,
        returned: returnedEntries.length,
        hasMore,
        nextOffset: hasMore ? offset + returnedEntries.length : null,
        ...(indexVersion ? { indexVersion } : {}),
      },
      indexIncomplete,
    },
  };
}

/** @param {unknown[]} candidates @returns {SymbolGetAmbiguityCandidate[]} */
function normalizedAmbiguityCandidates(candidates) {
  /** @type {SymbolGetAmbiguityCandidate[]} */
  const normalized = [];
  for (const value of candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = /** @type {Record<string, unknown>} */ (value);
    const file = String(candidate.file || "");
    if (!file || candidate.source == null) continue;
    normalized.push({ file, source: candidate.source });
  }
  normalized.sort((left, right) => compareText(left.file, right.file));
  const seenFiles = new Set();
  return normalized.filter((candidate) => {
    if (seenFiles.has(candidate.file)) return false;
    seenFiles.add(candidate.file);
    return true;
  });
}

/** @param {unknown} value */
function traversalRefFromCallback(value) {
  const ref = typeof value === "string"
    ? value
    : (value && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value).ref
      : null);
  return typeof ref === "string" && /^#[A-Za-z0-9]+$/.test(ref) ? ref : null;
}

/**
 * Store each already-bounded ambiguous symbol body as an unseen scoped source
 * traversal and expose only its file/ref choice. The callback owns storage,
 * source metadata, and traversal issuance; it must not mark the body delivered.
 *
 * @param {Array<{file: string, source: unknown}>} candidates
 * @param {{storeSourceTraversalRef: (candidate: {file: string, source: unknown}) => string | {ref: string} | Promise<string | {ref: string}>}} [options]
 * @returns {Promise<Array<{file: string, ref: string}>>}
 */
export async function presentSymbolGetAmbiguityChoices(candidates, options) {
  const storeSourceTraversalRef = options?.storeSourceTraversalRef;
  if (typeof storeSourceTraversalRef !== "function") {
    throw presentationError(
      "missing_source_traversal_store",
      "symbol.get ambiguity presentation requires a scoped source traversal store callback",
    );
  }
  const choices = [];
  for (const candidate of normalizedAmbiguityCandidates(candidates)) {
    const stored = await storeSourceTraversalRef(candidate);
    const ref = traversalRefFromCallback(stored);
    if (!ref) {
      throw presentationError(
        "invalid_source_traversal_ref",
        `Scoped source traversal storage returned no usable ref for ${candidate.file}`,
      );
    }
    choices.push({ file: candidate.file, ref });
  }
  return choices;
}

// ---- code.structure compact projection (P0.4) ------------------------------
// The native structure result is an exact inventory: per-file symbol rows
// carrying a 64-hex ID, an issued handle, name, qualified name, kind, line,
// visibility, and a signature that repeats the qualified name, plus fan-in/out
// counters that are zero whenever edges were not requested. Atlas325 measured
// 291 characters per row; one eight-file directory cost 17.9k characters.
//
// This projection keeps every navigational fact (stable handle, qualified
// ownership, kind, line, non-default visibility, every explicit edge with its
// endpoints and direction, warnings, ambiguity, incompleteness) and removes
// only duplicated representation. Module rows are represented by the file key;
// a namespace row is represented once per file as `namespace`. Fan-in/out is
// emitted only when edges were computed, so "edges disabled" never reads as
// "zero relationships".

export const COMPACT_STRUCTURE_PROJECTION = "compact-structure-v1";
export const COMPACT_STRUCTURE_DEFAULT_MAX_FILES = 12;
export const COMPACT_STRUCTURE_DEFAULT_MAX_CHARS = 6_000;
// Space reserved on the inline page for the evidence/traversal stamps and the
// owner envelope that wrap the model-visible payload after projection.
export const COMPACT_STRUCTURE_ENVELOPE_RESERVE_CHARS = 700;
const STRUCTURE_FILE_REPRESENTED_KINDS = new Set(["module", "namespace"]);
const STRUCTURE_DEFAULT_VISIBILITY = "public";
const STRUCTURE_EDGE_SCOPES = Object.freeze(["internal", "inbound", "outbound"]);
const STRUCTURE_OMITTED_PATH_PREVIEW = 20;

/** @param {unknown} value */
function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null;
}

/** @param {unknown} value */
function textOrNull(value) {
  const text = value == null ? "" : String(value).trim();
  return text ? text : null;
}

/** @param {unknown} value */
function nonNegativeInt(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Stable per-symbol reference: the session handle when the owner issued one,
 * else the canonical ID. Handles are what the model reads back through
 * symbol.get / code.window, so the projection never invents a third key.
 * @param {Record<string, any>} symbol
 */
function symbolReference(symbol) {
  return textOrNull(symbol.symbolHandle) || textOrNull(symbol.symbolId) || null;
}

/**
 * @param {Record<string, any>} symbol
 * @returns {Array<string | number>}
 */
function compactSymbolRow(symbol) {
  const qualified = textOrNull(symbol.qualifiedName) || textOrNull(symbol.name) || "";
  const kind = textOrNull(symbol.kind) || "unknown";
  const line = nonNegativeInt(symbol.line);
  const row = [qualified, kind, line == null ? 0 : line];
  const visibility = textOrNull(symbol.visibility);
  if (visibility && visibility !== STRUCTURE_DEFAULT_VISIBILITY) row.push(visibility);
  return row;
}

/**
 * @param {Record<string, any>} file
 * @param {Map<string, string>} handleById
 */
function compactStructureFile(file, handleById) {
  const path = textOrNull(file.path) || "";
  const rows = Array.isArray(file.symbols) ? file.symbols : [];
  /** @type {Record<string, Array<string | number>>} */
  const symbols = {};
  let namespace = null;
  let represented = 0;
  const ordered = rows
    .map((row) => plainRecord(row))
    .filter((row) => row != null)
    .sort((left, right) => (nonNegativeInt(left.line) ?? 0) - (nonNegativeInt(right.line) ?? 0)
      || compareText(String(left.qualifiedName || left.name || ""), String(right.qualifiedName || right.name || "")));
  for (const row of ordered) {
    const id = textOrNull(row.symbolId);
    const handle = textOrNull(row.symbolHandle);
    if (id && handle) handleById.set(id, handle);
    const kind = textOrNull(row.kind) || "";
    if (STRUCTURE_FILE_REPRESENTED_KINDS.has(kind)) {
      represented += 1;
      if (kind === "namespace" && !namespace) {
        namespace = textOrNull(row.qualifiedName) || textOrNull(row.name);
      }
      continue;
    }
    const ref = symbolReference(row);
    if (!ref) continue;
    // A duplicate reference keeps the first row; a later identical ref cannot
    // add navigational information and would silently overwrite the line.
    if (Object.prototype.hasOwnProperty.call(symbols, ref)) continue;
    symbols[ref] = compactSymbolRow(row);
  }
  return {
    path,
    ...(namespace ? { namespace } : {}),
    symbols,
    // Bookkeeping for the summary only; stripped from the model-facing rows.
    _declared: Object.keys(symbols).length,
    _represented: represented,
  };
}

/** @param {Record<string, any>} file */
function modelFacingStructureFile(file) {
  const { _declared, _represented, ...rest } = file;
  void _declared;
  void _represented;
  return rest;
}

/**
 * @param {Record<string, any>} edge
 * @param {"internal" | "inbound" | "outbound"} scope
 * @param {Map<string, string>} handleById
 */
function compactStructureEdge(edge, scope, handleById) {
  /** @param {string} prefix */
  const endpoint = (prefix) => {
    const id = textOrNull(edge[`${prefix}SymbolId`]);
    const ref = (id && handleById.get(id)) || id || null;
    return {
      ...(ref ? { ref } : {}),
      name: textOrNull(edge[`${prefix}Name`]) || "",
      file: textOrNull(edge[`${prefix}Path`]) || "",
    };
  };
  const site = textOrNull(edge.site);
  return {
    kind: textOrNull(edge.kind) || "unknown",
    from: endpoint("from"),
    to: endpoint("to"),
    ...(site ? { site } : {}),
    scope,
  };
}

/**
 * Project one native code.structure payload into the compact shape. Pure and
 * deterministic: identical input yields identical output regardless of
 * caller. Pagination is a separate step so a full compact payload can also be
 * returned unpaged when continuation storage is unavailable.
 *
 * @param {Record<string, any>} data native structure data (bare or envelope.data)
 * @param {{ edgesRequested?: boolean | null, requestedMaxFiles?: number | null }} [options]
 */
export function projectCompactCodeStructure(data, options = {}) {
  const record = plainRecord(data) || {};
  /** @type {Map<string, string>} */
  const handleById = new Map();
  const files = (Array.isArray(record.files) ? record.files : [])
    .map((file) => plainRecord(file))
    .filter((file) => file != null)
    .map((file) => compactStructureFile(/** @type {Record<string, any>} */ (file), handleById));
  const metrics = plainRecord(record.metrics) || {};
  const requestedKinds = Array.isArray(metrics.edgeKinds)
    ? metrics.edgeKinds.map((kind) => String(kind || "")).filter(Boolean)
    : [];
  const edgeRows = [];
  for (const scope of STRUCTURE_EDGE_SCOPES) {
    const rows = record[`${scope}Edges`];
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const edge = plainRecord(raw);
      if (edge) edgeRows.push(compactStructureEdge(edge, /** @type {any} */ (scope), handleById));
    }
  }
  const explicitRequest = options.edgesRequested;
  const edgesComputed = explicitRequest === false
    ? false
    : (explicitRequest === true || edgeRows.length > 0);
  const counts = {
    internal: nonNegativeInt(metrics.internalEdgeCount),
    inbound: nonNegativeInt(metrics.inboundEdgeCount),
    outbound: nonNegativeInt(metrics.outboundEdgeCount),
  };
  const countEntries = Object.entries(counts).filter(([, value]) => value != null);
  const edges = edgesComputed
    ? {
        computed: true,
        kinds: requestedKinds,
        ...(countEntries.length > 0 ? { counts: Object.fromEntries(countEntries) } : {}),
        rows: edgeRows,
      }
    : { computed: false };
  const fileEdges = edgesComputed && Array.isArray(record.fileEdges) && record.fileEdges.length > 0
    ? record.fileEdges
    : null;
  const fanIn = edgesComputed && Array.isArray(metrics.highestInternalFanIn) && metrics.highestInternalFanIn.length > 0
    ? metrics.highestInternalFanIn
    : null;
  const declared = files.reduce((sum, file) => sum + file._declared, 0);
  const represented = files.reduce((sum, file) => sum + file._represented, 0);
  const truncated = record.truncated === true;
  const requestedMaxFiles = nonNegativeInt(options.requestedMaxFiles);
  const omittedPaths = Array.isArray(record.omittedPaths)
    ? record.omittedPaths.map((value) => textOrNull(value)).filter(Boolean)
    : [];
  const omittedFileCount = nonNegativeInt(record.omittedFileCount);
  const incomplete = truncated
    ? {
        reason: "max_files",
        selectedFiles: files.length,
        ...(requestedMaxFiles != null ? { maxFiles: requestedMaxFiles } : {}),
        ...(omittedFileCount != null ? { omittedFiles: omittedFileCount } : {}),
        ...(omittedPaths.length > 0 ? {
          omittedPathPreview: omittedPaths.slice(0, STRUCTURE_OMITTED_PATH_PREVIEW),
          omittedPathPreviewTruncated: omittedPaths.length > STRUCTURE_OMITTED_PATH_PREVIEW,
        } : {}),
        note: "The index holds more files under the requested paths than the file limit allowed; narrow the paths or raise maxFiles. This is index-side incompleteness, not a stored continuation.",
      }
    : null;
  const indexedSymbols = nonNegativeInt(metrics.symbolCount);
  return {
    projection: COMPACT_STRUCTURE_PROJECTION,
    edges,
    ...(fileEdges ? { fileEdges } : {}),
    ...(fanIn ? { highestInternalFanIn: fanIn } : {}),
    files: files.map(modelFacingStructureFile),
    summary: {
      fileCount: nonNegativeInt(metrics.fileCount) ?? files.length,
      declaredSymbols: declared,
      ...(represented > 0 ? { fileRepresentedRows: represented } : {}),
      ...(indexedSymbols != null ? { indexedSymbols } : {}),
    },
    ...(incomplete ? { incomplete } : {}),
    ...(Array.isArray(record.warnings) && record.warnings.length > 0
      ? { warnings: record.warnings.map((value) => String(value)) }
      : {}),
    ...(record.pathAmbiguity ? { pathAmbiguity: record.pathAmbiguity } : {}),
    ...(record.negativeEvidence ? { negativeEvidence: record.negativeEvidence } : {}),
  };
}

/** @param {unknown} value */
function jsonChars(value) {
  return JSON.stringify(value).length;
}

/**
 * Split a compact projection into ordered pages that each fit `maxChars`.
 * Every page advances: it carries at least one edge row, one file, or one
 * symbol slice of a file too large for a page (marked `continued`). Edges are
 * placed on the first page ahead of any inventory; when even the edge table
 * alone exceeds the page, it is sliced across leading pages. Order is the
 * projection order, so the same input always pages identically.
 *
 * @param {ReturnType<typeof projectCompactCodeStructure>} projected
 * @param {{ maxChars?: number }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function paginateCompactCodeStructure(projected, options = {}) {
  const maxChars = boundedInteger(options.maxChars, COMPACT_STRUCTURE_DEFAULT_MAX_CHARS, 400, Number.MAX_SAFE_INTEGER);
  const { files, edges, ...header } = /** @type {Record<string, any>} */ (projected);
  /** @type {Array<Record<string, any>>} */
  const edgeRows = Array.isArray(edges?.rows) ? edges.rows : [];
  const { rows: _rows, ...edgeHeader } = /** @type {Record<string, any>} */ (edges || { computed: false });
  /** @type {Array<Record<string, any>>} */
  const pages = [];
  /** @param {boolean} first */
  const pageBase = (first) => (first
    ? { ...header, edges: { ...edgeHeader }, files: [] }
    : { projection: header.projection, edges: { ...edgeHeader }, files: [] });
  const openPage = () => {
    /** @type {Record<string, any>} */
    const page = pageBase(pages.length === 0);
    pages.push(page);
    return page;
  };
  // Fit against the page as it will be emitted: the pagination block is
  // attached after slicing, so its space is reserved up front.
  const paginationReserve = { page: 9999, pages: 9999, filesOnPage: 9999, hasMore: true };
  /** @param {unknown} candidate */
  const fits = (candidate) => jsonChars({ .../** @type {any} */ (candidate), pagination: paginationReserve }) <= maxChars;
  let page = openPage();

  // 1. Edge rows, sliced when necessary. A row that fits nowhere alone is
  //    still placed so the page advances rather than looping.
  let placed = 0;
  while (placed < edgeRows.length) {
    const rows = Array.isArray(page.edges.rows) ? page.edges.rows : [];
    const candidateEdges = { ...page.edges, rows: [...rows, edgeRows[placed]] };
    if (rows.length === 0 || fits({ ...page, edges: candidateEdges })) {
      page.edges = candidateEdges;
      placed += 1;
    } else {
      page.edges.continued = true;
      page = openPage();
    }
  }

  // 2. Files, sliced by symbol when a single file exceeds the page.
  for (const file of files) {
    if (fits({ ...page, files: [...page.files, file] })) {
      page.files = [...page.files, file];
      continue;
    }
    const pageHasContent = page.files.length > 0
      || (Array.isArray(page.edges.rows) && page.edges.rows.length > 0);
    if (pageHasContent) page = openPage();
    if (fits({ ...page, files: [file] })) {
      page.files = [file];
      continue;
    }
    const entries = Object.entries(file.symbols || {});
    if (entries.length === 0) {
      page.files = [file];
      continue;
    }
    let index = 0;
    let part = 0;
    while (index < entries.length) {
      /** @type {Record<string, any>} */
      const slice = { ...file, symbols: {}, part: part + 1, continued: true };
      let added = 0;
      while (index < entries.length) {
        const [ref, row] = entries[index];
        const attempt = { ...slice, symbols: { ...slice.symbols, [ref]: row } };
        if (added === 0 || fits({ ...page, files: [...page.files, attempt] })) {
          slice.symbols = attempt.symbols;
          added += 1;
          index += 1;
        } else {
          break;
        }
      }
      if (index >= entries.length) delete slice.continued;
      page.files = [...page.files, slice];
      part += 1;
      if (index < entries.length) page = openPage();
    }
  }
  const total = pages.length;
  // A single page needs no pagination block; the payload is complete as shown.
  if (total > 1) {
    pages.forEach((entry, position) => {
      entry.pagination = {
        page: position + 1,
        pages: total,
        filesOnPage: entry.files.length,
        ...(position + 1 < total ? { hasMore: true } : {}),
      };
    });
  }
  return pages;
}

/**
 * Rows a page set must expose exactly once for the "every retained row once"
 * invariant: `${path} ${ref}` per symbol row and `edge:<n>` per edge row.
 * @param {Array<Record<string, any>>} pages
 */
export function compactCodeStructurePageRows(pages) {
  const rows = [];
  let edgeIndex = 0;
  for (const page of pages) {
    for (const edge of Array.isArray(page?.edges?.rows) ? page.edges.rows : []) {
      rows.push(`edge:${edgeIndex}:${edge.kind}:${edge.from?.ref || edge.from?.name}:${edge.to?.ref || edge.to?.name}`);
      edgeIndex += 1;
    }
    for (const file of Array.isArray(page?.files) ? page.files : []) {
      for (const ref of Object.keys(file.symbols || {})) rows.push(`${file.path} ${ref}`);
    }
  }
  return rows;
}
