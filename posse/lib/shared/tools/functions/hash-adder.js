import crypto from "crypto";

import {
  getObservationContext,
  hashRefFetchObservationLedger,
  recordObservation,
} from "../../../domains/observability/functions/observations.js";
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
import {
  admitHashRefFetch,
  hashRefModelVisibility,
  hashRefModelVisibleScope,
} from "./fetch-ref-policy.js";

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
const RESEARCH_FETCH_REF_MAX_REFS = 24;
const RESEARCH_FETCH_REF_PER_REF_CHARS = 8000;
const RESEARCH_FETCH_REF_TOTAL_TEXT_CHARS = 32000;
const RESEARCH_FETCH_REF_MAX_SERIALIZED_CHARS = 40000;
const RESEARCH_FETCH_REF_ENVELOPE_BASE_RESERVE = 4096;
const RESEARCH_FETCH_REF_ENVELOPE_PER_REF_RESERVE = 1024;
const RESEARCH_FETCH_REF_VISIBLE_METADATA_CHARS = 240;
const RESEARCH_FETCH_REF_NESTED_METADATA_CHARS = 512;
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

// symbol.search bounding is a transport invariant (atlas_search_result_paging,
// default on — an explicit "off" is an operator escape hatch, not a baseline):
// unbounded search results were a primary retained-input regression while the
// flag defaulted off. search_files/list_files keep their long-standing
// unconditional policies.
const SEARCH_PAGING_POLICY_KEYS = new Set(["symbol.search", "atlas.symbol.search"]);

function searchResultPagingEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.ATLAS_SEARCH_RESULT_PAGING);
    if (stored == null) return true;
    const normalized = String(stored).trim().toLowerCase();
    return !(normalized === "off" || normalized === "false" || normalized === "0" || normalized === "no");
  } catch {
    return true;
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

function boundedResultSlices(text, policy, sizeChars = String(text || "").length) {
  const headChars = Math.max(0, Math.min(policy.headChars || policy.capChars || 0, sizeChars));
  const tailChars = Math.max(0, Math.min(policy.tailChars || 0, Math.max(0, sizeChars - headChars)));
  const tailStart = sizeChars - tailChars;
  return {
    head: text.slice(0, headChars),
    tail: tailChars > 0 ? text.slice(tailStart) : "",
    omitted: text.slice(headChars, tailStart),
    omittedStart: headChars,
    omittedEnd: tailStart,
  };
}

function renderBoundedResult(text, {
  policy,
  toolName,
  objectType,
  args,
  sizeChars,
  slices = boundedResultSlices(text, policy, sizeChars),
}) {
  const { head, tail } = slices;
  const omitted = slices.omitted.length;
  const objectLabel = normalizeObjectType(objectType) || normalizeObjectType(toolName) || "tool_result";
  const digest = overflowDigest(text, policy, toolName, args);
  const digestText = JSON.stringify(digest, null, 2);
  const lines = [
    `[bounded_result ${objectLabel}: full payload ${sizeChars} chars; showing ${head.length}${tail ? `+${tail.length}` : ""} chars; omitted ${omitted} chars]`,
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
  return lines.join("\n");
}

function boundedSearchRow({
  line,
  lineNumber,
  matchStart = 0,
  matchLength = 0,
  maxChars,
}) {
  const prefix = `${lineNumber}:`;
  const value = String(line || "");
  const budget = Math.max(0, Number(maxChars) || 0);
  if (budget <= prefix.length) {
    return {
      text: prefix.slice(0, budget),
      truncated: value.length > 0,
    };
  }
  const available = budget - prefix.length;
  if (value.length <= available) {
    return { text: `${prefix}${value}`, truncated: false };
  }

  const marker = "…";
  const rawBudget = Math.max(1, available - (marker.length * 2));
  const safeMatchStart = Math.max(0, Math.min(Number(matchStart) || 0, value.length));
  const safeMatchLength = Math.max(0, Math.min(Number(matchLength) || 0, value.length - safeMatchStart));
  const matchCenter = safeMatchStart + Math.floor(safeMatchLength / 2);
  let start = Math.max(0, matchCenter - Math.floor(rawBudget / 2));
  start = Math.min(start, Math.max(0, value.length - rawBudget));
  let end = Math.min(value.length, start + rawBudget);
  const leading = start > 0 ? marker : "";
  const trailing = end < value.length ? marker : "";
  const exactBudget = Math.max(1, available - leading.length - trailing.length);
  if (end - start > exactBudget) end = start + exactBudget;
  return {
    text: `${prefix}${leading}${value.slice(start, end)}${trailing}`.slice(0, budget),
    truncated: true,
  };
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
      const matchStart = lines[i].toLowerCase().indexOf(literalNeedle);
      if (matchStart >= 0) {
        literalRows.push({
          line: lines[i],
          lineNumber: i + 1,
          matchStart,
          matchLength: search.length,
        });
      }
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
          const match = expression.exec(lines[i]);
          if (match) {
            rows.push({
              line: lines[i],
              lineNumber: i + 1,
              matchStart: match.index,
              matchLength: match[0]?.length || 0,
            });
          }
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
    let truncatedMatchRows = 0;
    for (const row of rows.slice(rowOffset)) {
      const separatorChars = selected.length > 0 ? 1 : 0;
      const remaining = limit - chars - separatorChars;
      if (remaining <= 0) break;
      const rendered = boundedSearchRow({ ...row, maxChars: remaining });
      if (!rendered.text) break;
      selected.push(rendered.text);
      if (rendered.truncated) truncatedMatchRows += 1;
      chars += rendered.text.length + separatorChars;
      if (chars >= limit) break;
    }
    const selectedRowCount = selected.length;
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
        truncated_match_rows: truncatedMatchRows,
        next_offset: rowOffset + selectedRowCount < rows.length ? rowOffset + selectedRowCount : null,
        has_more: rowOffset + selectedRowCount < rows.length,
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
          ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
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
          fetch_class: "survey_page",
          ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
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
const BATCH_WINDOW_INLINE_CONTENT_CHARS = 4000;

function boundedBatchWindowContent(content) {
  if (content.length <= BATCH_WINDOW_INLINE_CONTENT_CHARS) {
    return { content, truncated: false };
  }
  const bounded = content.slice(0, BATCH_WINDOW_INLINE_CONTENT_CHARS);
  const finalLineBreak = bounded.lastIndexOf("\n");
  return {
    content: finalLineBreak > 0 ? bounded.slice(0, finalLineBreak) : bounded,
    truncated: true,
  };
}

function compactBatchCodeWindowItem(data = {}) {
  const compact = {};
  for (const key of [
    "repo_rel_path",
    "symbolId",
    "startLine",
    "endLine",
    "totalLines",
    "estimatedTokens",
    "truncated",
    "selectionBounded",
    "outputTruncated",
    "identifiersFound",
    "identifiersReturned",
    "identifiersMissing",
    "identifiersOmitted",
    "returnedFunctionAnchors",
    "returnedFunctionAnchorsOmitted",
    "continuationRef",
    "continuationWindows",
    "continuationRanges",
  ]) {
    if (data[key] != null) compact[key] = data[key];
  }
  if (typeof data.content === "string") {
    const preview = boundedBatchWindowContent(data.content);
    compact.content = preview.content;
    if (preview.truncated) {
      compact.inlineContentTruncated = true;
      compact.fullContentEndLine = data.endLine;
      const startLine = Number(data.startLine);
      if (Number.isFinite(startLine) && preview.content.length > 0) {
        compact.endLine = startLine + preview.content.split("\n").length - 1;
      }
    }
  }
  const additionalWindows = Array.isArray(data.additionalWindows)
    ? data.additionalWindows
    : [];
  if (additionalWindows.length > 0) {
    compact.inlineAdditionalWindowsOmitted = additionalWindows.length;
    compact.additionalWindowRanges = additionalWindows.map((window) => ({
      startLine: Number(window?.startLine) || null,
      endLine: Number(window?.endLine) || null,
      ...(Array.isArray(window?.identifiers) && window.identifiers.length > 0
        ? { identifiers: window.identifiers.map(String) }
        : {}),
    }));
  }
  if (compact.inlineContentTruncated || additionalWindows.length > 0) {
    compact.fetchEvidenceRefForFullContent = true;
  }
  return compact;
}

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

function dedupeCodeWindowContinuationWindows(entries) {
  const windows = [];
  const byContentRange = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object" || typeof entry.content !== "string" || !entry.content) continue;
    const startLine = Math.max(1, Number(entry.startLine) || 1);
    const endLine = Math.max(startLine, Number(entry.endLine) || startLine);
    const identifiers = Array.isArray(entry.identifiers)
      ? [...new Set(entry.identifiers.map(String).filter(Boolean))]
      : [];
    const key = `${startLine}\u0000${endLine}\u0000${entry.content}`;
    const existing = byContentRange.get(key);
    if (existing) {
      existing.identifiers = [...new Set([...existing.identifiers, ...identifiers])];
      continue;
    }
    const normalized = { content: entry.content, startLine, endLine, identifiers };
    byContentRange.set(key, normalized);
    windows.push(normalized);
  }
  windows.sort((left, right) => (
    left.startLine - right.startLine
    || left.endLine - right.endLine
    || left.content.localeCompare(right.content)
  ));
  return windows;
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
  const min = minChars ?? resultRefPagingMinChars();
  const hashContext = contextForHashRefs(context);

  let envelope;
  try {
    envelope = JSON.parse(result);
  } catch {
    return { result, compacted: false };
  }
  const batchData = envelope?.data && typeof envelope.data === "object"
    ? envelope.data
    : envelope;
  if (tool === "code.window" && batchData?.batch === true && Array.isArray(batchData.items)) {
    const scope = { ownerScope: ownerScope || (hashContext.job_id != null ? "job" : null) };
    let compacted = false;
    for (const item of batchData.items) {
      if (item?.ok !== true || !item.data || typeof item.data !== "object") continue;
      const itemArgs = Array.isArray(args?.items) ? args.items[item.index] || {} : {};
      const child = compactCodeWindowLensResult("code.window", JSON.stringify(item.data), {
        args: itemArgs,
        context,
        ownerScope,
        enabled,
        minChars,
      });
      try {
        item.data = JSON.parse(child.result);
        compacted ||= child.compacted;
      } catch {
        // The child began as JSON; retain the original structured data if a
        // defensive transform ever returns a non-JSON transport string.
      }
      if (!hasHashRefScope(hashContext)) continue;
      const payloadText = JSON.stringify(item.data, null, 1);
      let surfaced;
      try {
        surfaced = surfaceHashRefForContext(hashContext, {
          entryKind: "materialized",
          payloadText,
          descriptor: {
            kind: "tool_result",
            tool: "code.window",
            args: itemArgs,
            batchItem: Number(item.index),
            source: "tool:code.window",
          },
          objectType: "atlas.code.window.batch_item",
          source: "tool:code.window",
          note: `code.window batch item ${Number(item.index) + 1}: ${item.data.repo_rel_path || item.target?.file || item.target?.symbolId || "selection"}`,
          sizeChars: payloadText.length,
          recomputable: true,
          metadata: {
            surfaced_by: "code_window_batch",
            fetch_class: "citation",
            // The response carries a flattened preview, not this complete
            // stored payload. Keep the full-item ref fetchable for any
            // explicitly reported omitted content or secondary windows.
            ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
            tool: "code.window",
            batch_item: Number(item.index),
            repo_rel_path: item.data.repo_rel_path || null,
          },
        }, scope);
      } catch (err) {
        recordHashSurfaceFailure(hashContext, tool, payloadText.length, err?.message || err);
      }
      if (surfaced?.ok && surfaced?.entry?.ref) {
        item.evidenceRef = {
          ref: surfaced.entry.ref,
          objectType: surfaced.entry.object_type,
          sizeChars: payloadText.length,
        };
        Object.assign(item, compactBatchCodeWindowItem(item.data));
        delete item.data;
        compacted = true;
      }
    }
    return compacted
      ? { result: JSON.stringify(envelope, null, 2), compacted: true }
      : { result, compacted: false };
  }
  // Like code.survey above: the MCP owner stamps the BARE payload (top-level
  // matches[]/content), dispatch envelopes nest it under .data. Accept both —
  // the .data-only assumption silently no-ops the production owner/embedded paths.
  const bare = envelope && typeof envelope === "object"
    && (Array.isArray(envelope.matches) || typeof envelope.content === "string")
    ? envelope
    : null;
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : bare;
  if (!data) return { result, compacted: false };
  const scope = { ownerScope: ownerScope || (hashContext.job_id != null ? "job" : null) };
  const pagingEnabled = enabled ?? resultRefPagingEnabled();
  let compacted = false;

  // A returned anonymous callable is useful as an addressable source scope,
  // but not as a durable indexed symbol. Materialize its exact native range
  // once in the job hash store and expose only a compact line/ref map. This
  // runs independently of result-tail paging because it is addressability,
  // not a response-size optimization.
  if (tool === "code.window" && Array.isArray(data._returnedFunctionAnchors)) {
    const seen = new Set();
    const anchors = data._returnedFunctionAnchors.filter((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.content !== "string" || !entry.content) {
        return false;
      }
      const key = [
        data.repo_rel_path,
        Number(entry.rangeStart) || 0,
        Number(entry.rangeEnd) || 0,
        entry.content,
      ].join("\u0000");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    delete data._returnedFunctionAnchors;
    const anchorMap = [];
    for (const entry of anchors) {
      const startLine = Math.max(1, Number(entry.startLine) || 1);
      const endLine = Math.max(startLine, Number(entry.endLine) || startLine);
      const signature = String(entry.signature || "").trim();
      const callableKind = String(entry.callableKind || "anonymous_function").trim();
      const owner = String(entry.owner || "").trim();
      const anchor = String(entry.anchor || "").trim()
        || (owner ? `${owner}::<returned ${signature || callableKind}>` : `<returned ${signature || callableKind} @ line ${startLine}>`);
      const visible = {
        anchor,
        ...(owner ? { owner } : {}),
        signature,
        callableKind,
        startLine,
        endLine,
      };
      if (hasHashRefScope(hashContext)) {
        let surfaced;
        try {
          surfaced = surfaceHashRefForContext(hashContext, {
            entryKind: "materialized",
            payloadText: entry.content,
            descriptor: {
              kind: "source_anchor",
              tool: "code.window",
              repo_rel_path: data.repo_rel_path,
              startLine,
              endLine,
              relation: "return",
            },
            objectType: "code.window.returned_function",
            source: "tool:code.window",
            note: `${data.repo_rel_path} returned anonymous function lines ${startLine}-${endLine}`,
            sizeChars: entry.content.length,
            recomputable: true,
            metadata: {
              surfaced_by: "returned_function_anchor",
              fetch_class: "source_anchor",
              ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
              tool: "code.window",
              repo_rel_path: data.repo_rel_path,
              start_line: startLine,
              end_line: endLine,
              relation: "return",
            },
          }, scope);
        } catch (err) {
          recordHashSurfaceFailure(hashContext, tool, entry.content.length, err?.message || err);
        }
        if (surfaced?.ok && surfaced?.entry?.ref) visible.ref = surfaced.entry.ref;
      }
      anchorMap.push(visible);
    }
    if (anchorMap.length > 0) data.returnedFunctionAnchors = anchorMap;
    compacted = true;
  }

  // A continuation is a lossless partition of the already-selected result.
  // Combine the native hard-budget remainder with any Node display tail before
  // materialization so one ordered ref owns every omitted line exactly once.
  // Never infer a continuation from the legacy `truncated` bit: it also marks
  // intentional bounded selections.
  if (tool === "code.window") {
    const nativeContinuation = Array.isArray(data._continuationWindows)
      ? data._continuationWindows
      : [];
    const carriedNativeContinuation = Array.isArray(data._continuationWindows);
    delete data._continuationWindows;
    let displayTail = null;
    let displayOriginal = null;
    if (
      pagingEnabled
      && result.length > min
      && hasHashRefScope(hashContext)
      && typeof data.content === "string"
      && data.content.length > min
    ) {
      const lines = data.content.split("\n");
      let headChars = 0;
      let splitAt = lines.length;
      for (let index = 0; index < lines.length; index++) {
        headChars += lines[index].length + 1;
        if (headChars >= min) {
          splitAt = index + 1;
          break;
        }
      }
      if (splitAt < lines.length) {
        const startLine = Number(data.startLine) || 1;
        const contentEndLine = startLine + lines.length - 1;
        const originalEndLine = Math.max(contentEndLine, Number(data.endLine) || contentEndLine);
        displayOriginal = {
          endLine: originalEndLine,
          outputTruncated: data.outputTruncated === true,
          truncated: data.truncated === true,
        };
        displayTail = {
          content: lines.slice(splitAt).join("\n"),
          startLine: startLine + splitAt,
          endLine: originalEndLine,
          identifiers: [],
        };
        data.content = lines.slice(0, splitAt).join("\n");
        data.endLine = displayTail.startLine - 1;
        data.outputTruncated = true;
        data.truncated = true;
      }
    }
    const continuation = dedupeCodeWindowContinuationWindows([
      ...nativeContinuation,
      ...(displayTail ? [displayTail] : []),
    ]);
    if (continuation.length > 0 && hasHashRefScope(hashContext)) {
      const continuationPayload = JSON.stringify({
        tool: "code.window",
        repo_rel_path: data.repo_rel_path,
        requestedWindows: continuation,
      }, null, 1);
      let surfaced;
      try {
        surfaced = surfaceHashRefForContext(hashContext, {
          entryKind: "materialized",
          payloadText: continuationPayload,
          descriptor: { kind: "tool_result", tool: "code.window", args, source: "tool:code.window" },
          objectType: "code.window.continuation",
          source: "tool:code.window",
          note: `${continuation.length} selected code.window region(s) omitted from the inline display`,
          sizeChars: continuationPayload.length,
          recomputable: true,
          metadata: {
            surfaced_by: "requested_region_continuation",
            fetch_class: "result_continuation",
            ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
            tool: "code.window",
            windows: continuation.length,
          },
        }, scope);
      } catch (err) {
        recordHashSurfaceFailure(hashContext, tool, continuationPayload.length, err?.message || err);
      }
      if (surfaced?.ok && surfaced?.entry?.ref) {
        data.continuationRef = surfaced.entry.ref;
        data.continuationWindows = continuation.length;
        data.continuationRanges = continuation.map((entry) => `${entry.startLine}-${entry.endLine}`);
      } else {
        // Materialization failure must not silently discard selected evidence.
        // Restore the display tail to the primary content and expose native
        // slices inline.
        if (displayTail) {
          data.content = `${data.content}\n${displayTail.content}`;
          data.endLine = displayOriginal.endLine;
          data.outputTruncated = displayOriginal.outputTruncated;
          data.truncated = displayOriginal.truncated;
        }
        const nativeInline = continuation.filter((entry) => !(displayTail
          && entry.startLine === displayTail.startLine
          && entry.endLine === displayTail.endLine
          && entry.content === displayTail.content));
        data.additionalWindows = [
          ...(Array.isArray(data.additionalWindows) ? data.additionalWindows : []),
          ...nativeInline,
        ];
        const nowInline = [...new Set(nativeInline.flatMap((entry) => (
          Array.isArray(entry.identifiers) ? entry.identifiers.map(String) : []
        )))];
        data.identifiersReturned = [...new Set([
          ...(Array.isArray(data.identifiersReturned) ? data.identifiersReturned.map(String) : []),
          ...nowInline,
        ])];
        data.identifiersOmitted = (Array.isArray(data.identifiersOmitted) ? data.identifiersOmitted : [])
          .filter((identifier) => !nowInline.includes(String(identifier)));
        data.outputTruncated = false;
        data.continuationInline = true;
      }
      compacted = true;
    } else if (continuation.length > 0) {
      if (displayTail) {
        data.content = `${data.content}\n${displayTail.content}`;
        data.endLine = displayOriginal.endLine;
        data.outputTruncated = displayOriginal.outputTruncated;
        data.truncated = displayOriginal.truncated;
      }
      const nativeInline = continuation.filter((entry) => !(displayTail
        && entry.startLine === displayTail.startLine
        && entry.endLine === displayTail.endLine
        && entry.content === displayTail.content));
      data.additionalWindows = [
        ...(Array.isArray(data.additionalWindows) ? data.additionalWindows : []),
        ...nativeInline,
      ];
      const nowInline = [...new Set(nativeInline.flatMap((entry) => (
        Array.isArray(entry.identifiers) ? entry.identifiers.map(String) : []
      )))];
      data.identifiersReturned = [...new Set([
        ...(Array.isArray(data.identifiersReturned) ? data.identifiersReturned.map(String) : []),
        ...nowInline,
      ])];
      data.identifiersOmitted = (Array.isArray(data.identifiersOmitted) ? data.identifiersOmitted : [])
        .filter((identifier) => !nowInline.includes(String(identifier)));
      data.outputTruncated = false;
      data.continuationInline = true;
      compacted = true;
    } else if (carriedNativeContinuation) {
      compacted = true;
    }
  }

  if (!pagingEnabled || result.length <= min || !hasHashRefScope(hashContext)) {
    return compacted
      ? { result: JSON.stringify(envelope, null, 2), compacted: true }
      : { result, compacted: false };
  }

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
        metadata: {
          surfaced_by: "result_ref_paging",
          fetch_class: "result_tail",
          ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
          tool: "code.lens",
          matches: tail.length,
        },
      }, scope);
    } catch (err) {
      recordHashSurfaceFailure(hashContext, tool, tailPayload.length, err?.message || err);
      return { result, compacted: false };
    }
    if (!surfaced?.ok || !surfaced?.entry?.ref) return { result, compacted: false };
    data.matches = data.matches.slice(0, LENS_INLINE_MATCHES);
    data.tailMatchesRef = surfaced.entry.ref;
    data.tailMatchesTotal = LENS_INLINE_MATCHES + tail.length;
    return { result: JSON.stringify(envelope, null, 2), compacted: true };
  }

  return compacted
    ? { result: JSON.stringify(envelope, null, 2), compacted: true }
    : { result, compacted: false };
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

