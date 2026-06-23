// @ts-check
//
// ATLAS v2 embeddings stale-tracking helpers. Pure functions that operate on
// the passed-in warm-job result object (collecting content hashes whose
// embeddings are now stale) and on the embedding index (pruning stale /
// orphaned vectors). They hold no instance state — `base`, `view`, and `index`
// are all threaded in by the caller.

/** @typedef {import("../contracts/jobs.js").AtlasWarmJobResult} AtlasWarmJobResult */
/** @typedef {import("../../../classes/v2/View.js").View} View */

/**
 * @param {AtlasWarmJobResult} base
 * @param {unknown} contentHash
 */
export function recordStaleEmbeddingHash(base, contentHash) {
  const hash = String(contentHash || "").trim();
  if (!hash) return;
  const target = /** @type {any} */ (base);
  if (!Array.isArray(target._staleEmbeddingHashes)) target._staleEmbeddingHashes = [];
  target._staleEmbeddingHashes.push(hash);
}

/**
 * @param {AtlasWarmJobResult} base
 * @returns {string[]}
 */
export function staleEmbeddingHashes(base) {
  const values = /** @type {any} */ (base)._staleEmbeddingHashes;
  return Array.isArray(values) ? [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))] : [];
}

/**
 * @param {{ base: AtlasWarmJobResult, index: any }} args
 * @returns {Promise<void>}
 */
export async function pruneStaleEmbeddingHashes({ base, index }) {
  const hashes = staleEmbeddingHashes(base);
  if (hashes.length === 0 || typeof index?.removeByContentHash !== "function") return;
  const removed = await index.removeByContentHash(hashes);
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_pruned = Number(removed);
  }
}

/**
 * @param {{ base: AtlasWarmJobResult, view: View, index: any }} args
 * @returns {Promise<void>}
 */
export async function pruneEmbeddingIndexToCurrentView({ base, view, index }) {
  if (!view || typeof index?.pruneToKeys !== "function") return;
  const symbols = view.query.allSymbols({ limit: 100_000 });
  const removed = await index.pruneToKeys(symbols.map((symbol) => ({
    content_hash: symbol.content_hash,
    local_id: symbol.local_id,
  })));
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_orphans_pruned = Number(removed);
  }
}
