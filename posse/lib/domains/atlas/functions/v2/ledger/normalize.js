// @ts-check
//
// Stateless, cross-domain helpers shared by the ATLAS v2 Ledger wireframe and
// its domain stores (FeedbackStore, BlobStore, …). No DB handle, no state.

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Inline parser for SymbolId strings ("<content_hash>:<local_id>"). The
 * retrieval layer has its own parseSymbolId, but the Ledger lives below
 * that layer and we don't want a back-edge import — duplicating the tiny
 * parse keeps the dependency arrow pointing the right way.
 *
 * @param {unknown} id
 * @returns {{ content_hash: string, local_id: number } | null}
 */
export function parseSymbolIdString(id) {
  if (typeof id !== "string") return null;
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) return null;
  const ch = id.slice(0, idx);
  const lid = Number(id.slice(idx + 1));
  if (!/^[0-9a-f]{64}$/.test(ch) || !Number.isInteger(lid) || lid < 0) return null;
  return { content_hash: ch, local_id: lid };
}
