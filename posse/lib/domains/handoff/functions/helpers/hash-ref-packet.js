import {
  formatHashRefSelector,
  HASH_REF_DESTINATION_SET,
  HASH_REF_LANES,
  isHashRefAlias,
  normalizeHashRefAlias,
  parseHashRefSelector,
} from "../../../../catalog/hash-store.js";
import {
  fetchHashRefForContext,
  materializeHashRefEvidenceForContext,
  promoteHashRefTraversalForContext,
  surfaceHashRefForContext,
} from "../../../queue/functions/hash-refs.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { hashRefModelVisibility } from "../../../../shared/tools/functions/fetch-ref-policy.js";
import { renderTraversalRefStub } from "../../../../shared/tools/functions/ref-surface.js";
import { normalizedEvidenceSourceWindows } from "../../../../shared/tools/functions/source-evidence.js";

const DEFAULT_MAX_REFS_PER_LANE = 24;
const DEFAULT_MAX_WHY_CHARS = 180;
const PROOF_EXPANSION_GENERATOR = "hash_ref_store";
const DEV_BRIEF_EXPANSION_GENERATOR = "hash_ref_store.dev_brief";
const DEFAULT_DEV_BRIEF_EXPANSION_MAX_CHARS = 32000;
const DEFAULT_DEV_BRIEF_EXPANSION_MAX_REFS = 16;
const stagedDevBriefEvidence = new WeakMap();

function fetchEvidenceOrSource(context, ref) {
  const evidence = materializeHashRefEvidenceForContext(context, ref);
  if (evidence?.found) return evidence;
  return fetchHashRefForContext(context, ref);
}

