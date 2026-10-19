// @ts-check
//
// ATLAS v2 merge-reflection helper. Pure predicate that decides whether a WI
// branch's merge has already been reflected onto the destination branch — used
// to treat a replay error as idempotent success when a post-commit hook beat
// the warm job to it. Reads only the ledger handle threaded in by the caller.

import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./hash.js";
import { wiCommitTree } from "./wi-source-proof.js";
import { gitExecBufferAsync } from "../../../git/functions/utils.js";
import { MAX_PARSE_FILE_BYTES } from "./parser/index-filters.js";

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

/**
 * A changed-path main refresh may reflect only part of a WI before its replay.
 * Recover only untouched baseline paths, with their final bytes proven against
 * the clean destination checkout. A divergent destination or source fails
 * closed; this never resolves a real merge conflict by choosing a side.
 *
 * @param {{ ledger: Ledger, branch: string, ontoBranch: string, fromSeq: number,
 *   sourceProof: any, repoRoot: string }} args
 * @returns {Promise<string[]>}
 */
export async function partiallyReflectedMergePaths({ ledger, branch, ontoBranch, fromSeq, sourceProof, repoRoot }) {
  if (sourceProof?.ok !== true || sourceProof.target_branch !== ontoBranch
    || !/^[0-9a-f]{40,64}$/u.test(String(sourceProof.git_oid || ""))) return [];
  const source = ledger.tail(branch, fromSeq);
  const destPaths = ledger.pathSnapshotAt(ontoBranch, ledger.headSeq(ontoBranch));
  const changes = new Map();
  for (const entry of source) {
    const prior = changes.get(entry.repo_rel_path);
    changes.set(entry.repo_rel_path, {
      before: prior ? prior.before : entry.before_content_hash ?? null,
      after: entry.after_content_hash ?? null,
    });
  }
  const pending = [];
  let reflected = false;
  for (const [repoRelPath, change] of changes) {
    const current = destPaths.get(repoRelPath) ?? null;
    if (current === change.after) { reflected = true; continue; }
    if (current !== change.before) return [];
    pending.push({ path: repoRelPath, after: change.after });
  }
  if (!reflected || pending.length === 0) return [];
  return await mergePathsMatchSource({ changes, ontoBranch, sourceProof, repoRoot })
    ? pending.map((entry) => entry.path) : [];
}

/** Verify the final state of every affected path against the exact main source. */
export async function isMergeReflectedInSource({ ledger, branch, fromSeq, ontoBranch, sourceProof, repoRoot }) {
  const changes = new Map(ledger.tail(branch, fromSeq).map((entry) => [
    entry.repo_rel_path, { after: entry.after_content_hash ?? null },
  ]));
  return mergePathsMatchSource({ changes, ontoBranch, sourceProof, repoRoot });
}

async function mergePathsMatchSource({ changes, ontoBranch, sourceProof, repoRoot }) {
  if (sourceProof?.ok !== true || sourceProof.target_branch !== ontoBranch
    || !/^[0-9a-f]{40,64}$/u.test(String(sourceProof.git_oid || ""))) return false;
  // Prove every final path, including paths already reflected in the ledger:
  // agreement between two ledger branches does not prove the target commit.
  // A clean checkout can still contain ignored files, so verify Git too.
  const tree = await wiCommitTree(repoRoot, sourceProof.git_oid);
  for (const [repoRelPath, change] of changes) {
    const entry = { path: repoRelPath, after: change.after };
    const file = path.resolve(repoRoot, entry.path);
    const relative = path.relative(repoRoot, file);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return false;
    try {
      const committed = tree.get(entry.path);
      if (entry.after === null) {
        if (committed) return false;
        await fs.promises.lstat(file);
        return false;
      }
      if (!committed || committed.type !== "blob" || !["100644", "100755"].includes(committed.mode)) return false;
      const bytes = await gitExecBufferAsync(["cat-file", "blob", committed.oid], repoRoot, { maxBuffer: MAX_PARSE_FILE_BYTES + 1024 });
      if (sha256Hex(bytes) !== entry.after || !(await fs.promises.lstat(file)).isFile()
        || sha256Hex(await fs.promises.readFile(file)) !== entry.after) return false;
    } catch (error) {
      if (entry.after !== null || error?.code !== "ENOENT") return false;
    }
  }
  return true;
}
