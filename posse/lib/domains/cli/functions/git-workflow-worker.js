import { parentPort, workerData } from "worker_threads";
import { createGitWorkflowHelpers } from "./git-workflows.js";
import {
  computeWorktreeStatus,
  commitInScopeChanges,
  discardWorktreeFiles,
  stashTargetBranchChanges,
} from "./worktree-status.js";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* worker is already closing */ }
}

function errorPayload(err) {
  const payload = {
    name: err?.name || "Error",
    message: err?.message || String(err || "git workflow task failed"),
    stack: err?.stack || null,
  };
  for (const key of ["code", "errno", "syscall", "path", "spawnargs", "status", "signal", "killed", "timeoutMs"]) {
    if (err?.[key] != null) payload[key] = err[key];
  }
  return payload;
}

async function main() {
  const {
    task,
    args = {},
    projectDir,
    targetBranch,
    autoMerge = false,
  } = workerData || {};
  const helpers = createGitWorkflowHelpers({
    projectDir,
    targetBranch,
    autoMerge,
  });

  if (task === "gitMergeToTarget") {
    return helpers.gitMergeToTarget(args.branch, args.cwd || projectDir, {
      wiId: args.wiId ?? null,
      onPhase: (event = {}) => post({ type: "progress", event }),
    });
  }
  if (task === "cleanupWiBranch") {
    return helpers.cleanupWiBranch(args.wi, { clearMergeState: !!args.clearMergeState });
  }
  if (task === "snapshotAndRemoveWorktreeOnly") {
    return helpers._snapshotAndRemoveWorktreeOnly(args.wi, args.reason || "merge-failed");
  }
  if (task === "ensureCleanTargetBranch") {
    return helpers.ensureCleanTargetBranch(args.reason || "workflow", args.options || {});
  }
  if (task === "guardStartupDirtyTree") {
    return helpers.guardStartupDirtyTree({
      reason: args.reason || "startup",
      policy: args.policy ?? null,
      message: args.message || "chore: preserve startup work before posse boot",
      onPhase: (event = {}) => post({ type: "progress", event }),
    });
  }
  if (task === "collectDirtyState") {
    return helpers._collectDirtyState();
  }
  if (task === "collectPushOfferState") {
    return helpers._collectPushOfferState(args.mergedCount || 0);
  }
  if (task === "executePush") {
    return helpers._executePush(args);
  }
  if (task === "gitDiffStat") {
    return helpers.gitDiffStat(args.mergeBase, args.branch, args.cwd || projectDir);
  }
  if (task === "computeWorktreeStatus") {
    return computeWorktreeStatus(args);
  }
  if (task === "commitInScopeChanges") {
    return commitInScopeChanges(args);
  }
  if (task === "discardWorktreeFiles") {
    return discardWorktreeFiles(args);
  }
  if (task === "stashTargetBranchChanges") {
    return stashTargetBranchChanges(args);
  }
  throw new Error(`Unknown git workflow worker task: ${task}`);
}

main()
  .then((result) => post({ type: "result", result }))
  .catch((err) => post({ type: "error", error: errorPayload(err) }));
