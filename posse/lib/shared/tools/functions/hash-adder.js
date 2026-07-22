import crypto from "crypto";

import { getObservationContext, recordObservation } from "../../../domains/observability/functions/observations.js";
import {
  fetchHashRefForContext,
  surfaceHashRefForContext,
} from "../../../domains/queue/functions/hash-refs.js";
import {
  isHashRefAlias,
  normalizeHashRefAlias,
} from "../../../catalog/hash-store.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../../domains/queue/functions/settings.js";
import {
  CONTEXT_BOUNDED_RETENTION_CHAR_CAP,
  CONTEXT_BOUNDING_POLICIES,
  CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
  CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
  CONTEXT_HASH_REF_MATERIALIZE_CHAR_CAP,
} from "../../../catalog/context.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { logEvent } from "../../../domains/queue/functions/events.js";
import { ContextMeter } from "../../classes/ContextMeter.js";

// Ambient-stamping experiment (2026-07-16) is FLAG-GATED after the run28
// lesson: changing the stamp floor globally mid-experiment shifted agent
// behavior. Defaults below reproduce the long-standing behavior exactly;
// set atlas_ambient_ref_stamping=on to enable the evidence-class experiment.
const DEFAULT_SURFACE_MIN_CHARS = 4000;
const AMBIENT_STAMPING_SURFACE_MIN_CHARS = 500;
const EVIDENCE_REF_SURFACE_MIN_CHARS = 1;
const EVIDENCE_REF_TOOLS = new Set([
  "code.skeleton",
  "code.window",
  "code.lens",
  "code.survey",
  "code.structure",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  "symbol.card",
  "symbol.overview",
  "tree.branch",
  "tree.expand",
  "file.read",
  "read_file",
]);
const DEFAULT_MATERIALIZE_CHAR_CAP = CONTEXT_HASH_REF_MATERIALIZE_CHAR_CAP;
const HASH_ADDER_BLOCKED_TOOLS = new Set(["fetch_ref", "create_ref"]);
const CREATE_REF_MAX_TEXT_CHARS = 60000;
const CREATE_REF_MAX_NOTE_CHARS = 300;
const CREATE_REF_MAX_BATCH = 24;
const CREATE_REF_OWNER_SCOPES = new Set(["work_item", "job"]);
const FETCH_REF_SEARCH_MODES = new Set(["auto", "literal", "regex"]);
const FETCH_REF_REGEX_HINT = /[\\^$.*+?()[\]{}|]/;
const TREE_SCOPE_INLINE_CANDIDATES = 10;
const TREE_SCOPE_DEFERRED_PAGES = Object.freeze([
  Object.freeze({ start: 10, end: 20 }),
  Object.freeze({ start: 20, end: 40 }),
]);

function normalizeRef(value) {
  return normalizeHashRefAlias(value);
}

function refInputs(args = {}) {
  const out = [];
  const push = (value) => {
    const normalized = normalizeRef(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };
  const addMany = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return;
    }
    if (typeof value === "string" && /[\s,;]+/.test(value.trim())) {
      for (const entry of value.split(/[\s,;]+/)) push(entry);
      return;
    }
    push(value);
  };
  addMany(args.refs);
  addMany(args.hashes);
  if (out.length === 0) addMany(args.ref || args.hash);
  return out;
}

function lineFingerprintMap(text, chunkLines = 80) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const chunks = {};
  for (let i = 0; i < lines.length; i += chunkLines) {
    const key = `lines:${i + 1}-${Math.min(lines.length, i + chunkLines)}`;
    const body = lines.slice(i, i + chunkLines).join("\n");
    chunks[key] = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  }
  return {
    line_count: lines.length,
    char_count: String(text || "").length,
    chunks,
  };
}

function normalizeObjectType(value) {
  return String(value || "")
    .trim()
    .replace(/[^0-9A-Za-z_.:-]+/g, "_")
    .slice(0, 80);
}

function normalizedLinesForHandoff(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length;
}

// symbol.search enrollment is flag-gated (atlas_search_result_paging, default
// off) so mid-experiment baselines stay stable; search_files/list_files keep
// their long-standing unconditional policies.
const SEARCH_PAGING_POLICY_KEYS = new Set(["symbol.search", "atlas.symbol.search"]);

function searchResultPagingEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.ATLAS_SEARCH_RESULT_PAGING);
    if (stored == null) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === "on" || normalized === "true" || normalized === "1" || normalized === "yes";
  } catch {
    return false;
  }
}

function boundingPolicyFor(toolName, objectType, { searchPaging = null } = {}) {
  const candidates = [
    normalizeObjectType(objectType),
    normalizeObjectType(toolName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    for (const key of [candidate, candidate.toLowerCase()]) {
      const policy = CONTEXT_BOUNDING_POLICIES[key];
      if (!policy) continue;
      if (SEARCH_PAGING_POLICY_KEYS.has(key) && !(searchPaging ?? searchResultPagingEnabled())) continue;
      return policy;
    }
  }
  return null;
}

function parsePositiveInt(value, fallback, max = null) {
  const n = Number.parseInt(String(value ?? ""), 10);
  const parsed = Number.isFinite(n) && n > 0 ? n : fallback;
  if (max == null) return parsed;
  return Math.min(parsed, max);
}

function parseSearchRows(text) {
  const files = new Map();
  const firstMatches = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (!line || line === "--") continue;
    const match = /^(.*?):(\d+)(?::|-|\+)(.*)$/.exec(line);
    if (!match) continue;
    const file = match[1] || "(unknown)";
    const row = files.get(file) || { file, count: 0, first_line: Number(match[2]) || null };
    row.count += 1;
    if (row.first_line == null) row.first_line = Number(match[2]) || null;
    files.set(file, row);
    if (firstMatches.length < 12 && line.includes(":")) firstMatches.push(line.slice(0, 240));
  }
  return {
    file_count: files.size,
    match_like_row_count: [...files.values()].reduce((sum, entry) => sum + entry.count, 0),
    files: [...files.values()]
      .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
      .slice(0, 30),
    first_matches: firstMatches,
  };
}