function refStub({ entry, toolName, sizeChars, refRole = "citation" }) {
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
  const normalizedRole = refRole === "continuation" ? "continuation" : "citation";
  const currentFetch = normalizedRole === "continuation" ? "allowed" : "not_needed";
  return `\n\n[ref_hash ${objectType} ${sizeChars} chars ${ref} ref_role=${normalizedRole} current_fetch=${currentFetch}${note}]`;
}

function recordHashObservation(context, surfaced, toolName, sizeChars, {
  refRole = "citation",
} = {}) {
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
      fetch_class: surfaced.entry?.metadata?.fetch_class || null,
      ref_role: refRole === "continuation" ? "continuation" : "citation",
      current_fetch: refRole === "continuation" ? "allowed" : "not_needed",
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

function initiallyVisibleHashRefRanges(policy, sizeChars) {
  if (!policy) return [{ start: 0, end: sizeChars }];
  const headChars = Math.max(0, Math.min(policy.headChars || policy.capChars || 0, sizeChars));
  const tailChars = Math.max(0, Math.min(policy.tailChars || 0, Math.max(0, sizeChars - headChars)));
  return [
    ...(headChars > 0 ? [{ start: 0, end: headChars }] : []),
    ...(tailChars > 0 ? [{ start: sizeChars - tailChars, end: sizeChars }] : []),
  ];
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
  const descriptor = {
    kind: "tool_result",
    tool: toolName,
    args,
    source: source || `tool:${toolName}`,
  };
  const resolvedOwnerScope = ownerScope || (hashContext.job_id != null ? "job" : null);

  if (boundedIngress) {
    const slices = boundedResultSlices(text, boundPolicy, sizeChars);
    const boundedAnchor = renderBoundedResult(text, {
      policy: boundPolicy,
      toolName,
      objectType: effectiveObjectType,
      args,
      sizeChars,
      slices,
    });
    const continuationMaterialized = slices.omitted.length <= CONTEXT_BOUNDED_RETENTION_CHAR_CAP;
    const continuationDescriptor = {
      ...descriptor,
      kind: "bounded_result_continuation",
      original_size_chars: sizeChars,
      original_char_range: { start: slices.omittedStart, end: slices.omittedEnd },
    };
    let continuation;
    if (slices.omitted.length > 0) {
      try {
        continuation = surfaceHashRefForContext(hashContext, {
          ...(continuationMaterialized
            ? {
                entryKind: "materialized",
                payloadText: slices.omitted,
                descriptor: continuationDescriptor,
                recomputable: true,
              }
            : {
                entryKind: "descriptor",
                descriptor: continuationDescriptor,
                fingerprintMap: lineFingerprintMap(slices.omitted),
                recomputable: true,
              }),
          objectType: `${effectiveObjectType}.continuation`,
          source: source || `tool:${toolName}`,
          note: [
            note,
            continuationMaterialized
              ? `omitted original chars ${slices.omittedStart}-${slices.omittedEnd}`
              : "bounded continuation exceeded retention cap",
          ].filter(Boolean).join(" | "),
          sizeChars: slices.omitted.length,
          metadata: {
            surfaced_by: "hash_adder",
            fetch_class: "bounded_result",
            tool: toolName || null,
            materialized: continuationMaterialized,
            bounded_ingress: true,
            bounded_continuation: true,
            retention_exceeded: !continuationMaterialized,
            original_size_chars: sizeChars,
            original_char_start: slices.omittedStart,
            original_char_end: slices.omittedEnd,
            ...hashRefModelVisibility(hashContext, { visibility: "hidden" }),
          },
        }, { ownerScope: resolvedOwnerScope });
      } catch (err) {
        recordHashSurfaceFailure(hashContext, toolName, slices.omitted.length, err?.message || err);
      }
    }
    const continuationAvailable = continuationMaterialized
      && continuation?.ok
      && continuation?.entry?.ref;
    let anchor;
    try {
      anchor = surfaceHashRefForContext(hashContext, {
        entryKind: "materialized",
        payloadText: boundedAnchor,
        descriptor: {
          ...descriptor,
          kind: "bounded_result_anchor",
          continuation_ref: continuationAvailable ? continuation.entry.ref : null,
        },
        objectType: effectiveObjectType,
        source: source || `tool:${toolName}`,
        note: [note, "bounded visible anchor"].filter(Boolean).join(" | "),
        sizeChars: boundedAnchor.length,
        recomputable: true,
        metadata: {
          surfaced_by: "hash_adder",
          fetch_class: "visible_copy",
          tool: toolName || null,
          materialized: true,
          bounded_ingress: true,
          bounded_anchor: true,
          continuation_ref: continuationAvailable ? continuation.entry.ref : null,
          ...hashRefModelVisibility(hashContext, {
            visibility: "full",
            ranges: [{ start: 0, end: boundedAnchor.length }],
          }),
        },
      }, { ownerScope: resolvedOwnerScope });
    } catch (err) {
      recordHashSurfaceFailure(hashContext, toolName, boundedAnchor.length, err?.message || err);
    }
    if (!anchor?.ok || !anchor?.entry?.ref) {
      recordHashSurfaceFailure(hashContext, toolName, boundedAnchor.length, anchor?.error || "surface_failed");
      recordContextMeterSample(hashContext, toolName, {
        fullSizeChars: sizeChars,
        emittedSizeChars: boundedAnchor.length,
        bounded: true,
      });
      return boundedAnchor;
    }
    recordHashObservation(hashContext, anchor, toolName, boundedAnchor.length, { refRole: "citation" });
    if (continuationAvailable) {
      recordHashObservation(hashContext, continuation, toolName, slices.omitted.length, { refRole: "continuation" });
    }
    const bounded = [
      boundedAnchor,
      refStub({
        entry: anchor.entry,
        toolName: effectiveObjectType,
        sizeChars: boundedAnchor.length,
        refRole: "citation",
      }),
      ...(continuationAvailable ? [
        `\n\n[bounded_continuation_ref ${continuation.entry.ref}]`,
        refStub({
          entry: continuation.entry,
          toolName: `${effectiveObjectType}.continuation`,
          sizeChars: slices.omitted.length,
          refRole: "continuation",
        }),
      ] : ["\n\n[bounded_result_unretained]"]),
    ].join("");
    recordContextMeterSample(hashContext, toolName, {
      fullSizeChars: sizeChars,
      emittedSizeChars: bounded.length,
      bounded: true,
      ref: anchor.entry.ref,
    });
    return bounded;
  }

  const materialized = sizeChars <= materializeCharCap;
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
  const noteText = note || null;
  try {
    surfaced = surfaceHashRefForContext(hashContext, {
      ...entry,
      objectType: effectiveObjectType,
      source: source || `tool:${toolName}`,
      note: noteText,
      sizeChars,
      metadata: {
        surfaced_by: "hash_adder",
        fetch_class: "visible_copy",
        tool: toolName || null,
        materialized,
        ...hashRefModelVisibility(hashContext, {
          visibility: "full",
          ranges: initiallyVisibleHashRefRanges(null, sizeChars),
        }),
      },
    }, { ownerScope: resolvedOwnerScope });
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
  recordHashObservation(hashContext, surfaced, toolName, sizeChars, { refRole: "citation" });
  const stamped = `${result}${refStub({ entry: surfaced.entry, toolName, sizeChars, refRole: "citation" })}`;
  recordContextMeterSample(hashContext, toolName, {
    fullSizeChars: sizeChars,
    emittedSizeChars: stamped.length,
    bounded: false,
    ref: surfaced.entry?.ref || null,
  });
  return stamped;
}

function boundedResearchFetchString(value) {
  if (value == null) return value;
  const text = String(value);
  return text.length <= RESEARCH_FETCH_REF_VISIBLE_METADATA_CHARS
    ? text
    : `${text.slice(0, RESEARCH_FETCH_REF_VISIBLE_METADATA_CHARS - 1)}…`;
}

function boundedResearchFetchMetadata(value) {
  if (value == null) return value;
  let serialized;
  try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
  if (serialized.length <= RESEARCH_FETCH_REF_NESTED_METADATA_CHARS) return value;
  const summary = /** @type {Record<string, any>} */ ({
    omitted: true,
    serialized_chars: serialized.length,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
  });
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["kind", "tool", "source_ref"]) {
      if (value[key] != null) summary[key] = boundedResearchFetchString(value[key]);
    }
  }
  return summary;
}

