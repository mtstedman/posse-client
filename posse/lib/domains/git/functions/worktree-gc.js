// lib/domains/git/functions/worktree-gc.js
//
// Startup/closeout garbage collection of worker worktrees: prunes recovery
// snapshots (throttled per project), then walks the worktree root and, per WI,
// snapshots + removes terminal/inactive checkouts, resets held dirty worktrees,
// and deletes/retains branches per merge state. Work-item state predicates and
// GC message formatters live here too.

import fs from "fs";
import path from "path";
import { LOCK_HOLDING_JOB_STATUSES, TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { getWorkItem, listJobsByWorkItem, refreshWorkItemStatus, setMergeState, setWorkItemBranch } from "../../queue/functions/index.js";
import { throwIfAborted, isAbortError } from "../../runtime/functions/yield.js";
import { jobNeedsGitWorktree } from "./policy.js";
import { contextDir, wiScopeId } from "../../artifacts/functions/index.js";
import { disposeWorkItemAtlasGraph } from "../../integrations/functions/atlas.js";
import { gitExecAsync } from "./utils.js";
import { createGcTiming } from "./worktree-internal.js";
import { worktreeRoot } from "./worktree-path.js";
import {
  worktreeNeedsRecoveryAsync,
  snapshotAndResetDirtyWorktreeAsync,
} from "./worktree-recovery.js";
import { safeSnapshotAndRemoveWorktreeAsync } from "./worktree-safe-remove.js";
import { deleteBranchPreservingTipAsync } from "./worktree-branch-ops.js";
import { pruneRecoveredWorktreeSnapshotsAsync } from "./worktree-snapshots.js";

const HOLDING_STATUSES = new Set(["queued", ...LOCK_HOLDING_JOB_STATUSES]);
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);

function workItemHoldsBench(workItemId) {
  const jobs = listJobsByWorkItem(workItemId);
  return jobs.some((job) => jobNeedsGitWorktree(job) && HOLDING_STATUSES.has(job.status));
}

function clearWorkItemBranchState(wi, { clearMergeState = false } = {}) {
  if (!wi) return;
  setWorkItemBranch(wi.id, null, null);
  if (clearMergeState) setMergeState(wi.id, null);
}

function shouldPreserveUnmergedCompleteAtlasView(wi) {
  return wi?.status === "complete" && wi?.merge_state !== "merged";
}

function shouldDeferBranchBackedCompleteCleanupUntilMerge(wi) {
  return wi?.status === "complete" && !!wi?.branch_name && wi?.merge_state !== "merged";
}

function disposeTerminalWorkItemAtlasGraph(projectDir, wiId, worktreePath = null, options = {}) {
  return disposeWorkItemAtlasGraph({ projectDir, workItemId: wiId, worktreePath, ...options });
}

function shouldDeleteBranchForInactiveWi(wi) {
  if (!wi?.branch_name) return false;
  return wi.status === "canceled" || wi.merge_state === "merged";
}

function gcCleanupBranchPhrase(branchCleanup, { stale = false } = {}) {
  if (branchCleanup?.ok) {
    const branchKind = stale ? "stale branch" : "branch";
    return ` and deleted ${branchKind}${branchCleanup.snapshotRef ? ` (tip saved at ${branchCleanup.snapshotRef})` : ""}`;
  }
  return "";
}

function gcTerminalWorktreeMessage(wi, branchCleanup) {
  const branchMsg = gcCleanupBranchPhrase(branchCleanup);
  if (wi?.merge_state === "merged") {
    return `GC: WI#${wi.id} was already merged; cleaned up leftover worktree${branchMsg}`;
  }
  if (wi?.status === "canceled") {
    return `GC: WI#${wi.id} was canceled; cleaned up leftover worktree${branchMsg}`;
  }
  if (wi?.status === "complete") {
    return `GC: WI#${wi.id} is complete/pending review; cleaned up worktree checkout (branch remains mergeable)${branchMsg}`;
  }
  return `GC: WI#${wi?.id ?? "?"} is ${wi?.status || "terminal"}; cleaned up leftover worktree${branchMsg}`;
}

