// lib/domains/git/functions/workflows.js
// Git/worktree workflow helpers used by CLI, bridge, and worker surfaces.

import { createGitWorkflowContext } from "./workflow-context.js";
import { askSingleKeyYesNo } from "./workflow-prompts.js";
import { createStartupDirtyGuardHelpers } from "./workflow-startup-guard.js";
import { createReviewWorktreeHelpers } from "./workflow-review-worktrees.js";
import { createPushWorkflowHelpers } from "./workflow-push.js";
import { createCleanupWorkflowHelpers } from "./workflow-cleanup.js";
import { createMergeWorkflowHelpers } from "./workflow-merge.js";
import { createAutoMergeWorkflowHelpers } from "./workflow-auto-merge.js";

export { askSingleKeyYesNo };

export function createGitWorkflowHelpers(options = {}) {
  const context = createGitWorkflowContext(options);
  const startup = createStartupDirtyGuardHelpers(context);
  const review = createReviewWorktreeHelpers(context, {
    isRuntimePorcelainLine: startup.isRuntimePorcelainLine,
  });
  const push = createPushWorkflowHelpers(context, {
    auditWorktreeState: review.auditWorktreeState,
    askSingleKeyYesNo,
  });
  const cleanup = createCleanupWorkflowHelpers(context, {
    guardStartupDirtyTreeAsync: startup.guardStartupDirtyTreeAsync,
  });
  const merge = createMergeWorkflowHelpers(context, {
    ensureCleanTargetBranch: startup.ensureCleanTargetBranch,
    isRuntimePorcelainLine: startup.isRuntimePorcelainLine,
    sourceWorktreeDirtyState: review.sourceWorktreeDirtyState,
    sweepOrphanedInferTsconfig: startup.sweepOrphanedInferTsconfig,
  });
  const autoMerge = createAutoMergeWorkflowHelpers(context, {
    gitMergeToTargetAsync: merge.gitMergeToTargetAsync,
    queueAtlasMainRefreshAfterMerge: merge.queueAtlasMainRefreshAfterMerge,
    cleanupWiBranchAsync: cleanup.cleanupWiBranchAsync,
    snapshotAndRemoveWorktreeOnlyAsync: cleanup.snapshotAndRemoveWorktreeOnlyAsync,
  });

  return {
    auditWorktreeState: review.auditWorktreeState,
    collectDirtyState: review.collectDirtyState,
    collectDirtyStateAsync: review.collectDirtyStateAsync,
    ensureCleanTargetBranch: startup.ensureCleanTargetBranch,
    ensureCleanTargetBranchAsync: startup.ensureCleanTargetBranchAsync,
    guardStartupDirtyTree: startup.guardStartupDirtyTree,
    guardStartupDirtyTreeAsync: startup.guardStartupDirtyTreeAsync,
    guardStartupDirtyTreeInWorker: startup.guardStartupDirtyTreeInWorker,
    notifyDirtyState: review.notifyDirtyState,
    offerPush: push.offerPush,
    startupWorktreeCleanup: cleanup.startupWorktreeCleanup,
    gitDiffStat: merge.gitDiffStat,
    gitDiffStatAsync: merge.gitDiffStatAsync,
    gitMergeToTarget: merge.gitMergeToTarget,
    gitMergeToTargetAsync: merge.gitMergeToTargetAsync,
    mergeIterativePassToTarget: merge.mergeIterativePassToTarget,
    gitBranchExists: cleanup.gitBranchExists,
    gitWorktreePathsForBranch: cleanup.gitWorktreePathsForBranch,
    gitWorktreeRemove: cleanup.gitWorktreeRemove,
    cleanupWiBranch: cleanup.cleanupWiBranch,
    cleanupWiBranchAsync: cleanup.cleanupWiBranchAsync,
    snapshotAndRemoveWorktreeOnlyAsync: cleanup.snapshotAndRemoveWorktreeOnlyAsync,
    autoMergeCompletedWorkItems: autoMerge.autoMergeCompletedWorkItems,
    hasAutoMergeableCompletedWorkItems: autoMerge.hasAutoMergeableCompletedWorkItems,
    // Exposed for tests — internal helper that decides whether a git
    // porcelain line refers to a posse-runtime-managed file.
    _isRuntimePorcelainLine: startup.isRuntimePorcelainLine,
    _sweepOrphanedInferTsconfig: startup.sweepOrphanedInferTsconfig,
    _sweepOrphanedInferTsconfigAsync: startup.sweepOrphanedInferTsconfigAsync,
    _currentTargetBranch: context.currentTargetBranch,
    _collectDirtyState: review.collectDirtyState,
    _collectPushOfferState: push.collectPushOfferState,
    _executePush: push.executePush,
    _snapshotAndRemoveWorktreeOnly: cleanup.snapshotAndRemoveWorktreeOnly,
  };
}
