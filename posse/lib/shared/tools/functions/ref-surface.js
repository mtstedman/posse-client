import { normalizeHashRefAlias } from "../../../catalog/hash-store.js";

export const HASH_REF_SURFACE_KINDS = Object.freeze({
  EVIDENCE: "evidence",
  TRAVERSAL: "traversal",
});

const HASH_REF_SURFACE_SUFFIX_RE = /\n+\[(?:ref_hash|evidence_ref|traversal_ref) [^\n]*\]\s*$/i;

function normalizedRef(value) {
  return normalizeHashRefAlias(value);
}

export function evidenceRefSurface(ref, _options = {}) {
  const normalized = normalizedRef(ref);
  if (!normalized) return null;
  return { ref: normalized };
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
    kind: String(kind || "continuation"),
    ...(offset != null && Number.isFinite(Number(offset)) ? { offset: Math.max(0, Number(offset)) } : {}),
    ...(limit != null && Number.isFinite(Number(limit)) ? { limit: Math.max(1, Number(limit)) } : {}),
    ...(search ? { search: String(search) } : {}),
    ...(searchMode ? { search_mode: String(searchMode) } : {}),
    ...(ranks ? { ranks: String(ranks) } : {}),
    ...(count != null && Number.isFinite(Number(count)) ? { count: Math.max(0, Number(count)) } : {}),
  };
}

export function renderEvidenceRefStub({ ref } = {}) {
  const surface = evidenceRefSurface(ref);
  if (!surface) return "";
  return `\n\n[evidence_ref ${surface.ref}]`;
}

export function renderTraversalRefStub({ ref, kind = "continuation", sizeChars = null } = {}) {
  const surface = traversalRefSurface(ref, { kind });
  if (!surface) return "";
  const size = sizeChars != null && Number.isFinite(Number(sizeChars))
    ? ` chars=${Math.max(0, Number(sizeChars))}`
    : "";
  return `\n\n[traversal_ref ${surface.ref} kind=${String(kind || "continuation").replace(/[^0-9A-Za-z_.:-]+/g, "_")}${size}]`;
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
