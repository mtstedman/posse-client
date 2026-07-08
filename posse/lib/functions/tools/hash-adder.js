import crypto from "crypto";

import { getObservationContext, recordObservation } from "../../domains/observability/functions/observations.js";
import {
  fetchHashRefForContext,
  surfaceHashRefForContext,
} from "../../domains/queue/functions/hash-refs.js";

const DEFAULT_SURFACE_MIN_CHARS = 4000;
const DEFAULT_MATERIALIZE_CHAR_CAP = 60000;
const HASH_ADDER_BLOCKED_TOOLS = new Set(["fetch_ref"]);

function normalizeRef(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
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
  const objectType = entry?.object_type || toolName || "tool_result";
  const note = entry?.note ? ` note="${String(entry.note).slice(0, 140)}"` : "";
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
      owner_scope: surfaced.owner_scope,
      owner_id: surfaced.owner_id,
      reused: surfaced.reused === true,
    },
  });
}

export function appendHashRefIfMajor(toolName, result, {
  args = {},
  context = {},
  source = null,
  objectType = null,
  note = null,
  minChars = DEFAULT_SURFACE_MIN_CHARS,
  materializeCharCap = DEFAULT_MATERIALIZE_CHAR_CAP,
} = {}) {
  if (!shouldSurfaceHashRef(toolName, result, { minChars })) return result;
  const hashContext = contextForHashRefs(context);
  if (!hasHashRefScope(hashContext)) return result;

  const text = String(result);
  const sizeChars = text.length;
  const materialized = sizeChars <= materializeCharCap;
  const entry = materialized
    ? {
      entryKind: "materialized",
      payloadText: text,
    }
    : {
      entryKind: "descriptor",
      descriptor: {
        kind: "tool_result",
        tool: toolName,
        args,
        source: source || `tool:${toolName}`,
      },
      fingerprintMap: lineFingerprintMap(text),
      recomputable: true,
    };
  let surfaced;
  try {
    surfaced = surfaceHashRefForContext(hashContext, {
      ...entry,
      objectType: objectType || toolName || "tool_result",
      source: source || `tool:${toolName}`,
      note,
      sizeChars,
      metadata: {
        surfaced_by: "hash_adder",
        tool: toolName || null,
        materialized,
      },
    });
  } catch {
    return result;
  }
  if (!surfaced?.ok) return result;
  recordHashObservation(hashContext, surfaced, toolName, sizeChars);
  return `${result}${refStub({ entry: surfaced.entry, toolName, sizeChars })}`;
}

function fetchResultText(result) {
  if (!result?.ok || !result?.found || !result.entry) {
    return JSON.stringify({
      ok: false,
      ref: normalizeRef(result?.ref),
      error: result?.error || "not_found_or_not_visible",
    }, null, 2);
  }
  const entry = result.entry;
  if (entry.entry_kind === "materialized") {
    return JSON.stringify({
      ok: true,
      ref: entry.ref,
      owner_scope: result.owner_scope,
      via_parent: result.via_parent === true,
      object_type: entry.object_type,
      source: entry.source,
      note: entry.note,
      content_hash: entry.content_hash,
      size_chars: entry.size_chars,
      text: entry.payload_text || "",
    }, null, 2);
  }
  return JSON.stringify({
    ok: true,
    ref: entry.ref,
    owner_scope: result.owner_scope,
    via_parent: result.via_parent === true,
    object_type: entry.object_type,
    source: entry.source,
    note: entry.note,
    content_hash: entry.content_hash,
    size_chars: entry.size_chars,
    degraded: true,
    descriptor: entry.descriptor,
    fingerprint_map: entry.fingerprint_map,
    notice: "This ref is descriptor-backed. Recompute fetch is not wired for this descriptor in the current runtime, so the original payload is not being claimed verbatim.",
  }, null, 2);
}

function recordFetchObservation(hashContext, ref, result) {
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
      owner_scope: result?.owner_scope || null,
      via_parent: result?.via_parent === true,
      error: result?.error || null,
    },
  });
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
    const result = fetchHashRefForContext(hashContext, refs[0]);
    recordFetchObservation(hashContext, refs[0], result);
    return fetchResultText(result);
  }

  const results = refs.map((ref) => {
    const result = fetchHashRefForContext(hashContext, ref);
    recordFetchObservation(hashContext, ref, result);
    return parseFetchPayload(fetchResultText(result));
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
  lineFingerprintMap,
  normalizeRef,
  shouldSurfaceHashRef,
});