function listDigest(text) {
  const paths = String(text || "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const roots = new Map();
  const extensions = new Map();
  for (const p of paths) {
    const normalized = p.replace(/\\/g, "/");
    const root = normalized.includes("/") ? normalized.split("/")[0] : ".";
    roots.set(root, (roots.get(root) || 0) + 1);
    const leaf = normalized.split("/").pop() || "";
    const extMatch = /(\.[^.\/]+)$/.exec(leaf);
    const ext = extMatch ? extMatch[1].toLowerCase() : "(none)";
    extensions.set(ext, (extensions.get(ext) || 0) + 1);
  }
  return {
    path_count: paths.length,
    first_paths: paths.slice(0, 25),
    roots: [...roots.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
      .map(([root, count]) => ({ root, count })),
    extensions: [...extensions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
      .map(([extension, count]) => ({ extension, count })),
  };
}

function genericDigest(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const nonEmpty = lines.filter((line) => line.trim()).length;
  return {
    line_count: lines.length,
    non_empty_line_count: nonEmpty,
    char_count: normalized.length,
    first_lines: lines.filter((line) => line.trim()).slice(0, 12).map((line) => line.slice(0, 220)),
  };
}

function symbolCardDigest(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return genericDigest(text);
  }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const cards = Array.isArray(data?.cards)
    ? data.cards
    : (data?.symbolId ? [data] : []);
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  return {
    char_count: String(text || "").length,
    card_count: cards.length,
    error_count: errors.length,
    cards: cards.slice(0, 100).map((card) => ({
      symbolId: card?.symbolId || null,
      name: card?.name || null,
      qualifiedName: card?.qualifiedName || null,
      kind: card?.kind || null,
      file: card?.location?.repo_rel_path || card?.repo_rel_path || null,
      line: Number(card?.location?.startLine ?? card?.startLine) || null,
      signature: typeof card?.signature === "string" ? card.signature.slice(0, 300) : null,
    })),
    errors: errors.slice(0, 100).map((error) => ({
      index: error?.index ?? null,
      symbolId: error?.symbolId || null,
      symbolRef: error?.symbolRef || null,
      message: String(error?.message || error?.error || "").slice(0, 300),
    })),
  };
}

function overflowDigest(text, policy, toolName, args = {}) {
  const digestKind = policy?.digest || "generic";
  const base = {
    tool: toolName || null,
    digest: digestKind,
    omitted_chars: Math.max(0, String(text || "").length - (policy?.headChars || 0) - (policy?.tailChars || 0)),
  };
  if (args && typeof args === "object") {
    if (args.path || args.directory) base.path = args.path || args.directory;
    if (args.pattern) base.pattern = args.pattern;
    if (args.output_mode) base.output_mode = args.output_mode;
  }
  if (digestKind === "search_files") return { ...base, ...parseSearchRows(text) };
  if (digestKind === "list_files") return { ...base, ...listDigest(text) };
  if (digestKind === "symbol_card") return { ...base, ...symbolCardDigest(text) };
  return { ...base, ...genericDigest(text) };
}

function renderBoundedResult(text, {
  policy,
  toolName,
  objectType,
  args,
  entry,
  sizeChars,
  materialized = false,
}) {
  const headChars = Math.max(0, Math.min(policy.headChars || policy.capChars || 0, sizeChars));
  const tailBudget = Math.max(0, Math.min(policy.tailChars || 0, Math.max(0, sizeChars - headChars)));
  const head = text.slice(0, headChars);
  const tail = tailBudget > 0 ? text.slice(sizeChars - tailBudget) : "";
  const omitted = Math.max(0, sizeChars - head.length - tail.length);
  const objectLabel = normalizeObjectType(objectType) || normalizeObjectType(toolName) || "tool_result";
  const digest = overflowDigest(text, policy, toolName, args);
  const digestText = JSON.stringify(digest, null, 2);
  const lines = [
    `[bounded_result ${objectLabel}: full payload ${sizeChars} chars; showing ${head.length}${tail ? `+${tail.length}` : ""} chars; omitted ${omitted} chars]`,
    materialized
      ? `[bounded_result traversal: atlas.fetch_ref {"ref":"${entry?.ref || ""}","offset":<char_offset>,"limit":<chars>} opens this stored result; it is not a fresh ${toolName || "tool"} call. Continue with page.next_offset or use search=<literal>]`
      : `[bounded_result recovery: payload exceeded retention cap; digest+fingerprints kept; re-run ${toolName || "the tool"} with narrower args]`,
    "[overflow_digest]",
    digestText,
    "[/overflow_digest]",
    "",
    head,
  ];
  if (tail) {
    lines.push("", `[... ${omitted} chars omitted from bounded view ...]`, "", tail);
  } else if (omitted > 0) {
    lines.push("", `[... ${omitted} chars omitted from bounded view ...]`);
  }
  lines.push(refStub({ entry, toolName: objectLabel, sizeChars }));
  return lines.join("\n");
}

function pageMaterializedText(text, args = {}) {
  const limit = parsePositiveInt(args.limit, CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS, CONTEXT_FETCH_REF_MAX_LIMIT_CHARS);
  const search = String(args.search || "").trim();
  if (search) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const requestedModeValue = String(args.search_mode ?? args.searchMode ?? "auto").trim().toLowerCase();
    const requestedMode = FETCH_REF_SEARCH_MODES.has(requestedModeValue) ? requestedModeValue : "auto";
    const literalNeedle = search.toLowerCase();
    const literalRows = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(literalNeedle)) literalRows.push(`${i + 1}:${lines[i]}`);
    }

    let rows = literalRows;
    let searchMode = "literal";
    let searchError = null;
    const shouldTryRegex = requestedMode === "regex"
      || (requestedMode === "auto" && literalRows.length === 0 && FETCH_REF_REGEX_HINT.test(search));
    if (shouldTryRegex) {
      try {
        const expression = new RegExp(search, "i");
        rows = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (expression.test(lines[i])) rows.push(`${i + 1}:${lines[i]}`);
        }
        searchMode = "regex";
      } catch (err) {
        searchError = `invalid_regex: ${err?.message || err}`;
        if (requestedMode === "regex") rows = [];
      }
    }
    const rowOffset = parsePositiveInt(args.offset, 0);
    const selected = [];
    let chars = 0;
    for (const row of rows.slice(rowOffset)) {
      const nextChars = chars + row.length + (selected.length > 0 ? 1 : 0);
      if (selected.length > 0 && nextChars > limit) break;
      selected.push(row);
      chars = nextChars;
      if (chars >= limit) break;
    }
    return {
      text: selected.join("\n"),
      page: {
        mode: "search",
        search,
        search_mode: searchMode,
        requested_search_mode: requestedMode,
        search_error: searchError,
        offset: rowOffset,
        limit,
        returned_chars: selected.join("\n").length,
        match_count: rows.length,
        next_offset: rowOffset + selected.length < rows.length ? rowOffset + selected.length : null,
        has_more: rowOffset + selected.length < rows.length,
      },
    };
  }
  const offset = parsePositiveInt(args.offset, 0);
  const page = String(text || "").slice(offset, offset + limit);
  return {
    text: page,
    page: {
      mode: "offset",
      offset,
      limit,
      returned_chars: page.length,
      next_offset: offset + page.length < String(text || "").length ? offset + page.length : null,
      has_more: offset + page.length < String(text || "").length,
    },
  };
}

