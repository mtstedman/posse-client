// @ts-check
import fs from "node:fs";
import path from "node:path";
import { gitExecAsync, gitExecBufferAsync } from "../../../git/functions/utils.js";
import { ledgerBranchForWi } from "./runtime-paths.js";

const WI_COMMIT_TREE_MAX_BUFFER = 64 * 1024 * 1024;

/** Reconcile a mounted WI from its checkout, never from the storage root. */
export async function reconcileWiSource({ repoRoot, worktreePath, workItemId, ledgerPath, viewPath, config, warm }) {
  const commitSha = String(await gitExecAsync(["rev-parse", "HEAD"], worktreePath)).trim();
  await verifyWiSource({ repoRoot, worktreePath, commitSha });
  const branch = ledgerBranchForWi(workItemId);
  const result = await warm({
    repoRoot, ledgerPath, dbPath: viewPath, branch, config,
    job: {
      purpose: "wi", branch, work_item_id: workItemId,
      worktree_path: worktreePath, commit_sha: commitSha,
      out_view_path: viewPath,
    },
  });
  if (result?.wi_source_verified !== true) {
    throw new Error(`WI source reconciliation failed: ${JSON.stringify(result?.skipped || [])}`);
  }
  await verifyWiSource({ repoRoot, worktreePath, commitSha });
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
export async function verifyWiSource({ repoRoot, worktreePath, commitSha }) {
  if (!worktreePath || !/^[0-9a-f]{40,64}$/u.test(String(commitSha || ""))) {
    throw new Error("WI refresh requires a worktree path and exact commit SHA");
  }
  const root = fs.realpathSync(repoRoot);
  const source = fs.realpathSync(worktreePath);
  if (root === source) throw new Error("WI refresh cannot index the trunk checkout");
  const commonDir = async (cwd) => fs.realpathSync(path.resolve(cwd,
    String(await gitExecAsync(["rev-parse", "--git-common-dir"], cwd)).trim()));
  if (await commonDir(root) !== await commonDir(source)) {
    throw new Error("WI refresh worktree belongs to a different repository");
  }
  const head = String(await gitExecAsync(["rev-parse", "HEAD"], source)).trim();
  if (head !== commitSha && !(await isAncestorCommit(source, commitSha, head))) {
    throw new Error("WI refresh source no longer contains the committed revision");
  }
  return { sourceRoot: source, head };
}

async function isAncestorCommit(cwd, ancestor, descendant) {
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", ancestor, descendant], cwd);
    return true;
  } catch {
    // Not an ancestor, or unresolvable: fail closed.
    return false;
  }
}

/**
 * The commit's whole tracked snapshot (not the index, which can hold a
 * sibling job's staged work), as repo-relative path -> tree entry.
 *
 * @param {string} worktreePath
 * @param {string} commitSha
 * @returns {Promise<Map<string, { mode: string, type: string, oid: string }>>}
 */
export async function wiCommitTree(worktreePath, commitSha) {
  const listing = String(await gitExecAsync(["ls-tree", "-r", "-z", "--full-tree", commitSha], worktreePath, {
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
 * staged or unstaged edits in the shared WI worktree.
 *
 * @param {string} worktreePath
 * @param {string} commitSha
 * @returns {Promise<Set<string>>}
 */
export async function wiPathsDifferingFromCommit(worktreePath, commitSha) {
  const out = await gitExecAsync(["diff", "--name-only", "--no-renames", "--no-color", "-z", commitSha, "--"], worktreePath);
  return new Set(String(out).split("\0").filter(Boolean));
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
