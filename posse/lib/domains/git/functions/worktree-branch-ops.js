// lib/domains/git/functions/worktree-branch-ops.js
//
// Branch deletion that preserves the tip (via a recovery snapshot) when the
// branch is not already an ancestor of the merge target, plus the ancestor
// predicate and the native-result compactor.

import path from "path";
import { isAbortError } from "../../runtime/functions/yield.js";
import { gitExec, gitExecAsync } from "./utils.js";
import { resolveTargetBranch, resolveTargetBranchAsync } from "./target-branch.js";
import { runGitNativeMethodAsync } from "./native/invoke.js";
import { isExpectedGitPredicateMiss, logSuppressedGitFailure } from "./worktree-internal.js";
import { gitBranchExists } from "./worktree-path.js";
import { preserveBranchTipSnapshot } from "./worktree-snapshots.js";

export function branchIsAncestorOfTarget(branchName, targetBranch, cwd) {
  if (!branchName || !targetBranch) return false;
  try {
    gitExec(["merge-base", "--is-ancestor", branchName, targetBranch], cwd);
    return true;
  } catch (err) {
    if (!isExpectedGitPredicateMiss(err)) {
      logSuppressedGitFailure("branch ancestor check", err, { cwd, branchName, targetBranch });
    }
    return false;
  }
}

export async function branchIsAncestorOfTargetAsync(branchName, targetBranch, cwd, options = {}) {
  if (!branchName || !targetBranch) return false;
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", branchName, targetBranch], cwd, options);
    return true;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!isExpectedGitPredicateMiss(err)) {
      logSuppressedGitFailure("branch ancestor check", err, { cwd, branchName, targetBranch });
    }
    return false;
  }
}

// deleteBranchPreservingTip / deleteBranchPreservingTipAsync are intentionally
// NOT twins of one body: the sync fn sequences the snapshot + branch delete in
// node-git, while the async fn delegates to native methods. Changes here must
// be mirrored on the async/native side.
export function deleteBranchPreservingTip(
  projectDir,
  branchName,
  { targetBranch = resolveTargetBranch(projectDir), reason = "branch-cleanup", wiId = null, onMsg = null } = {},
) {
  if (!branchName) {
    return { ok: true, existed: false, deleted: false, snapshotRef: null, reason: "missing_branch_name" };
  }
  if (!gitBranchExists(branchName, projectDir)) {
    return { ok: true, existed: false, deleted: false, snapshotRef: null, reason: "branch_missing" };
  }

  const ancestorSafe = branchIsAncestorOfTarget(branchName, targetBranch, projectDir);
  let snapshotRef = null;
  if (!ancestorSafe) {
    snapshotRef = preserveBranchTipSnapshot(projectDir, branchName, { reason, wiId, onMsg });
    if (!snapshotRef) {
      return { ok: false, existed: true, deleted: false, snapshotRef: null, reason: "snapshot_failed" };
    }
  }

  try {
    gitExec(["branch", ancestorSafe ? "-d" : "-D", branchName], projectDir);
  } catch (err) {
    return {
      ok: false,
      existed: true,
      deleted: false,
      snapshotRef,
      reason: "branch_delete_failed",
      error: err?.message || String(err),
    };
  }

  if (gitBranchExists(branchName, projectDir)) {
    return { ok: false, existed: true, deleted: false, snapshotRef, reason: "branch_still_exists" };
  }
  return {
    ok: true,
    existed: true,
    deleted: true,
    snapshotRef,
    reason: ancestorSafe ? "ancestor_merged" : "snapshot_preserved",
  };
}

export function compactNativeDeleteBranchResult(value = {}) {
  const result = {
    ok: Boolean(value.ok),
    existed: Boolean(value.existed),
    deleted: Boolean(value.deleted),
    snapshotRef: value.snapshotRef || null,
    reason: String(value.reason || ""),
  };
  if (value.error) result.error = String(value.error);
  return result;
}

export async function deleteBranchPreservingTipAsync(
  projectDir,
  branchName,
  { targetBranch = null, reason = "branch-cleanup", wiId = null, onMsg = null, signal = null, nativeParity = {} } = {},
) {
  // Resolved in-body via the async twin: a sync default-param resolve would
  // block the async lane (startup GC omits targetBranch) on a native spawn.
  if (targetBranch == null) targetBranch = await resolveTargetBranchAsync(projectDir, { signal });
  const result = await runGitNativeMethodAsync(
    "git.worktree.deleteBranchPreservingTip",
    {
      projectDir: path.resolve(projectDir),
      branchName: String(branchName || ""),
      targetBranch: String(targetBranch || ""),
      reason,
      wiId: wiId == null ? null : String(wiId),
    },
    { ...nativeParity, signal },
  );
  return compactNativeDeleteBranchResult(result);
}
