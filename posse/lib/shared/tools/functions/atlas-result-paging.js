import { hashRefModelVisibility } from "./fetch-ref-policy.js";
import { traversalRefSurface } from "./ref-surface.js";
import { surfaceHashRefForContext } from "../../../domains/queue/functions/hash-refs.js";
import {
  COMPACT_STRUCTURE_DEFAULT_MAX_CHARS,
  COMPACT_STRUCTURE_ENVELOPE_RESERVE_CHARS,
  COMPACT_STRUCTURE_PROJECTION,
  compactCodeStructurePageRows,
  paginateCompactCodeStructure,
  projectCompactCodeStructure,
} from "../../../domains/atlas/functions/v2/retrieval/compact-presentation.js";
import { contextForHashRefs, hasHashRefScope, recordHashSurfaceFailure } from "./hash-ref-context.js";

// ---- code.survey snapshot paging -------------------------------------------
// A survey is materialized once as ordinary hash-map pages. Page 1 owns the
// survey-wide call map/metrics and the first bounded file page; every page owns
// a small file set and carries a backed traversal_ref cursor to the next page.
// There is deliberately no second, monolithic copy of the full survey.
const SURVEY_PAGE_FILES = 10;

function surveyFetchCursor(page) {
  if (!page?.ref) return null;
  const traversalRef = traversalRefSurface(page.ref, {
    kind: "survey_page",
    ranks: page.ranks,
    count: page.count,
  });
  return {
    label: `next ${page.count}`,
    call: "atlas.traverse_ref",
    args: { traversal_ref: page.ref },
    traversal_ref: traversalRef,
    ranks: page.ranks,
    count: page.count,
  };
}

// Keep flat records compact but retain record boundaries for line-oriented
// traversal/search. A single-line page would turn every match into a full read.
function compactSurveyJson(value) {
  if (Array.isArray(value)) return `[${value.map(compactSurveyJson).join(",\n")}]`;
  if (value && typeof value === "object" && Object.values(value).some(child => child && typeof child === "object")) {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${JSON.stringify(key)}:${compactSurveyJson(child)}`).join(",\n")}}`;
  }
  return JSON.stringify(value);
}

export function materializeCodeSurveyPages(data, {
  args = {},
  context = {},
  ownerScope = null,
  source = "tool:code.survey",
  objectType = "atlas.code.survey",
  pageSize = SURVEY_PAGE_FILES,
} = {}) {
  const hashContext = contextForHashRefs(context);
  // Native complete-tool surveys carry a private lean snapshot containing
  // every symbol from the surveyed files. The public `files` list remains the
  // ranked compact map. Store the complete snapshot, never the already-capped
  // preview, and omit the private carrier from page metadata.
  const files = Array.isArray(data?._snapshotFiles)
    ? data._snapshotFiles
    : (Array.isArray(data?.files) ? data.files : null);
  if (!files || files.length === 0 || !hasHashRefScope(hashContext)) return null;
  const safePageSize = Math.max(1, Math.min(50, Number(pageSize) || SURVEY_PAGE_FILES));
  const totalFiles = files.length;
  const { files: _files, _snapshotFiles: _snapshotFiles, ...surveyMetadata } = data;
  const resolvedOwnerScope = ownerScope || (hashContext.job_id != null ? "job" : "work_item");
  let nextPage = null;
  let firstPage = null;

  try {
    const finalStart = Math.floor((totalFiles - 1) / safePageSize) * safePageSize;
    for (let start = finalStart; start >= 0; start -= safePageSize) {
      const pageFiles = files.slice(start, start + safePageSize);
      const rankStart = start + 1;
      const rankEnd = start + pageFiles.length;
      const cursor = surveyFetchCursor(nextPage);
      const payloadText = compactSurveyJson({
        ok: true,
        action: "code.survey.page",
        pagination: {
          pageSize: safePageSize,
          totalFiles,
          current: { ranks: `${rankStart}-${rankEnd}`, count: pageFiles.length },
          ...(cursor ? { cursor } : {}),
        },
        ...(start === 0 ? { survey: surveyMetadata } : {}),
        files: pageFiles,
      });
      const surfaced = surfaceHashRefForContext(hashContext, {
        entryKind: "materialized",
        payloadText,
        descriptor: {
          kind: "survey_file_page",
          tool: "code.survey",
          args,
          ranks: { start: rankStart, end: rankEnd },
          source,
        },
        recomputable: true,
        objectType: start === 0 ? objectType : `${objectType}.page`,
        source,
        note: start === 0
          ? `survey page 1: files ${rankStart}-${rankEnd} plus call map and metrics`
          : `survey files ${rankStart}-${rankEnd}`,
        sizeChars: payloadText.length,
        metadata: {
          surfaced_by: "survey_snapshot_pager",
          fetch_class: "survey_page",
          ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
          // A cursor is only useful while every frozen page remains
          // materialized. Keep survey pages out of the ordinary LRU budget so
          // storing a later page cannot degrade an earlier cursor to a
          // descriptor that would have to rerun code.survey.
          bounded_ingress: true,
          tool: "code.survey",
          rank_start: rankStart,
          rank_end: rankEnd,
          file_count: pageFiles.length,
          total_files: totalFiles,
        },
      }, { ownerScope: resolvedOwnerScope });
      if (!surfaced?.ok || !surfaced?.entry?.ref) return null;
      const currentPage = {
        ranks: `${rankStart}-${rankEnd}`,
        count: pageFiles.length,
        ref: surfaced.model_ref || surfaced.entry.ref,
      };
      if (start === 0) {
        firstPage = {
          ...currentPage,
          objectType,
          sizeChars: payloadText.length,
          note: "survey page 1",
          cursor,
        };
      }
      nextPage = currentPage;
    }
  } catch (err) {
    recordHashSurfaceFailure(hashContext, "code.survey", 0, err?.message || err);
    return null;
  }
  return firstPage;
}