function contextForHashRefs(explicitContext = {}) {
  const ambient = getObservationContext() || {};
  return {
    work_item_id: explicitContext.work_item_id ?? explicitContext.workItemId ?? ambient.work_item_id ?? null,
    job_id: explicitContext.job_id ?? explicitContext.jobId ?? ambient.job_id ?? null,
    attempt_id: explicitContext.attempt_id ?? explicitContext.attemptId ?? ambient.attempt_id ?? null,
    agent_call_id: explicitContext.agent_call_id ?? explicitContext.agentCallId ?? ambient.agent_call_id ?? null,
  };
}

function hasHashRefScope(context = {}) {
  return context.attempt_id != null || context.job_id != null || context.work_item_id != null || context.agent_call_id != null;
}

/**
 * Keep the highest-value tree.scope candidates in context while making the
 * remainder available through the same fetch_ref path as every other value.
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
        ...(nextPage ? { nextCandidateFiles: nextPage } : {}),
        traversalNote: "This is a stored tree.scope page. atlas.fetch_ref follows nextCandidateFiles without rerunning tree.scope. Call tree.scope again only for a materially different query or scope.",
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
        ref: surfaced.entry.ref,
      };
    }
  } catch (err) {
    recordHashSurfaceFailure(hashContext, "tree.scope", result.length, err?.message || err);
    return { result, compacted: false };
  }
  if (!nextPage) return { result, compacted: false };

  envelope.data.candidateFiles = candidates.slice(0, TREE_SCOPE_INLINE_CANDIDATES);
  envelope.data.nextCandidateFiles = nextPage;
  envelope.data.candidateFilesTotal = candidates.length;
  envelope.data.traversalNote = "nextCandidateFiles points to the next stored page. atlas.fetch_ref traverses it without rerunning tree.scope. Follow nextCandidateFiles until absent; call tree.scope again only for a materially different query or scope.";
  return { result: JSON.stringify(envelope, null, 2), compacted: true };
}

function ambientStampingEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.ATLAS_AMBIENT_REF_STAMPING);
    if (stored == null) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === "on" || normalized === "true" || normalized === "1" || normalized === "yes";
  } catch {
    return false;
  }
}

function surfaceMinCharsFor(toolName, { ambient = null } = {}) {
  if (!(ambient ?? ambientStampingEnabled())) return DEFAULT_SURFACE_MIN_CHARS;
  return EVIDENCE_REF_TOOLS.has(String(toolName || ""))
    ? EVIDENCE_REF_SURFACE_MIN_CHARS
    : AMBIENT_STAMPING_SURFACE_MIN_CHARS;
}

// ---- code.survey snapshot paging -------------------------------------------
// A survey is materialized once as ordinary hash-map pages. Page 1 owns the
// survey-wide call map/metrics and the first ten file records; every page owns
// at most ten files and carries a backed fetch_ref cursor to the next page.
// There is deliberately no second, monolithic copy of the full survey.
const SURVEY_PAGE_FILES = 10;

function surveyFetchCursor(page) {
  if (!page?.ref) return null;
  return {
    label: "next 10",
    call: "atlas.fetch_ref",
    args: { ref: page.ref },
    ranks: page.ranks,
    count: page.count,
  };
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
      const payloadText = JSON.stringify({
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
        traversalNote: "This is a stored code.survey page. atlas.fetch_ref follows pagination.cursor without rerunning code.survey. Follow cursors until absent; call code.survey again only for a materially different path or symbol scope.",
      }, null, 2);
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
        ref: surfaced.entry.ref,
      };
      if (start === 0) {
        firstPage = {
          ...currentPage,
          objectType,
          sizeChars: payloadText.length,
          note: "survey page 1; next 10 is already cached",
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
    return { result: JSON.stringify(envelope, null, 2), compacted: false };
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
  data.surveyRef = {
    ref: snapshot.ref,
    objectType: snapshot.objectType,
    sizeChars: snapshot.sizeChars,
  };
  data.surveyNote = snapshot.cursor
    ? `This survey has already run. atlas.fetch_ref traverses a stored ${SURVEY_PAGE_FILES}-file survey page containing the full surveyed symbol inventory; it is not a fresh retrieval and does not rerun code.survey. Follow pagination.cursor while missing material is likely in this result; call code.survey again only for a materially different path or symbol scope.`
    : "This survey has already run. atlas.fetch_ref opens its stored full-symbol snapshot; it is not a fresh retrieval and does not rerun code.survey. Call code.survey again only for a materially different path or symbol scope.";
  return { result: JSON.stringify(envelope, null, 2), compacted: true };
}

// ---- code.window / code.lens result ref-paging (flag-gated, default ON) -----
// L3b (TOKEN-LEVERS). Same demand-paging move as survey cursor pages: only fires
// when the full result exceeds the min-chars threshold. code.lens carries a
// matches[] array — page the lower-ranked tail. code.window is a monolithic
// content string — keep the head lines inline (up to the char budget) and page
// the tail lines behind one fetch_ref. Threshold from atlas_result_ref_paging_min_chars.
const RESULT_REF_PAGING_DEFAULT_MIN_CHARS = 12000;
const LENS_INLINE_MATCHES = 8;

function resultRefPagingEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.ATLAS_RESULT_REF_PAGING);
    if (stored == null) return false;
    const n = String(stored).trim().toLowerCase();
    return n === "on" || n === "true" || n === "1" || n === "yes";
  } catch {
    return false;
  }
}

function resultRefPagingMinChars() {
  try {
    const raw = Number(getSetting(SETTING_KEYS.ATLAS_RESULT_REF_PAGING_MIN_CHARS));
    return Number.isFinite(raw) && raw >= 2000 ? raw : RESULT_REF_PAGING_DEFAULT_MIN_CHARS;
  } catch {
    return RESULT_REF_PAGING_DEFAULT_MIN_CHARS;
  }
}

export function compactCodeWindowLensResult(toolName, result, {
  args = {},
  context = {},
  ownerScope = null,
  enabled = null,
  minChars = null,
} = {}) {
  const tool = String(toolName || "");
  if ((tool !== "code.window" && tool !== "code.lens") || typeof result !== "string") {
    return { result, compacted: false };
  }
  if (!(enabled ?? resultRefPagingEnabled())) return { result, compacted: false };
  const min = minChars ?? resultRefPagingMinChars();
  if (result.length <= min) return { result, compacted: false };
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) return { result, compacted: false };

  let envelope;
  try {
    envelope = JSON.parse(result);
  } catch {
    return { result, compacted: false };
  }
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : null;
  if (!data) return { result, compacted: false };
  const scope = { ownerScope: ownerScope || (hashContext.job_id != null ? "job" : null) };

  // code.lens: page the lower-ranked matches[] tail.
  if (tool === "code.lens" && Array.isArray(data.matches) && data.matches.length > LENS_INLINE_MATCHES) {
    const tail = data.matches.slice(LENS_INLINE_MATCHES);
    const tailPayload = JSON.stringify({ tool: "code.lens", tailMatches: tail }, null, 1);
    let surfaced;
    try {
      surfaced = surfaceHashRefForContext(hashContext, {
        entryKind: "materialized",
        payloadText: tailPayload,
        descriptor: { kind: "tool_result", tool: "code.lens", args, source: "tool:code.lens" },
        objectType: "code.lens.tail",
        source: "tool:code.lens",
        note: `lower-ranked code.lens matches ${LENS_INLINE_MATCHES + 1}-${data.matches.length}`,
        sizeChars: tailPayload.length,
        recomputable: true,
        metadata: { surfaced_by: "result_ref_paging", tool: "code.lens", matches: tail.length },
      }, scope);
    } catch (err) {
      recordHashSurfaceFailure(hashContext, tool, tailPayload.length, err?.message || err);
      return { result, compacted: false };
    }
    if (!surfaced?.ok || !surfaced?.entry?.ref) return { result, compacted: false };
    data.matches = data.matches.slice(0, LENS_INLINE_MATCHES);
    data.tailMatchesRef = surfaced.entry.ref;
    data.tailMatchesTotal = LENS_INLINE_MATCHES + tail.length;
    data.tailNote = `COVERED: ${tail.length} lower-ranked matches are stored at ${surfaced.entry.ref}. atlas.fetch_ref traverses this stored code.lens tail; it is not a fresh code.lens call. Fetch it when the missing match is likely among the lower-ranked results.`;
    return { result: JSON.stringify(envelope, null, 2), compacted: true };
  }

  // code.window: keep head lines inline up to the char budget, page the tail.
  if (tool === "code.window" && typeof data.content === "string" && data.content.length > min) {
    const lines = data.content.split("\n");
    let headChars = 0;
    let splitAt = lines.length;
    for (let i = 0; i < lines.length; i++) {
      headChars += lines[i].length + 1;
      if (headChars >= min) { splitAt = i + 1; break; }
    }
    if (splitAt >= lines.length) return { result, compacted: false };
    const headContent = lines.slice(0, splitAt).join("\n");
    const tailContent = lines.slice(splitAt).join("\n");
    const startLine = Number(data.startLine) || 1;
    const tailStartLine = startLine + splitAt;
    const tailPayload = JSON.stringify({
      tool: "code.window",
      repo_rel_path: data.repo_rel_path,
      startLine: tailStartLine,
      endLine: data.endLine,
      content: tailContent,
    }, null, 1);
    let surfaced;
    try {
      surfaced = surfaceHashRefForContext(hashContext, {
        entryKind: "materialized",
        payloadText: tailPayload,
        descriptor: { kind: "tool_result", tool: "code.window", args, source: "tool:code.window" },
        objectType: "code.window.tail",
        source: "tool:code.window",
        note: `${data.repo_rel_path} lines ${tailStartLine}-${data.endLine}`,
        sizeChars: tailPayload.length,
        recomputable: true,
        metadata: { surfaced_by: "result_ref_paging", tool: "code.window", tail_start_line: tailStartLine },
      }, scope);
    } catch (err) {
      recordHashSurfaceFailure(hashContext, tool, tailPayload.length, err?.message || err);
      return { result, compacted: false };
    }
    if (!surfaced?.ok || !surfaced?.entry?.ref) return { result, compacted: false };
    data.content = headContent;
    data.contentTailRef = surfaced.entry.ref;
    data.contentTailLines = `${tailStartLine}-${data.endLine}`;
    data.tailNote = `COVERED: lines ${tailStartLine}-${data.endLine} of ${data.repo_rel_path} are stored at ${surfaced.entry.ref}. atlas.fetch_ref traverses this stored code.window tail; it is not a fresh code.window call. Fetch it when the missing lines are likely in this window.`;
    return { result: JSON.stringify(envelope, null, 2), compacted: true };
  }

  return { result, compacted: false };
}

function shouldSurfaceHashRef(toolName, result, {
  minChars = null,
  ambient = null,
} = {}) {
  if (HASH_ADDER_BLOCKED_TOOLS.has(String(toolName || ""))) return false;
  if (typeof result !== "string") return false;
  const effectiveMin = minChars ?? surfaceMinCharsFor(toolName, { ambient });
  if (result.length < effectiveMin) return false;
  if (/^Error:/i.test(result.trimStart())) return false;
  return true;
}

function refStub({ entry, toolName, sizeChars }) {
  const ref = entry?.ref || "";
  const objectType = String(entry?.object_type || toolName || "tool_result")
    .replace(/[^0-9A-Za-z_.:-]+/g, "_")
    .slice(0, 80) || "tool_result";
  const noteValue = String(entry?.note || "")
    .replace(/["\\\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  const note = noteValue ? ` note="${noteValue}"` : "";
  return `\n\n[ref_hash ${objectType} ${sizeChars} chars ${ref}${note}]`;
}

function recordHashObservation(context, surfaced, toolName, sizeChars) {
  if (!surfaced?.ok || !surfaced?.entry?.ref) return;
  recordObservation({
    work_item_id: context.work_item_id ?? null,
    job_id: context.job_id ?? null,
    attempt_id: context.attempt_id ?? null,
    observation_type: "hash_ref.surface",
    summary: `Surfaced ${toolName || "tool_result"} as ${surfaced.entry.ref}`,
    detail: {
      ref: surfaced.entry.ref,
      object_type: surfaced.entry.object_type,
      content_hash: surfaced.entry.content_hash,
      size_chars: sizeChars,
      reused: surfaced.reused === true,
    },
  });
}

function recordHashSurfaceFailure(context, toolName, sizeChars, reason) {
  try {
    recordObservation({
      work_item_id: context.work_item_id ?? null,
      job_id: context.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: "hash_ref.surface_failed",
      summary: `Failed to surface ${toolName || "tool_result"} as hash ref`,
      detail: {
        tool: toolName || null,
        size_chars: sizeChars,
        error: String(reason || "surface_failed").slice(0, 500),
      },
    });
  } catch {
    // Hash-ref telemetry must never break the tool result path.
  }
}

function recordContextMeterSample(context, toolName, {
  fullSizeChars,
  emittedSizeChars,
  bounded = false,
  ref = null,
} = {}) {
  try {
    const meter = ContextMeter.forContext(context);
    if (!meter) return;
    const snapshot = meter.recordToolResult({ fullSizeChars, emittedSizeChars, bounded });
    if (bounded) {
      logEvent({
        work_item_id: context.work_item_id ?? null,
        job_id: context.job_id ?? null,
        attempt_id: context.attempt_id ?? null,
        event_type: EVENT_TYPES.CONTEXT_BOUNDED_INGRESS,
        actor_type: EVENT_ACTORS.SYSTEM,
        actor_id: "context_meter",
        message: `Bounded ${toolName || "tool_result"} before context ingress`,
        event_json: {
          tool: toolName || null,
          ref,
          full_size_chars: fullSizeChars,
          emitted_size_chars: emittedSizeChars,
          trimmed_chars: Math.max(0, Number(fullSizeChars || 0) - Number(emittedSizeChars || 0)),
          estimate_tokens: snapshot.estimate_tokens,
          pressure_band: snapshot.pressure_band,
        },
      });
    }
    if (!bounded && !meter.shouldReport(snapshot)) return;
    recordObservation({
      work_item_id: context.work_item_id ?? null,
      job_id: context.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: bounded ? "context_meter.bounded_ingress" : "context_meter.sample",
      summary: bounded
        ? `Bounded ${toolName || "tool_result"} before context ingress`
        : `Context estimate ${snapshot.estimate_tokens} tokens (${snapshot.pressure_band})`,
      detail: {
        tool: toolName || null,
        ref,
        full_size_chars: fullSizeChars,
        emitted_size_chars: emittedSizeChars,
        bounded,
        ...snapshot,
      },
    });
  } catch {
    // Shadow context telemetry must never affect tool delivery.
  }
}

export function appendHashRefIfMajor(toolName, result, {
  args = {},
  context = {},
  source = null,
  objectType = null,
  note = null,
  ownerScope = null,
  minChars = null,
  ambient = null,
  searchPaging = null,
  materializeCharCap = DEFAULT_MATERIALIZE_CHAR_CAP,
} = {}) {
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) return result;
  if (!shouldSurfaceHashRef(toolName, result, { minChars, ambient })) {
    if (typeof result === "string") {
      recordContextMeterSample(hashContext, toolName, {
        fullSizeChars: result.length,
        emittedSizeChars: result.length,
        bounded: false,
      });
    }
    return result;
  }

  const text = String(result);
  const sizeChars = text.length;
  const effectiveObjectType = normalizeObjectType(objectType || toolName || "tool_result") || "tool_result";
  const boundPolicy = boundingPolicyFor(toolName, effectiveObjectType, { searchPaging });
  const boundedIngress = !!(boundPolicy && sizeChars > boundPolicy.capChars);
  const retainedBoundedPayload = boundedIngress && sizeChars <= CONTEXT_BOUNDED_RETENTION_CHAR_CAP;
  const materialized = sizeChars <= materializeCharCap || retainedBoundedPayload;
  const descriptor = {
    kind: "tool_result",
    tool: toolName,
    args,
    source: source || `tool:${toolName}`,
  };
  const entry = materialized
    ? {
      entryKind: "materialized",
      payloadText: text,
      descriptor,
      recomputable: true,
    }
    : {
      entryKind: "descriptor",
      descriptor,
      fingerprintMap: lineFingerprintMap(text),
      recomputable: true,
    };
  let surfaced;
  const noteText = [
    note,
    boundedIngress
      ? (materialized
        ? `bounded stored result; atlas.fetch_ref traverses the rest without rerunning ${toolName || "the source tool"}`
        : `bounded view; payload exceeded retention cap; re-run ${toolName || "the tool"} with narrower args`)
      : "",
  ].filter(Boolean).join(" | ") || null;
  try {
    surfaced = surfaceHashRefForContext(hashContext, {
      ...entry,
      objectType: effectiveObjectType,
      source: source || `tool:${toolName}`,
      note: noteText,
      sizeChars,
      metadata: {
        surfaced_by: "hash_adder",
        tool: toolName || null,
        materialized,
        bounded_ingress: boundedIngress,
        retention_exceeded: boundedIngress && !materialized,
      },
    }, { ownerScope: ownerScope || (hashContext.job_id != null ? "job" : null) });
  } catch (err) {
    recordHashSurfaceFailure(hashContext, toolName, sizeChars, err?.message || err);
    recordContextMeterSample(hashContext, toolName, {
      fullSizeChars: sizeChars,
      emittedSizeChars: sizeChars,
      bounded: false,
    });
    return result;
  }
  if (!surfaced?.ok) {
    recordHashSurfaceFailure(hashContext, toolName, sizeChars, surfaced?.error || "surface_failed");
    recordContextMeterSample(hashContext, toolName, {
      fullSizeChars: sizeChars,
      emittedSizeChars: sizeChars,
      bounded: false,
    });
    return result;
  }
  recordHashObservation(hashContext, surfaced, toolName, sizeChars);
  if (boundPolicy && sizeChars > boundPolicy.capChars) {
    const bounded = renderBoundedResult(text, {
      policy: boundPolicy,
      toolName,
      objectType: effectiveObjectType,
      args,
      entry: surfaced.entry,
      sizeChars,
      materialized: surfaced.entry?.entry_kind === "materialized",
    });
    recordContextMeterSample(hashContext, toolName, {
      fullSizeChars: sizeChars,
      emittedSizeChars: bounded.length,
      bounded: true,
      ref: surfaced.entry?.ref || null,
    });
    return bounded;
  }
  const stamped = `${result}${refStub({ entry: surfaced.entry, toolName, sizeChars })}`;
  recordContextMeterSample(hashContext, toolName, {
    fullSizeChars: sizeChars,
    emittedSizeChars: stamped.length,
    bounded: false,
    ref: surfaced.entry?.ref || null,
  });
  return stamped;
}

function fetchResultText(result, args = {}) {
  if (!result?.ok || !result?.found || !result.entry) {
    return JSON.stringify({
      ok: false,
      ref: normalizeRef(result?.ref),
      error: result?.error || "not_found_or_not_visible",
    }, null, 2);
  }
  const entry = result.entry;
  if (entry.entry_kind === "materialized") {
    const fullText = entry.payload_text || "";
    const paged = pageMaterializedText(fullText, args);
    const handoffLines = String(fullText).replace(/\r\n?/g, "\n").split("\n");
    if (handoffLines.length > 1 && handoffLines.at(-1) === "") handoffLines.pop();
    return JSON.stringify({
      ok: true,
      ref: entry.ref,
      object_type: entry.object_type,
      source: entry.source,
      note: entry.note,
      content_hash: entry.content_hash,
      size_chars: entry.size_chars,
      handoff_line_count: handoffLines.length,
      handoff_requires_slice: handoffLines.length > 40 || fullText.length > 4000,
      text: paged.text,
      page: {
        ...paged.page,
        full_size_chars: fullText.length,
      },
      notice: paged.page.has_more
        ? "atlas.fetch_ref returned a bounded page from the same stored dataset; this is not a fresh originating-tool call. Continue with page.next_offset as offset, or use search for a focused slice."
        : undefined,
    }, null, 2);
  }
  return JSON.stringify({
    ok: true,
    ref: entry.ref,
    object_type: entry.object_type,
    source: entry.source,
    note: entry.note,
    content_hash: entry.content_hash,
    size_chars: entry.size_chars,
    degraded: true,
    descriptor: entry.descriptor,
    fingerprint_map: entry.fingerprint_map,
    notice: entry.metadata?.retention_exceeded
      ? `Payload exceeded the bounded retention cap. Digest and fingerprints were kept; re-run ${entry.descriptor?.tool || "the source tool"} with narrower args.`
      : "This ref is descriptor-backed. Recompute fetch is not wired for this descriptor in the current runtime, so the original payload is not being claimed verbatim.",
  }, null, 2);
}

function fetchDeliveryDetail(renderedText) {
  try {
    const rendered = JSON.parse(String(renderedText || "{}"));
    const page = rendered?.page && typeof rendered.page === "object" ? rendered.page : {};
    const returnedChars = Number.isFinite(Number(page.returned_chars))
      ? Number(page.returned_chars)
      : (typeof rendered?.text === "string" ? rendered.text.length : null);
    return {
      object_type: rendered?.object_type || null,
      page_mode: page.mode || null,
      search_mode: page.search_mode || null,
      requested_search_mode: page.requested_search_mode || null,
      match_count: Number.isFinite(Number(page.match_count)) ? Number(page.match_count) : null,
      returned_chars: returnedChars,
      has_more: page.has_more === true,
      empty: rendered?.ok === true && returnedChars === 0,
      search_error: page.search_error || null,
    };
  } catch {
    return {
      object_type: null,
      page_mode: null,
      search_mode: null,
      requested_search_mode: null,
      match_count: null,
      returned_chars: null,
      has_more: false,
      empty: false,
      search_error: null,
    };
  }
}

function recordFetchObservation(hashContext, ref, result, renderedText = null) {
  const delivery = fetchDeliveryDetail(renderedText);
  try {
    logEvent({
      work_item_id: hashContext.work_item_id ?? null,
      job_id: hashContext.job_id ?? null,
      attempt_id: hashContext.attempt_id ?? null,
      event_type: EVENT_TYPES.HASH_REF_FETCH,
      actor_type: EVENT_ACTORS.SYSTEM,
      actor_id: "hash_ref_store",
      message: result?.ok && result?.found ? `Fetched ${ref}` : `Fetch miss for ${ref}`,
      event_json: {
        ref,
        ok: result?.ok === true,
        found: result?.found === true,
        error: result?.error || null,
        ...delivery,
      },
    });
  } catch {
    // Durable counters are useful, but fetch_ref delivery must stay best-effort.
  }
  recordObservation({
    work_item_id: hashContext.work_item_id ?? null,
    job_id: hashContext.job_id ?? null,
    attempt_id: hashContext.attempt_id ?? null,
    observation_type: "hash_ref.fetch",
    summary: result?.ok && result?.found ? `Fetched ${ref}` : `Fetch miss for ${ref}`,
    detail: {
      ref,
      ok: result?.ok === true,
      found: result?.found === true,
      error: result?.error || null,
      ...delivery,
    },
  });
}

function invalidRefResult(ref) {
  return {
    ok: false,
    found: false,
    ref: normalizeRef(ref),
    error: "invalid_ref",
  };
}

function parseFetchPayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_fetch_ref_payload", text: String(text || "") };
  }
}

export function fetchHashRefTool(args = {}, {
  context = {},
} = {}) {
  const hashContext = contextForHashRefs(context);
  const refs = refInputs(args);
  if (refs.length === 0) return JSON.stringify({ ok: false, error: "fetch_ref requires ref or refs" }, null, 2);
  if (refs.length === 1 && !Array.isArray(args.refs) && !Array.isArray(args.hashes)) {
    const result = isHashRefAlias(refs[0]) ? fetchHashRefForContext(hashContext, refs[0]) : invalidRefResult(refs[0]);
    const rendered = fetchResultText(result, args);
    recordFetchObservation(hashContext, refs[0], result, rendered);
    return rendered;
  }

  const results = refs.map((ref) => {
    const result = isHashRefAlias(ref) ? fetchHashRefForContext(hashContext, ref) : invalidRefResult(ref);
    const rendered = fetchResultText(result, args);
    recordFetchObservation(hashContext, ref, result, rendered);
    return parseFetchPayload(rendered);
  });
  const found = results.filter((entry) => entry?.ok === true).length;
  return JSON.stringify({
    ok: found === refs.length,
    count: refs.length,
    found,
    missing: refs.length - found,
    refs: results,
  }, null, 2);
}

function createRefError(error, extra = {}) {
  return { ok: false, error, ...extra };
}

function sliceSourcePayload(payloadText, item) {
  const text = String(payloadText ?? "");
  const lines = String(item.lines || "").trim();
  if (lines) {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(lines);
    if (!match) return { error: "invalid_lines_range (use \"start-end\", 1-based)" };
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < 1 || end < start) return { error: "invalid_lines_range (use \"start-end\", 1-based)" };
    const rows = text.replace(/\r\n/g, "\n").split("\n");
    if (start > rows.length) return { error: `lines_out_of_range (source has ${rows.length} lines)` };
    return { text: rows.slice(start - 1, Math.min(end, rows.length)).join("\n"), slice: `lines:${start}-${Math.min(end, rows.length)}` };
  }
  const offset = Math.max(0, Number(item.offset) || 0);
  const limit = item.limit != null ? Math.max(1, Number(item.limit) || 0) : null;
  if (offset === 0 && limit == null) return { text, slice: null };
  if (offset >= text.length) return { error: `offset_out_of_range (source has ${text.length} chars)` };
  return {
    text: text.slice(offset, limit != null ? offset + limit : undefined),
    slice: `chars:${offset}-${limit != null ? Math.min(offset + limit, text.length) : text.length}`,
  };
}

function createOneHashRef(hashContext, item = {}) {
  const inlineText = typeof item.text === "string" ? item.text : null;
  const sourceRef = item.source_ref ?? item.sourceRef ?? item.from_ref ?? null;
  if ((inlineText == null || inlineText.trim() === "") && !sourceRef) {
    return createRefError("create_ref requires text or source_ref");
  }
  if (inlineText != null && sourceRef) {
    return createRefError("create_ref accepts text OR source_ref, not both");
  }

  let payload = inlineText;
  let sliceNote = null;
  let sourceAlias = null;
  if (sourceRef) {
    sourceAlias = normalizeRef(sourceRef);
    if (!isHashRefAlias(sourceAlias)) return createRefError("invalid_source_ref", { source_ref: String(sourceRef) });
    const fetched = fetchHashRefForContext(hashContext, sourceAlias);
    if (!fetched?.ok || !fetched?.found || !fetched.entry) {
      return createRefError("source_ref_not_found_or_not_visible", { source_ref: sourceAlias });
    }
    if (fetched.entry.payload_text == null) {
      return createRefError("source_ref_not_materialized (descriptor-only payloads cannot be sliced)", { source_ref: sourceAlias });
    }
    const sliced = sliceSourcePayload(fetched.entry.payload_text, item);
    if (sliced.error) return createRefError(sliced.error, { source_ref: sourceAlias });
    payload = sliced.text;
    sliceNote = sliced.slice;
  }

  if (typeof payload !== "string" || payload.trim() === "") {
    return createRefError("empty_payload");
  }
  if (payload.length > CREATE_REF_MAX_TEXT_CHARS) {
    return createRefError(`payload_too_large (${payload.length} chars, max ${CREATE_REF_MAX_TEXT_CHARS}); split into smaller chunks`);
  }

  const note = String(item.note ?? "").replace(/\s+/g, " ").trim().slice(0, CREATE_REF_MAX_NOTE_CHARS) || null;
  const objectType = normalizeObjectType(item.object_type ?? item.objectType ?? "agent.chunk") || "agent.chunk";
  const requestedScope = String(item.owner_scope ?? item.ownerScope ?? "work_item").trim();
  if (!CREATE_REF_OWNER_SCOPES.has(requestedScope)) {
    return createRefError(`invalid_owner_scope (use ${[...CREATE_REF_OWNER_SCOPES].join(" or ")})`);
  }
  // Handoff chunks default to work_item scope so any later agent in the work
  // item (sibling jobs included) can resolve them; job scope is the opt-in.
  const ownerScope = requestedScope === "work_item" && hashContext.work_item_id == null ? "job" : requestedScope;

  let surfaced;
  try {
    surfaced = surfaceHashRefForContext(hashContext, {
      entryKind: "materialized",
      payloadText: payload,
      descriptor: {
        kind: "agent_chunk",
        source: "agent:create_ref",
        ...(sourceAlias ? { source_ref: sourceAlias, slice: sliceNote } : {}),
      },
      objectType,
      source: "agent:create_ref",
      note,
      sizeChars: payload.length,
      recomputable: false,
      metadata: {
        surfaced_by: "create_ref",
        ...(sourceAlias ? { source_ref: sourceAlias, slice: sliceNote } : {}),
      },
    }, { ownerScope });
  } catch (err) {
    return createRefError(`create_failed: ${err?.message || err}`);
  }
  if (!surfaced?.ok || !surfaced?.entry?.ref) {
    return createRefError(`create_failed: ${surfaced?.error || "store rejected the entry"}`);
  }

  recordObservation({
    work_item_id: hashContext.work_item_id ?? null,
    job_id: hashContext.job_id ?? null,
    attempt_id: hashContext.attempt_id ?? null,
    observation_type: "hash_ref.create",
    summary: `Created ${surfaced.entry.ref} (${objectType}, ${payload.length} chars)`,
    detail: {
      ref: surfaced.entry.ref,
      object_type: objectType,
      owner_scope: ownerScope,
      size_chars: payload.length,
      source_ref: sourceAlias,
      slice: sliceNote,
    },
  });

  const handoffLineCount = normalizedLinesForHandoff(payload);
  return {
    ok: true,
    ref: surfaced.entry.ref,
    stub: refStub({ entry: { ref: surfaced.entry.ref, object_type: objectType, note }, toolName: "create_ref", sizeChars: payload.length }).trim(),
    object_type: objectType,
    owner_scope: ownerScope,
    chars: payload.length,
    lines: handoffLineCount,
    authorship: sourceAlias ? "server_slice" : "agent_authored",
    handoff_requires_slice: handoffLineCount > 40 || payload.length > 4000,
    ...(note ? { note } : {}),
    ...(sourceAlias ? { source_ref: sourceAlias, slice: sliceNote } : {}),
  };
}

/**
 * Agent-callable minting: store a chunk of evidence (inline text, or a slice
 * of an existing materialized ref) and get back a citable #ref + stub.
 * Single form: { text | source_ref [+ lines|offset/limit], note?, object_type?, owner_scope? }
 * Batch form:  { chunks: [ ...same per-item fields... ] } with per-item errors.
 * The contract intent: synthesis stays prose; evidence moves as refs.
 */
