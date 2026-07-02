// lib/domains/git/functions/worktree-path.js
//
// Worktree path/branch resolution helpers: branch existence + current-branch
// lookups, git top-level resolution, nested-project subpath detection, and the
// native worktree root/path/findLegacy addressing entrypoints.

import path from "path";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { Repo, Worktree } from "../classes/index.js";
import { gitExecAsync } from "./utils.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";
import { logSuppressedGitFailure } from "./worktree-internal.js";

export function gitBranchExists(branchName, cwd) {
  return new Repo(cwd).branchExists(branchName);
}

export function gitBranchExistsAsync(branchName, cwd, options = {}) {
  return new Repo(cwd).branchExistsAsync(branchName, options);
}

export function gitCurrentBranchAsync(cwd, options = {}) {
  return Worktree.at(cwd, cwd).currentBranchAsync(options);
}

export async function gitTopLevelAsync(cwd, options = {}) {
  try {
    return path.resolve(await gitExecAsync(["rev-parse", "--show-toplevel"], cwd, options));
  } catch (err) {
    logSuppressedGitFailure("git top-level resolution", err, { cwd });
    return path.resolve(cwd);
  }
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

// Shared request builders: method string + payload normalization live once so
// the sync/async executor twins cannot drift on what they send.
function worktreePathRequest(projectDir, wiId) {
  return ["git.worktree.path", { projectDir: path.resolve(projectDir), wiId: String(wiId) }];
}

function findLegacyWorktreeRequest(projectDir, wiId) {
  return ["git.worktree.findLegacy", { projectDir: path.resolve(projectDir), wiId: String(wiId) }];
}

export function worktreePath(projectDir, wiId, _wiTitle = null, nativeParity = {}) {
  const [method, payload] = worktreePathRequest(projectDir, wiId);
  return runGitNativeMethod(method, payload, nativeParity);
}

export function findLegacyWorktreeForWi(projectDir, wiId, nativeParity = {}) {
  const [method, payload] = findLegacyWorktreeRequest(projectDir, wiId);
  return runGitNativeMethod(method, payload, nativeParity);
}

// Async twins for main-thread call sites (e.g. the TUI diff-review builder): the
// native git call runs off the event loop so a render frame never blocks on a
// per-call posse-git spawn.
export function worktreePathAsync(projectDir, wiId, _wiTitle = null, options = {}) {
  const [method, payload] = worktreePathRequest(projectDir, wiId);
  return runGitNativeMethodAsync(method, payload, options);
}

export function findLegacyWorktreeForWiAsync(projectDir, wiId, options = {}) {
  const [method, payload] = findLegacyWorktreeRequest(projectDir, wiId);
  return runGitNativeMethodAsync(method, payload, options);
}