export function compactCodeSurveyResult(toolName, result, {
  args = {},
  context = {},
  ownerScope = null,
  enabled = null,
} = {}) {
  if (String(toolName || "") !== "code.survey" || typeof result !== "string") {
    return { result, compacted: false };
  }
  if (enabled === false) return { result, compacted: false };
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) return { result, compacted: false };

  let envelope;
  try {
    envelope = JSON.parse(result);
  } catch {
    return { result, compacted: false };
  }
  // The MCP owner stamps the BARE survey payload ({granularity, files,
  // callMap, ...}); dispatch envelopes nest it under .data. Accept both —
  // run28 proved the .data-only assumption silently no-ops the owner path.
  const data = envelope?.data && typeof envelope.data === "object"
    ? envelope.data
    : (Array.isArray(envelope?.files) ? envelope : null);
  const files = Array.isArray(data?.files) ? data.files : null;
  const snapshotFiles = Array.isArray(data?._snapshotFiles) ? data._snapshotFiles : null;
  if (!files || (!snapshotFiles && files.length <= SURVEY_PAGE_FILES)) {
    return { result, compacted: false };
  }

  // A backed snapshot can be identical to the visible inventory. Its mere
  // presence must not advertise a traversal that only repeats visible rows.
  // Compare identities rather than signatures: snapshots deliberately omit
  // display detail, and symbol counts may describe a wider input population.
  if (snapshotFiles && files.length <= SURVEY_PAGE_FILES) {
    const symbolKey = (symbol) => JSON.stringify([symbol.name, symbol.kind, symbol.line]);
    const visible = new Map(files.map((file) => [file.path, new Set((file.symbols || []).map(symbolKey))]));
    const hasMissingRows = snapshotFiles.some((file) => {
      const symbols = visible.get(file.path);
      return !symbols || (file.symbols || []).some((symbol) => !symbols.has(symbolKey(symbol)));
    });
    if (!hasMissingRows) {
      delete data._snapshotFiles;
      return { result: JSON.stringify(envelope), compacted: true };
    }
  }

  const snapshot = materializeCodeSurveyPages(data, {
    args,
    context: hashContext,
    ownerScope,
    source: "tool:code.survey",
  });
  // `_snapshotFiles` is an internal transport only. Even if materialization
  // fails, never expose the potentially large private carrier to the model.
  delete data._snapshotFiles;
  if (!snapshot?.ref) {
    return { result: JSON.stringify(envelope), compacted: false };
  }

  data.files = files.slice(0, SURVEY_PAGE_FILES);
  const totalFiles = snapshotFiles?.length || files.length;
  data.filesTotal = totalFiles;
  if (snapshot.cursor) {
    const firstCount = Math.min(SURVEY_PAGE_FILES, totalFiles);
    data.pagination = {
      pageSize: SURVEY_PAGE_FILES,
      totalFiles,
      current: { ranks: `1-${firstCount}`, count: firstCount },
      cursor: snapshot.cursor,
    };
  }
  data.traversal_ref = traversalRefSurface(snapshot.ref, {
    kind: "survey_page",
    ranks: snapshot.ranks,
    count: snapshot.count,
  });
  return { result: JSON.stringify(envelope), compacted: true };
}