function fetchResultText(result, args = {}, { researchDelivery = false } = {}) {
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
      source: researchDelivery ? boundedResearchFetchString(entry.source) : entry.source,
      note: researchDelivery ? boundedResearchFetchString(entry.note) : entry.note,
      content_hash: entry.content_hash,
      size_chars: entry.size_chars,
      handoff_line_count: handoffLines.length,
      handoff_requires_slice: handoffLines.length > 40 || fullText.length > 4000,
      text: paged.text,
      page: {
        ...paged.page,
        full_size_chars: fullText.length,
      },
    }, null, 2);
  }
  return JSON.stringify({
    ok: true,
    ref: entry.ref,
    object_type: entry.object_type,
    source: researchDelivery ? boundedResearchFetchString(entry.source) : entry.source,
    note: researchDelivery ? boundedResearchFetchString(entry.note) : entry.note,
    content_hash: entry.content_hash,
    size_chars: entry.size_chars,
    degraded: true,
    descriptor: researchDelivery ? boundedResearchFetchMetadata(entry.descriptor) : entry.descriptor,
    fingerprint_map: researchDelivery ? boundedResearchFetchMetadata(entry.fingerprint_map) : entry.fingerprint_map,
    notice: entry.metadata?.retention_exceeded
      ? "Payload unavailable: bounded retention cap exceeded."
      : "Payload unavailable: descriptor-backed ref cannot be recomputed in this runtime.",
  }, null, 2);
}

