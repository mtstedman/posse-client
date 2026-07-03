// lib/domains/git/functions/workflow-cleanup.js
// Worktree GC, snapshot removal, and WI branch cleanup helpers.

import fs from "fs";
import path from "path";
import { getDb } from "../../../shared/storage/functions/index.js";
import { logEvent, setMergeState } from "../../queue/functions/index.js";
import { disposeWorkItemAtlasGraph } from "../../integrations/functions/atlas.js";
import { emitWiCleanup as emitAtlasV2WiCleanup, isAtlasV2EmissionEnabled } from "../../atlas/classes/v2/PipelineHooks.js";
import { C } from "../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { throwIfAborted } from "../../runtime/functions/yield.js";
import { GIT_OPERATION_TIMEOUT_MS, gitExec } from "./utils.js";
import { FORCE_REMOVE_OPTIONS } from "./worktree-remove-options.js";
import {
  worktreePath as canonicalWorktreePath,
  findLegacyWorktreeForWi,
  worktreeRoot,
  preserveDirtyWorktreeSnapshot,
  deleteBranchPreservingTip,
  gcWorktreesAsync,
  withWorktreeLock,
} from "./worktree.js";
import { GIT_WORKFLOW_TASK_TIMEOUT_MS } from "./workflow-context.js";

