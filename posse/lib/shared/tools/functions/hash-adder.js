import crypto from "crypto";

import {
  getObservationContext,
  hashRefFetchObservationLedger,
  recordObservation,
} from "../../../domains/observability/functions/observations.js";
import {
  createHashRefEvidenceForContext,
  fetchHashRefEvidenceForContext,
  fetchHashRefForContext,
  fetchHashRefTraversalForContext,
  issueHashRefTraversalForContext,
  materializeHashRefEvidenceForContext,
  promoteHashRefTraversalForContext,
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
import {
  consumeSourceReaccessAuthorization,
  sourceSelectorFingerprint,
} from "../../../domains/research/classes/SourceCoverageOwner.js";
import {
  evidenceRefSurface,
  hashRefSurfaceInput,
  renderEvidenceRefStub,
  renderTraversalRefStub,
  traversalRefSurface,
} from "./ref-surface.js";
import {
  hashRefViewSelector,
  materializeHashRefView,
  nextHashRefViewSelector,
} from "./hash-ref-view.js";
import { canonicalEvidenceSourcePath } from "./source-evidence.js";

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
const HASH_ADDER_BLOCKED_TOOLS = new Set(["fetch_ref", "traverse_ref", "create_ref"]);
const CREATE_REF_MAX_TEXT_CHARS = 60000;
const CREATE_REF_MAX_NOTE_CHARS = 300;
const CREATE_REF_MAX_BATCH = 24;
const CREATE_REF_OWNER_SCOPES = new Set(["work_item", "job"]);
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
  const surface = hashRefSurfaceInput(args);
  addMany(surface.value);
  return { refs: out, requestedCapability: surface.requested_capability };
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

function contextForHashRefs(explicitContext = {}) {
  const ambient = getObservationContext() || {};
  const explicitKeys = [
    "work_item_id",
    "workItemId",
    "job_id",
    "jobId",
    "attempt_id",
    "attemptId",
    "agent_call_id",
    "agentCallId",
  ];
  // Scope provenance is one lineage tuple, not four independent defaults. A
  // caller that supplies any scope field owns the whole tuple; the queue layer
  // can safely derive its missing ancestors from SQLite. Field-wise ambient
  // backfill can splice a concurrent job's attempt onto the explicit job.
  const source = explicitKeys.some((key) => Object.hasOwn(explicitContext, key))
    ? explicitContext
    : ambient;
  return {
    work_item_id: source.work_item_id ?? source.workItemId ?? null,
    job_id: source.job_id ?? source.jobId ?? null,
    attempt_id: source.attempt_id ?? source.attemptId ?? null,
    agent_call_id: source.agent_call_id ?? source.agentCallId ?? null,
  };
}

function hasHashRefScope(context = {}) {
  return context.attempt_id != null || context.job_id != null || context.work_item_id != null || context.agent_call_id != null;
}

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
          next_traversal_ref: traversalRefSurface(nextPage.ref, {
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
  envelope.data.next_traversal_ref = traversalRefSurface(nextPage.ref, {
    kind: "tree_scope_page",
    ranks: nextPage.ranks,
    count: nextPage.count,
  });
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
// at most ten files and carries a backed traversal_ref cursor to the next page.
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
    label: "next 10",
    call: "atlas.traverse_ref",
    args: { traversal_ref: page.ref },
    traversal_ref: traversalRef,
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
  data.traversal_ref = traversalRefSurface(snapshot.ref, {
    kind: "survey_page",
    ranks: snapshot.ranks,
    count: snapshot.count,
  });
  return { result: JSON.stringify(envelope, null, 2), compacted: true };
}

// ---- code.window / code.lens result ref-paging (flag-gated, default ON) -----
// L3b (TOKEN-LEVERS). Same demand-paging move as survey cursor pages: only fires
// when the full result exceeds the min-chars threshold. code.lens carries a
// matches[] array — page the lower-ranked tail. code.window is a monolithic
// content string — keep the head lines inline (up to the char budget) and page
// the tail lines behind one traversal_ref. Threshold from atlas_result_ref_paging_min_chars.
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

function mergedCodeWindowInlineRanges(data) {
  const ranges = [];
  const push = (entry) => {
    if (!entry || typeof entry !== "object" || !String(entry.content || "")) return;
    const startLine = Math.max(1, Number(entry.startLine) || 1);
    ranges.push({ startLine, endLine: Math.max(startLine, Number(entry.endLine) || startLine) });
  };
  push(data);
  for (const entry of Array.isArray(data?.additionalWindows) ? data.additionalWindows : []) push(entry);
  ranges.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function codeWindowTargetCoverage(target, ranges) {
  const startLine = Math.max(1, Number(target?.location?.startLine) || 1);
  const endLine = Math.max(startLine, Number(target?.location?.endLine) || startLine);
  const intersections = ranges
    .map((range) => ({
      startLine: Math.max(startLine, range.startLine),
      endLine: Math.min(endLine, range.endLine),
    }))
    .filter((range) => range.endLine >= range.startLine);
  let coverage = "none";
  if (intersections.length > 0) {
    let cursor = startLine;
    coverage = "full";
    for (const range of intersections) {
      if (range.startLine > cursor) coverage = "partial";
      cursor = Math.max(cursor, range.endLine + 1);
    }
    if (cursor <= endLine) coverage = "partial";
  }
  target.coverage = coverage;
  target.inlineRanges = intersections.map((range) => `${range.startLine}-${range.endLine}`);
}

function refreshCodeWindowMapCoverage(data) {
  const map = data?.map;
  if (!map || typeof map !== "object") return;
  const ranges = mergedCodeWindowInlineRanges(data);
  map.inlineRanges = ranges.map((range) => `${range.startLine}-${range.endLine}`);
  for (const target of Array.isArray(map.symbolIndex) ? map.symbolIndex : []) {
    codeWindowTargetCoverage(target, ranges);
  }
  const returned = new Set(
    (Array.isArray(data.identifiersReturned) ? data.identifiersReturned : [])
      .map((entry) => String(entry || "").toLowerCase()),
  );
  for (const request of Array.isArray(map.requested) ? map.requested : []) {
    const targets = Array.isArray(request.targets) ? request.targets : [];
    for (const target of targets) codeWindowTargetCoverage(target, ranges);
    if (targets.some((target) => target.coverage === "full")) request.coverage = "full";
    else if (targets.some((target) => target.coverage === "partial")) request.coverage = "partial";
    else if (request.state === "textually_found_unindexed"
      && returned.has(String(request.identifier || "").toLowerCase())) request.coverage = "partial";
    else request.coverage = "none";
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
  const min = minChars ?? resultRefPagingMinChars();
  const hashContext = contextForHashRefs(context);

  let envelope;
  try {
    envelope = JSON.parse(result);
  } catch {
    return { result, compacted: false };
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
              ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
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
        if (surfaced?.ok && surfaced?.entry?.ref) {
          visible.traversal_ref = traversalRefSurface(surfaced.model_ref || surfaced.entry.ref, {
            kind: "returned_function",
          });
        }
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
  if (tool === "code.window" || tool === "code.lens") {
    const continuationTool = tool;
    let nativeContinuation = Array.isArray(data._continuationWindows)
      ? data._continuationWindows
      : [];
    const carriedNativeContinuation = Array.isArray(data._continuationWindows);
    delete data._continuationWindows;
    let displayTail = null;
    let displayOriginal = null;
    if (
      tool === "code.window" && pagingEnabled
      && result.length > min
      && hasHashRefScope(hashContext)
      && Array.isArray(data.additionalWindows)
      && data.additionalWindows.length > 0
    ) {
      const deferredAdditional = data.additionalWindows;
      nativeContinuation = dedupeCodeWindowContinuationWindows([
        ...nativeContinuation,
        ...deferredAdditional,
      ]);
      const deferredIdentifiers = new Set(deferredAdditional.flatMap((entry) => (
        Array.isArray(entry?.identifiers) ? entry.identifiers.map(String) : []
      )));
      data.identifiersReturned = (Array.isArray(data.identifiersReturned) ? data.identifiersReturned : [])
        .filter((identifier) => !deferredIdentifiers.has(String(identifier)));
      data.identifiersOmitted = [...new Set([
        ...(Array.isArray(data.identifiersOmitted) ? data.identifiersOmitted.map(String) : []),
        ...deferredIdentifiers,
      ])];
      data.outputTruncated = true;
      data.truncated = true;
      delete data.additionalWindows;
      compacted = true;
    }
    const originalContent = typeof data.content === "string" ? data.content : "";
    let inlineContentBudget = min;
    if (tool === "code.window" && originalContent) {
      data.content = "";
      const structuralChars = JSON.stringify(envelope, null, 2).length;
      data.content = originalContent;
      inlineContentBudget = Math.max(1000, min - structuralChars - 1200);
    }
    if (
      tool === "code.window" && pagingEnabled
      && result.length > min
      && hasHashRefScope(hashContext)
      && typeof data.content === "string"
      && data.content.length > inlineContentBudget
    ) {
      const lines = data.content.split("\n");
      let headChars = 0;
      let splitAt = 0;
      for (let index = 0; index < lines.length; index++) {
        const nextChars = lines[index].length + (index > 0 ? 1 : 0);
        if (splitAt > 0 && headChars + nextChars > inlineContentBudget) break;
        headChars += nextChars;
        splitAt = index + 1;
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
    const lensTail = tool === "code.lens"
      && pagingEnabled
      && result.length > min
      && hasHashRefScope(hashContext)
      && Array.isArray(data.matches)
      && data.matches.length > LENS_INLINE_MATCHES
      ? data.matches.slice(LENS_INLINE_MATCHES)
      : [];
    if (continuation.length > 0 && hasHashRefScope(hashContext)) {
      const continuationEnvelope = {
        tool: continuationTool,
        repo_rel_path: data.repo_rel_path,
        requestedWindows: continuation,
        ...(lensTail.length > 0 ? { tailMatches: lensTail } : {}),
      };
      // Compact encoding makes every complete window's payload span exact and
      // stable. Ref traversal can therefore promote only fully delivered windows.
      const continuationPayload = JSON.stringify(continuationEnvelope);
      let continuationSearchOffset = 0;
      const continuationSourceWindows = continuation.map((entry) => {
        const encoded = JSON.stringify(entry);
        const payloadStart = continuationPayload.indexOf(encoded, continuationSearchOffset);
        const payloadEnd = payloadStart >= 0 ? payloadStart + encoded.length : -1;
        if (payloadEnd >= 0) continuationSearchOffset = payloadEnd;
        return {
          repository_identity: data.repositoryIdentity || null,
          source_version: data.sourceVersion || null,
          repo_rel_path: data.repo_rel_path || null,
          start_line: Number(entry.startLine) || null,
          end_line: Number(entry.endLine) || null,
          path: data.repo_rel_path || null,
          source_start_line: Number(entry.startLine) || null,
          source_end_line: Number(entry.endLine) || null,
          materialized_start_line: materializedLineAt(continuationPayload, payloadStart),
          materialized_end_line: materializedLineAt(continuationPayload, Math.max(payloadStart, payloadEnd - 1)),
          payload_start: payloadStart,
          payload_end: payloadEnd,
          content_sha256: crypto.createHash("sha256").update(String(entry.content || "").replace(/\r\n/g, "\n")).digest("hex"),
          selector_fingerprint: sourceSelectorFingerprint(args),
        };
      }).filter((entry) => entry.payload_start >= 0 && entry.payload_end > entry.payload_start);
      let surfaced;
      try {
        surfaced = surfaceHashRefForContext(hashContext, {
          entryKind: "materialized",
          payloadText: continuationPayload,
          descriptor: { kind: "tool_result", tool: continuationTool, args, source: `tool:${continuationTool}` },
          objectType: `${continuationTool}.continuation`,
          source: `tool:${continuationTool}`,
          note: `${continuation.length} selected ${continuationTool} source region(s) omitted from the inline display`,
          sizeChars: continuationPayload.length,
          recomputable: true,
          metadata: {
            surfaced_by: "requested_region_continuation",
            fetch_class: "result_continuation",
            ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
            tool: continuationTool,
            windows: continuation.length,
            line_semantics: "source",
            ...(data.repo_rel_path ? { path: data.repo_rel_path } : {}),
            ...(data.repositoryIdentity ? { repository_identity: data.repositoryIdentity } : {}),
            ...(data.sourceVersion ? { source_version: data.sourceVersion } : {}),
            source_windows: continuationSourceWindows,
          },
        }, scope);
      } catch (err) {
        recordHashSurfaceFailure(hashContext, tool, continuationPayload.length, err?.message || err);
      }
      if (surfaced?.ok && surfaced?.entry?.ref) {
        data.traversal_ref = traversalRefSurface(surfaced.model_ref || surfaced.entry.ref, {
          kind: `${continuationTool.replace(".", "_")}_continuation`,
        });
        data.continuationWindows = continuation.length;
        data.continuationRanges = continuation.map((entry) => `${entry.startLine}-${entry.endLine}`);
        if (lensTail.length > 0) {
          data.matches = data.matches.slice(0, LENS_INLINE_MATCHES);
          data.inlineMatchCount = data.matches.length;
          data.deferredMatchCount = lensTail.length;
          data.tailMatchesTotal = data.inlineMatchCount + data.deferredMatchCount;
          data.totalMatchCount = data.tailMatchesTotal
            + Math.max(0, Number(data.omittedMatchCount) || 0);
        }
        for (const entry of hashContext.attempt_id != null ? continuationSourceWindows : []) {
          recordObservation({
            work_item_id: hashContext.work_item_id ?? null,
            job_id: hashContext.job_id ?? null,
            attempt_id: hashContext.attempt_id ?? null,
            observation_type: "source.coverage",
            summary: `available_unseen source coverage ${entry.repo_rel_path}:${entry.start_line}-${entry.end_line}`,
            detail: {
              ...entry,
              evidence_ref: surfaced.model_ref || surfaced.entry.ref,
              delivery_state: "available_unseen",
              origin: "continuation",
              stored_chars: Math.max(0, entry.payload_end - entry.payload_start),
              returned_chars: 0,
            },
          });
        }
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
        if (tool === "code.lens") {
          data.continuationWindowsInline = nativeInline;
          data.continuationInline = true;
          compacted = true;
          delete data.sourceVersion;
          delete data.repositoryIdentity;
          return { result: JSON.stringify(envelope, null, 2), compacted: true };
        }
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
      if (tool === "code.lens") {
        data.continuationWindowsInline = nativeInline;
        data.continuationInline = true;
        compacted = true;
        delete data.sourceVersion;
        delete data.repositoryIdentity;
        return { result: JSON.stringify(envelope, null, 2), compacted: true };
      }
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
    // Source-version identity is durable coverage metadata, not model-facing
    // evidence. Keep the response focused after continuation materialization.
    if (tool === "code.window") refreshCodeWindowMapCoverage(data);
    delete data.sourceVersion;
    delete data.repositoryIdentity;
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
          ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
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
    data.traversal_ref = traversalRefSurface(surfaced.model_ref || surfaced.entry.ref, {
      kind: "code_lens_tail",
    });
    data.inlineMatchCount = data.matches.length;
    data.deferredMatchCount = tail.length;
    data.tailMatchesTotal = data.inlineMatchCount + data.deferredMatchCount;
    data.totalMatchCount = data.tailMatchesTotal
      + Math.max(0, Number(data.omittedMatchCount) || 0);
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
  const input = {
    ref: entry?.ref || "",
    objectType: entry?.object_type || toolName || "tool_result",
    sizeChars,
    note: entry?.note || "",
  };
  return refRole === "continuation"
    ? renderTraversalRefStub({ ...input, kind: "continuation" })
    : renderEvidenceRefStub(input);
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
    summary: `Surfaced ${toolName || "tool_result"} as ${surfaced.model_ref || surfaced.entry.ref}`,
    detail: {
      ref: surfaced.model_ref || surfaced.entry.ref,
      object_type: surfaced.entry.object_type,
      content_hash: surfaced.entry.content_hash,
      size_chars: sizeChars,
      reused: surfaced.reused === true,
      fetch_class: surfaced.entry?.metadata?.fetch_class || null,
      ref_role: refRole === "continuation" ? "continuation" : "citation",
      current_fetch: refRole === "continuation" ? "allowed" : "not_needed",
      surface_kind: refRole === "continuation" ? "traversal" : "evidence",
    },
  });
}

function recordHashSurfaceFailure(context, toolName, sizeChars, reason) {
  try {
    const error = reason && typeof reason === "object"
      ? String(reason.error || reason.message || "surface_failed")
      : String(reason || "surface_failed");
    const errorDetail = reason && typeof reason === "object"
      ? reason.detail ?? reason.error_detail ?? null
      : null;
    recordObservation({
      work_item_id: context.work_item_id ?? null,
      job_id: context.job_id ?? null,
      attempt_id: context.attempt_id ?? null,
      observation_type: "hash_ref.surface_failed",
      summary: `Failed to surface ${toolName || "tool_result"} as hash ref`,
      detail: {
        tool: toolName || null,
        size_chars: sizeChars,
        error: error.slice(0, 500),
        error_detail: errorDetail == null ? null : String(errorDetail).slice(0, 500),
        work_item_id: context.work_item_id ?? null,
        job_id: context.job_id ?? null,
        attempt_id: context.attempt_id ?? null,
        agent_call_id: context.agent_call_id ?? null,
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

function materializedLineAt(text, offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function encodedContentMaterializedRange(payload, content, cursor = 0) {
  const encoded = JSON.stringify(String(content || ""));
  const start = payload.indexOf(encoded, Math.max(0, cursor));
  if (start < 0) return { start: null, end: null, cursor };
  const endOffset = start + encoded.length;
  return {
    start: materializedLineAt(payload, start),
    end: materializedLineAt(payload, Math.max(start, endOffset - 1)),
    cursor: endOffset,
  };
}

function mergeSourceWindows(windows) {
  const ordered = windows
    .filter((window) => window?.path
      && Number.isInteger(window.source_start_line)
      && Number.isInteger(window.source_end_line)
      && window.source_start_line > 0
      && window.source_end_line >= window.source_start_line)
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.source_start_line - right.source_start_line
      || left.source_end_line - right.source_end_line
    ));
  const merged = [];
  for (const window of ordered) {
    const prior = merged.at(-1);
    let compatible = true;
    if (prior?.path === window.path && window.source_start_line <= prior.source_end_line) {
      const overlapStart = window.source_start_line;
      const overlapEnd = Math.min(prior.source_end_line, window.source_end_line);
      for (let line = overlapStart; line <= overlapEnd; line += 1) {
        const priorText = prior.content_lines?.[line - prior.source_start_line];
        const nextText = window.content_lines?.[line - window.source_start_line];
        if (priorText != null && nextText != null && priorText !== nextText) {
          compatible = false;
          break;
        }
      }
    }
    if (prior?.path === window.path
      && window.source_start_line <= prior.source_end_line + 1
      && compatible) {
      if (Array.isArray(prior.content_lines) && Array.isArray(window.content_lines)) {
        const appendFrom = Math.max(0, prior.source_end_line - window.source_start_line + 1);
        prior.content_lines.push(...window.content_lines.slice(appendFrom));
      }
      prior.source_end_line = Math.max(prior.source_end_line, window.source_end_line);
      if (Number.isInteger(window.materialized_start_line)) {
        prior.materialized_start_line = Number.isInteger(prior.materialized_start_line)
          ? Math.min(prior.materialized_start_line, window.materialized_start_line)
          : window.materialized_start_line;
      }
      if (Number.isInteger(window.materialized_end_line)) {
        prior.materialized_end_line = Number.isInteger(prior.materialized_end_line)
          ? Math.max(prior.materialized_end_line, window.materialized_end_line)
          : window.materialized_end_line;
      }
      continue;
    }
    merged.push({ ...window, ...(Array.isArray(window.content_lines) ? { content_lines: [...window.content_lines] } : {}) });
  }
  return merged.map(({ content_lines: _contentLines, ...window }) => window);
}

function structuredSourceMetadata(toolName, payload, args = {}) {
  const normalizedTool = String(toolName || "").toLowerCase().replace(/^tools[.:]/, "");
  const isRead = ["read_file", "chain_read", "inspect_file"].includes(normalizedTool);
  const isWindow = normalizedTool.endsWith("code.window");
  const isLens = normalizedTool.endsWith("code.lens");
  if (!isRead && !isWindow && !isLens) return null;

  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = null; }
  const envelope = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const fallbackPath = canonicalEvidenceSourcePath(
    envelope?.repo_rel_path
      || envelope?.repoRelPath
      || envelope?.path
      || args.file
      || args.path,
  );
  const windows = [];

  if ((isRead || isWindow) && envelope && typeof envelope === "object") {
    const candidates = [
      envelope,
      ...(Array.isArray(envelope.additionalWindows) ? envelope.additionalWindows : []),
      ...(Array.isArray(envelope.additional_windows) ? envelope.additional_windows : []),
    ];
    let cursor = 0;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.content !== "string") continue;
      const sourceStart = Number(candidate.startLine ?? candidate.start_line);
      const declaredEnd = Number(candidate.endLine ?? candidate.end_line);
      const contentLines = normalizedLinesForHandoff(candidate.content);
      const sourceEnd = Number.isInteger(declaredEnd) && declaredEnd >= sourceStart
        ? declaredEnd
        : sourceStart + contentLines - 1;
      const sourcePath = canonicalEvidenceSourcePath(
        candidate.repo_rel_path || candidate.repoRelPath || candidate.path || fallbackPath,
      );
      if (!sourcePath || !Number.isInteger(sourceStart) || sourceStart < 1 || sourceEnd < sourceStart) continue;
      const materialized = encodedContentMaterializedRange(payload, candidate.content, cursor);
      cursor = materialized.cursor;
      windows.push({
        path: sourcePath,
        source_start_line: sourceStart,
        source_end_line: sourceEnd,
        materialized_start_line: materialized.start,
        materialized_end_line: materialized.end,
        content_lines: String(candidate.content).replace(/\r\n?/g, "\n").split("\n"),
      });
    }
  }

  if (isLens && envelope && typeof envelope === "object") {
    let cursor = 0;
    for (const match of Array.isArray(envelope.matches) ? envelope.matches : []) {
      const sourceLine = Number(match?.line);
      const before = Array.isArray(match?.context?.before) ? match.context.before.map(String) : [];
      const after = Array.isArray(match?.context?.after) ? match.context.after.map(String) : [];
      const sourcePath = canonicalEvidenceSourcePath(match?.repo_rel_path || match?.repoRelPath || fallbackPath);
      if (!sourcePath || !Number.isInteger(sourceLine) || sourceLine < 1 || typeof match?.text !== "string") continue;
      const materializedLines = [...before, match.text, ...after].map((line) => {
        const located = encodedContentMaterializedRange(payload, line, cursor);
        cursor = located.cursor;
        return located;
      });
      const starts = materializedLines.map((line) => line.start).filter(Number.isInteger);
      const ends = materializedLines.map((line) => line.end).filter(Number.isInteger);
      windows.push({
        path: sourcePath,
        source_start_line: Math.max(1, sourceLine - before.length),
        source_end_line: sourceLine + after.length,
        materialized_start_line: starts.length > 0 ? Math.min(...starts) : null,
        materialized_end_line: ends.length > 0 ? Math.max(...ends) : null,
        content_lines: [...before, match.text, ...after],
      });
    }
  }

  if (isRead && windows.length === 0) {
    let current = null;
    for (const [index, line] of payload.replace(/\r\n?/g, "\n").split("\n").entries()) {
      const matched = /^\s*(\d+)\t(.*)$/.exec(line);
      const sourceLine = Number(matched?.[1]);
      if (!matched || !Number.isInteger(sourceLine) || sourceLine < 1) {
        current = null;
        continue;
      }
      if (!current || sourceLine !== current.source_end_line + 1) {
        current = {
          path: fallbackPath,
          source_start_line: sourceLine,
          source_end_line: sourceLine,
          materialized_start_line: index + 1,
          materialized_end_line: index + 1,
        };
        windows.push(current);
      } else {
        current.source_end_line = sourceLine;
        current.materialized_end_line = index + 1;
      }
    }
  }

  const sourceWindows = mergeSourceWindows(windows);
  if (sourceWindows.length === 0) return null;
  const paths = [...new Set(sourceWindows.map((window) => window.path))];
  return {
    line_semantics: "source",
    source_windows: sourceWindows,
    ...(paths.length === 1 ? { path: paths[0] } : {}),
    ...(envelope?.repositoryIdentity || parsed?.repositoryIdentity
      ? { repository_identity: envelope?.repositoryIdentity || parsed?.repositoryIdentity }
      : {}),
    ...(envelope?.sourceVersion || parsed?.sourceVersion
      ? { source_version: envelope?.sourceVersion || parsed?.sourceVersion }
      : {}),
  };
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
  const sourceMetadata = boundPolicy && sizeChars > boundPolicy.capChars
    ? null
    : structuredSourceMetadata(toolName, text, args);

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
            ...hashRefModelVisibility(hashContext, { visibility: "hidden", issuedAs: "traversal" }),
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
            issuedAs: "evidence",
          }),
        },
      }, { ownerScope: resolvedOwnerScope });
    } catch (err) {
      recordHashSurfaceFailure(hashContext, toolName, boundedAnchor.length, err?.message || err);
    }
    if (!anchor?.ok || !anchor?.entry?.ref) {
      recordHashSurfaceFailure(hashContext, toolName, boundedAnchor.length, anchor || "surface_failed");
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
        entry: { ...anchor.entry, ref: anchor.model_ref || anchor.entry.ref },
        toolName: effectiveObjectType,
        sizeChars: boundedAnchor.length,
        refRole: "citation",
      }),
      ...(continuationAvailable ? [
        refStub({
          entry: { ...continuation.entry, ref: continuation.model_ref || continuation.entry.ref },
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
        ...(sourceMetadata || { line_semantics: "materialized" }),
        ...hashRefModelVisibility(hashContext, {
          visibility: "full",
          ranges: initiallyVisibleHashRefRanges(null, sizeChars),
          issuedAs: "evidence",
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
    recordHashSurfaceFailure(hashContext, toolName, sizeChars, surfaced || "surface_failed");
    recordContextMeterSample(hashContext, toolName, {
      fullSizeChars: sizeChars,
      emittedSizeChars: sizeChars,
      bounded: false,
    });
    return result;
  }
  recordHashObservation(hashContext, surfaced, toolName, sizeChars, { refRole: "citation" });
  const stamped = `${result}${refStub({
    entry: { ...surfaced.entry, ref: surfaced.model_ref || surfaced.entry.ref },
    toolName,
    sizeChars,
    refRole: "citation",
  })}`;
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
    const paged = materializeHashRefView(fullText, args);
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

function attachFetchedCapabilityRefs(renderedText, {
  hashContext,
  requestedRef,
  sourceEntry,
  traversalCapability = null,
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
  const selector = hashRefViewSelector(rendered, fetchArgs);
  let evidenceRef = null;
  if (traversalCapability?.ref) {
    const promoted = promoteHashRefTraversalForContext(hashContext, traversalCapability.ref, {
      selector,
      viewText,
      sourceContentHash: sourceEntry?.content_hash || null,
    });
    if (promoted?.ok) evidenceRef = promoted.evidence.ref;
  } else {
    const existing = fetchHashRefEvidenceForContext(hashContext, requestedRef);
    const sameSelector = existing?.found
      && JSON.stringify(existing.capability?.selector || null) === JSON.stringify(selector);
    if (sameSelector) {
      evidenceRef = existing.capability.ref;
    } else {
      const created = createHashRefEvidenceForContext(hashContext, {
        sourceRef: sourceEntry?.ref,
        selector,
        viewText,
        sourceContentHash: sourceEntry?.content_hash || null,
      });
      if (created?.ok) evidenceRef = created.evidence.ref;
    }
  }
  if (!evidenceRef) {
    recordHashSurfaceFailure(hashContext, "fetch_ref.promote", viewText.length, "capability_promotion_failed");
    return renderedText;
  }
  recordHashObservation(hashContext, {
    ok: true,
    entry: {
      ref: evidenceRef,
      object_type: `${normalizeObjectType(sourceEntry?.object_type || "stored_ref")}.view`,
      content_hash: crypto.createHash("sha256").update(viewText).digest("hex"),
      metadata: { fetch_class: "visible_view" },
    },
  }, "fetch_ref.promote", viewText.length, { refRole: "citation" });
  rendered.evidence_ref = evidenceRefSurface(evidenceRef, {
    exactField: "text",
    chars: viewText.length,
    lines: normalizedLinesForHandoff(viewText),
  });
  if (selector.mode === "search") {
    rendered.evidence_ref.usage = "inspect_only";
    rendered.evidence_ref.citable = false;
    rendered.evidence_ref.non_citable_reason = "search_result_view";
    if (sourceEntry?.ref) rendered.evidence_ref.parent_ref = sourceEntry.ref;
    rendered.evidence_ref.next_action = "Use a validated coordinate or slice from parent_ref; numbered search-result rows are navigation, not citable source.";
  }
  // The traversal identity itself is now the evidence identity. Do not leave
  // the backing source alias in the primary ref field, especially for opaque
  // continuation cursors where it may identify a different visible page.
  rendered.ref = evidenceRef;
  const nextSelector = nextHashRefViewSelector(rendered);
  if (nextSelector) {
    const issued = issueHashRefTraversalForContext(hashContext, {
      sourceRef: sourceEntry?.ref,
      selector: nextSelector,
      sourceContentHash: sourceEntry?.content_hash || null,
    });
    if (issued?.ok) rendered.next_traversal_ref = traversalRefSurface(issued.capability.ref, {
      kind: rendered.page.mode === "search" ? "search_page" : "offset_page",
    });
  }
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
    requested_capability: policy.requested_capability || "legacy",
    legacy_alias: policy.requested_capability !== "traversal",
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
  const sourceWindows = Array.isArray(result?.entry?.metadata?.source_windows)
    ? result.entry.metadata.source_windows
    : [];
  if (
    admitted
    && detail.page_mode === "offset"
    && detail.delivered_range_start != null
    && detail.delivered_range_end != null
  ) {
    for (const window of sourceWindows) {
      if (!Number.isFinite(Number(window.payload_start))
        || !Number.isFinite(Number(window.payload_end))
        || !window.repo_rel_path) continue;
      if (detail.delivered_range_start > Number(window.payload_start)) continue;
      if (detail.delivered_range_end < Number(window.payload_end)) continue;
      recordObservation({
        work_item_id: hashContext.work_item_id ?? null,
        job_id: hashContext.job_id ?? null,
        attempt_id: hashContext.attempt_id ?? null,
        observation_type: "source.coverage",
        summary: `delivered continuation coverage ${window.repo_rel_path}:${window.start_line}-${window.end_line}`,
        detail: {
          ...window,
          evidence_ref: ref,
          delivery_state: "delivered",
          origin: "continuation",
          stored_chars: Math.max(0, Number(window.payload_end) - Number(window.payload_start)),
          returned_chars: Math.max(0, Number(window.payload_end) - Number(window.payload_start)),
          agent_call_id: hashContext.agent_call_id ?? null,
        },
      });
    }
  }
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
  requireTraversal = false,
} = {}) {
  const hashContext = contextForHashRefs(context);
  const { refs, requestedCapability } = refInputs(args);
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
  if (refs.length === 0) return JSON.stringify({ ok: false, error: "traverse_ref requires traversal_ref" }, null, 2);
  const requestedReaccessAuthorization = String(args.reaccessAuthorization || "").trim();
  if (requestedReaccessAuthorization && refs.length !== 1) {
    return JSON.stringify({
      ok: false,
      code: "fetch_ref_reaccess_single_ref_required",
      classification: "reaccess_scope_mismatch",
      retryable: false,
      message: "A covered-evidence re-access authorization applies to exactly one stored ref.",
    });
  }

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
    const traversal = isHashRefAlias(ref)
      ? fetchHashRefTraversalForContext(hashContext, ref)
      : { found: false };
    const result = traversal?.found
      ? {
          ok: true,
          found: true,
          ref: traversal.source.ref,
          entry: traversal.source,
        }
      : (isHashRefAlias(ref) ? fetchHashRefForContext(hashContext, ref) : invalidRefResult(ref));
    const storedSelector = traversal?.capability?.selector || null;
    const selectorArgs = storedSelector
      ? {
          ...deliveryArgs,
          ...storedSelector,
          ...(deliveryBudget ? {
            limit: Math.min(
              Math.max(1, Number(storedSelector.limit) || deliveryBudget.allocated_per_ref_chars),
              deliveryBudget.allocated_per_ref_chars,
            ),
          } : {}),
        }
      : deliveryArgs;
    const history = result?.entry?.content_hash
      ? hashRefFetchObservationLedger({
          jobId: hashContext.job_id,
          attemptId: hashContext.attempt_id,
          agentCallId: hashContext.agent_call_id,
          contentHash: result.entry.content_hash,
        })
      : [];
    const reaccessAuthorization = requestedReaccessAuthorization;
    const reaccess = reaccessAuthorization
      ? (result?.ok && result?.found
          ? consumeSourceReaccessAuthorization({
              authorization: reaccessAuthorization,
              ref: normalizeRef(ref),
              context: hashContext,
            })
          : { allowed: false, reason: "source_missing" })
      : null;
    const policy = requireTraversal && !reaccess?.allowed && !traversal?.found
      ? {
          allowed: false,
          code: "traversal_ref_not_issued",
          classification: "not_issued_for_traversal",
          message: "This identity is not an unpromoted traversal capability for the current agent call. Use a visible evidence ref directly or follow an explicit traversal ref.",
        }
      : (reaccessAuthorization && !reaccess?.allowed
      ? {
          allowed: false,
          code: reaccess?.reason === "source_missing"
            ? "fetch_ref_reaccess_source_missing"
            : "fetch_ref_reaccess_invalid",
          classification: reaccess?.reason === "source_missing"
            ? "reaccess_source_missing"
            : "reaccess_invalid_or_consumed",
          message: reaccess?.reason === "source_missing"
            ? "The stored evidence for this re-access authorization is unavailable; the authorization was not consumed."
            : "This covered-evidence re-access authorization is invalid, mismatched, or already consumed.",
        }
      : admitHashRefFetch({
      entry: result?.entry || null,
      args: selectorArgs,
      history,
      context: hashContext,
      enforce: reaccess?.allowed ? false : enforcePolicy,
      // Table membership is now the traversal capability. Source metadata is
      // retained only for compatibility and visibility accounting.
      requireTraversal: false,
    }));
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
      rendered = fetchResultText(result, policy.args || selectorArgs, {
        researchDelivery: deliveryBudget != null,
      });
      rendered = attachFetchedCapabilityRefs(rendered, {
        hashContext,
        requestedRef: ref,
        sourceEntry: result?.entry || null,
        traversalCapability: traversal?.capability || null,
        fetchArgs: policy.args || selectorArgs,
      });
    }
    recordFetchObservation(hashContext, ref, result, rendered, {
      ...policy,
      reaccess_authorized: reaccess?.allowed === true,
      reaccess_consumed: reaccessAuthorization ? reaccess?.allowed === true : false,
      research_phase: researchPhase,
      visible_ledger_enforced: enforcePolicy,
      requested_capability: requestedCapability,
    });
    return rendered;
  };

  const batchRequested = Array.isArray(args.traversal_ref)
    || Array.isArray(args.traversal_refs)
    || Array.isArray(args.ref)
    || Array.isArray(args.refs)
    || Array.isArray(args.hashes);
  if (refs.length === 1 && !batchRequested) {
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
  let sourceCitationMetadata = null;
  if (sourceRef) {
    sourceAlias = normalizeRef(sourceRef);
    if (!isHashRefAlias(sourceAlias)) return createRefError("invalid_source_ref", { source_ref: String(sourceRef) });
    const evidenceView = materializeHashRefEvidenceForContext(hashContext, sourceAlias);
    const fetched = evidenceView?.found
      ? { ok: evidenceView.ok, found: evidenceView.ok, entry: evidenceView.entry }
      : fetchHashRefForContext(hashContext, sourceAlias);
    if (!fetched?.ok || !fetched?.found || !fetched.entry) {
      return createRefError("source_ref_not_found_or_not_visible", { source_ref: sourceAlias });
    }
    if (fetched.entry.payload_text == null) {
      return createRefError("source_ref_not_materialized (descriptor-only payloads cannot be sliced)", { source_ref: sourceAlias });
    }
    const visible = hashRefModelVisibleScope(fetched.entry, hashContext);
    if (visible.contracted && !visible.fully_visible) {
      return createRefError(
        "source_ref_not_visible (traverse an explicitly issued traversal_ref and use the returned evidence_ref as source_ref)",
        { source_ref: sourceAlias },
      );
    }
    if (fetched.entry.metadata?.citable === false) {
      const reason = String(fetched.entry.metadata.non_citable_reason || "").trim();
      const parentRef = normalizeRef(
        fetched.entry.metadata.parent_ref
          ?? fetched.entry.metadata.capability_source_ref
          ?? sourceAlias,
      ) || sourceAlias;
      sourceCitationMetadata = {
        citable: false,
        parent_ref: parentRef,
        ...(reason ? { non_citable_reason: reason } : {}),
      };
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
      ...(sourceCitationMetadata ? { reuse: false } : {}),
      metadata: {
        surfaced_by: "create_ref",
        fetch_class: "visible_copy",
        ...hashRefModelVisibility(hashContext, {
          visibility: "full",
          ranges: [{ start: 0, end: payload.length }],
          issuedAs: "evidence",
        }),
        ...(sourceAlias ? { source_ref: sourceAlias, slice: sliceNote } : {}),
        ...(sourceCitationMetadata || {}),
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
    evidence_ref: evidenceRefSurface(surfaced.entry.ref, {
      exactField: sourceAlias ? "source_ref slice" : "request text",
      chars: payload.length,
      lines: handoffLineCount,
    }),
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
  pageMaterializedText: materializeHashRefView,
  renderBoundedResult,
  lineFingerprintMap,
  normalizeRef,
  shouldSurfaceHashRef,
});