function attachFetchedViewRef(renderedText, {
  hashContext,
  sourceEntry,
  fetchArgs = {},
} = {}) {
  let rendered;
  try {
    rendered = JSON.parse(String(renderedText || "{}"));
  } catch {
    return renderedText;
  }
  if (rendered?.ok !== true || typeof rendered.text !== "string" || rendered.text.length === 0) {
    return renderedText;
  }
  const viewText = rendered.text;
  let surfaced;
  try {
    surfaced = surfaceHashRefForContext(hashContext, {
      entryKind: "materialized",
      payloadText: viewText,
      descriptor: {
        kind: "fetch_ref_view",
        tool: sourceEntry?.descriptor?.tool || sourceEntry?.metadata?.tool || "fetch_ref",
        source_ref: sourceEntry?.ref || null,
        fetch: {
          offset: Number(rendered?.page?.offset) || 0,
          limit: Number(rendered?.page?.returned_chars) || viewText.length,
          mode: rendered?.page?.mode || "offset",
          ...(fetchArgs?.search ? { search: String(fetchArgs.search) } : {}),
        },
      },
      objectType: `${normalizeObjectType(sourceEntry?.object_type || "stored_ref")}.view`,
      source: sourceEntry?.source || "tool:fetch_ref",
      note: `exact fetched view of ${sourceEntry?.ref || "stored ref"}`,
      sizeChars: viewText.length,
      recomputable: true,
      metadata: {
        surfaced_by: "fetch_ref_view",
        fetch_class: "visible_copy",
        source_ref: sourceEntry?.ref || null,
        exact_visible_field: "text",
        ...hashRefModelVisibility(hashContext, {
          visibility: "full",
          ranges: [{ start: 0, end: viewText.length }],
        }),
      },
    }, {
      // Keep fetched views beside ordinary tool refs so an all-content page
      // reuses the continuation row instead of materializing the same bytes a
      // second time. Model visibility remains scoped to this agent call.
      ownerScope: hashContext?.job_id != null ? "job" : "work_item",
    });
  } catch (err) {
    recordHashSurfaceFailure(hashContext, "fetch_ref.view", viewText.length, err?.message || err);
    return renderedText;
  }
  if (!surfaced?.ok || !surfaced?.entry?.ref) {
    recordHashSurfaceFailure(hashContext, "fetch_ref.view", viewText.length, surfaced?.error || "surface_failed");
    return renderedText;
  }
  recordHashObservation(hashContext, surfaced, "fetch_ref.view", viewText.length, { refRole: "citation" });
  rendered.view_ref = {
    ref: surfaced.entry.ref,
    ref_role: "citation",
    current_fetch: "not_needed",
    exact_field: "text",
    chars: viewText.length,
    lines: normalizedLinesForHandoff(viewText),
  };
  return JSON.stringify(rendered, null, 2);
}