function gcInactiveWorktreeMessage(wi, branchCleanup) {
  const branchMsg = gcCleanupBranchPhrase(branchCleanup, { stale: true });
  if (wi?.merge_state === "merged") {
    return `GC: WI#${wi.id} was already merged; cleaned up inactive worktree${branchMsg}`;
  }
  if (wi?.status === "canceled") {
    return `GC: WI#${wi.id} was canceled; cleaned up inactive worktree${branchMsg}`;
  }
  return `GC: WI#${wi?.id ?? "?"} inactive (${wi?.status || "nonterminal"}); cleaned up worktree${branchMsg}`;
}

function gcRemovalLabel(label) {
  return String(label || "worktree").trim() || "worktree";
}

function gcSnapshotRemovalCallbacks(wi, {
  wiId,
  reason,
  label,
  onMsg,
}) {
  const cleanupLabel = gcRemovalLabel(label);
  return {
    reason,
    branchName: wi?.branch_name || null,
    wiId,
    preserveCorrupt: true,
    onMsg,
    onSnapshot: ({ snapshotDir, corruptMetadata }) => {
      if (corruptMetadata) {
        onMsg(`GC: preserved corrupt ${cleanupLabel} worktree for WI#${wiId} at ${snapshotDir}`);
      } else {
        onMsg(`GC: preserved ${cleanupLabel} dirty worktree for WI#${wiId} at ${snapshotDir}`);
      }
    },
    onFailure: ({ message }) => {
      onMsg(`GC: failed to clean ${cleanupLabel} worktree for WI#${wiId}: ${message}`);
    },
    onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir: resetSnapshotDir = null }) => {
      const preview = remainingPaths.slice(0, 10).join(", ");
      const more = remainingPaths.length > 10 ? " ..." : "";
      onMsg(`GC: reset incomplete for ${cleanupLabel} WI#${wiId}; remaining path(s): ${preview}${more}`);
      if (postResetPorcelain && resetSnapshotDir) {
        onMsg(`GC: reset incomplete snapshot for ${cleanupLabel} WI#${wiId}: ${resetSnapshotDir}`);
      }
    },
  };
}

async function gcSnapshotAndRemoveWorktreeAsync(projectDir, wtDir, wi, options) {
  const { signal = null } = options || {};
  return safeSnapshotAndRemoveWorktreeAsync(
    wtDir,
    projectDir,
    {
      ...gcSnapshotRemovalCallbacks(wi, options),
      signal,
    },
  );
}

const DEFAULT_RECOVERY_SNAPSHOT_PRUNE_MIN_INTERVAL_MS = 5 * 60 * 1000;
// Narrow runtime throttle: closeout/startup can call GC several times in one
// process, and recovery snapshot pruning walks git refs/notes. Worktree cleanup
// still runs every time; only the expensive snapshot-retention sweep is skipped
// when it just ran for the same project.
const lastRecoverySnapshotPruneAtByProject = new Map();

function recoverySnapshotPruneProjectKey(projectDir) {
  return path.resolve(String(projectDir || process.cwd()));
}

function gcNowMs(nowFn) {
  if (typeof nowFn === "function") {
    const value = Number(nowFn());
    if (Number.isFinite(value)) return value;
  }
  return Date.now();
}

