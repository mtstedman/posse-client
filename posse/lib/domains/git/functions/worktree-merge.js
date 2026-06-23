// lib/domains/git/functions/worktree-merge.js
//
// Merge-state inspection and target-into-worktree merging. All of these are thin
// wrappers over the native git binary plus a result compactor for the merge op.

import path from "path";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";

export function classifyDirtyWorktree(wtPath, { jobId = null, nativeParity = {} } = {}) {
  return runGitNativeMethod(
    "git.worktree.classifyDirty",
    { wtPath: path.resolve(wtPath), jobId: jobId == null ? null : String(jobId) },
    nativeParity,
  );
}

export async function classifyDirtyWorktreeAsync(wtPath, { jobId = null, signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.classifyDirty",
    { wtPath: path.resolve(wtPath), jobId: jobId == null ? null : String(jobId) },
    { ...nativeParity, signal },
  );
}

/**
 * Is a merge currently in progress inside this worktree? True when MERGE_HEAD
 * is set (from a `git merge` that hit conflicts or was paused before commit).
 */
export function isMergeInProgress(wtPath, nativeParity = {}) {
  return runGitNativeMethod("git.worktree.isMergeInProgress", { wtPath: path.resolve(wtPath) }, nativeParity);
}

export async function isMergeInProgressAsync(wtPath, { signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.isMergeInProgress",
    { wtPath: path.resolve(wtPath) },
    { ...nativeParity, signal },
  );
}

/**
 * List the unmerged (conflicted) paths in a worktree. Empty array when no
 * conflicts or when git errors out.
 */
export function listMergeConflicts(wtPath, nativeParity = {}) {
  return runGitNativeMethod("git.worktree.listMergeConflicts", { wtPath: path.resolve(wtPath) }, nativeParity);
}

export async function listMergeConflictsAsync(wtPath, { signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.listMergeConflicts",
    { wtPath: path.resolve(wtPath) },
    { ...nativeParity, signal },
  );
}

function compactNativeMergeResult(value = {}) {
  const result = { ok: Boolean(value.ok) };
  if (value.error) result.error = String(value.error);
  if (value.updated !== null && value.updated !== undefined) result.updated = Boolean(value.updated);
  if (value.mergeCommit) result.mergeCommit = String(value.mergeCommit);
  if (value.alreadyInProgress) result.alreadyInProgress = true;
  if (value.leftInTree) result.leftInTree = true;
  if (value.abortFailed) result.abortFailed = true;
  if (value.manualRecoveryRequired) result.manualRecoveryRequired = true;
  if (Array.isArray(value.conflicts) && (!result.ok || value.conflicts.length > 0)) {
    result.conflicts = value.conflicts;
  }
  if (value.message) result.message = String(value.message);
  return result;
}

/**
 * Merge the target branch (main/master) into the WI branch inside its worktree.
 * Called before mutating jobs run so the dev agent sees the current state of
 * `main` and can resolve conflicts in-context rather than at wrap-up merge time.
 *
 * Returns one of:
 *   { ok: true, updated: false }                             — already up-to-date
 *   { ok: true, updated: true, mergeCommit }                 — clean merge landed
 *   { ok: false, conflicts: [paths], leftInTree: true }      — conflicts left for the dev to resolve (leaveOnConflict)
 *   { ok: false, conflicts: [paths], message }               — conflicts; aborted cleanly
 *   { ok: false, abortFailed: true, manualRecoveryRequired: true, ... }
 *                                                            — abort failed; MERGE_HEAD still set
 *   { ok: false, alreadyInProgress: true, conflicts: [...] } — a prior merge is still in progress; no-op
 *   { ok: false, error: message }                            — non-conflict failure (target missing etc.)
 *
 * Options:
 *   leaveOnConflict — when true, on conflict the merge is NOT aborted; MERGE_HEAD
 *     and conflict markers are left in the worktree so downstream (handoff + dev)
 *     can complete the merge. When false, the merge is aborted cleanly.
 */
export async function mergeTargetIntoWorktreeAsync(wtPath, projectDir, targetBranch, {
  leaveOnConflict = false,
  initialMergeInProgress = null,
  signal = null,
  nativeParity = {},
} = {}) {
  void initialMergeInProgress;
  const result = await runGitNativeMethodAsync(
    "git.worktree.mergeTarget",
    {
      wtPath: path.resolve(wtPath),
      projectDir: path.resolve(projectDir),
      targetBranch: String(targetBranch || ""),
      leaveOnConflict: Boolean(leaveOnConflict),
    },
    { ...nativeParity, signal },
  );
  return compactNativeMergeResult(result);
}
