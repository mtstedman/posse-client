import { readonlySet } from "./readonly-collections.js";
// @ts-check
// Checked projection of posse-bin/crates/catalog/src/git_methods.rs and the native Git argv policy.



// This allowlist mirrors every statically read-only arm in posse-git's
// dispatch_git_method. Payload-sensitive methods are handled separately and
// every unrecognized method falls through to git:mutate.
export const GIT_READ_ONLY_METHODS = readonlySet([
  "git.branchExists",
  "git.capabilities",
  "git.commitScope.conflictsWith",
  "git.commitScope.containsFile",
  "git.commitScope.findConflict",
  "git.commitScope.fromInput",
  "git.commitScope.fromPayload",
  "git.commitScope.hasScope",
  "git.commitScope.isWildcard",
  "git.commitScope.lockRows",
  "git.currentBranch",
  "git.currentHash",
  "git.findStallStash",
  "git.hasChanges",
  "git.hasIgnoredChanges",
  "git.history",
  "git.isAncestor",
  "git.isReadOnly",
  "git.jobNeedsWorktree",
  "git.jobsNeedWorktree",
  "git.localBranchExists",
  "git.mergeBase",
  "git.push.refspecCanPublishSnapshotRefs",
  "git.remoteHeadBranch",
  "git.repairWebAssetCreateScope",
  "git.repo.branchExists",
  "git.repo.currentBranch",
  "git.repo.currentHash",
  "git.repo.hasChanges",
  "git.repo.isAncestor",
  "git.repo.isReadOnly",
  "git.repo.mergeBase",
  "git.repo.statusPorcelain",
  "git.repo.workflowStatus",
  "git.resolvePushBranch",
  "git.resolveTargetBranch",
  "git.snapshot.dirSizeBytes",
  "git.snapshot.exists",
  "git.snapshot.findExistingDedupRef",
  "git.snapshot.listRefs",
  "git.snapshot.readNote",
  "git.snapshot.refName",
  "git.snapshot.safeFilename",
  "git.snapshotPublishingPushConfigs",
  "git.statusFromRepo",
  "git.statusPorcelain",
  "git.workflow.status",
  "git.workflow.statusFromRepo",
  "git.workflowStatus",
  "git.worktree.branchLockPath",
  "git.worktree.classifyDirty",
  "git.worktree.currentBranch",
  "git.worktree.exists",
  "git.worktree.findLegacy",
  "git.worktree.inspectPrepared",
  "git.worktree.isMergeInProgress",
  "git.worktree.isUsable",
  "git.worktree.listMergeConflicts",
  "git.worktree.lockPath",
  "git.worktree.parsePorcelainRemainingPaths",
  "git.worktree.path",
  "git.worktree.stashLockPath",
  "status",
  "workflow-status",
]);

// git.exec must use the encoder's argument policy, not the broader Node Repo
// scheduling classifier. These tables match git_core::repo, except that, like
// posse-git's session-scope classifier, `--exec-path`, `--` and empty leading
// arguments are unclassifiable: `--exec-path=<dir>` makes Git run subcommand
// programs from that directory, so it can never be a read.
export const GIT_EXEC_READ_ONLY_COMMANDS = readonlySet([
  "blame",
  "cat-file",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "merge-base",
  "rev-list",
  "rev-parse",
  "show",
  "status",
]);

export const GIT_EXEC_GLOBAL_OPTIONS_WITH_VALUE = readonlySet([
  "-C",
  "-c",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);

export const GIT_EXEC_GLOBAL_FLAGS = readonlySet([
  "--bare",
  "--glob-pathspecs",
  "--icase-pathspecs",
  "--literal-pathspecs",
  "--no-pager",
  "--no-replace-objects",
  "--noglob-pathspecs",
]);

export const GIT_EXEC_GLOBAL_OPTIONS_WITH_EQUALS = [
  "--git-dir=",
  "--namespace=",
  "--work-tree=",
];

export const GIT_EXEC_BRANCH_MUTATING_FLAGS = readonlySet([
  "-c", "-C", "-d", "-D", "-f", "-m", "-M", "--copy",
  "--create-reflog", "--delete", "--edit-description", "--force", "--move",
  "--no-create-reflog", "--no-track", "--set-upstream-to", "--track", "--unset-upstream",
]);

export const GIT_EXEC_BRANCH_READ_FLAGS = readonlySet([
  "-a", "-r", "-v", "-vv", "--all", "--color", "--column", "--contains",
  "--format", "--ignore-case", "--list", "--merged", "--no-color", "--no-column",
  "--no-contains", "--no-merged", "--points-at", "--remotes", "--show-current",
  "--sort", "--verbose",
]);

export const GIT_EXEC_BRANCH_READ_OPTIONS_WITH_VALUE = readonlySet([
  "--contains", "--format", "--merged",
  "--no-contains", "--no-merged", "--points-at", "--sort",
]);

export const GIT_EXEC_CONFIG_READ_FLAGS = readonlySet([
  "-l", "--get", "--get-all", "--get-color", "--get-colorbool",
  "--get-regexp", "--get-urlmatch", "--list",
]);

export const GIT_EXEC_CONFIG_WRITE_FLAGS = readonlySet([
  "--add", "--remove-section", "--rename-section", "--replace-all",
  "--set", "--unset", "--unset-all",
]);

export const GIT_EXEC_CONFIG_OPTIONS_WITH_VALUE = readonlySet(["--blob", "--file", "--type"]);

export const GIT_EXEC_READ_ONLY_UNSAFE_OPTIONS = readonlySet(["--ext-diff", "--filters", "--output", "--textconv"]);
