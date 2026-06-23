// @ts-check
//
// ATLAS v2 source-stat helpers. Pure functions that build and compare the
// per-path source stat rows (size + mtime + content hash) used by the boot
// freshness scan and the per-path indexing pipeline. No instance state — they
// operate purely on their arguments.

/**
 * @param {import("fs").Stats | null | undefined} stat
 * @returns {number}
 */
export function mtimeEpochMs(stat) {
  return Math.max(0, Math.round(Number(stat?.mtimeMs || 0)));
}

/**
 * @param {{ branch: string, repo_rel_path: string, content_hash: string, stat: import("fs").Stats | null | undefined }} args
 */
export function sourceStatRecord({ branch, repo_rel_path, content_hash, stat }) {
  return {
    branch,
    repo_rel_path,
    content_hash,
    size_bytes: Math.max(0, Number(stat?.size || 0)),
    mtime_epoch_ms: mtimeEpochMs(stat),
    indexed_at_epoch_ms: Date.now(),
  };
}

/**
 * @param {any} stored
 * @param {import("fs").Stats} stat
 * @param {string} expectedHash
 * @returns {boolean}
 */
export function sourceStatMatches(stored, stat, expectedHash) {
  if (!stored || !expectedHash) return false;
  return String(stored.content_hash || "") === expectedHash
    && Number(stored.size_bytes) === Number(stat.size)
    && Number(stored.mtime_epoch_ms) === mtimeEpochMs(stat);
}