function fetchDeliveryDetail(renderedText) {
  try {
    const rendered = JSON.parse(String(renderedText || "{}"));
    const page = rendered?.page && typeof rendered.page === "object" ? rendered.page : {};
    const returnedChars = Number.isFinite(Number(page.returned_chars))
      ? Number(page.returned_chars)
      : (typeof rendered?.text === "string" ? rendered.text.length : null);
    const pageOffset = Number.isFinite(Number(page.offset)) ? Number(page.offset) : null;
    return {
      object_type: rendered?.object_type || null,
      page_mode: page.mode || null,
      search_mode: page.search_mode || null,
      requested_search_mode: page.requested_search_mode || null,
      match_count: Number.isFinite(Number(page.match_count)) ? Number(page.match_count) : null,
      truncated_match_rows: Number.isFinite(Number(page.truncated_match_rows))
        ? Number(page.truncated_match_rows)
        : null,
      returned_chars: returnedChars,
      delivered_range_start: page.mode === "offset" ? pageOffset : null,
      delivered_range_end: page.mode === "offset" && pageOffset != null && returnedChars != null
        ? pageOffset + returnedChars
        : null,
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
      truncated_match_rows: null,
      returned_chars: null,
      delivered_range_start: null,
      delivered_range_end: null,
      has_more: false,
      empty: false,
      search_error: null,
    };
  }
}