export async function gcWorktreesAsync(projectDir, onMsg = () => {}, {
  signal = null,
  timingSlowMs = null,
  timingNow = null,
  recoveryPruneMinIntervalMs = DEFAULT_RECOVERY_SNAPSHOT_PRUNE_MIN_INTERVAL_MS,
  forceRecoveryPrune = false,
} = {}) {
  const timing = createGcTiming(onMsg, { slowMs: timingSlowMs, now: timingNow });
  try {
    const projectKey = recoverySnapshotPruneProjectKey(projectDir);
    const minIntervalMs = Math.max(0, Number(recoveryPruneMinIntervalMs) || 0);
    const lastPrunedAt = lastRecoverySnapshotPruneAtByProject.get(projectKey) || 0;
    const now = gcNowMs(timingNow);
    if (forceRecoveryPrune || minIntervalMs === 0 || now - lastPrunedAt >= minIntervalMs) {
      await timing.step("recovery snapshot prune", () => pruneRecoveredWorktreeSnapshotsAsync(projectDir, onMsg, { signal }), { gitCwd: projectDir });
      lastRecoverySnapshotPruneAtByProject.set(projectKey, gcNowMs(timingNow));
    }
    throwIfAborted(signal);

    const root = worktreeRoot(projectDir, { disabled: true });
    if (!fs.existsSync(root)) return;

    let entries;
    try {
      entries = await timing.step("worktree root readdir", () => fs.promises.readdir(root));
    } catch {
      return;
    }

    let removed = 0;
    let cleaned = 0;
    let preserved = 0;

    for (const entry of entries) {
      throwIfAborted(signal);
      const wtDir = path.join(root, entry);
      let stat = null;
      try { stat = await timing.step(`stat ${entry}`, () => fs.promises.stat(wtDir)); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const match = entry.match(/^wi-(\d+)(?:-|$)/);
      if (!match) continue;

      const wiId = parseInt(match[1], 10);
      let wi;
      try {
        wi = await timing.step(`WI#${wiId} status lookup`, () => {
          refreshWorkItemStatus(wiId);
          return getWorkItem(wiId);
        });
      } catch {
        continue;
      }

      if (wi && TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status)) {
        if (shouldDeferBranchBackedCompleteCleanupUntilMerge(wi)) {
          onMsg(`GC: skipping terminal worktree cleanup for WI#${wiId}; branch ${wi.branch_name} is pending merge review`);
          continue;
        }
        let holdsBench = false;
        try {
          holdsBench = await timing.step(`WI#${wiId} bench hold lookup`, () => workItemHoldsBench(wiId));
        } catch {
          onMsg(`GC: unable to resolve bench hold for terminal WI#${wiId}; skipping cleanup for this worktree`);
          continue;
        }
        if (holdsBench) {
          onMsg(`GC: skipping terminal worktree cleanup for WI#${wiId}; a job still holds the bench`);
          continue;
        }
        let cleanupResult = null;
        try {
          const atlasDispose = disposeTerminalWorkItemAtlasGraph(projectDir, wiId, wtDir, {
            includeWarmed: !shouldPreserveUnmergedCompleteAtlasView(wi),
          });
          if (atlasDispose?.deferredInUse) {
            onMsg(`GC: WI#${wiId} ATLAS view DB still in use; deferring its delete to the next GC (${(atlasDispose.errors || []).filter((e) => e.inUse).map((e) => e.path).join(", ")})`);
          }
          cleanupResult = await timing.step(`terminal WI#${wiId} snapshot/remove`, () => gcSnapshotAndRemoveWorktreeAsync(projectDir, wtDir, wi, {
            wiId,
            reason: "startup-gc-terminal-worktree",
            label: "terminal",
            onMsg,
            signal,
          }), { gitCwd: wtDir });
        } catch (err) {
          if (isAbortError(err)) throw err;
          onMsg(`GC: failed to clean terminal worktree for WI#${wiId}: ${err?.message || err}`);
          continue;
        }
        if (cleanupResult?.snapshotDir) preserved++;
        if (cleanupResult?.skipped || (cleanupResult?.existed && !cleanupResult?.removed)) continue;
        const shouldDeleteBranch = shouldDeleteBranchForInactiveWi(wi);
        let branchCleanup = null;
        if (shouldDeleteBranch && wi.branch_name) {
          branchCleanup = await timing.step(`WI#${wiId} branch cleanup`, () => deleteBranchPreservingTipAsync(projectDir, wi.branch_name, {
            reason: wi.status === "canceled" ? "startup-gc-canceled-branch" : "startup-gc-merged-branch",
            wiId,
            onMsg,
            signal,
          }), { gitCwd: projectDir });
          if (branchCleanup.ok) {
            clearWorkItemBranchState(wi, { clearMergeState: wi.status === "canceled" });
          } else {
            onMsg(`GC: retained WI#${wiId} branch ${wi.branch_name} (${branchCleanup.reason})`);
          }
        }
        const ctxDir = contextDir(wiScopeId(wiId), projectDir);
        try { await timing.step(`WI#${wiId} context cleanup`, () => fs.promises.rm(ctxDir, { recursive: true, force: true })); } catch {}
        removed++;
        onMsg(gcTerminalWorktreeMessage(wi, branchCleanup));
      } else {
        let holdsBench = false;
        try {
          holdsBench = await timing.step(`WI#${wiId} bench hold lookup`, () => workItemHoldsBench(wiId));
        } catch {
          onMsg(`GC: unable to resolve bench hold for WI#${wiId}; skipping cleanup for this worktree`);
          continue;
        }
        if (!holdsBench) {
          let cleanupResult = null;
          try {
            const atlasDispose = disposeTerminalWorkItemAtlasGraph(projectDir, wiId, wtDir);
            if (atlasDispose?.deferredInUse) {
              onMsg(`GC: WI#${wiId} ATLAS view DB still in use; deferring its delete to the next GC (${(atlasDispose.errors || []).filter((e) => e.inUse).map((e) => e.path).join(", ")})`);
            }
            cleanupResult = await timing.step(`inactive WI#${wiId} snapshot/remove`, () => gcSnapshotAndRemoveWorktreeAsync(projectDir, wtDir, wi, {
              wiId,
              reason: "startup-gc-inactive-worktree",
              label: "inactive",
              onMsg,
              signal,
            }), { gitCwd: wtDir });
          } catch (err) {
            if (isAbortError(err)) throw err;
            onMsg(`GC: failed to clean inactive worktree for WI#${wiId}: ${err?.message || err}`);
            continue;
          }
          if (cleanupResult?.snapshotDir) preserved++;
          if (cleanupResult?.skipped || (cleanupResult?.existed && !cleanupResult?.removed)) continue;
          const staleBranch = wi?.branch_name || null;
          const shouldDeleteBranch = shouldDeleteBranchForInactiveWi(wi);
          let branchCleanup = null;
          if (staleBranch && shouldDeleteBranch) {
            branchCleanup = await timing.step(`WI#${wiId} branch cleanup`, () => deleteBranchPreservingTipAsync(projectDir, staleBranch, {
              reason: wi.status === "canceled" ? "startup-gc-canceled-inactive-branch" : "startup-gc-merged-inactive-branch",
              wiId,
              onMsg,
              signal,
            }), { gitCwd: projectDir });
            if (branchCleanup.ok) {
              clearWorkItemBranchState(wi, { clearMergeState: wi.merge_state === "merged" });
            } else {
              onMsg(`GC: retained WI#${wiId} branch ${staleBranch} (${branchCleanup.reason})`);
            }
          } else if (staleBranch) {
            onMsg(`GC: retained WI#${wiId} branch ${staleBranch} (merge_state=${wi?.merge_state || "null"})`);
          }
          const ctxDir = contextDir(wiScopeId(wiId), projectDir);
          try { await timing.step(`WI#${wiId} context cleanup`, () => fs.promises.rm(ctxDir, { recursive: true, force: true })); } catch {}
          removed++;
          onMsg(gcInactiveWorktreeMessage(wi, branchCleanup));
          continue;
        } else {
          try {
            if (await timing.step(`held WI#${wiId} dirty check`, () => worktreeNeedsRecoveryAsync(wtDir, { signal }), { gitCwd: wtDir })) {
              const snapshotDir = await timing.step(`held WI#${wiId} snapshot/reset`, () => snapshotAndResetDirtyWorktreeAsync(wtDir, projectDir, {
                reason: "startup-gc-dirty-worktree",
                branchName: wi?.branch_name || null,
                wiId,
                onMsg,
                signal,
                onResetIncomplete: ({ remainingPaths = [] }) => {
                  const preview = remainingPaths.slice(0, 10).join(", ");
                  const more = remainingPaths.length > 10 ? " ..." : "";
                  onMsg(`GC: reset incomplete for held WI#${wiId}; remaining path(s): ${preview}${more}`);
                },
              }), { gitCwd: wtDir });
              if (snapshotDir) {
                preserved++;
                onMsg(`GC: preserved dirty worktree for WI#${wiId} at ${snapshotDir}`);
              }
              cleaned++;
            }
          } catch (err) {
            if (isAbortError(err)) throw err;
            onMsg(`GC: failed to clean held worktree for WI#${wiId}: ${err?.message || err}`);
          }
        }
      }
    }

    try { await timing.step("git worktree prune", () => gitExecAsync(["worktree", "prune"], projectDir, { signal }), { gitCwd: projectDir }); } catch (err) { if (isAbortError(err)) throw err; }

    if (removed > 0 || cleaned > 0 || preserved > 0) {
      onMsg(`GC: cleaned up ${removed} leftover worktree(s), reset ${cleaned} held dirty worktree(s), preserved ${preserved} snapshot(s)`);
    }
  } finally {
    timing.finish();
  }
}
