// @ts-check
import fs from "node:fs";
import path from "node:path";
import { gitExecAsync, gitExecBufferAsync } from "../../../git/functions/utils.js";
import { ledgerBranchForWi } from "./runtime-paths.js";

const WI_COMMIT_TREE_MAX_BUFFER = 64 * 1024 * 1024;

/** Reconcile a mounted WI from its checkout, never from the storage root. */
export async function reconcileWiSource({ repoRoot, worktreePath, workItemId, ledgerPath, viewPath, config, warm, signal = null }) {
  signal?.throwIfAborted();
  const commitSha = String(await gitExecAsync(["rev-parse", "HEAD"], worktreePath, { signal })).trim();
  await verifyWiSource({ repoRoot, worktreePath, commitSha, signal });
  const branch = ledgerBranchForWi(workItemId);
  const result = await warm({
    repoRoot, ledgerPath, dbPath: viewPath, branch, config,
    job: {
      purpose: "wi", branch, work_item_id: workItemId,
      worktree_path: worktreePath, commit_sha: commitSha,
      out_view_path: viewPath,
    },
  }, { signal });
  signal?.throwIfAborted();
  if (result?.wi_source_verified !== true) {
    throw new Error(`WI source reconciliation failed: ${JSON.stringify(result?.skipped || [])}`);
  }
  await verifyWiSource({ repoRoot, worktreePath, commitSha, signal });
  return result;
}

/**
 * Verify that a post-commit refresh reads this repository's WI checkout and
 * that its HEAD is the committed revision or a descendant of it (a sibling
 * job sharing the WI worktree may commit right after this one). Returns the
 * checkout and HEAD; the refresh indexes HEAD's committed bytes, so
 * serialized refreshes of one WI branch only ever move its ledger forward.
 * Working-tree dirt is not checked here: the refresh reads committed bytes
 * (see wiPathsDifferingFromCommit and materializeWiCommitPaths), because jobs
 * sharing a WI worktree leave each other's in-progress edits in it.
 *
 * @returns {Promise<{ sourceRoot: string, head: string }>}
 */
export async function verifyWiSource({ repoRoot, worktreePath, commitSha, signal = null }) {
  signal?.throwIfAborted();
  if (!worktreePath || !/^[0-9a-f]{40,64}$/u.test(String(commitSha || ""))) {
    throw new Error("WI refresh requires a worktree path and exact commit SHA");
  }
  const root = fs.realpathSync(repoRoot);
  const source = fs.realpathSync(worktreePath);
  if (root === source) throw new Error("WI refresh cannot index the trunk checkout");
  const commonDir = async (cwd) => fs.realpathSync(path.resolve(cwd,
    String(await gitExecAsync(["rev-parse", "--git-common-dir"], cwd, { signal })).trim()));
  if (await commonDir(root) !== await commonDir(source)) {
    throw new Error("WI refresh worktree belongs to a different repository");
  }
  const head = String(await gitExecAsync(["rev-parse", "HEAD"], source, { signal })).trim();
  if (head !== commitSha && !(await isAncestorCommit(source, commitSha, head, signal))) {
    throw new Error("WI refresh source no longer contains the committed revision");
  }
  signal?.throwIfAborted();
  return { sourceRoot: source, head };
}

async function isAncestorCommit(cwd, ancestor, descendant, signal) {
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", ancestor, descendant], cwd, { signal });
    return true;
  } catch {
    signal?.throwIfAborted();
    // Not an ancestor, or unresolvable: fail closed.
    return false;
  }
}

/**
 * The commit's whole tracked snapshot under `worktreePath` (not the index,
 * which can hold a sibling job's staged work), as path -> tree entry. Paths are
 * relative to `worktreePath`, the Atlas path space: for a project nested in its
 * repository that is the project directory, and git's repository-relative
 * names would match nothing in the ledger.
 *
 * @param {string} worktreePath
 * @param {string} commitSha
 * @returns {Promise<Map<string, { mode: string, type: string, oid: string }>>}
 */
export async function wiCommitTree(worktreePath, commitSha) {
  const listing = String(await gitExecAsync(["ls-tree", "-r", "-z", commitSha], worktreePath, {
    maxBuffer: WI_COMMIT_TREE_MAX_BUFFER,
  }));
  const entries = new Map();
  for (const record of listing.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).trim().split(" ");
    entries.set(record.slice(tab + 1), { mode, type, oid });
  }
  return entries;
}

/**
 * Paths whose working-tree bytes differ from the commit, e.g. a sibling job's
 * staged or unstaged edits in the shared WI worktree, relative to
 * `worktreePath` like wiCommitTree.
 *
 * @param {string} worktreePath
 * @param {string} commitSha
 * @returns {Promise<Set<string>>}
 */
export async function wiPathsDifferingFromCommit(worktreePath, commitSha) {
  const out = await gitExecAsync(["diff", "--relative", "--name-only", "--no-renames", "--no-color", "-z", commitSha, "--"], worktreePath);
  return new Set(String(out).split("\0").filter(Boolean));
}