function recordFetchBatchObservation(hashContext, refs, args, {
  researchPhase = null,
  enforcePolicy = false,
  deliveryBudget = null,
} = {}) {
  recordObservation({
    work_item_id: hashContext.work_item_id ?? null,
    job_id: hashContext.job_id ?? null,
    attempt_id: hashContext.attempt_id ?? null,
    observation_type: "hash_ref.fetch_batch",
    summary: `fetch_ref batch requested with ${refs.length} ref${refs.length === 1 ? "" : "s"}`,
    detail: {
      kind: "hash_ref_fetch_batch",
      ref_count: refs.length,
      batch_shape: refs.length === 1 ? "singleton" : (refs.length > 1 ? "multi" : "empty"),
      refs,
      research_phase: researchPhase || null,
      visible_ledger_enforced: enforcePolicy === true,
      search: String(args?.search || "").trim() || null,
      requested_search_mode: String(args?.search_mode ?? args?.searchMode ?? "auto"),
      requested_offset: Number.isFinite(Number(args?.offset)) ? Number(args.offset) : 0,
      requested_limit: Number.isFinite(Number(args?.limit)) ? Number(args.limit) : null,
      delivery_budget: deliveryBudget,
      agent_call_id: hashContext.agent_call_id ?? null,
    },
  });
}

function recordFetchBatchDeliveryObservation(hashContext, refs, renderedText, {
  researchPhase = null,
  enforcePolicy = false,
  deliveryBudget = null,
} = {}) {
  let returnedTextChars = 0;
  try {
    const parsed = JSON.parse(String(renderedText || "{}"));
    const entries = Array.isArray(parsed?.refs) ? parsed.refs : [parsed];
    returnedTextChars = entries.reduce(
      (sum, entry) => sum + (typeof entry?.text === "string" ? entry.text.length : 0),
      0,
    );
  } catch {
    returnedTextChars = 0;
  }
  recordObservation({
    work_item_id: hashContext.work_item_id ?? null,
    job_id: hashContext.job_id ?? null,
    attempt_id: hashContext.attempt_id ?? null,
    observation_type: "hash_ref.fetch_batch_delivery",
    summary: `fetch_ref delivered ${returnedTextChars} text characters across ${refs.length} ref${refs.length === 1 ? "" : "s"}`,
    detail: {
      kind: "hash_ref_fetch_batch_delivery",
      ref_count: refs.length,
      returned_text_chars: returnedTextChars,
      serialized_chars: String(renderedText || "").length,
      research_phase: researchPhase || null,
      visible_ledger_enforced: enforcePolicy === true,
      delivery_budget: deliveryBudget,
      agent_call_id: hashContext.agent_call_id ?? null,
    },
  });
}

function researchFetchDeliveryBudget(refCount) {
  const count = Math.max(1, Math.min(RESEARCH_FETCH_REF_MAX_REFS, Number(refCount) || 1));
  const envelopeAwareTextCap = Math.max(
    count,
    RESEARCH_FETCH_REF_MAX_SERIALIZED_CHARS
      - RESEARCH_FETCH_REF_ENVELOPE_BASE_RESERVE
      - (count * RESEARCH_FETCH_REF_ENVELOPE_PER_REF_RESERVE),
  );
  const totalTextChars = Math.min(RESEARCH_FETCH_REF_TOTAL_TEXT_CHARS, envelopeAwareTextCap);
  return {
    max_refs: RESEARCH_FETCH_REF_MAX_REFS,
    max_per_ref_chars: RESEARCH_FETCH_REF_PER_REF_CHARS,
    max_total_text_chars: RESEARCH_FETCH_REF_TOTAL_TEXT_CHARS,
    max_serialized_chars: RESEARCH_FETCH_REF_MAX_SERIALIZED_CHARS,
    allocated_total_text_chars: totalTextChars,
    allocated_per_ref_chars: Math.max(
      1,
      Math.min(RESEARCH_FETCH_REF_PER_REF_CHARS, Math.floor(totalTextChars / count)),
    ),
  };
}

function enforceResearchFetchSerializedBudget(renderedText, deliveryBudget, refs) {
  if (!deliveryBudget || String(renderedText || "").length <= deliveryBudget.max_serialized_chars) {
    return renderedText;
  }
  // The normal path fits because researcher-visible strings and nested
  // metadata are bounded before serialization. Fail compactly if a future
  // response field escapes that accounting instead of sending an unbounded
  // payload to the model.
  return JSON.stringify({
    ok: false,
    code: "fetch_ref_delivery_budget_exceeded",
    error: "fetch_ref could not serialize the requested refs inside the researcher delivery budget",
    requested: refs.length,
    max_serialized_chars: deliveryBudget.max_serialized_chars,
    retryable: true,
  });
}