function compactText(value, max = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function packetSource(value) {
  const source = String(value || "atlas").trim().toLowerCase();
  return source || "atlas";
}

function normalizeDestination(value) {
  const destination = String(value || "handoff").trim().toLowerCase();
  return HASH_REF_DESTINATION_SET.has(destination) ? destination : "handoff";
}

function entryParts(entry, maxWhyChars) {
  if (typeof entry === "string") {
    const selector = parseHashRefSelector(entry);
    return {
      ref: selector?.ref || entry,
      lines: selector?.lines || null,
      why: "",
    };
  }
  if (Array.isArray(entry)) {
    const selector = typeof entry[0] === "string"
      ? parseHashRefSelector(entry[0])
      : null;
    return {
      ref: selector?.ref || entry[0]?.ref || entry[0]?.hash || entry[0],
      lines: selector?.lines || entry[0]?.lines || null,
      why: compactText(entry[1], maxWhyChars),
    };
  }
  if (entry && typeof entry === "object") {
    const selector = parseHashRefSelector(entry.selector ?? entry.ref ?? entry.hash ?? entry.ref_hash);
    return {
      ref: selector?.ref || entry.ref || entry.hash || entry.ref_hash,
      lines: selector?.lines || entry.lines || null,
      why: compactText(entry.why ?? entry.reason ?? entry.note, maxWhyChars),
      sourceRef: entry.source_ref ?? entry.sourceRef ?? null,
      sourceSelector: entry.source_selector ?? entry.sourceSelector ?? null,
      objectType: entry.object_type ?? entry.objectType ?? null,
      entryKind: entry.entry_kind ?? entry.entryKind ?? null,
      sizeChars: entry.size_chars ?? entry.sizeChars ?? null,
      contentHash: entry.content_hash ?? entry.contentHash ?? null,
      preview: entry.preview ?? null,
      unresolved: entry.unresolved === true,
      error: entry.error || null,
    };
  }
  return { ref: "", why: "" };
}

function normalizeLineRange(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const start = Number(value.start);
  const count = value.count == null ? null : Number(value.count);
  const end = count == null ? Number(value.end) : start + count - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

function packetLaneSource(input, lane) {
  if (Array.isArray(input?.lanes?.[lane])) return input.lanes[lane];
  return Array.isArray(input?.[lane]) ? input[lane] : [];
}

function hasLaneRefs(lanes) {
  return HASH_REF_LANES.some((lane) => Array.isArray(lanes?.[lane]) && lanes[lane].length > 0);
}

function laneCount(lanes) {
  return HASH_REF_LANES.reduce((sum, lane) => sum + (Array.isArray(lanes?.[lane]) ? lanes[lane].length : 0), 0);
}

function normalizeProofExpansion(entry, {
  trustInlinePayload = false,
} = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const ref = normalizeHashRefAlias(entry.ref);
  if (!isHashRefAlias(ref)) return null;
  const out = {
    ref,
  };
  const sourceRef = normalizeHashRefAlias(entry.source_ref ?? entry.sourceRef ?? "");
  if (isHashRefAlias(sourceRef)) out.source_ref = sourceRef;
  if (entry.object_type || entry.objectType) out.object_type = compactText(entry.object_type ?? entry.objectType, 80);
  if (entry.entry_kind || entry.entryKind) out.entry_kind = compactText(entry.entry_kind ?? entry.entryKind, 40);
  if ((entry.size_chars ?? entry.sizeChars) != null && Number.isFinite(Number(entry.size_chars ?? entry.sizeChars))) {
    out.size_chars = Math.max(0, Number(entry.size_chars ?? entry.sizeChars));
  }
  if (/^[0-9a-f]{64}$/i.test(String(entry.content_hash ?? entry.contentHash ?? ""))) {
    out.content_hash = String(entry.content_hash ?? entry.contentHash).toLowerCase();
  }
  if (entry.note) out.note = compactText(entry.note, 240);
  if (entry.why) out.why = compactText(entry.why, DEFAULT_MAX_WHY_CHARS);
  if (entry.generated_by === PROOF_EXPANSION_GENERATOR) out.generated_by = PROOF_EXPANSION_GENERATOR;
  if (trustInlinePayload && out.generated_by === PROOF_EXPANSION_GENERATOR) {
    if (entry.text != null) out.text = String(entry.text);
    if (entry.descriptor != null) out.descriptor = entry.descriptor;
    if (entry.fingerprint_map != null || entry.fingerprintMap != null) {
      out.fingerprint_map = entry.fingerprint_map ?? entry.fingerprintMap;
    }
    if (entry.degraded === true) out.degraded = true;
    if (entry.notice) out.notice = compactText(entry.notice, 300);
  }
  if (entry.error) out.error = compactText(entry.error, 120);
  return out;
}

function normalizeLocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const path = compactText(value.repo_rel_path || value.repoRelPath || value.path || value.file || "", 220);
  const startLine = Number(value.startLine ?? value.start_line ?? value.range_start_line);
  const endLine = Number(value.endLine ?? value.end_line ?? value.range_end_line);
  const out = {};
  if (path) out.path = path;
  if (Number.isFinite(startLine) && startLine > 0) out.startLine = startLine;
  if (Number.isFinite(endLine) && endLine > 0) out.endLine = endLine;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizePreviewSymbol(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbolId = compactText(value.symbolId || value.symbol_id || value.id || "", 90);
  const name = compactText(value.qualifiedName || value.qualified_name || value.name || value.symbolName || value.symbol_name || "", 160);
  if (!symbolId && !name) return null;
  const out = {};
  if (symbolId) out.symbolId = symbolId;
  if (name) out.name = name;
  if (value.qualifiedName || value.qualified_name) out.qualifiedName = compactText(value.qualifiedName || value.qualified_name, 180);
  if (value.kind) out.kind = compactText(value.kind, 60);
  if (value.lang) out.lang = compactText(value.lang, 40);
  const location = normalizeLocation(value.location || value.loc || value);
  if (location) out.location = location;
  if (Number.isFinite(Number(value.score))) out.score = Number(value.score);
  if (value.relevance) out.relevance = compactText(value.relevance, 40);
  return out;
}

function normalizePreview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const symbols = (Array.isArray(value.symbols) ? value.symbols : [])
    .map(normalizePreviewSymbol)
    .filter(Boolean)
    .slice(0, 8);
  if (symbols.length === 0) return null;
  return {
    kind: "symbols",
    symbols,
    ...(Number.isFinite(Number(value.total)) ? { total: Math.max(symbols.length, Number(value.total)) } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

export function normalizeHashRefHandoffPacket(input, opts = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { packet: null, dropped: [] };
  }
  const maxRefsPerLane = Math.max(
    1,
    Number.parseInt(String(opts.maxRefsPerLane || DEFAULT_MAX_REFS_PER_LANE), 10) || DEFAULT_MAX_REFS_PER_LANE,
  );
  const maxWhyChars = Math.max(
    1,
    Number.parseInt(String(opts.maxWhyChars || DEFAULT_MAX_WHY_CHARS), 10) || DEFAULT_MAX_WHY_CHARS,
  );
  const dropped = [];
  const seen = new Set();
  const lanes = {};

  for (const lane of HASH_REF_LANES) {
    lanes[lane] = [];
    for (const entry of packetLaneSource(input, lane)) {
      if (lanes[lane].length >= maxRefsPerLane) break;
      const parts = entryParts(entry, maxWhyChars);
      const ref = normalizeHashRefAlias(parts.ref);
      const lines = normalizeLineRange(parts.lines);
      const selector = formatHashRefSelector(ref, lines);
      const why = compactText(parts.why, maxWhyChars);
      if (!isHashRefAlias(ref)) {
        dropped.push({ lane, ref: String(parts.ref || "").trim(), reason: "invalid_ref" });
        continue;
      }
      if (seen.has(selector)) {
        dropped.push({ lane, ref: selector, reason: "duplicate_ref" });
        continue;
      }
      if (lane === "decoy" && !why) {
        dropped.push({ lane, ref, reason: "missing_decoy_why" });
        continue;
      }
      seen.add(selector);
      const normalized = { ref };
      if (lines) normalized.lines = lines;
      if (why) normalized.why = why;
      if (parts.sourceRef) normalized.source_ref = normalizeHashRefAlias(parts.sourceRef);
      if (parts.sourceSelector && parseHashRefSelector(parts.sourceSelector)) {
        normalized.source_selector = formatHashRefSelector(
          parseHashRefSelector(parts.sourceSelector).ref,
          parseHashRefSelector(parts.sourceSelector).lines,
        );
      }
      if (parts.objectType) normalized.object_type = compactText(parts.objectType, 80);
      if (parts.entryKind) normalized.entry_kind = compactText(parts.entryKind, 40);
      if (parts.sizeChars != null && Number.isFinite(Number(parts.sizeChars))) {
        normalized.size_chars = Math.max(0, Number(parts.sizeChars));
      }
      if (/^[0-9a-f]{64}$/i.test(String(parts.contentHash || ""))) {
        normalized.content_hash = String(parts.contentHash).toLowerCase();
      }
      const preview = normalizePreview(parts.preview);
      if (preview) normalized.preview = preview;
      if (parts.unresolved) normalized.unresolved = true;
      if (parts.error) normalized.error = compactText(parts.error, 120);
      lanes[lane].push(normalized);
    }
  }

  if (!hasLaneRefs(lanes)) return { packet: null, dropped };

  const packet = {
    schema_version: 1,
    source: packetSource(input.source || input.evidence_source || opts.source),
    destination: normalizeDestination(input.destination || opts.destination),
    synthesis: compactText(input.synthesis || input.summary || "", 1200),
    lanes,
    ref_count: laneCount(lanes),
  };
  if (Array.isArray(input.dropped) && input.dropped.length > 0) {
    packet.upstream_dropped = input.dropped.slice(0, 50);
  }
  const trustProofExpansions = opts.trustProofExpansions === true
    || input.proof_expansions_generated === PROOF_EXPANSION_GENERATOR;
  const proofExpansions = (Array.isArray(input.proof_expansions) ? input.proof_expansions : [])
    .map((entry) => normalizeProofExpansion(entry, { trustInlinePayload: trustProofExpansions }))
    .filter(Boolean);
  if (proofExpansions.length > 0) packet.proof_expansions = proofExpansions;
  if (trustProofExpansions && proofExpansions.length > 0) {
    packet.proof_expansions_generated = PROOF_EXPANSION_GENERATOR;
  }
  return { packet, dropped };
}

function selectedPayloadText(payloadText, lines) {
  if (!lines) return String(payloadText || "");
  const sourceLines = String(payloadText || "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.end > sourceLines.length) return null;
  return sourceLines.slice(lines.start - 1, lines.end).join("\n");
}

function validMaterializedSourceWindows(entry) {
  return normalizedEvidenceSourceWindows(entry?.metadata?.source_windows)
    .filter((window) => {
      const materializedStart = Number(window.materialized_start_line);
      const materializedEnd = Number(window.materialized_end_line);
      return Number.isInteger(materializedStart)
        && Number.isInteger(materializedEnd)
        && materializedStart > 0
        && materializedEnd >= materializedStart
        && materializedEnd - materializedStart === window.source_end_line - window.source_start_line;
    });
}

function selectStructuredSourceContent(entry, lines) {
  let parsed;
  try { parsed = JSON.parse(String(entry?.payload_text || "")); } catch { return null; }
  const envelope = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (!envelope || typeof envelope !== "object") return null;
  const windows = normalizedEvidenceSourceWindows(entry?.metadata?.source_windows)
    .filter((window) => lines.start >= window.source_start_line && lines.end <= window.source_end_line);
  if (windows.length !== 1) return null;
  const [window] = windows;
  const candidates = [
    envelope,
    ...(Array.isArray(envelope.additionalWindows) ? envelope.additionalWindows : []),
    ...(Array.isArray(envelope.additional_windows) ? envelope.additional_windows : []),
  ].filter((candidate) => candidate && typeof candidate.content === "string");
  const contentCandidate = candidates.find((candidate) => {
    const path = String(candidate.repo_rel_path || candidate.repoRelPath || candidate.path || entry?.metadata?.path || "");
    const start = Number(candidate.startLine ?? candidate.start_line);
    const contentLines = String(candidate.content).replace(/\r\n?/g, "\n").split("\n");
    const end = start + contentLines.length - 1;
    return path === window.path
      && Number.isInteger(start)
      && lines.start >= start
      && lines.end <= end;
  });
  if (!contentCandidate) return null;
  const contentStart = Number(contentCandidate.startLine ?? contentCandidate.start_line);
  const contentLines = String(contentCandidate.content).replace(/\r\n?/g, "\n").split("\n");
  const payloadText = contentLines.slice(lines.start - contentStart, lines.end - contentStart + 1).join("\n");
  return {
    payloadText,
    metadata: {
      ...(entry.metadata || {}),
      path: window.path,
      line_semantics: "source",
      source_payload_encoding: "structured_content_excerpt",
      source_windows: [{
        ...window,
        source_start_line: lines.start,
        source_end_line: lines.end,
        materialized_start_line: 1,
        materialized_end_line: lines.end - lines.start + 1,
        source_payload_encoding: "structured_content_excerpt",
      }],
    },
  };
}

function selectSourceCoordinatePayload(entry, lines) {
  if (String(entry?.metadata?.line_semantics || "").toLowerCase() !== "source") return null;
  const structuredSelection = selectStructuredSourceContent(entry, lines);
  if (structuredSelection) return structuredSelection;
  const windows = validMaterializedSourceWindows(entry);
  const sourceCandidates = windows.filter((window) => (
    lines.start >= window.source_start_line && lines.end <= window.source_end_line
  ));
  let window = sourceCandidates.length === 1 ? sourceCandidates[0] : null;
  let materializedStart;
  let materializedEnd;
  let sourceStart;
  let sourceEnd;

  if (window) {
    sourceStart = lines.start;
    sourceEnd = lines.end;
    materializedStart = window.materialized_start_line + sourceStart - window.source_start_line;
    materializedEnd = window.materialized_start_line + sourceEnd - window.source_start_line;
  } else if (sourceCandidates.length === 0) {
    const materializedCandidates = windows.filter((candidate) => (
      lines.start >= candidate.materialized_start_line && lines.end <= candidate.materialized_end_line
    ));
    if (materializedCandidates.length !== 1) return null;
    [window] = materializedCandidates;
    materializedStart = lines.start;
    materializedEnd = lines.end;
    sourceStart = window.source_start_line + materializedStart - window.materialized_start_line;
    sourceEnd = window.source_start_line + materializedEnd - window.materialized_start_line;
  } else {
    return null;
  }

  const payloadText = selectedPayloadText(entry.payload_text, {
    start: materializedStart,
    end: materializedEnd,
  });
  if (payloadText == null) return null;
  return {
    payloadText,
    metadata: {
      ...(entry.metadata || {}),
      path: window.path,
      line_semantics: "source",
      source_windows: [{
        ...window,
        source_start_line: sourceStart,
        source_end_line: sourceEnd,
        materialized_start_line: 1,
        materialized_end_line: sourceEnd - sourceStart + 1,
      }],
    },
  };
}

function entryForResurface(fetchResult, laneEntry = null) {
  const entry = fetchResult?.entry;
  if (!entry) return null;
  if (entry.entry_kind === "materialized") {
    const sourceSelection = laneEntry?.lines
      ? selectSourceCoordinatePayload(entry, laneEntry.lines)
      : null;
    if (laneEntry?.lines && String(entry?.metadata?.line_semantics || "").toLowerCase() === "source" && !sourceSelection) {
      return null;
    }
    const payloadText = sourceSelection?.payloadText
      ?? selectedPayloadText(entry.payload_text, laneEntry?.lines);
    if (payloadText == null) return null;
    return {
      entryKind: "materialized",
      payloadText,
      metadata: sourceSelection?.metadata || entry.metadata || {},
    };
  }
  if (laneEntry?.lines) return null;
  return {
    entryKind: "descriptor",
    descriptor: entry.descriptor,
    fingerprintMap: entry.fingerprint_map,
    recomputable: entry.recomputable === true,
    degraded: entry.degraded === true,
  };
}

function noteWithWhy(note, why) {
  const parts = [note, why].map((value) => compactText(value, 240)).filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)].join(" | ").slice(0, 1000) : null;
}

function resurfaceEntry(fetchResult, laneEntry, {
  targetContext,
  targetOwnerScope = "job",
  packet,
} = {}) {
  const sourceEntry = fetchResult?.entry;
  const surfacedEntry = entryForResurface(fetchResult, laneEntry);
  if (!sourceEntry || !surfacedEntry) return null;
  const { metadata: selectedMetadata, ...surfaceFields } = surfacedEntry;
  const sourceSelector = formatHashRefSelector(laneEntry.ref, laneEntry.lines);
  const surfaced = surfaceHashRefForContext(targetContext, {
    ...surfaceFields,
    ...(laneEntry.lines ? {} : { contentHash: sourceEntry.content_hash }),
    objectType: sourceEntry.object_type,
    source: sourceEntry.source || `hash_ref:${sourceSelector}`,
    note: noteWithWhy(sourceEntry.note, laneEntry.why),
    ...(laneEntry.lines ? {} : { sizeChars: sourceEntry.size_chars }),
    versionId: sourceEntry.version_id,
    metadata: {
      ...(selectedMetadata || sourceEntry.metadata || {}),
      ...hashRefModelVisibility(targetContext, { visibility: "hidden", issuedAs: "traversal" }),
      reissued_by: "hash_ref_handoff",
      source_ref: laneEntry.ref,
      ...(laneEntry.lines ? { source_lines: laneEntry.lines, source_selector: sourceSelector } : {}),
      handoff_destination: packet?.destination || "handoff",
    },
  }, { ownerScope: targetOwnerScope });
  if (!surfaced?.ok || !surfaced.entry?.ref) return null;
  return {
    ref: surfaced.model_ref || surfaced.entry.ref,
    source_ref: laneEntry.ref,
    ...(laneEntry.lines ? { source_selector: sourceSelector } : {}),
    ...(laneEntry.why ? { why: laneEntry.why } : {}),
    object_type: surfaced.entry.object_type,
    entry_kind: surfaced.entry.entry_kind,
    size_chars: surfaced.entry.size_chars,
    content_hash: surfaced.entry.content_hash,
  };
}

export function reissueHashRefHandoffPacket(input, {
  sourceContext = {},
  targetContext = {},
  targetOwnerScope = "job",
  preserveOnMiss = true,
} = {}) {
  const normalized = normalizeHashRefHandoffPacket(input);
  if (!normalized.packet) return { packet: null, dropped: normalized.dropped, reissued: 0, missed: 0 };

  const packet = {
    ...normalized.packet,
    lanes: {},
    reissued: true,
  };
  const dropped = [...normalized.dropped];
  let reissued = 0;
  let missed = 0;

  for (const lane of HASH_REF_LANES) {
    packet.lanes[lane] = [];
    for (const laneEntry of normalized.packet.lanes[lane]) {
      let targetFetchResult = null;
      try {
        targetFetchResult = fetchEvidenceOrSource(targetContext, laneEntry.ref);
      } catch {
        targetFetchResult = null;
      }
      let fetchResult = targetFetchResult?.ok && targetFetchResult?.found && targetFetchResult.entry
        ? targetFetchResult
        : null;
      try {
        if (!fetchResult) fetchResult = fetchEvidenceOrSource(sourceContext, laneEntry.ref);
      } catch (err) {
        fetchResult = { ok: false, found: false, ref: laneEntry.ref, error: err?.message || "fetch_failed" };
      }
      if (fetchResult?.ok && fetchResult?.found && fetchResult.entry) {
        try {
          const surfaced = resurfaceEntry(fetchResult, laneEntry, {
            targetContext,
            targetOwnerScope,
            packet: normalized.packet,
          });
          if (surfaced) {
            packet.lanes[lane].push(surfaced);
            reissued += 1;
            continue;
          }
        } catch (err) {
          fetchResult = { ok: false, found: false, ref: laneEntry.ref, error: err?.message || "surface_failed" };
        }
      }
      missed += 1;
      const reason = fetchResult?.error || "not_found_or_not_visible";
      dropped.push({ lane, ref: laneEntry.ref, reason });
      if (preserveOnMiss) {
        packet.lanes[lane].push({
          ...laneEntry,
          unresolved: true,
          error: compactText(reason, 120),
        });
      }
    }
  }
  packet.ref_count = laneCount(packet.lanes);
  packet.reissued_count = reissued;
  packet.missed_count = missed;
  return { packet: hasLaneRefs(packet.lanes) ? packet : null, dropped, reissued, missed };
}

function proofExpansionForFetch(fetchResult, laneEntry) {
  const entry = fetchResult?.entry;
  if (!entry) return null;
  const base = {
    ref: laneEntry.ref,
    source_ref: laneEntry.source_ref || null,
    ...(laneEntry.why ? { why: laneEntry.why } : {}),
    object_type: entry.object_type,
    entry_kind: entry.entry_kind,
    size_chars: entry.size_chars,
    content_hash: entry.content_hash,
    note: entry.note,
    generated_by: PROOF_EXPANSION_GENERATOR,
  };
  if (entry.entry_kind === "materialized") {
    return {
      ...base,
      text: entry.payload_text || "",
    };
  }
  return {
    ...base,
    degraded: true,
    descriptor: entry.descriptor,
    fingerprint_map: entry.fingerprint_map,
    notice: "Descriptor-backed proof could not be recomputed by the handoff renderer; traverse_ref can report the current descriptor state when this ref is issued for traversal.",
  };
}

function devBriefExpansionForFetch(fetchResult, laneEntry, lane) {
  const expansion = proofExpansionForFetch(fetchResult, laneEntry);
  if (!expansion || expansion.text == null) return null;
  const sourceWindows = normalizedEvidenceSourceWindows(fetchResult?.entry?.metadata?.source_windows);
  return {
    ...expansion,
    lane,
    ...(laneEntry.source_selector ? { source_selector: laneEntry.source_selector } : {}),
    ...(sourceWindows.length > 0 ? { source_windows: sourceWindows } : {}),
  };
}

export function expandHashRefHandoffPacketForDevBrief(input, {
  context = {},
  maxChars = DEFAULT_DEV_BRIEF_EXPANSION_MAX_CHARS,
  maxRefs = DEFAULT_DEV_BRIEF_EXPANSION_MAX_REFS,
} = {}) {
  const normalized = normalizeHashRefHandoffPacket(input);
  if (!normalized.packet) {
    return { packet: null, expansions: [], dropped: normalized.dropped, expanded: 0, missed: 0 };
  }

  const packet = {
    ...normalized.packet,
    dev_brief_expansions_generated: DEV_BRIEF_EXPANSION_GENERATOR,
    dev_brief_expansions: [],
  };
  const dropped = [...normalized.dropped];
  const charLimit = Math.max(0, Number(maxChars) || 0);
  const refLimit = Math.max(0, Number(maxRefs) || 0);
  let usedChars = 0;
  let missed = 0;

  for (const lane of ["proof", "support"]) {
    for (const laneEntry of packet.lanes[lane] || []) {
      if (laneEntry.unresolved) {
        missed += 1;
        dropped.push({ lane, ref: laneEntry.ref, reason: laneEntry.error || "unresolved_ref" });
        continue;
      }
      if (packet.dev_brief_expansions.length >= refLimit) {
        dropped.push({ lane, ref: laneEntry.ref, reason: "dev_brief_expansion_ref_cap" });
        continue;
      }
      let fetchResult = null;
      try {
        fetchResult = fetchEvidenceOrSource(context, laneEntry.ref);
      } catch (err) {
        fetchResult = { ok: false, found: false, ref: laneEntry.ref, error: err?.message || "fetch_failed" };
      }
      if (!fetchResult?.ok || !fetchResult?.found || !fetchResult.entry) {
        missed += 1;
        dropped.push({ lane, ref: laneEntry.ref, reason: fetchResult?.error || "not_found_or_not_visible" });
        continue;
      }
      const expansion = devBriefExpansionForFetch(fetchResult, laneEntry, lane);
      if (!expansion) {
        missed += 1;
        dropped.push({ lane, ref: laneEntry.ref, reason: "dev_brief_evidence_not_materialized" });
        continue;
      }
      const expansionChars = String(expansion.text || "").length;
      if (usedChars + expansionChars > charLimit) {
        dropped.push({ lane, ref: laneEntry.ref, reason: "dev_brief_expansion_char_cap" });
        continue;
      }
      packet.dev_brief_expansions.push(expansion);
      usedChars += expansionChars;
    }
  }

  packet.dev_brief_expanded_count = packet.dev_brief_expansions.length;
  packet.dev_brief_expanded_chars = usedChars;
  return {
    packet,
    expansions: packet.dev_brief_expansions,
    dropped,
    expanded: packet.dev_brief_expansions.length,
    missed,
  };
}

function expansionLocation(expansion) {
  const windows = Array.isArray(expansion?.source_windows) ? expansion.source_windows : [];
  if (windows.length !== 1) return "";
  const [window] = windows;
  return `${window.path}:${window.source_start_line}-${window.source_end_line}`;
}

export function renderAutoExpandedDevBriefEvidence(input, {
  maxChars = DEFAULT_DEV_BRIEF_EXPANSION_MAX_CHARS,
} = {}) {
  if (input?.dev_brief_expansions_generated !== DEV_BRIEF_EXPANSION_GENERATOR) {
    return { text: "", expansions: [], dropped: [] };
  }
  const charLimit = Math.max(0, Number(maxChars) || 0);
  const header = [
    "PLANNER DEV BRIEF EVIDENCE (auto-expanded locally):",
    "The planner selected this existing-code evidence as directly relevant. It is already visible in this call: use the evidence_ref directly and do not traverse it. Writable scope is unchanged.",
  ].join("\n");
  if (header.length > charLimit) return { text: "", expansions: [], dropped: [] };

  const parts = [header];
  const expansions = [];
  const dropped = [];
  let usedChars = header.length;
  for (const expansion of Array.isArray(input.dev_brief_expansions) ? input.dev_brief_expansions : []) {
    const location = expansionLocation(expansion);
    const details = [
      expansion.source_selector ? `from ${expansion.source_selector}` : (expansion.source_ref ? `from ${expansion.source_ref}` : ""),
      location,
      expansion.object_type ? `type=${expansion.object_type}` : "",
    ].filter(Boolean).join("; ");
    const block = [
      `=== ${String(expansion.lane || "support").toUpperCase()} [evidence_ref ${expansion.ref} usage=cite_or_handoff]${details ? ` (${details})` : ""} ===`,
      String(expansion.text || "") || "(empty evidence payload)",
    ].join("\n");
    const addedChars = block.length + 2;
    if (usedChars + addedChars > charLimit) {
      dropped.push({ lane: expansion.lane, ref: expansion.ref, reason: "dev_brief_render_char_cap" });
      continue;
    }
    parts.push(block);
    expansions.push(expansion);
    usedChars += addedChars;
  }
  if (expansions.length === 0) return { text: "", expansions: [], dropped };
  return { text: parts.join("\n\n"), expansions, dropped };
}

export function stageAutoExpandedDevBriefEvidence(packet, rendered = {}) {
  if (!packet || typeof packet !== "object") return false;
  const text = String(rendered?.text || "").trim();
  const expansions = Array.isArray(rendered?.expansions) ? rendered.expansions : [];
  if (!text || expansions.length === 0) return false;
  stagedDevBriefEvidence.set(packet, { text, expansions });
  return true;
}

export function bindAutoExpandedDevBriefEvidenceToAgentCall(packet, {
  context = {},
  deliveredPrompt = "",
} = {}) {
  const staged = packet && typeof packet === "object" ? stagedDevBriefEvidence.get(packet) : null;
  const agentCallId = Number(context?.agent_call_id ?? context?.agentCallId) || null;
  if (!staged || !agentCallId || !String(deliveredPrompt || "").includes(staged.text)) {
    return { promoted: 0, coverage: 0, skipped: !staged ? "not_staged" : !agentCallId ? "missing_agent_call" : "not_delivered" };
  }

  const exactContext = { ...context, agent_call_id: agentCallId };
  let promoted = 0;
  let coverage = 0;
  for (const expansion of staged.expansions) {
    let result = null;
    try {
      result = promoteHashRefTraversalForContext(exactContext, expansion.ref, {
        viewText: String(expansion.text || ""),
      });
    } catch {
      result = null;
    }
    if (!result?.ok || !result.evidence) continue;
    promoted += 1;
    for (const window of Array.isArray(expansion.source_windows) ? expansion.source_windows : []) {
      recordObservation({
        work_item_id: exactContext.work_item_id ?? null,
        job_id: exactContext.job_id ?? null,
        attempt_id: exactContext.attempt_id ?? null,
        observation_type: "source.coverage",
        summary: `delivered dev-brief coverage ${window.path}:${window.source_start_line}-${window.source_end_line}`,
        detail: {
          repository_identity: window.repository_identity || null,
          source_version: window.source_version || null,
          repo_rel_path: window.path,
          path: window.path,
          start_line: window.source_start_line,
          end_line: window.source_end_line,
          source_start_line: window.source_start_line,
          source_end_line: window.source_end_line,
          evidence_ref: expansion.ref,
          delivery_state: "delivered",
          origin: "dev_brief_auto_expand",
          tool: "planner_dev_brief",
          stored_chars: String(expansion.text || "").length,
          returned_chars: String(expansion.text || "").length,
          agent_call_id: agentCallId,
        },
      });
      coverage += 1;
    }
  }
  return { promoted, coverage };
}

function parsePayloadJson(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function pushSymbolPreview(out, value) {
  const symbol = normalizePreviewSymbol(value);
  if (!symbol) return;
  const key = symbol.symbolId || `${symbol.name}:${symbol.location?.path || ""}:${symbol.location?.startLine || ""}`;
  if (out.seen.has(key)) return;
  out.seen.add(key);
  out.symbols.push(symbol);
}

function collectSymbolsFromValue(value, out, depth = 0) {
  if (!value || depth > 6 || out.symbols.length >= 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSymbolsFromValue(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  if (value.symbolId || value.symbol_id || value.qualifiedName || value.qualified_name) {
    pushSymbolPreview(out, value);
  }
  if (value.after) collectSymbolsFromValue(value.after, out, depth + 1);
  if (value.before) collectSymbolsFromValue(value.before, out, depth + 1);
  if (value.ref) collectSymbolsFromValue(value.ref, out, depth + 1);
  for (const key of ["items", "cards", "symbols", "retrievedSymbols", "results"]) {
    if (Array.isArray(value[key])) collectSymbolsFromValue(value[key], out, depth + 1);
  }
  if (value.result) collectSymbolsFromValue(value.result, out, depth + 1);
  if (value.data) collectSymbolsFromValue(value.data, out, depth + 1);
  if (value.delta) collectSymbolsFromValue(value.delta, out, depth + 1);
}

function typeAwarePreviewForFetch(fetchResult) {
  const entry = fetchResult?.entry;
  if (!entry) return null;
  const objectType = String(entry.object_type || "").toLowerCase();
  const source = String(entry.source || "").toLowerCase();
  const looksSymbolish = /symbol|slice|review\.risk|review\.delta/.test(objectType)
    || /symbol|slice|review\.risk|review\.delta/.test(source);
  if (!looksSymbolish && entry.entry_kind !== "materialized") return null;

  const out = { symbols: [], seen: new Set() };
  if (entry.entry_kind === "materialized") {
    const parsed = parsePayloadJson(entry.payload_text);
    if (parsed) collectSymbolsFromValue(parsed, out);
  }
  const descriptor = entry.descriptor || {};
  collectSymbolsFromValue(descriptor, out);
  if (out.symbols.length === 0) return null;
  return {
    kind: "symbols",
    symbols: out.symbols,
    total: out.symbols.length,
    truncated: out.symbols.length >= 8,
  };
}

export function expandHashRefHandoffPacketProofs(input, {
  context = {},
} = {}) {
  const normalized = normalizeHashRefHandoffPacket(input);
  if (!normalized.packet) return { packet: null, dropped: normalized.dropped, expanded: 0, missed: 0 };

  const packet = {
    ...normalized.packet,
    lanes: normalized.packet.lanes,
    proof_expanded: true,
    proof_expansions_generated: PROOF_EXPANSION_GENERATOR,
    proof_expansions: [],
  };
  const dropped = [...normalized.dropped];
  let expanded = 0;
  let missed = 0;
  let previewed = 0;

  for (const proof of packet.lanes.proof || []) {
    if (proof.unresolved) {
      missed += 1;
      dropped.push({ lane: "proof", ref: proof.ref, reason: proof.error || "unresolved_ref" });
      continue;
    }
    let fetchResult = null;
    try {
      fetchResult = fetchEvidenceOrSource(context, proof.ref);
    } catch (err) {
      fetchResult = { ok: false, found: false, ref: proof.ref, error: err?.message || "fetch_failed" };
    }
    if (fetchResult?.ok && fetchResult?.found && fetchResult.entry) {
      const expansion = proofExpansionForFetch(fetchResult, proof);
      if (expansion) {
        packet.proof_expansions.push(expansion);
        expanded += 1;
        continue;
      }
    }
    missed += 1;
    const reason = fetchResult?.error || "not_found_or_not_visible";
    proof.unresolved = true;
    proof.error = compactText(reason, 120);
    dropped.push({ lane: "proof", ref: proof.ref, reason });
  }

  for (const lane of ["support", "decoy"]) {
    for (const entry of packet.lanes[lane] || []) {
      if (entry.unresolved || entry.preview) continue;
      let fetchResult = null;
      try {
        fetchResult = fetchEvidenceOrSource(context, entry.ref);
      } catch (err) {
        fetchResult = { ok: false, found: false, ref: entry.ref, error: err?.message || "fetch_failed" };
      }
      if (fetchResult?.ok && fetchResult?.found && fetchResult.entry) {
        const preview = typeAwarePreviewForFetch(fetchResult);
        if (preview) {
          entry.preview = preview;
          previewed += 1;
        }
      }
    }
  }

  packet.proof_expanded_count = expanded;
  packet.proof_missed_count = missed;
  packet.previewed_count = previewed;
  return { packet, dropped, expanded, missed, previewed };
}

function renderPreview(preview) {
  const normalized = normalizePreview(preview);
  if (!normalized) return [];
  const lines = [];
  if (normalized.kind === "symbols") {
    for (const symbol of normalized.symbols || []) {
      const location = symbol.location
        ? [
            symbol.location.path || "",
            symbol.location.startLine ? `:${symbol.location.startLine}` : "",
            symbol.location.endLine && symbol.location.endLine !== symbol.location.startLine ? `-${symbol.location.endLine}` : "",
          ].join("")
        : "";
      const details = [
        symbol.kind ? `kind=${symbol.kind}` : "",
        symbol.lang ? `lang=${symbol.lang}` : "",
        location ? `loc=${location}` : "",
        symbol.symbolId ? `id=${symbol.symbolId}` : "",
      ].filter(Boolean);
      lines.push(`symbol ${symbol.qualifiedName || symbol.name}${details.length > 0 ? ` (${details.join("; ")})` : ""}`);
    }
  }
  return lines;
}

export function renderHashRefHandoffPacket(input, opts = {}) {
  const normalized = normalizeHashRefHandoffPacket(input, {
    ...opts,
    trustProofExpansions: opts.trustProofExpansions === true
      || input?.proof_expansions_generated === PROOF_EXPANSION_GENERATOR,
  });
  const packet = normalized.packet;
  if (!packet || packet.source !== "atlas") return "";
  const lines = [
    "ATLAS HASH REF HANDOFF PACKET:",
    "Compact durable evidence map. Expanded proof and previews are already visible evidence; use them directly. Only explicit traversal_ref stubs are callable for missing content.",
  ];
  if (packet.synthesis) {
    lines.push("");
    lines.push(`Synthesis: ${packet.synthesis}`);
  }
  for (const lane of HASH_REF_LANES) {
    const refs = packet.lanes[lane] || [];
    if (refs.length === 0) continue;
    lines.push("");
    lines.push(`${lane}:`);
    for (const entry of refs) {
      const selector = formatHashRefSelector(entry.ref, entry.lines);
      const details = [
        entry.source_selector ? `from ${entry.source_selector}` : (entry.source_ref ? `from ${entry.source_ref}` : ""),
        entry.object_type ? `type=${entry.object_type}` : "",
        Number.isFinite(Number(entry.size_chars)) ? `${Number(entry.size_chars)} chars` : "",
        lane === "proof" && packet.proof_expansions?.some((expanded) => expanded.ref === entry.ref) ? "expanded inline" : "",
        entry.preview ? "preview inline" : "",
        entry.unresolved ? `unresolved=${entry.error || "true"}` : "",
        entry.why ? entry.why : "",
      ].filter(Boolean);
      const expanded = lane === "proof"
        && packet.proof_expansions?.some((candidate) => candidate.ref === entry.ref);
      const visiblePreview = lane !== "proof" && entry.preview;
      const renderedRef = expanded || visiblePreview
        ? `[evidence_ref ${selector} usage=cite_or_handoff]`
        : renderTraversalRefStub({ ref: entry.ref, kind: entry.object_type || lane }).trim();
      lines.push(`- ${renderedRef}${details.length > 0 ? ` - ${details.join("; ")}` : ""}`);
      const previewLines = lane === "proof" ? [] : renderPreview(entry.preview);
      for (const previewLine of previewLines) {
        lines.push(`  ${previewLine}`);
      }
    }
  }
  if (Array.isArray(packet.proof_expansions) && packet.proof_expansions.length > 0) {
    lines.push("");
    lines.push("EXPANDED PROOF EVIDENCE:");
    for (const entry of packet.proof_expansions) {
      const details = [
        entry.source_ref ? `from ${entry.source_ref}` : "",
        entry.object_type ? `type=${entry.object_type}` : "",
        Number.isFinite(Number(entry.size_chars)) ? `${Number(entry.size_chars)} chars` : "",
        entry.degraded ? "degraded" : "",
        entry.note ? `note=${entry.note}` : "",
        entry.why ? `why=${entry.why}` : "",
      ].filter(Boolean);
      lines.push("");
      lines.push(`=== PROOF ${entry.ref}${details.length > 0 ? ` (${details.join("; ")})` : ""} ===`);
      if (entry.text != null) {
        lines.push(entry.text || "(empty proof payload)");
      } else {
        lines.push(entry.notice || "Proof ref is descriptor-backed; exact payload was not materialized.");
        if (entry.descriptor != null) {
          lines.push(JSON.stringify({ descriptor: entry.descriptor, fingerprint_map: entry.fingerprint_map || null }, null, 2));
        }
      }
    }
  }
  if (normalized.dropped.length > 0) {
    lines.push("");
    lines.push("Dropped refs:");
    for (const entry of normalized.dropped.slice(0, 12)) {
      lines.push(`- ${entry.lane}:${entry.ref || "(empty)"}:${entry.reason}`);
    }
  }
  return lines.join("\n");
}
