// lib/domains/git/functions/utils.js
//
// Shared git shell helpers for worker-side operations.

import { Repo, gitGateReleaseKey, gitGateSnapshot, waitForGitGateRelease } from "../classes/index.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export { gitGateReleaseKey, gitGateSnapshot, waitForGitGateRelease };

// Default subprocess timeout for git operations spawned via execFileSync/
// execSync. 30 seconds matches the historical inline literals used across
// worktree teardown, merge inspection, and admin commands.
export const GIT_OPERATION_TIMEOUT_MS = 30000;

function nativeAsyncOptions(options = {}) {
  return {
    ...(options.nativeParity || {}),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  };
}

export function gitExec(cmdOrArgs, cwd, options = {}) {
  return new Repo(cwd).exec(cmdOrArgs, options);
}

export function gitExecAsync(cmdOrArgs, cwd, options = {}) {
  return new Repo(cwd).execAsync(cmdOrArgs, options);
}

export function gitCurrentHash(cwd, nativeParity = {}) {
  return runGitNativeMethod("git.currentHash", { cwd, refName: "HEAD" }, nativeParity);
}

export async function gitCurrentHashAsync(cwd, options = {}) {
  return runGitNativeMethodAsync("git.currentHash", { cwd, refName: "HEAD" }, nativeAsyncOptions(options));
}

export function gitHasChanges(cwd, nativeParity = {}) {
  return runGitNativeMethod("git.hasChanges", { cwd }, nativeParity);
}

export async function gitHasChangesAsync(cwd, options = {}) {
  return runGitNativeMethodAsync("git.hasChanges", { cwd }, nativeAsyncOptions(options));
}

export function gitHasIgnoredChanges(cwd, nativeParity = {}) {
  return runGitNativeMethod("git.hasIgnoredChanges", { cwd }, nativeParity);
}

export async function gitHasIgnoredChangesAsync(cwd, options = {}) {
  return runGitNativeMethodAsync("git.hasIgnoredChanges", { cwd }, nativeAsyncOptions(options));
}

export function gitStash(message, cwd) {
  new Repo(cwd).exec(["stash", "push", "--include-untracked", "-m", message]);
}

export function gitLocalBranchExists(cwd, branchName, nativeParity = {}) {
  const branch = String(branchName || "").trim();
  return runGitNativeMethod("git.localBranchExists", { cwd, branchName: branch }, nativeParity);
}

export function gitCurrentBranch(cwd, nativeParity = {}) {
  return runGitNativeMethod("git.currentBranch", { cwd }, nativeParity);
}

export function gitRemoteHeadBranch(cwd, remote = "origin", nativeParity = {}) {
  const remoteName = String(remote || "origin").trim() || "origin";
  return runGitNativeMethod("git.remoteHeadBranch", { cwd, remote: remoteName }, nativeParity);
}

export function resolvePushBranch(cwd, targetBranch, {
  currentBranch = "",
  remote = "origin",
  nativeParity = {},
} = {}) {
  const target = String(targetBranch || "").trim();
  return runGitNativeMethod(
    "git.resolvePushBranch",
    { cwd, targetBranch: target, currentBranch, remote },
    nativeParity,
  );
}

export function findStallStash(jobId, cwd, nativeParity = {}) {
  return runGitNativeMethod("git.findStallStash", { cwd, jobId: String(jobId) }, nativeParity);
}

export async function findStallStashAsync(jobId, cwd, options = {}) {
  return runGitNativeMethodAsync(
    "git.findStallStash",
    { cwd, jobId: String(jobId) },
    nativeAsyncOptions(options),
  );
}