function recordFetchObservation(hashContext, ref, result, renderedText = null, policy = {}) {
  const delivery = fetchDeliveryDetail(renderedText);
  const admitted = policy.allowed !== false;
  const message = admitted
    ? (result?.ok && result?.found ? `Fetched ${ref}` : `Fetch miss for ${ref}`)
    : `Rejected ${policy.classification || "fetch_ref"} for ${ref}`;
  const detail = {
    ref,
    content_hash: result?.entry?.content_hash || null,
    ok: admitted && result?.ok === true,
    found: result?.found === true,
    error: admitted ? (result?.error || null) : (policy.code || "fetch_ref_rejected"),
    admission: admitted ? "allowed" : "rejected",
    classification: policy.classification || null,
    fetch_class: policy.fetch_class || null,
    initial_visibility: policy.initial_visibility || null,
    retryable: policy.retryable === true,
    search_signature: policy.search_signature || null,
    requested_offset: policy.requested_offset ?? null,
    requested_limit: policy.requested_limit ?? null,
    effective_offset: policy.effective_offset ?? null,
    effective_limit: policy.effective_limit ?? null,
    skipped_visible_chars: policy.skipped_visible_chars ?? 0,
    research_phase: policy.research_phase || null,
    visible_ledger_enforced: policy.visible_ledger_enforced === true,
    agent_call_id: hashContext.agent_call_id ?? null,
    ...delivery,
  };
  try {
    logEvent({
      work_item_id: hashContext.work_item_id ?? null,
      job_id: hashContext.job_id ?? null,
      attempt_id: hashContext.attempt_id ?? null,
      event_type: EVENT_TYPES.HASH_REF_FETCH,
      actor_type: EVENT_ACTORS.SYSTEM,
      actor_id: "hash_ref_store",
      message,
      event_json: detail,
    });
  } catch {
    // Durable counters are useful, but fetch_ref delivery must stay best-effort.
  }
  recordObservation({
    work_item_id: hashContext.work_item_id ?? null,
    job_id: hashContext.job_id ?? null,
    attempt_id: hashContext.attempt_id ?? null,
    observation_type: "hash_ref.fetch",
    summary: message,
    detail,
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
  researchPhase = null,
  enforcePolicy = false,
} = {}) {
  const hashContext = contextForHashRefs(context);
  const refs = refInputs(args);
  if (enforcePolicy && refs.length > RESEARCH_FETCH_REF_MAX_REFS) {
    return JSON.stringify({
      ok: false,
      code: "fetch_ref_batch_too_large",
      error: `fetch_ref accepts at most ${RESEARCH_FETCH_REF_MAX_REFS} unique refs for a researcher call`,
      requested: refs.length,
      max_refs: RESEARCH_FETCH_REF_MAX_REFS,
      retryable: true,
    });
  }
  const deliveryBudget = enforcePolicy && refs.length > 0
    ? researchFetchDeliveryBudget(refs.length)
    : null;
  recordFetchBatchObservation(hashContext, refs, args, { researchPhase, enforcePolicy, deliveryBudget });
  if (refs.length === 0) return JSON.stringify({ ok: false, error: "fetch_ref requires ref or refs" }, null, 2);

  const requestedLimit = parsePositiveInt(
    args.limit,
    CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
    CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
  );
  const deliveryArgs = deliveryBudget
    ? {
        ...args,
        limit: Math.min(requestedLimit, deliveryBudget.allocated_per_ref_chars),
      }
    : args;

  const fetchOne = (ref) => {
    const result = isHashRefAlias(ref) ? fetchHashRefForContext(hashContext, ref) : invalidRefResult(ref);
    const history = result?.entry?.content_hash
      ? hashRefFetchObservationLedger({
          jobId: hashContext.job_id,
          attemptId: hashContext.attempt_id,
          agentCallId: hashContext.agent_call_id,
          contentHash: result.entry.content_hash,
        })
      : [];
    const policy = admitHashRefFetch({
      entry: result?.entry || null,
      args: deliveryArgs,
      history,
      context: hashContext,
      enforce: enforcePolicy,
    });
    let rendered;
    if (policy.allowed === false) {
      rendered = JSON.stringify({
        ok: false,
        ref: normalizeRef(ref),
        code: policy.code,
        classification: policy.classification,
        retryable: false,
        message: policy.message,
      }, null, 2);
    } else {
      rendered = fetchResultText(result, policy.args || deliveryArgs, {
        researchDelivery: deliveryBudget != null,
      });
      rendered = attachFetchedViewRef(rendered, {
        hashContext,
        sourceEntry: result?.entry || null,
        fetchArgs: policy.args || deliveryArgs,
      });
    }
    recordFetchObservation(hashContext, ref, result, rendered, {
      ...policy,
      research_phase: researchPhase,
      visible_ledger_enforced: enforcePolicy,
    });
    return rendered;
  };

  if (refs.length === 1 && !Array.isArray(args.refs) && !Array.isArray(args.hashes)) {
    const rendered = enforceResearchFetchSerializedBudget(fetchOne(refs[0]), deliveryBudget, refs);
    recordFetchBatchDeliveryObservation(hashContext, refs, rendered, {
      researchPhase,
      enforcePolicy,
      deliveryBudget,
    });
    return rendered;
  }

  const results = refs.map((ref) => parseFetchPayload(fetchOne(ref)));
  const found = results.filter((entry) => entry?.ok === true).length;
  const rejected = results.filter((entry) => entry?.retryable === false && entry?.classification).length;
  const rendered = enforceResearchFetchSerializedBudget(JSON.stringify({
    ok: found === refs.length,
    count: refs.length,
    found,
    missing: refs.length - found,
    rejected,
    refs: results,
  }), deliveryBudget, refs);
  recordFetchBatchDeliveryObservation(hashContext, refs, rendered, {
    researchPhase,
    enforcePolicy,
    deliveryBudget,
  });
  return rendered;
}

function createRefError(error, extra = {}) {
  const message = String(error || "create_ref_failed");
  const code = message.startsWith("create_ref requires text or source_ref")
    ? "missing_create_ref_input"
    : (message.startsWith("create_ref accepts text OR source_ref")
      ? "create_ref_input_conflict"
      : (message.match(/^[a-z][a-z0-9_]*/i)?.[0] || "create_ref_failed"));
  return { ok: false, code, error: message, ...extra };
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
    const visible = hashRefModelVisibleScope(fetched.entry, hashContext);
    if (visible.contracted && !visible.fully_visible) {
      return createRefError(
        "source_ref_not_visible (fetch the continuation and use the returned view_ref as source_ref)",
        { source_ref: sourceAlias },
      );
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
export function createHashRefResult(args = {}, {
  context = {},
} = {}) {
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) {
    return createRefError("create_ref requires an active work item / job scope", {
      code: "create_ref_scope_unavailable",
      status: "failed",
    });
  }
  const batch = Array.isArray(args.chunks) ? args.chunks : null;
  if (batch) {
    if (batch.length === 0) return createRefError("chunks must be a non-empty array", { code: "empty_chunks" });
    if (batch.length > CREATE_REF_MAX_BATCH) {
      return createRefError(`too_many_chunks (${batch.length}, max ${CREATE_REF_MAX_BATCH})`);
    }
    const results = batch.map((item) => createOneHashRef(hashContext, item && typeof item === "object" ? item : {}));
    const created = results.filter((entry) => entry.ok).length;
    const failed = results.length - created;
    const executionFailure = results.some((entry) => entry?.code === "create_failed");
    return {
      ok: created === results.length,
      ...(failed > 0 ? { code: created > 0 ? "create_ref_partial" : "create_ref_batch_failed" } : {}),
      ...(failed > 0 ? { status: created > 0 || executionFailure ? "failed" : "rejected" } : {}),
      ...(failed > 0 ? { error: created > 0
        ? `create_ref partially completed (${created} created, ${failed} failed)`
        : `create_ref batch failed (${failed} failed)` } : {}),
      count: results.length,
      created,
      failed,
      chunks: results,
    };
  }
  return createOneHashRef(hashContext, args);
}

export function createHashRefTool(args = {}, options = {}) {
  return JSON.stringify(createHashRefResult(args, options), null, 2);
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