/**
 * Paths under `worktreePath` deleted from `commitSha`'s parent (none for a
 * root commit) to `head`; a rename counts as a deletion of its old name.
 *
 * @param {string} worktreePath
 * @param {string} commitSha
 * @param {string} head
 * @returns {Promise<string[]>}
 */
export async function wiCommitDeletedPaths(worktreePath, commitSha, head) {
  let base = commitSha;
  try {
    base = String(await gitExecAsync(["rev-parse", "--verify", "--quiet", `${commitSha}^`], worktreePath)).trim() || commitSha;
  } catch {
    // A root commit has no parent; it deletes nothing itself.
  }
  const out = await gitExecAsync([
    "diff", "--relative", "--name-only", "--no-renames", "--no-color", "-z", "--diff-filter=D", base, head, "--",
  ], worktreePath, { trim: false });
  return String(out).split("\0").filter(Boolean);
}

const HISTORY_DELETION_SAMPLE = 64;

/** True when some commit reachable from `head` deleted one of `paths` (relative to `worktreePath`). */
async function wiHistoryDeletesAny(worktreePath, head, paths) {
  const sample = paths.slice(0, HISTORY_DELETION_SAMPLE);
  if (sample.length === 0) return false;
  try {
    const out = await gitExecAsync([
      "log", "-1", "--no-renames", "--diff-filter=D", "--format=%H", head, "--",
      ...sample.map((repoRelPath) => `:(literal)${repoRelPath}`),
    ], worktreePath);
    return String(out).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Refuse a refresh that would drop more of the WI's indexed paths than it
 * keeps when the indexed commits delete nothing. A real change does not do
 * that; a commit listing in a different path space from the ledger does
 * (sweep 5 A1: repository-relative names against a project-relative ledger
 * removed every path and mounted an empty view as verified). Paths still live
 * in the checkout (untracked or edited) are restored by the live overlay, so
 * they are not drops.
 *
 * @param {{ worktreePath: string, commitSha: string, head: string,
 *   tree: Map<string, unknown>, snapshot: Map<string, unknown> }} args
 */
export async function assertWiRefreshKeepsSource({ worktreePath, commitSha, head, tree, snapshot }) {
  const absent = [...snapshot.keys()].filter((repoRelPath) => !tree.has(repoRelPath));
  const kept = snapshot.size - absent.length;
  if (absent.length <= kept) return;
  const live = new Set(await wiLivePaths(worktreePath, head));
  const dropped = absent.filter((repoRelPath) => !live.has(repoRelPath));
  if (dropped.length <= kept) return;
  if ((await wiCommitDeletedPaths(worktreePath, commitSha, head)).length > 0) return;
  // The ledger can predate commitSha's parent (coalesced warms keep only the
  // newest commit; an earlier refresh may have failed), so an earlier commit
  // that deleted a dropped path also explains the drop.
  if (await wiHistoryDeletesAny(worktreePath, head, dropped)) return;
  throw new Error(`WI source refresh would drop ${dropped.length} of ${snapshot.size} indexed paths `
    + `(first: ${dropped[0]}) and keep ${kept}, but ${String(commitSha).slice(0, 12)}..${String(head).slice(0, 12)} `
    + "deletes none; refusing to publish the WI view");
}

/**
 * Write the committed state of `paths` under `overlayRoot` from the object
 * store so the refresh reads the commit's bytes instead of the working tree.
 * Returns repo-relative path -> overlay path, or null when the commit has no
 * such path (the refresh then records it as removed).
 *
 * @param {{ worktreePath: string, tree: Map<string, { mode: string, type: string, oid: string }>, paths: string[], overlayRoot: string }} args
 * @returns {Promise<Map<string, string | null>>}
 */
export async function materializeWiCommitPaths({ worktreePath, tree, paths, overlayRoot }) {
  /** @type {Map<string, string | null>} */
  const sources = new Map();
  for (const repoRelPath of paths) {
    const entry = tree.get(repoRelPath);
    if (!entry) {
      sources.set(repoRelPath, null);
      continue;
    }
    const overlayPath = path.join(overlayRoot, repoRelPath);
    await fs.promises.mkdir(path.dirname(overlayPath), { recursive: true });
    if (entry.type === "blob") {
      const size = Number(String(await gitExecAsync(["cat-file", "-s", entry.oid], worktreePath)).trim()) || 0;
      const bytes = await gitExecBufferAsync(["cat-file", "blob", entry.oid], worktreePath, { maxBuffer: size + 1024 });
      if (entry.mode === "120000") await fs.promises.symlink(bytes.toString("utf8"), overlayPath);
      else await fs.promises.writeFile(overlayPath, bytes);
    } else {
      await fs.promises.mkdir(overlayPath, { recursive: true });
    }
    sources.set(repoRelPath, overlayPath);
  }
  return sources;
}

/** Include new untracked source files as well as tracked edits/deletions. */
export async function wiLivePaths(worktreePath, commitSha) {
  const paths = await wiPathsDifferingFromCommit(worktreePath, commitSha);
  const untracked = await gitExecAsync(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath);
  for (const file of String(untracked).split("\0").filter(Boolean)) paths.add(file);
  return [...paths];
}