// ---- code.structure compact presentation + paging (P0.4) -------------------
// Researcher-only presentation of the exact structure inventory. The full
// native payload is projected (compact-presentation.js), split into pages that
// each fit the wire bound, and every page after the first is stored as a
// frozen hash entry chained through `traversal_ref`. Page 1 stays inline.
// Storage failure never drops rows: the whole compact projection is returned
// inline instead, with `pagination: null`, so the model is never promised a
// continuation the store cannot serve.
const STRUCTURE_PAGE_SURFACED_BY = "structure_page_compactor";

function structurePageCursor(page) {
  if (!page?.ref) return null;
  return traversalRefSurface(page.ref, {
    kind: "structure_page",
    ranks: page.ranks,
    count: page.count,
  });
}

export function compactCodeStructureResult(toolName, result, {
  args = {},
  context = {},
  ownerScope = null,
  projection = null,
  maxChars = COMPACT_STRUCTURE_DEFAULT_MAX_CHARS,
} = {}) {
  if (String(toolName || "") !== "code.structure" || typeof result !== "string") {
    return { result, compacted: false };
  }
  if (projection !== COMPACT_STRUCTURE_PROJECTION) return { result, compacted: false };
  let envelope;
  try {
    envelope = JSON.parse(result);
  } catch {
    return { result, compacted: false };
  }
  // The MCP owner stamps the BARE structure payload ({files, ...edges,
  // metrics}); dispatch envelopes nest it under .data. Accept both.
  const nested = envelope?.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data
    : null;
  const data = nested || (Array.isArray(envelope?.files) ? envelope : null);
  if (!data || !Array.isArray(data.files)) return { result, compacted: false };
  if (envelope?.ok === false || envelope?.error) return { result, compacted: false };

  const projected = projectCompactCodeStructure(data, {
    edgesRequested: args?.includeEdges === false ? false : (args?.includeEdges === true ? true : null),
    requestedMaxFiles: args?.maxFiles,
  });
  const bound = Math.max(400, Number(maxChars) || COMPACT_STRUCTURE_DEFAULT_MAX_CHARS);
  const pageChars = Math.max(400, bound - COMPACT_STRUCTURE_ENVELOPE_RESERVE_CHARS);
  const pages = paginateCompactCodeStructure(projected, { maxChars: pageChars });
  const totalRows = compactCodeStructurePageRows(pages).length;
  const replace = (payload) => (nested
    ? JSON.stringify({ ...envelope, data: payload })
    : JSON.stringify(payload));

  if (pages.length <= 1) {
    return {
      result: replace(pages[0] || projected),
      compacted: true,
      projection: COMPACT_STRUCTURE_PROJECTION,
      pages: 1,
      rows: totalRows,
    };
  }

  const hashContext = contextForHashRefs(context);
  const unpaged = () => ({
    result: replace({ ...projected, pagination: null, continuation: "unavailable" }),
    compacted: true,
    projection: COMPACT_STRUCTURE_PROJECTION,
    pages: 1,
    rows: totalRows,
    continuationUnavailable: true,
  });
  if (!hasHashRefScope(hashContext)) return unpaged();

  const resolvedOwnerScope = ownerScope || (hashContext.job_id != null ? "job" : "work_item");
  let nextPage = null;
  try {
    for (let index = pages.length - 1; index >= 1; index -= 1) {
      const page = pages[index];
      const cursor = structurePageCursor(nextPage);
      const payload = {
        ok: true,
        action: "code.structure.page",
        ...page,
        ...(cursor ? { traversal_ref: cursor } : {}),
      };
      const payloadText = JSON.stringify(payload, null, 1);
      const rankStart = index + 1;
      const surfaced = surfaceHashRefForContext(hashContext, {
        entryKind: "materialized",
        payloadText,
        descriptor: {
          kind: "structure_page",
          tool: "code.structure",
          args,
          page: rankStart,
          pages: pages.length,
        },
        recomputable: true,
        objectType: "atlas.code.structure.page",
        source: "tool:code.structure",
        note: `structure page ${rankStart} of ${pages.length}`,
        sizeChars: payloadText.length,
        metadata: {
          surfaced_by: STRUCTURE_PAGE_SURFACED_BY,
          fetch_class: "cursor_page",
          ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
          // Frozen pages must all stay materialized for the chain to hold.
          bounded_ingress: true,
          tool: "code.structure",
          page: rankStart,
          pages: pages.length,
          file_count: page.files.length,
        },
      }, { ownerScope: resolvedOwnerScope });
      if (!surfaced?.ok || !surfaced?.entry?.ref) return unpaged();
      nextPage = {
        ranks: `${rankStart}-${pages.length}`,
        count: page.files.length,
        ref: surfaced.model_ref || surfaced.entry.ref,
      };
    }
  } catch (err) {
    recordHashSurfaceFailure(hashContext, "code.structure", result.length, err?.message || err);
    return unpaged();
  }
  const first = pages[0];
  const inlinePaths = new Set(first.files.map((file) => file.path));
  // A file sliced across pages is one omitted file, not one per slice; a file
  // whose first slice is already inline is not omitted at all.
  const omittedPaths = pages.slice(1)
    .flatMap((page) => page.files.map((file) => file.path))
    .filter((path, position, all) => all.indexOf(path) === position && !inlinePaths.has(path));
  const omittedFiles = omittedPaths.length;
  const omittedPathPreview = omittedPaths.slice(0, 12);
  const inline = {
    ...first,
    pagination: {
      ...first.pagination,
      omittedFiles,
      omittedPathPreview,
    },
    traversal_ref: structurePageCursor(nextPage),
  };
  return {
    result: replace(inline),
    compacted: true,
    projection: COMPACT_STRUCTURE_PROJECTION,
    pages: pages.length,
    rows: totalRows,
  };
}

