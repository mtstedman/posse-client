// lib/domains/git/functions/worktree-path.js
//
// Worktree path/branch resolution helpers: branch existence + current-branch
// lookups, git top-level resolution, nested-project subpath detection, and the
// native worktree root/path/findLegacy addressing entrypoints.

import path from "path";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { Repo, Worktree } from "../classes/index.js";
import { gitExec, gitExecAsync } from "./utils.js";
import { runGitNativeMethod } from "./native/invoke.js";
import { logSuppressedGitFailure } from "./worktree-internal.js";

export function gitBranchExists(branchName, cwd) {
  return new Repo(cwd).branchExists(branchName);
}

export function gitBranchExistsAsync(branchName, cwd, options = {}) {
  return new Repo(cwd).branchExistsAsync(branchName, options);
}

export function gitCurrentBranch(cwd, nativeParity = {}) {
  return Worktree.at(cwd, cwd).currentBranch(nativeParity);
}

export function gitCurrentBranchAsync(cwd, options = {}) {
  return Worktree.at(cwd, cwd).currentBranchAsync(options);
}

export function gitTopLevel(cwd) {
  try {
    return path.resolve(gitExec(["rev-parse", "--show-toplevel"], cwd));
  } catch (err) {
    logSuppressedGitFailure("git top-level resolution", err, { cwd });
    return path.resolve(cwd);
  }
}

export async function gitTopLevelAsync(cwd, options = {}) {
  try {
    return path.resolve(await gitExecAsync(["rev-parse", "--show-toplevel"], cwd, options));
  } catch (err) {
    logSuppressedGitFailure("git top-level resolution", err, { cwd });
    return path.resolve(cwd);
  }
}

export function nestedProjectSubpath(projectDir) {
  const projectRoot = path.resolve(projectDir);
  const repoRoot = gitTopLevel(projectDir);
  const rel = path.relative(repoRoot, projectRoot);
  if (!rel || rel === "") return null;
  if (!isInsideRoot(projectRoot, repoRoot, { allowEqual: false, followSymlinks: false })) return null;
  return rel.replace(/\\/g, "/");
}

export async function nestedProjectSubpathAsync(projectDir, options = {}) {
  const projectRoot = path.resolve(projectDir);
  const repoRoot = await gitTopLevelAsync(projectDir, options);
  const rel = path.relative(repoRoot, projectRoot);
  if (!rel || rel === "") return null;
  if (!isInsideRoot(projectRoot, repoRoot, { allowEqual: false, followSymlinks: false })) return null;
  return rel.replace(/\\/g, "/");
}

export function worktreeRoot(projectDir, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.root",
    { projectDir: path.resolve(projectDir), create: true },
    nativeParity,
  );
}

export function worktreePath(projectDir, wiId, _wiTitle = null, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.path",
    { projectDir: path.resolve(projectDir), wiId: String(wiId) },
    nativeParity,
  );
}

export function findLegacyWorktreeForWi(projectDir, wiId, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.findLegacy",
    { projectDir: path.resolve(projectDir), wiId: String(wiId) },
    nativeParity,
  );
}
