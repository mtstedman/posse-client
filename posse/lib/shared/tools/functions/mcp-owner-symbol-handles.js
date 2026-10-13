import { normalizedOwnerSourcePath } from "./mcp-owner-evidence.js";

const ATLAS_SYMBOL_HANDLE_PATTERN = /^s[1-9][0-9]{0,5}$/;

export const ATLAS_CANONICAL_SYMBOL_ID_PATTERN = /^[0-9a-f]{64}:[0-9]+$/;

function atlasSymbolHandleState(session) {
  if (!session?._atlasSymbolHandles) {
    session._atlasSymbolHandles = {
      next: 1,
      byHandle: new Map(),
      bySymbolId: new Map(),
      sourcePathBySymbolId: new Map(),
    };
  }
  if (!(session._atlasSymbolHandles.sourcePathBySymbolId instanceof Map)) {
    session._atlasSymbolHandles.sourcePathBySymbolId = new Map();
  }
  return session._atlasSymbolHandles;
}

export function rememberAtlasSymbolSourcePaths(session, mappings = []) {
  if (!session || !Array.isArray(mappings) || mappings.length === 0) return;
  const state = atlasSymbolHandleState(session);
  for (const mapping of mappings) {
    const symbolId = String(mapping?.symbol_id || "").trim().toLowerCase();
    const sourcePath = normalizedOwnerSourcePath(mapping?.repo_rel_path);
    if (!ATLAS_CANONICAL_SYMBOL_ID_PATTERN.test(symbolId) || !sourcePath) continue;
    state.sourcePathBySymbolId.set(symbolId, sourcePath);
  }
  while (state.sourcePathBySymbolId.size > 2048) {
    state.sourcePathBySymbolId.delete(state.sourcePathBySymbolId.keys().next().value);
  }
}

export function atlasSymbolSourcePath(session, symbolId) {
  const wanted = String(symbolId || "").trim().toLowerCase();
  if (!ATLAS_CANONICAL_SYMBOL_ID_PATTERN.test(wanted)) return null;
  return session?._atlasSymbolHandles?.sourcePathBySymbolId?.get(wanted) || null;
}

export function atlasSymbolHandleForId(session, symbolId) {
  if (!session || !ATLAS_CANONICAL_SYMBOL_ID_PATTERN.test(String(symbolId || ""))) return null;
  const state = atlasSymbolHandleState(session);
  const prior = state.bySymbolId.get(symbolId);
  if (prior) return prior;
  if (state.next > 999999) return null;
  const handle = `s${state.next}`;
  state.next += 1;
  state.byHandle.set(handle, symbolId);
  state.bySymbolId.set(symbolId, handle);
  return handle;
}

export function resolveAtlasSymbolHandle(session, value) {
  const symbolId = String(value || "");
  if (ATLAS_SYMBOL_HANDLE_PATTERN.test(symbolId)) {
    const resolved = session?._atlasSymbolHandles?.byHandle?.get(symbolId) || null;
    return resolved
      ? { ok: true, value: resolved }
      : { ok: false, handle: symbolId };
  }
  if (ATLAS_CANONICAL_SYMBOL_ID_PATTERN.test(symbolId)) return { ok: true, value };
  // Provider transports have occasionally dropped one character from a copied
  // opaque ID. Repair only from this session's already-surfaced canonical IDs,
  // only for a long prefix plus the exact local-id suffix, and only when the
  // match is unique. This is deterministic handle recovery, not ID guessing.
  const truncated = symbolId.match(/^([0-9a-f]{16,63}):(\d+)$/u);
  if (truncated) {
    const prefix = `${truncated[1]}`;
    const suffix = `:${truncated[2]}`;
    const matches = [...(session?._atlasSymbolHandles?.bySymbolId?.keys?.() || [])]
      .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix));
    if (matches.length === 1) return { ok: true, value: matches[0], repaired: true };
  }
  return { ok: true, value };
}

export function __testRememberAtlasSymbolSourcePaths(session, mappings = []) {
  rememberAtlasSymbolSourcePaths(session, mappings);
}
