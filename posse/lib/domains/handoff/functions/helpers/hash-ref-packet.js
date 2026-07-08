import {
  HASH_REF_DESTINATION_SET,
  HASH_REF_LANES,
  isHashRefAlias,
  normalizeHashRefAlias,
} from "../../../../catalog/hash-store.js";
import {
  fetchHashRefForContext,
  surfaceHashRefForContext,
} from "../../../queue/functions/hash-refs.js";

const DEFAULT_MAX_REFS_PER_LANE = 24;
const DEFAULT_MAX_WHY_CHARS = 180;

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
  if (typeof entry === "string") return { ref: entry, why: "" };
  if (Array.isArray(entry)) {
    return {
      ref: entry[0],
      why: compactText(entry[1], maxWhyChars),
    };
  }
  if (entry && typeof entry === "object") {
    return {
      ref: entry.ref ?? entry.hash ?? entry.ref_hash,
      why: compactText(entry.why ?? entry.reason ?? entry.note, maxWhyChars),
      sourceRef: entry.source_ref ?? entry.sourceRef ?? null,
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

function normalizeProofExpansion(entry) {
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
  if (entry.text != null) out.text = String(entry.text);
  if (entry.descriptor != null) out.descriptor = entry.descriptor;
  if (entry.fingerprint_map != null || entry.fingerprintMap != null) {
    out.fingerprint_map = entry.fingerprint_map ?? entry.fingerprintMap;
  }
  if (entry.degraded === true) out.degraded = true;
  if (entry.error) out.error = compactText(entry.error, 120);
  if (entry.notice) out.notice = compactText(entry.notice, 300);
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
      const why = compactText(parts.why, maxWhyChars);
      if (!isHashRefAlias(ref)) {
        dropped.push({ lane, ref: String(parts.ref || "").trim(), reason: "invalid_ref" });
        continue;
      }
      if (seen.has(ref)) {
        dropped.push({ lane, ref, reason: "duplicate_ref" });
        continue;
      }
      if (lane === "decoy" && !why) {
        dropped.push({ lane, ref, reason: "missing_decoy_why" });
        continue;
      }
      seen.add(ref);
      const normalized = { ref };
      if (why) normalized.why = why;
      if (parts.sourceRef) normalized.source_ref = normalizeHashRefAlias(parts.sourceRef);
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
  const proofExpansions = (Array.isArray(input.proof_expansions) ? input.proof_expansions : [])
    .map(normalizeProofExpansion)
    .filter(Boolean);
  if (proofExpansions.length > 0) packet.proof_expansions = proofExpansions;
  return { packet, dropped };
}

function entryForResurface(fetchResult) {
  const entry = fetchResult?.entry;
  if (!entry) return null;
  if (entry.entry_kind === "materialized") {
    return {
      entryKind: "materialized",
      payloadText: entry.payload_text || "",
    };
  }
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
  const surfacedEntry = entryForResurface(fetchResult);
  if (!sourceEntry || !surfacedEntry) return null;
  const surfaced = surfaceHashRefForContext(targetContext, {
    ...surfacedEntry,
    contentHash: sourceEntry.content_hash,
    objectType: sourceEntry.object_type,
    source: sourceEntry.source || `hash_ref:${laneEntry.ref}`,
    note: noteWithWhy(sourceEntry.note, laneEntry.why),
    sizeChars: sourceEntry.size_chars,
    versionId: sourceEntry.version_id,
    metadata: {
      ...(sourceEntry.metadata || {}),
      reissued_by: "hash_ref_handoff",
      source_ref: laneEntry.ref,
      source_owner_scope: fetchResult.owner_scope || null,
      source_owner_id: fetchResult.owner_id || null,
      handoff_destination: packet?.destination || "handoff",
    },
  }, { ownerScope: targetOwnerScope });
  if (!surfaced?.ok || !surfaced.entry?.ref) return null;
  return {
    ref: surfaced.entry.ref,
    source_ref: laneEntry.ref,
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
      let fetchResult = null;
      try {
        fetchResult = fetchHashRefForContext(sourceContext, laneEntry.ref);
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
    notice: "Descriptor-backed proof could not be recomputed by the handoff renderer; fetch_ref can report the current descriptor state.",
  };
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
      fetchResult = fetchHashRefForContext(context, proof.ref);
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
        fetchResult = fetchHashRefForContext(context, entry.ref);
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
  const normalized = normalizeHashRefHandoffPacket(input, opts);
  const packet = normalized.packet;
  if (!packet || packet.source !== "atlas") return "";
  const lines = [
    "ATLAS HASH REF HANDOFF PACKET:",
    "Proof refs are auto-expanded below. Support and decoy refs get compact type-aware previews when possible; use fetch_ref for exact evidence when needed.",
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
      const details = [
        entry.source_ref ? `from ${entry.source_ref}` : "",
        entry.object_type ? `type=${entry.object_type}` : "",
        Number.isFinite(Number(entry.size_chars)) ? `${Number(entry.size_chars)} chars` : "",
        lane === "proof" && packet.proof_expansions?.some((expanded) => expanded.ref === entry.ref) ? "expanded inline" : "",
        entry.preview ? "preview inline" : "",
        entry.unresolved ? `unresolved=${entry.error || "true"}` : "",
        entry.why ? entry.why : "",
      ].filter(Boolean);
      lines.push(`- ${entry.ref}${details.length > 0 ? ` - ${details.join("; ")}` : ""}`);
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