// Keep ranked tree.scope candidates inline with the same cursor-backed paging
// used by the other Atlas result compactions.
const TREE_SCOPE_INLINE_CANDIDATES = 10;
const TREE_SCOPE_DEFERRED_PAGES = Object.freeze([
  Object.freeze({ start: 10, end: 20 }),
  Object.freeze({ start: 20, end: 40 }),
]);

/**
 * Keep the highest-value tree.scope candidates in context while making the
 * remainder available through the same traversal_ref path as every other value.
 * If refs cannot be created, return the original result so no candidates are
 * silently lost.
 */
export function compactTreeScopeResult(toolName, result, {
  args = {},
  context = {},
  ownerScope = null,
} = {}) {
  if (String(toolName || "") !== "tree.scope" || typeof result !== "string") {
    return { result, compacted: false };
  }
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) return { result, compacted: false };

  let envelope;
  try {
    envelope = JSON.parse(result);
  } catch {
    return { result, compacted: false };
  }
  const candidates = envelope?.data?.candidateFiles;
  if (
    !Array.isArray(candidates)
    || candidates.length <= TREE_SCOPE_INLINE_CANDIDATES
    || candidates.length > TREE_SCOPE_DEFERRED_PAGES.at(-1).end
  ) {
    return { result, compacted: false };
  }

  let nextPage = null;
  try {
    for (const page of [...TREE_SCOPE_DEFERRED_PAGES].reverse()) {
      const pageCandidates = candidates.slice(page.start, page.end);
      if (pageCandidates.length === 0) continue;
      const rankStart = page.start + 1;
      const rankEnd = page.start + pageCandidates.length;
      const payloadText = JSON.stringify({
        ok: true,
        action: "tree.scope.candidates",
        ranks: { start: rankStart, end: rankEnd },
        candidateFiles: pageCandidates,
        ...(nextPage ? {
          traversal_ref: traversalRefSurface(nextPage.ref, {
            kind: "tree_scope_page",
            ranks: nextPage.ranks,
            count: nextPage.count,
          }),
        } : {}),
      }, null, 2);
      const surfaced = surfaceHashRefForContext(hashContext, {
        entryKind: "materialized",
        payloadText,
        descriptor: {
          kind: "tree_scope_candidate_page",
          tool: "tree.scope",
          args,
          ranks: { start: rankStart, end: rankEnd },
        },
        recomputable: true,
        objectType: "tree.scope.candidates",
        source: "tool:tree.scope",
        note: `ranked tree.scope candidates ${rankStart}-${rankEnd}`,
        sizeChars: payloadText.length,
        metadata: {
          surfaced_by: "tree_scope_rank_compactor",
          fetch_class: "cursor_page",
          ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
          tool: "tree.scope",
          rank_start: rankStart,
          rank_end: rankEnd,
          candidate_count: pageCandidates.length,
        },
      }, { ownerScope: ownerScope || (hashContext.job_id != null ? "job" : null) });
      if (!surfaced?.ok || !surfaced?.entry?.ref) return { result, compacted: false };
      nextPage = {
        ranks: `${rankStart}-${rankEnd}`,
        count: pageCandidates.length,
        ref: surfaced.model_ref || surfaced.entry.ref,
      };
    }
  } catch (err) {
    recordHashSurfaceFailure(hashContext, "tree.scope", result.length, err?.message || err);
    return { result, compacted: false };
  }
  if (!nextPage) return { result, compacted: false };

  envelope.data.candidateFiles = candidates.slice(0, TREE_SCOPE_INLINE_CANDIDATES);
  envelope.data.traversal_ref = traversalRefSurface(nextPage.ref, {
    kind: "tree_scope_page",
    ranks: nextPage.ranks,
    count: nextPage.count,
  });
  envelope.data.candidateFilesTotal = candidates.length;
  return { result: JSON.stringify(envelope), compacted: true };
}
