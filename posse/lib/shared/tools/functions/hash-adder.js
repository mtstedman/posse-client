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

const DEFAULT_SURFACE_MIN_CHARS = 4000;
const DEFAULT_MATERIALIZE_CHAR_CAP = CONTEXT_HASH_REF_MATERIALIZE_CHAR_CAP;
const HASH_ADDER_BLOCKED_TOOLS = new Set(["fetch_ref"]);
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

function boundingPolicyFor(toolName, objectType) {
  const candidates = [
    normalizeObjectType(objectType),
    normalizeObjectType(toolName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (CONTEXT_BOUNDING_POLICIES[candidate]) return CONTEXT_BOUNDING_POLICIES[candidate];
    const lower = candidate.toLowerCase();
    if (CONTEXT_BOUNDING_POLICIES[lower]) return CONTEXT_BOUNDING_POLICIES[lower];
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
      ? `[bounded_result recovery: fetch_ref ref=${entry?.ref || ""} offset=<char_offset> limit=<chars> search=<literal> pages the stored payload]`
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
    const lower = search.toLowerCase();
    const rows = [];
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(lower)) rows.push(`${i + 1}:${lines[i]}`);
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
  return { result: JSON.stringify(envelope, null, 2), compacted: true };
}

function shouldSurfaceHashRef(toolName, result, {
  minChars = DEFAULT_SURFACE_MIN_CHARS,
} = {}) {
  if (HASH_ADDER_BLOCKED_TOOLS.has(String(toolName || ""))) return false;
  if (typeof result !== "string") return false;
  if (result.length < minChars) return false;
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
  minChars = DEFAULT_SURFACE_MIN_CHARS,
  materializeCharCap = DEFAULT_MATERIALIZE_CHAR_CAP,
} = {}) {
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) return result;
  if (!shouldSurfaceHashRef(toolName, result, { minChars })) {
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
  const boundPolicy = boundingPolicyFor(toolName, effectiveObjectType);
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
        ? "bounded view; fetch_ref pages the rest"
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
    return JSON.stringify({
      ok: true,
      ref: entry.ref,
      object_type: entry.object_type,
      source: entry.source,
      note: entry.note,
      content_hash: entry.content_hash,
      size_chars: entry.size_chars,
      text: paged.text,
      page: {
        ...paged.page,
        full_size_chars: fullText.length,
      },
      notice: paged.page.has_more
        ? "fetch_ref returned a bounded page. Call fetch_ref again with page.next_offset as offset, or use search to recover a focused slice."
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

function recordFetchObservation(hashContext, ref, result) {
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
    recordFetchObservation(hashContext, refs[0], result);
    return fetchResultText(result, args);
  }

  const results = refs.map((ref) => {
    const result = isHashRefAlias(ref) ? fetchHashRefForContext(hashContext, ref) : invalidRefResult(ref);
    recordFetchObservation(hashContext, ref, result);
    return parseFetchPayload(fetchResultText(result, args));
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

export const __testHashAdderInternals = Object.freeze({
  DEFAULT_MATERIALIZE_CHAR_CAP,
  DEFAULT_SURFACE_MIN_CHARS,
  boundingPolicyFor,
  overflowDigest,
  pageMaterializedText,
  renderBoundedResult,
  lineFingerprintMap,
  normalizeRef,
  shouldSurfaceHashRef,
});
