// lib/domains/git/functions/workflow-context.js
// Shared context for git workflow helper factories.

import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { gitExec as nativeGitExec, gitExecAsync as nativeGitExecAsync } from "./utils.js";

const GIT_WORKFLOW_WORKER_URL = new URL("./git-workflow-worker.js", import.meta.url);
const GIT_WORKFLOW_THREAD_MANAGER = new ThreadManager();
export const GIT_WORKFLOW_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const MUTATING_GIT_WORKFLOW_TASKS = new Set([
  "gitMergeToTarget",
  "cleanupWiBranch",
  "snapshotAndRemoveWorktreeOnly",
  "ensureCleanTargetBranch",
  "guardStartupDirtyTree",
  "executePush",
  "commitInScopeChanges",
  "discardWorktreeFiles",
  "stashTargetBranchChanges",
]);

export function createGitWorkflowContext({
  projectDir,
  targetBranch,
  getTargetBranch = null,
  autoMerge = false,
  nonInteractive = false,
  askFn = async () => "",
  gitExecFn = nativeGitExec,
  gitExecAsyncFn = nativeGitExecAsync,
  withWorktreeLockFn = null,
  worktreePathFn = null,
  findLegacyWorktreeFn = null,
  worktreeRootFn = null,
  deleteBranchPreservingTipFn = null,
  preserveDirtyWorktreeSnapshotFn = null,
  allowSnapshottedWorktreeRemoval = false,
  nativeParity = {},
  isIterativeWorkItemActive = () => false,
  shouldAutoApproveIterativeWorkItem = () => false,
} = {}) {
  if (!projectDir) throw new Error("createGitWorkflowHelpers requires projectDir");
  if (!targetBranch && typeof getTargetBranch !== "function") {
    throw new Error("createGitWorkflowHelpers requires targetBranch");
  }

  function currentTargetBranch() {
    const resolved = typeof getTargetBranch === "function" ? getTargetBranch() : targetBranch;
    if (resolved && typeof resolved.then === "function") {
      throw new Error("createGitWorkflowHelpers getTargetBranch must be synchronous");
    }
    const branch = String(resolved || "").trim();
    if (!branch) throw new Error("Target branch could not be resolved");
    return branch;
  }

  async function runGitWorkflowTaskOffMainThread(task, args = {}, {
    onPhase = null,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    const parsedTimeoutMs = Number(timeoutMs);
    const effectiveTimeoutMs = timeoutMs == null
      ? GIT_WORKFLOW_TASK_TIMEOUT_MS
      : Number.isFinite(parsedTimeoutMs)
        ? parsedTimeoutMs
        : GIT_WORKFLOW_TASK_TIMEOUT_MS;
    const routes = MUTATING_GIT_WORKFLOW_TASKS.has(task)
      ? ["git:read", "git:mutate"]
      : ["git:read"];
    const nativeRuntime = await nativeBinaries.prepareWorkerRuntime(["git"], {
      routesByBinary: { git: routes },
    });
    return GIT_WORKFLOW_THREAD_MANAGER.run(GIT_WORKFLOW_WORKER_URL, {
      label: `git workflow ${task}`,
      timeoutMs: effectiveTimeoutMs,
      signal,
      workerData: {
        task,
        args,
        projectDir,
        targetBranch: currentTargetBranch(),
        autoMerge,
        nonInteractive,
        nativeAuth: heartbeatAuthManager.getCapability(),
        nativeRuntime,
      },
      onProgress: (event = {}) => {
        if (typeof onPhase === "function") {
          try { onPhase(event || {}); } catch { /* display callback only */ }
        }
      },
    });
  }


  return {
    projectDir,
    targetBranch,
    getTargetBranch,
    autoMerge,
    nonInteractive,
    askFn,
    gitExec: gitExecFn,
    gitExecAsync: gitExecAsyncFn,
    withWorktreeLock: typeof withWorktreeLockFn === "function" ? withWorktreeLockFn : null,
    worktreePath: typeof worktreePathFn === "function" ? worktreePathFn : null,
    findLegacyWorktree: typeof findLegacyWorktreeFn === "function" ? findLegacyWorktreeFn : null,
    worktreeRoot: typeof worktreeRootFn === "function" ? worktreeRootFn : null,
    deleteBranchPreservingTip: typeof deleteBranchPreservingTipFn === "function" ? deleteBranchPreservingTipFn : null,
    preserveDirtyWorktreeSnapshot: typeof preserveDirtyWorktreeSnapshotFn === "function" ? preserveDirtyWorktreeSnapshotFn : null,
    allowSnapshottedWorktreeRemoval: allowSnapshottedWorktreeRemoval === true,
    nativeParity,
    isIterativeWorkItemActive,
    shouldAutoApproveIterativeWorkItem,
    currentTargetBranch,
    runGitWorkflowTaskOffMainThread,
  };
}
