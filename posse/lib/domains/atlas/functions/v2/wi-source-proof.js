// @ts-check
import fs from "node:fs";
import path from "node:path";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { ledgerBranchForWi } from "./runtime-paths.js";

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

/** Verify that a post-commit refresh reads this repository's WI checkout. */
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
  const dirty = String(await gitExecAsync(["status", "--porcelain", "--untracked-files=no"], source)).trim();
  if (head !== commitSha || dirty) throw new Error("WI refresh source no longer matches the clean committed revision");
  return source;
}

/** Include the whole tracked snapshot, not a capped last-commit path hint. */
export async function wiTrackedPaths(worktreePath) {
  return String(await gitExecAsync(["ls-files", "-z"], worktreePath)).split("\0").filter(Boolean);
}
