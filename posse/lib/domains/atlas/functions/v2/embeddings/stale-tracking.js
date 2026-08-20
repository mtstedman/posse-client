// @ts-check
//
// ATLAS v2 embeddings stale-tracking helpers. Pure functions that operate on
// the passed-in warm-job result object (collecting content hashes whose
// embeddings are now stale) and on the embedding index (pruning stale /
// orphaned vectors). They hold no instance state — `base`, `view`, and `index`
// are all threaded in by the caller.

import { embeddingKeysForSymbol } from "./documentation-channel.js";
import { iterateViewSymbolPages } from "../view-symbol-pages.js";

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
 * @param {{ base: AtlasWarmJobResult, index: any, hashes?: string[] | null, ledger?: any }} args
 * @returns {Promise<void>}
 */
export async function pruneStaleEmbeddingHashes({ base, index, hashes = null, ledger = null }) {
  const candidates = Array.isArray(hashes) ? hashes : staleEmbeddingHashes(base);
  const unique = [...new Set(candidates.map((v) => String(v || "").trim()).filter(Boolean))];
  if (unique.length === 0 || typeof index?.removeByContentHash !== "function") return;
  const channelHashes = [...unique];
  if (typeof ledger?.getBlobSymbols === "function") {
    for (const contentHash of unique) {
      try {
        const symbols = ledger.getBlobSymbols(contentHash);
        for (const symbol of Array.isArray(symbols) ? symbols : []) {
          const documentationKey = embeddingKeysForSymbol(symbol)
            .find((key) => key.channel === "documentation");
          if (documentationKey) channelHashes.push(documentationKey.content_hash);
        }
      } catch {
        // The ordinary source-hash prune is still safe. A documentation orphan
        // is view-filtered at read time and the next full prune removes it.
      }
    }
  }
  const removed = await index.removeByContentHash([...new Set(channelHashes)]);
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
// Keep prune requests comfortably beneath the shared native JSONL envelope.
// A repo-global index can have many warmed views, so bounding each view alone
// is insufficient: their union may still be arbitrarily large.
export const PRUNE_KEEP_REQUEST_BYTES = 48 * 1024 * 1024;

export async function pruneEmbeddingIndexToCurrentView({ base, view, index, extraKeepKeys = [] }) {
  if (!view || typeof index?.pruneToKeys !== "function") return;
  /** @type {Map<string, { content_hash: string, local_id: any }>} */
  const keep = new Map();
  let keepRequestBytes = 0;
  const addKeepKey = (key) => {
    const contentHash = String(key?.content_hash ?? "").trim();
    if (!contentHash) return true;
    const localId = key?.local_id;
    const identity = `${contentHash}\0${String(localId)}`;
    if (keep.has(identity)) return true;
    const normalized = { content_hash: contentHash, local_id: localId };
    // Match the vector wire shape closely enough to reserve ample space for
    // the worker envelope, auth pulse, method name, and JSON punctuation.
    const wireBytes = Buffer.byteLength(JSON.stringify({
      contentHash,
      localId,
    }), "utf8") + 1;
    if (keepRequestBytes + wireBytes > PRUNE_KEEP_REQUEST_BYTES) {
      /** @type {any} */ (base).embeddings_prune_skipped_keep_bytes = keepRequestBytes + wireBytes;
      return false;
    }
    keep.set(identity, normalized);
    keepRequestBytes += wireBytes;
    return true;
  };
  let symbolCount = 0;
  for await (const symbols of iterateViewSymbolPages({
    view,
    limit: PRUNE_KEEP_SCAN_LIMIT + 1,
  })) {
    symbolCount += symbols.length;
    if (symbolCount > PRUNE_KEEP_SCAN_LIMIT) {
      // Preserve the pre-existing memory guard, but use pagination metadata to
      // distinguish an actually complete keep-set from the old native 10k cap.
      /** @type {any} */ (base).embeddings_prune_skipped_keep_cap = symbolCount;
      return;
    }
    for (const symbol of symbols) {
      for (const key of embeddingKeysForSymbol(symbol)) {
        if (!addKeepKey(key)) return;
      }
    }
  }
  for (const key of extraKeepKeys) {
    if (!addKeepKey(key)) return;
  }
  const removed = await index.pruneToKeys([...keep.values()]);
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_orphans_pruned = Number(removed);
  }
}
