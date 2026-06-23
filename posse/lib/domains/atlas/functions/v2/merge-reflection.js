// @ts-check
//
// ATLAS v2 merge-reflection helper. Pure predicate that decides whether a WI
// branch's merge has already been reflected onto the destination branch — used
// to treat a replay error as idempotent success when a post-commit hook beat
// the warm job to it. Reads only the ledger handle threaded in by the caller.

/** @typedef {import("../../classes/v2/Ledger.js").Ledger} Ledger */

/**
 * @param {{ ledger: Ledger, branch: string, ontoBranch: string, fromSeq: number }} args
 * @returns {boolean}
 */
export function isMergeAlreadyReflected({ ledger, branch, ontoBranch, fromSeq }) {
  const source = ledger.tail(branch, fromSeq);
  const destHead = ledger.headSeq(ontoBranch);
  const destPaths = ledger.pathSnapshotAt(ontoBranch, destHead);
  /** @type {Map<string, string | null>} */
  const expected = new Map();
  for (const entry of source) {
    expected.set(entry.repo_rel_path, entry.after_content_hash ?? null);
  }
  for (const [repoRelPath, expectedAfter] of expected.entries()) {
    const current = destPaths.get(repoRelPath) ?? null;
    if (current !== expectedAfter) return false;
  }
  return source.length > 0;
}