export function createHashRefTool(args = {}, {
  context = {},
} = {}) {
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) {
    return JSON.stringify({ ok: false, error: "create_ref requires an active work item / job scope" }, null, 2);
  }
  const batch = Array.isArray(args.chunks) ? args.chunks : null;
  if (batch) {
    if (batch.length === 0) return JSON.stringify({ ok: false, error: "chunks must be a non-empty array" }, null, 2);
    if (batch.length > CREATE_REF_MAX_BATCH) {
      return JSON.stringify({ ok: false, error: `too_many_chunks (${batch.length}, max ${CREATE_REF_MAX_BATCH})` }, null, 2);
    }
    const results = batch.map((item) => createOneHashRef(hashContext, item && typeof item === "object" ? item : {}));
    const created = results.filter((entry) => entry.ok).length;
    return JSON.stringify({
      ok: created === results.length,
      count: results.length,
      created,
      failed: results.length - created,
      chunks: results,
    }, null, 2);
  }
  return JSON.stringify(createOneHashRef(hashContext, args), null, 2);
}

export const __testHashAdderInternals = Object.freeze({
  DEFAULT_MATERIALIZE_CHAR_CAP,
  DEFAULT_SURFACE_MIN_CHARS,
  AMBIENT_STAMPING_SURFACE_MIN_CHARS,
  EVIDENCE_REF_SURFACE_MIN_CHARS,
  EVIDENCE_REF_TOOLS,
  surfaceMinCharsFor,
  boundingPolicyFor,
  overflowDigest,
  pageMaterializedText,
  renderBoundedResult,
  lineFingerprintMap,
  normalizeRef,
  shouldSurfaceHashRef,
});
