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
 * @param {{ base: AtlasWarmJobResult, index: any, hashes?: string[] | null }} args
 * @returns {Promise<void>}
 */
export async function pruneStaleEmbeddingHashes({ base, index, hashes = null }) {
  const candidates = Array.isArray(hashes) ? hashes : staleEmbeddingHashes(base);
  const unique = [...new Set(candidates.map((v) => String(v || "").trim()).filter(Boolean))];
  if (unique.length === 0 || typeof index?.removeByContentHash !== "function") return;
  const removed = await index.removeByContentHash(unique);
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_pruned = Number(removed);
  }
}

/**
 * The embedding store is REPO-GLOBAL (shared by main and every WI view), so
 * the keep-set must be the union of live views — pruning to one view's keys
 * deletes vectors the sibling views still serve and forces re-encoding.
 * `extraKeepKeys` carries the sibling views' symbol identities.
 *
 * @param {{ base: AtlasWarmJobResult, view: View, index: any, extraKeepKeys?: Array<{ content_hash: string, local_id: number }> }} args
 * @returns {Promise<void>}
 */
export const PRUNE_KEEP_SCAN_LIMIT = 100_000;

export async function pruneEmbeddingIndexToCurrentView({ base, view, index, extraKeepKeys = [] }) {
  if (!view || typeof index?.pruneToKeys !== "function") return;
  const symbols = await view.query.allSymbols({ limit: PRUNE_KEEP_SCAN_LIMIT });
  if (symbols.length >= PRUNE_KEEP_SCAN_LIMIT) {
    // The keep-set is TRUNCATED: global_id assignment shifts across full view
    // rebuilds, so pruning against a moving 100k window deletes the displaced
    // tail every rebuild and re-encodes it on the next warm, forever. Skip
    // the prune instead — unbounded growth is bounded by real symbol churn;
    // churn from a sliding window is not.
    /** @type {any} */ (base).embeddings_prune_skipped_keep_cap = symbols.length;
    return;
  }
  const keep = symbols.map((symbol) => ({
    content_hash: symbol.content_hash,
    local_id: symbol.local_id,
  }));
  for (const key of extraKeepKeys) {
    if (key && key.content_hash != null) keep.push({ content_hash: key.content_hash, local_id: key.local_id });
  }
  const removed = await index.pruneToKeys(keep);
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_orphans_pruned = Number(removed);
  }
}
