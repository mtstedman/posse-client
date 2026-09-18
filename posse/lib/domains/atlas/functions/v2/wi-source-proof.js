// @ts-check
import fs from "node:fs";
import path from "node:path";
import { gitExecAsync } from "../../../git/functions/utils.js";

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
