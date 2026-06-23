// lib/domains/git/functions/worktree.js
//
// Worktree lifecycle barrel. The implementation now lives in cohesive sibling
// modules (worktree-internal/path/legacy/recovery/safe-remove/branch-ops/merge/
// create/gc); this file re-exports their public surface plus the sibling lock/
// snapshot/target-branch helpers it has always surfaced, so importers keep a
// single stable entrypoint.

export * from "./worktree-path.js";
export * from "./worktree-legacy.js";
export * from "./worktree-recovery.js";
export * from "./worktree-branch-ops.js";
export * from "./worktree-merge.js";
export * from "./worktree-safe-remove.js";
export * from "./worktree-create.js";
export * from "./worktree-gc.js";

export { resolveTargetBranch } from "./target-branch.js";
export {
  acquireWorktreeLockAsync,
  releaseWorktreeLockAsync,
  withWorktreeLock,
  withWorktreeLockAsync,
  __testResolveWorktreeLockWaitMs,
} from "./worktree-locks.js";
export {
  dirSizeBytes,
  pruneRecoveredWorktreeSnapshots,
  pruneRecoveredWorktreeSnapshotsAsync,
  preserveDirtyWorktreeSnapshot,
  preserveDirtyWorktreeSnapshotAsync,
  preserveBranchTipSnapshot,
  preserveBranchTipSnapshotAsync,
} from "./worktree-snapshots.js";

import { isExpectedGitPredicateMiss } from "./worktree-internal.js";
import { gitTopLevel, gitTopLevelAsync } from "./worktree-path.js";
import { branchIsAncestorOfTarget, branchIsAncestorOfTargetAsync } from "./worktree-branch-ops.js";
import { resetDirtyWorktreeAsync } from "./worktree-recovery.js";

export const __testGitDiagnostics = Object.freeze({
  branchIsAncestorOfTarget,
  branchIsAncestorOfTargetAsync,
  gitTopLevel,
  gitTopLevelAsync,
  isExpectedGitPredicateMiss,
  resetDirtyWorktreeAsync,
});