export function createCleanupWorkflowHelpers(context, { guardStartupDirtyTreeAsync }) {
  const { projectDir, currentTargetBranch, runGitWorkflowTaskOffMainThread } = context;

  async function startupWorktreeCleanup({
    signal = null,
    onMsg = null,
    skipDirtyTreeGuard = false,
    recoveryPruneMinIntervalMs = undefined,
    forceRecoveryPrune = false,
  } = {}) {
    if (!skipDirtyTreeGuard) {
      await guardStartupDirtyTreeAsync({
        reason: "startup cleanup",
        signal,
        onPhase: (event) => {
          if (typeof onMsg === "function" && event?.detail) onMsg(`Git dirty tree: ${event.detail}`);
        },
      });
      throwIfAborted(signal);
    }
    const gcOptions = { signal };
    if (recoveryPruneMinIntervalMs !== undefined) gcOptions.recoveryPruneMinIntervalMs = recoveryPruneMinIntervalMs;
    if (forceRecoveryPrune) gcOptions.forceRecoveryPrune = true;
    await gcWorktreesAsync(projectDir, (msg) => {
      if (typeof onMsg === "function") {
        onMsg(msg);
      } else {
        console.log(`  ${C.yellow}${msg}${C.reset}`);
      }
    }, gcOptions);
  }


  function gitBranchExists(branchName, cwd) {
    try {
      gitExec(["rev-parse", "--verify", branchName], cwd, { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  function sameFsPath(a, b) {
    if (!a || !b) return false;
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  function isManagedWiWorktreePath(worktreePath, wiId) {
    if (wiId == null) return false;
    const resolved = path.resolve(worktreePath);
    const root = worktreeRoot(projectDir);
    if (!sameFsPath(path.dirname(resolved), root)) return false;
    const dirName = path.basename(resolved);
    const canonicalName = `wi-${wiId}`;
    return dirName === canonicalName || dirName.startsWith(`${canonicalName}-`);
  }

  function uniqueFsPaths(paths) {
    const result = [];
    for (const candidate of paths) {
      if (!candidate) continue;
      const resolved = path.resolve(candidate);
      if (!result.some((existing) => sameFsPath(existing, resolved))) result.push(resolved);
    }
    return result;
  }

  function gitTopLevelPath(cwd) {
    try {
      return path.resolve(gitExec(["rev-parse", "--show-toplevel"], cwd, { timeoutMs: 3000 }).trim());
    } catch {
      return path.resolve(cwd);
    }
  }

  function gitWorktreePathsForBranch(branchName, cwd) {
    const paths = [];
    try {
      const raw = gitExec(["worktree", "list", "--porcelain"], cwd, { timeoutMs: 10000 });
      let currentPath = null;
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length).trim();
          continue;
        }
        if (currentPath && line.trim() === `branch refs/heads/${branchName}`) {
          paths.push(currentPath);
        }
        if (line.trim() === "") currentPath = null;
      }
    } catch {
      // best effort; branch deletion will surface failure if a worktree remains
    }
    return paths;
  }

  function gitWorktreeRemove(worktreePath, cwd) {
    const target = path.resolve(worktreePath);
    const projectRoot = path.resolve(cwd);
    const mainRoot = gitTopLevelPath(cwd);
    if (sameFsPath(target, projectRoot) || sameFsPath(target, mainRoot)) {
      return false;
    }

    let removed = false;
    try {
      gitExec(["worktree", "remove", worktreePath, "--force"], cwd, { timeoutMs: GIT_OPERATION_TIMEOUT_MS });
      removed = true;
    } catch {
      try { gitExec(["worktree", "prune"], cwd, { timeoutMs: GIT_OPERATION_TIMEOUT_MS }); } catch { /* best effort */ }
    }
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, FORCE_REMOVE_OPTIONS);
        removed = true;
      } catch {
        // best effort; caller can decide whether branch state is safe to clear
      }
    }
    try { gitExec(["worktree", "prune"], cwd, { timeoutMs: GIT_OPERATION_TIMEOUT_MS }); } catch { /* best effort */ }
    return removed || !fs.existsSync(worktreePath);
  }

  function gitWorktreePorcelain(worktreePath) {
    return gitExec(["status", "--porcelain"], worktreePath, { timeoutMs: 5000 }).trim();
  }

  function logWorktreeSnapshotCleanupFailure(wi, wtDir, message, extra = {}) {
    logEvent({
      work_item_id: wi?.id ?? null,
      event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message,
      event_json: JSON.stringify({
        worktree_path: wtDir,
        branch: wi?.branch_name || null,
        ...extra,
      }),
    });
  }

  function logExternalWorktreeCleanupSkipped(wi, branchName, worktreePaths) {
    const paths = uniqueFsPaths(worktreePaths);
    if (paths.length === 0) return;
    logEvent({
      work_item_id: wi?.id ?? null,
      event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Skipped external worktree cleanup for ${branchName}; keeping branch metadata on WI#${wi?.id ?? "?"}`,
      event_json: JSON.stringify({
        branch: branchName,
        external_worktree_paths: paths,
        managed_root: worktreeRoot(projectDir),
      }),
    });
  }

  /**
   * Snapshot-gated single-worktree removal: snapshot any dirty state, verify
   * clean (a verify that RAN and still reports dirt refuses removal even
   * after a "successful" snapshot — leftovers are what the stash cannot
   * capture, e.g. nested repos), then remove. Shared by
   * snapshotAndRemoveWorktreeOnly and cleanupWiBranch.
   */
  function snapshotGateAndRemoveWorktree(wi, wtDir, reason) {
    let removed = false;
    withWorktreeLock(wtDir, projectDir, () => {
      let snapshotSucceeded = false;
      let snapshotFailed = false;
      let status = "";
      try {
        status = gitWorktreePorcelain(wtDir);
        if (status) {
          const snapshotRef = preserveDirtyWorktreeSnapshot(wtDir, projectDir, {
            reason,
            branchName: wi.branch_name || null,
            wiId: wi.id,
            onMsg: (msg) => logEvent({
              work_item_id: wi.id,
              event_type: EVENT_TYPES.WORKTREE_SNAPSHOT_WARNING,
              actor_type: EVENT_ACTORS.SYSTEM,
              message: msg,
              event_json: JSON.stringify({ worktree_path: wtDir, branch: wi.branch_name || null }),
            }),
          });
          snapshotSucceeded = !!snapshotRef;
        }
      } catch (err) {
        snapshotFailed = true;
        logWorktreeSnapshotCleanupFailure(
          wi,
          wtDir,
          `Could not snapshot worktree before cleanup; leaving worktree on disk: ${err?.message || String(err)}`,
          { reason, error: err?.message || String(err) },
        );
      }

      let verifiedClean = false;
      let verifyRan = false;
      try {
        verifiedClean = gitWorktreePorcelain(wtDir) === "";
        verifyRan = true;
      } catch (err) {
        if (!snapshotSucceeded) {
          logWorktreeSnapshotCleanupFailure(
            wi,
            wtDir,
            `Could not verify worktree cleanliness before cleanup; leaving worktree on disk: ${err?.message || String(err)}`,
            { reason, error: err?.message || String(err), snapshot_failed: snapshotFailed },
          );
        }
      }

      if (!verifiedClean && (verifyRan || !snapshotSucceeded)) {
        if (!snapshotFailed) {
          logWorktreeSnapshotCleanupFailure(
            wi,
            wtDir,
            "Worktree cleanup skipped because dirty state was not snapshotted and worktree is not clean",
            { reason, porcelain: status },
          );
        }
        return;
      }

      removed = gitWorktreeRemove(wtDir, projectDir);
    });
    return removed;
  }

  /**
   * Snapshot any dirty state and remove the worktree directory only — preserves the
   * branch (and its commits) so the user can retry a failed merge or re-approve.
   * Mirrors boot GC behavior (snapshot-then-remove), without touching the branch.
   */
  function snapshotAndRemoveWorktreeOnly(wi, reason) {
    if (!wi) return;
    const canonical = canonicalWorktreePath(projectDir, wi.id);
    const legacy = findLegacyWorktreeForWi(projectDir, wi.id);
    const candidates = [canonical];
    if (legacy && legacy !== canonical) candidates.push(legacy);

    for (const wtDir of candidates) {
      if (!fs.existsSync(wtDir)) continue;
      snapshotGateAndRemoveWorktree(wi, wtDir, reason);
    }
    try { gitExec(["worktree", "prune"], projectDir, { timeoutMs: 10000 }); } catch { /* best effort */ }
  }

  /** Clean up a WI's branch and worktree. Uses canonical wi-{id} path and also reaps any legacy slug-suffixed worktree. */
  function cleanupWiBranch(wi, { clearMergeState = false } = {}) {
    const targetBranch = currentTargetBranch();
    if (!wi.branch_name) return true;

    const canonical = canonicalWorktreePath(projectDir, wi.id);
    const legacy = findLegacyWorktreeForWi(projectDir, wi.id);
    const branchName = wi.branch_name;
    const candidates = [];
    const addCandidate = (candidate) => {
      if (!candidate) return;
      const resolved = path.resolve(candidate);
      if (!candidates.some((existing) => sameFsPath(existing, resolved))) candidates.push(resolved);
    };
    const skippedExternalWorktrees = [];
    const addManagedCandidate = (candidate) => {
      if (!candidate) return;
      const resolved = path.resolve(candidate);
      if (!isManagedWiWorktreePath(resolved, wi.id)) {
        if (!skippedExternalWorktrees.some((existing) => sameFsPath(existing, resolved))) {
          skippedExternalWorktrees.push(resolved);
        }
        return;
      }
      addCandidate(resolved);
    };

    // 1. Remove worktree(s) first (branch delete fails if checked out)
    if (fs.existsSync(canonical)) addManagedCandidate(canonical);
    if (legacy && !sameFsPath(legacy, canonical) && fs.existsSync(legacy)) addManagedCandidate(legacy);
    for (const wtPath of gitWorktreePathsForBranch(branchName, projectDir)) addManagedCandidate(wtPath);
    disposeWorkItemAtlasGraph({ projectDir: projectDir, workItemId: wi.id });
    for (const wtPath of candidates) {
      disposeWorkItemAtlasGraph({ projectDir: projectDir, workItemId: wi.id, worktreePath: wtPath });
      // Snapshot-gated: reject/kill/requeue paths reach here with worktrees
      // that can hold uncommitted work (reviewer fixes, a just-killed agent's
      // writes) — bare force-removal destroyed it unsnapshotted. A refusal
      // leaves the worktree; the branch delete below then fails closed and
      // keeps the WI's branch metadata.
      snapshotGateAndRemoveWorktree(wi, wtPath, clearMergeState ? "wi-branch-discard" : "wi-branch-cleanup");
    }
    try { gitExec(["worktree", "prune"], projectDir, { timeoutMs: 10000 }); } catch { /* best effort */ }
    const remainingExternalWorktrees = gitWorktreePathsForBranch(branchName, projectDir)
      .filter((wtPath) => !isManagedWiWorktreePath(wtPath, wi.id));
    if (remainingExternalWorktrees.length > 0) {
      logExternalWorktreeCleanupSkipped(wi, branchName, [
        ...skippedExternalWorktrees,
        ...remainingExternalWorktrees,
      ]);
      return false;
    }
    // 2. Delete branch
    const deleteResult = deleteBranchPreservingTip(projectDir, branchName, {
      targetBranch: targetBranch,
      reason: clearMergeState ? "wi-branch-discard" : "wi-branch-cleanup",
      wiId: wi.id,
      onMsg: (msg) => logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.GIT_BRANCH_PRESERVED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: msg,
        event_json: JSON.stringify({ branch: branchName, target_branch: targetBranch }),
      }),
    });
    const branchDeleted = deleteResult.ok;
    const branchStillExists = gitBranchExists(branchName, projectDir);
    if (!branchDeleted || branchStillExists) {
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.GIT_BRANCH_CLEANUP_FAILED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Could not delete branch ${branchName}; keeping branch metadata on WI#${wi.id}`,
        event_json: JSON.stringify({ branch: branchName, candidates, delete_result: deleteResult }),
      });
      return false;
    }
    // 3. Clear branch info from WI record (only reset merge_state on rejection/deletion)
    const db = getDb();
    db.prepare(`UPDATE work_items SET branch_name = NULL, merge_base_hash = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), wi.id);
    if (clearMergeState) setMergeState(wi.id, null);
    if (isAtlasV2EmissionEnabled()) {
      emitAtlasV2WiCleanup({
        payload: {
          wi_id: Number(wi.id),
          branch: String(branchName || ""),
          disposition: clearMergeState ? "abandoned" : "merged",
        },
        onError: () => { /* outbox failure must not block cleanup */ },
      });
    }
    return true;
  }

  function cleanupWiBranchAsync(wi, {
    clearMergeState = false,
    signal = null,
    timeoutMs = GIT_WORKFLOW_TASK_TIMEOUT_MS,
  } = {}) {
    return runGitWorkflowTaskOffMainThread("cleanupWiBranch", { wi, clearMergeState }, { signal, timeoutMs });
  }

  function snapshotAndRemoveWorktreeOnlyAsync(wi, reason, workerOptions = {}) {
    return runGitWorkflowTaskOffMainThread("snapshotAndRemoveWorktreeOnly", { wi, reason }, workerOptions);
  }


  return {
    startupWorktreeCleanup,
    gitBranchExists,
    gitWorktreePathsForBranch,
    gitWorktreeRemove,
    cleanupWiBranch,
    cleanupWiBranchAsync,
    snapshotAndRemoveWorktreeOnly,
    snapshotAndRemoveWorktreeOnlyAsync,
  };
}
