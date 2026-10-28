import { parentPort, workerData } from "worker_threads";
import { createGitWorkflowHelpers } from "./workflows.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { HeartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { REVIEWED_REFRESH_TASK } from "../../../catalog/reviewed-handoffs.js";
import { prepareReviewedTargetRefresh } from "./reviewed-target-refresh.js";
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
  if (workerData?.nativeAuth?.envelope && typeof workerData.nativeAuth.envelope === "object") {
    nativeBinaries.setNativeAuthManager(HeartbeatAuthManager.fromCapability(workerData.nativeAuth, { trustedPolicy: workerData.nativeTrustedPolicy }));
  }
  nativeBinaries.installWorkerRuntime(workerData?.nativeRuntime);
  nativeBinaries.binary("git").workerPulsePort = workerData?.nativePulsePort || null;
  workerData?.nativePulsePort?.unref();
  if (workerData?.task === REVIEWED_REFRESH_TASK) return prepareReviewedTargetRefresh(workerData.args);
  const {
    task,
    args = {},
    projectDir,
    targetBranch,
    autoMerge = false,
    nonInteractive = true,
  } = workerData || {};
  const helpers = createGitWorkflowHelpers({
    projectDir,
    targetBranch,
    autoMerge,
    nonInteractive,
  });

  if (task === "gitMergeToTarget") {
    return helpers.gitMergeToTarget(args.branch, args.cwd || projectDir, {
      wiId: args.wiId ?? null,
      retryDeterministicConflict: args.retryDeterministicConflict === true,
      testWaiver: args.testWaiver || null,
      suppressPostMergeEffects: args.suppressPostMergeEffects === true,
      worktreeLockAlreadyHeld: args.worktreeLockAlreadyHeld === true,
      sharedTrunkOperationId: args.sharedTrunkOperationId || null,
      taskDeadlineMs: Number.isFinite(Number(args.taskDeadlineMs)) ? Number(args.taskDeadlineMs) : null,
      onPhase: (event = {}) => post({ type: "progress", event }),
    });
  }
  if (task === "recoverInterruptedSquash") {
    return helpers.recoverInterruptedSquash(args.cwd || projectDir, {
      worktreeLockAlreadyHeld: args.worktreeLockAlreadyHeld === true,
    });
  }
  if (task === "cleanupWiBranch") {
    return helpers.cleanupWiBranch(args.wi, {
      clearMergeState: !!args.clearMergeState,
      requireCleanWorktree: !!args.requireCleanWorktree,
    });
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
  if (task === "validatePushCandidate") {
    return helpers._validatePushCandidate(args);
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

async function run() {
  let outcome;
  try {
    outcome = { type: "result", result: await main() };
  } catch (err) {
    outcome = { type: "error", error: errorPayload(err) };
  }
  // Dispose before publishing the terminal frame: the parent is allowed to
  // terminate this one-shot worker as soon as it receives that frame.
  try { await nativeBinaries.disposeAll(); } catch { /* teardown is best effort */ }
  post(outcome);
}

void run();
