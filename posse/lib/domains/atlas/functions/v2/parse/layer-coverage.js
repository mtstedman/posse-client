// @ts-check
import path from "node:path";

/** @typedef {import("../../../classes/v2/Ledger.js").Ledger} Ledger */
/** @typedef {import("../contracts/jobs.js").AtlasWarmJobResult} AtlasWarmJobResult */

/**
 * @param {Ledger} ledger
 * @param {string} contentHash
 * @param {{ layerMerge?: boolean }} [options]
 * @returns {boolean}
 */
export function ledgerHasCurrentParsedBlob(ledger, contentHash, options = {}) {
  if (options.layerMerge === true && typeof /** @type {any} */ (ledger).hasCurrentTreeSitterLayer === "function") {
    return /** @type {any} */ (ledger).hasCurrentTreeSitterLayer(contentHash);
  }
  if (typeof /** @type {any} */ (ledger).hasCurrentParsedBlob === "function") {
    return /** @type {any} */ (ledger).hasCurrentParsedBlob(contentHash);
  }
  return typeof ledger.hasBlob === "function" ? ledger.hasBlob(contentHash) : false;
}

/**
 * A recoverable Tree-sitter gap is complete when SCIP durably indexed the
 * exact same immutable content hash. Keep the parser diagnostics on the warm
 * result, but remove those paths from `skipped`: callers use that list as the
 * fail-closed publication boundary, and the merged A+B view is complete for
 * these documents even though one source layer is partial or empty.
 *
 * @param {Ledger} ledger
 * @param {AtlasWarmJobResult} base
 * @param {Map<string, { contentHash: string, lang: string }>} parseGaps
 */
export function reconcileScipCoveredParseGaps(ledger, base, parseGaps) {
  if (!(parseGaps instanceof Map) || parseGaps.size === 0) return;
  const coveredPaths = [];
  for (const [repoRelPath, gap] of parseGaps.entries()) {
    let covered = false;
    try {
      covered = ledger.listBlobLayers(gap.contentHash).some((layer) => (
        layer?.source === "scip"
        && layer?.status === "indexed"
        && String(layer?.lang || "").toLowerCase() === gap.lang
      ));
    } catch {
      covered = false;
    }
    if (covered) coveredPaths.push(repoRelPath);
  }
  if (coveredPaths.length === 0) return;
  const covered = new Set(coveredPaths);
  base.skipped = base.skipped.filter((row) => !(
    row?.reason === "parse_error" && covered.has(String(row?.repo_rel_path || ""))
  ));
  /** @type {any} */ (base).scip_covered_parse_gaps = coveredPaths.length;
  /** @type {any} */ (base).scip_covered_parse_gap_paths = coveredPaths;
}

/**
 * SCIP runs before tree-sitter during warmup. Some SCIP indexers, notably the
 * PHP indexer, omit procedural declarations while still marking the blob as
 * parsed. Let tree-sitter merge in its symbol rows for those blobs instead of
 * skipping them as already current.
 *
 * @param {{ ledger: Ledger, contentHash: string | null, repoRelPath: string }} args
 * @returns {boolean}
 */
export function shouldMergeTreeSitterRowsForScipBlob({ ledger, contentHash, repoRelPath }) {
  if (!contentHash || path.extname(repoRelPath).toLowerCase() !== ".php") return false;
  const db = typeof /** @type {any} */ (ledger)._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  if (!db) return false;
  try {
    const rows = /** @type {Array<{ source: string, cnt: number }>} */ (
      db.prepare(
        `SELECT source, COUNT(*) AS cnt
         FROM (
           SELECT source FROM blob_symbols WHERE content_hash = ?
           UNION ALL
           SELECT source FROM blob_edges WHERE from_content_hash = ?
         )
         GROUP BY source`,
      ).all(contentHash, contentHash)
    );
    const hasScip = rows.some((row) => row.source === "scip" && Number(row.cnt || 0) > 0);
    const hasTreeSitter = rows.some((row) => row.source === "treesitter" && Number(row.cnt || 0) > 0);
    return hasScip && !hasTreeSitter;
  } catch {
    return false;
  }
}
