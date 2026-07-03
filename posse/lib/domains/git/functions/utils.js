// lib/domains/git/functions/utils.js
//
// Shared git shell helpers for worker-side operations.

import { Repo, gitGateReleaseKey, gitGateSnapshot, isGitCommandFailure, waitForGitGateRelease } from "../classes/index.js";
import { isAbortError } from "../../runtime/functions/yield.js";
import { nativeAsyncOptions, runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export { gitGateReleaseKey, gitGateSnapshot, isGitCommandFailure, waitForGitGateRelease };

// Default subprocess timeout for git operations spawned via execFileSync/
// execSync. 30 seconds matches the historical inline literals used across
// worktree teardown, merge inspection, and admin commands.
export const GIT_OPERATION_TIMEOUT_MS = 30000;

export function gitExec(cmdOrArgs, cwd, options = {}) {
  return new Repo(cwd).exec(cmdOrArgs, options);
}

export function gitExecAsync(cmdOrArgs, cwd, options = {}) {
  return new Repo(cwd).execAsync(cmdOrArgs, options);
}

function bufferExecOptions(options = {}) {
  return {
    encoding: "buffer",
    input: options.input == null ? undefined : String(options.input),
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 16,
    timeoutMs: options.timeoutMs ?? options.timeout ?? GIT_OPERATION_TIMEOUT_MS,
    gate: options.gate,
    gateMode: options.gateMode,
    nativeParity: options.nativeParity || {},
  };
}

export function gitExecBuffer(cmdOrArgs, cwd, options = {}) {
  return new Repo(cwd).exec(cmdOrArgs, bufferExecOptions(options));
}

export function gitExecBufferAsync(cmdOrArgs, cwd, options = {}) {
  return new Repo(cwd).execAsync(cmdOrArgs, { ...bufferExecOptions(options), signal: options.signal });
}

/**
 * Silent variants for probe-style call sites where empty output and "git said
 * no" are equivalent. Infrastructure failures (gate busy, native binary
 * unavailable) also map to "" here — callers whose behavior must distinguish
 * those (safety guards, security gates) should use gitExec and check
 * isGitCommandFailure instead.
 */
export function gitExecSafe(cmdOrArgs, cwd, options = {}) {
  try {
    return String(gitExec(cmdOrArgs, cwd, options) || "").trim();
  } catch {
    return "";
  }
}

export async function gitExecSafeAsync(cmdOrArgs, cwd, options = {}) {
  try {
    return String(await gitExecAsync(cmdOrArgs, cwd, options) || "").trim();
  } catch (err) {
    if (isAbortError(err)) throw err;
    return "";
  }
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

// SHA-addressed stall-stash resolution. refs/stash is shared by every linked
// worktree in the repo, so a positional `stash@{N}` goes stale the moment any
// other lane pushes or drops — consumers must apply by commit hash and drop
// only a slot re-verified against that hash. Matching mirrors the native
// find_stall_stash guards (whitespace before the needle, non-digit after, so
// "job #1" can never match "job #12").
const STALL_STASH_LIST_FORMAT = "%H%x00%gd%x00%s";

function parseStallStashEntry(list, jobId) {
  const needle = `job #${jobId}`;
  for (const line of String(list || "").split("\n")) {
    if (!line) continue;
    const [hash, ref, subject] = line.split("\0");
    if (!hash || !ref || !subject) continue;
    if (!subject.includes("posse:")) continue;
    const idx = subject.indexOf(needle);
    if (idx < 0) continue;
    if (idx > 0 && !/\s/.test(subject[idx - 1])) continue;
    const after = subject[idx + needle.length];
    if (after && /\d/.test(after)) continue;
    return { hash, ref, subject };
  }
  return null;
}

export function findStallStashEntry(jobId, cwd) {
  const list = gitExec(["stash", "list", `--format=${STALL_STASH_LIST_FORMAT}`], cwd);
  return parseStallStashEntry(list, jobId);
}

export async function findStallStashEntryAsync(jobId, cwd, options = {}) {
  const list = await gitExecAsync(["stash", "list", `--format=${STALL_STASH_LIST_FORMAT}`], cwd, options);
  return parseStallStashEntry(list, jobId);
}

export function dropStashByHash(cwd, hash) {
  if (!hash) return false;
  const list = gitExec(["stash", "list", "--format=%H %gd"], cwd);
  for (const line of String(list || "").split("\n")) {
    const [h, ref] = line.trim().split(" ");
    if (h === hash && ref) {
      gitExec(["stash", "drop", ref], cwd);
      return true;
    }
  }
  return false;
}

export async function dropStashByHashAsync(cwd, hash, options = {}) {
  if (!hash) return false;
  const list = await gitExecAsync(["stash", "list", "--format=%H %gd"], cwd, options);
  for (const line of String(list || "").split("\n")) {
    const [h, ref] = line.trim().split(" ");
    if (h === hash && ref) {
      await gitExecAsync(["stash", "drop", ref], cwd, options);
      return true;
    }
  }
  return false;
}
