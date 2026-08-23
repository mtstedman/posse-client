import { normalizeHashRefAlias } from "../../../catalog/hash-store.js";

export const HASH_REF_SURFACE_KINDS = Object.freeze({
  EVIDENCE: "evidence",
  TRAVERSAL: "traversal",
});

const HASH_REF_SURFACE_SUFFIX_RE = /\n+\[(?:ref_hash|evidence_ref|traversal_ref) [^\n]*\]\s*$/i;

function normalizedRef(value) {
  return normalizeHashRefAlias(value);
}

function boundedText(value, maxChars) {
  return String(value || "")
    .replace(/["\\\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function evidenceRefSurface(ref, {
  exactField = null,
  chars = null,
  lines = null,
} = {}) {
  const normalized = normalizedRef(ref);
  if (!normalized) return null;
  return {
    ref: normalized,
    usage: "cite_or_handoff",
    ...(exactField ? { exact_field: String(exactField) } : {}),
    ...(chars != null && Number.isFinite(Number(chars)) ? { chars: Math.max(0, Number(chars)) } : {}),
    ...(lines != null && Number.isFinite(Number(lines)) ? { lines: Math.max(0, Number(lines)) } : {}),
  };
}

export function traversalRefSurface(ref, {
  kind = "continuation",
  offset = null,
  limit = null,
  search = null,
  searchMode = null,
  ranks = null,
  count = null,
} = {}) {
  const normalized = normalizedRef(ref);
  if (!normalized) return null;
  return {
    ref: normalized,
    usage: "fetch_missing_content",
    kind: String(kind || "continuation"),
    ...(offset != null && Number.isFinite(Number(offset)) ? { offset: Math.max(0, Number(offset)) } : {}),
    ...(limit != null && Number.isFinite(Number(limit)) ? { limit: Math.max(1, Number(limit)) } : {}),
    ...(search ? { search: String(search) } : {}),
    ...(searchMode ? { search_mode: String(searchMode) } : {}),
    ...(ranks ? { ranks: String(ranks) } : {}),
    ...(count != null && Number.isFinite(Number(count)) ? { count: Math.max(0, Number(count)) } : {}),
  };
}

export function renderEvidenceRefStub({
  ref,
  objectType = "tool_result",
  sizeChars = 0,
  note = "",
} = {}) {
  const surface = evidenceRefSurface(ref);
  if (!surface) return "";
  const type = boundedText(objectType, 80).replace(/[^0-9A-Za-z_.:-]+/g, "_") || "tool_result";
  const noteText = boundedText(note, 140);
  return `\n\n[evidence_ref ${surface.ref} usage=cite_or_handoff object_type=${type} chars=${Math.max(0, Number(sizeChars) || 0)}${noteText ? ` note="${noteText}"` : ""}]`;
}

export function renderTraversalRefStub({
  ref,
  kind = "continuation",
  objectType = "tool_result.continuation",
  sizeChars = 0,
  note = "",
} = {}) {
  const surface = traversalRefSurface(ref, { kind });
  if (!surface) return "";
  const type = boundedText(objectType, 80).replace(/[^0-9A-Za-z_.:-]+/g, "_") || "tool_result.continuation";
  const noteText = boundedText(note, 140);
  return `\n\n[traversal_ref ${surface.ref} usage=fetch_missing_content kind=${boundedText(kind, 40) || "continuation"} object_type=${type} chars=${Math.max(0, Number(sizeChars) || 0)}${noteText ? ` note="${noteText}"` : ""}]`;
}

export function stripHashRefSurfaceSuffix(value) {
  let stripped = String(value ?? "");
  while (HASH_REF_SURFACE_SUFFIX_RE.test(stripped)) {
    stripped = stripped.replace(HASH_REF_SURFACE_SUFFIX_RE, "");
  }
  return stripped;
}

export function hashRefSurfaceInput(args = {}) {
  const canonical = args.traversal_refs
    ?? args.traversalRefs
    ?? args.traversal_ref
    ?? args.traversalRef
    ?? null;
  return {
    value: canonical ?? args.refs ?? args.hashes ?? args.ref ?? args.hash ?? null,
    requested_capability: canonical != null ? HASH_REF_SURFACE_KINDS.TRAVERSAL : "legacy",
  };
}
