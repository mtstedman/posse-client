// lib/domains/git/functions/worktree-gc.js
//
// Startup/closeout garbage collection of worker worktrees: prunes recovery
// snapshots (throttled per project), then walks the worktree root and, per WI,
// snapshots + removes terminal/inactive checkouts, resets held dirty worktrees,
// and deletes/retains branches per merge state. Work-item state predicates and
// GC message formatters live here too.

import fs from "fs";
import path from "path";
import { ACTIVE_LEASE_STATUSES, LOCK_HOLDING_JOB_STATUSES, TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import {
  clearWaitingLanePreparedAssetProof,
  getWaitingLanePreparation,
  getWorkItem,
  listJobsByWorkItem,
  poisonWaitingLanePreparation,
  refreshWorkItemStatus,
  retireWaitingLanePreparation,
  setMergeState,
  setWorkItemBranch,
} from "../../queue/functions/index.js";
import { throwIfAborted, isAbortError } from "../../runtime/functions/yield.js";
import { jobNeedsGitWorktree } from "./policy.js";
import { contextDir, wiScopeId } from "../../artifacts/functions/index.js";
import {
  disposeWorkItemAtlasGraph,
  resolveWorkItemAtlasContext,
} from "../../integrations/functions/atlas.js";
import { recordWaitingLaneTelemetry } from "../../observability/functions/waiting-lane-telemetry.js";
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
import { removePreparedWorktreeIfSafeAsync } from "./prepared-worktree-recovery.js";
import { selectWaitingLaneEvictionCandidates } from "../../scheduler/functions/waiting-lane-coordinator.js";
import { tombstoneWaitingLanePreparationForCleanup } from "./waiting-lane-cleanup.js";

const HOLDING_STATUSES = new Set(["queued", ...LOCK_HOLDING_JOB_STATUSES]);
const ACTIVE_LEASE_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);

function workItemHoldsBench(workItemId) {
  const jobs = listJobsByWorkItem(workItemId);
  return jobs.some((job) => jobNeedsGitWorktree(job) && HOLDING_STATUSES.has(job.status));
}

// Leased/running jobs may have a live agent writing to the worktree right now
// (agents hold no worktree lock during provider execution), so the held-path
// reset below must not touch them. Queued/blocked holders only park stale
// dirt from an earlier attempt — that reset is the designed recovery.
function workItemHasActiveLease(workItemId) {
  const jobs = listJobsByWorkItem(workItemId);
  return jobs.some((job) => jobNeedsGitWorktree(job) && ACTIVE_LEASE_STATUS_SET.has(job.status));
}

async function preparedWaitingLaneGcAction(projectDir, wi, wtDir, preparation, onMsg, { signal = null } = {}) {
  if (!preparation) return { handled: false, removed: false, preserved: false };
  if (preparation.state === "poisoned") {
    onMsg(`GC: preserving poisoned prepared worktree for WI#${preparation.work_item_id}`);
    return { handled: true, removed: false, preserved: true };
  }
  if (preparation.state === "active") {
    const transition = retireWaitingLanePreparation({
      workItemId: preparation.work_item_id,
      expectedVersion: preparation.version,
      reason: "gc_terminal_active_cleanup",
    });
    return transition.preparation?.state === "retired"
      ? { handled: false, removed: false, preserved: false }
      : { handled: true, removed: false, preserved: false };
  }
  if (wi?.branch_name) {
    const tombstone = await tombstoneWaitingLanePreparationForCleanup(preparation, { signal });
    if (!tombstone.ready) {
      onMsg(`GC: deferred branch-backed waiting-lane cleanup for WI#${preparation.work_item_id}; child settlement is incomplete`);
      return { handled: true, removed: false, preserved: false };
    }
    return { handled: false, removed: false, preserved: false };
  }
  const wiTerminal = !!wi && TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status);
  if (preparation.state !== "retired" && !wiTerminal) {
    onMsg(`GC: holding prepared waiting-lane worktree for WI#${preparation.work_item_id} (state=${preparation.state})`);
    return { handled: true, removed: false, preserved: false };
  }
  const tombstone = await tombstoneWaitingLanePreparationForCleanup(preparation, { signal });
  if (!tombstone.ready) {
    onMsg(`GC: deferred prepared waiting-lane cleanup for WI#${preparation.work_item_id}; child settlement is incomplete`);
    return { handled: true, removed: false, preserved: false };
  }
  preparation = tombstone.preparation;
  const root = path.resolve(preparation.worktree_root || wtDir);
  if (!preparation.ownership_record_id) {
    if (fs.existsSync(root)) {
      poisonWaitingLanePreparation({
        workItemId: preparation.work_item_id,
        expectedVersion: preparation.version,
        reason: "gc_missing_prepared_ownership_record",
      });
      onMsg(`GC: preserving prepared worktree for WI#${preparation.work_item_id}; ownership record is missing`);
      return { handled: true, removed: false, preserved: true };
    }
    clearWaitingLanePreparedAssetProof({
      workItemId: preparation.work_item_id,
      expectedVersion: preparation.version,
    });
    return { handled: true, removed: false, preserved: false };
  }
  const removal = await removePreparedWorktreeIfSafeAsync({
    projectDir,
    worktreeRoot: root,
    preparationId: preparation.ownership_record_id,
    expectedOid: preparation.applied_git_oid || preparation.desired_git_oid,
    signal,
  });
  if (!removal.removed && removal.preserve) {
    poisonWaitingLanePreparation({
      workItemId: preparation.work_item_id,
      expectedVersion: preparation.version,
      reason: `gc_preserved:${String(removal.reason || "inspection_mismatch").slice(0, 800)}`,
    });
    onMsg(`GC: preserving unexpected prepared worktree state for WI#${preparation.work_item_id} (${removal.reason})`);
    return { handled: true, removed: false, preserved: true };
  }
  if (!fs.existsSync(root)) {
    clearWaitingLanePreparedAssetProof({
      workItemId: preparation.work_item_id,
      expectedVersion: preparation.version,
    });
  }
  disposeTerminalWorkItemAtlasGraph(projectDir, preparation.work_item_id, root);
  if (removal.removed) onMsg(`GC: removed durably selected prepared worktree for WI#${preparation.work_item_id}`);
  return { handled: true, removed: removal.removed, preserved: false };
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
    onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir: resetSnapshotDir = null, operationErrors = [] }) => {
      const preview = remainingPaths.slice(0, 10).join(", ");
      const more = remainingPaths.length > 10 ? " ..." : "";
      onMsg(`GC: reset incomplete for ${cleanupLabel} WI#${wiId}; ${remainingPaths.length} remaining path(s), ${operationErrors.length} operation error(s)${preview ? `: ${preview}${more}` : ""}`);
      for (const operationError of operationErrors.slice(0, 3)) {
        onMsg(`GC: reset operation failed for ${cleanupLabel} WI#${wiId}: ${operationError}`);
      }
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

function measureWaitingLaneDiskBytes(targets, maxEntries = 100_000) {
  const pending = [...new Set(targets.filter(Boolean).map((target) => path.resolve(target)))];
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  while (pending.length > 0) {
    if (entries >= maxEntries) {
      truncated = true;
      break;
    }
    const target = pending.pop();
    let stat;
    try { stat = fs.lstatSync(target); } catch { continue; }
    entries++;
    bytes += Math.max(0, Number(stat.size) || 0);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let children = [];
    try { children = fs.readdirSync(target); } catch { continue; }
    for (const child of children) pending.push(path.join(target, child));
  }
  return { bytes, entries, truncated };
}

/**
 * Apply durable cap/TTL selection and physically retire only the exact rows
 * selected by that CAS. Ordinary worktree GC is intentionally excluded so a
 * scheduler cadence can run waiting-lane maintenance independently.
 */
export async function evictWaitingLanePreparationsAsync(projectDir, onMsg = () => {}, {
  signal = null,
  timingNow = null,
} = {}) {
  let removed = 0;
  let preserved = 0;
  const selectedPreparationIds = new Set();
  let evictionCandidates = [];
  try {
    evictionCandidates = selectWaitingLaneEvictionCandidates({ nowMs: gcNowMs(timingNow) });
  } catch (error) {
    onMsg(`GC: waiting-lane eviction selection unavailable (${error?.message || error})`);
  }
  for (const candidate of evictionCandidates) {
    throwIfAborted(signal);
    const transition = retireWaitingLanePreparation({
      workItemId: candidate.workItemId,
      expectedVersion: candidate.expectedVersion,
      reason: candidate.reason,
    });
    if (transition.outcome !== "retired" || transition.preparation?.state !== "retired") {
      onMsg(`GC: skipped waiting-lane eviction for WI#${candidate.workItemId}; state CAS ${transition.outcome}`);
      continue;
    }
    const preparation = transition.preparation;
    onMsg(`GC: durably selected waiting-lane WI#${candidate.workItemId} for ${candidate.reason}`);
    let wi = null;
    try { wi = getWorkItem(candidate.workItemId); } catch { /* row may already be gone */ }
    let warmedViewDbPath = null;
    try {
      warmedViewDbPath = resolveWorkItemAtlasContext({
        projectDir,
        worktreePath: preparation.worktree_root,
        workItemId: candidate.workItemId,
      })?.warmedViewDbPath || null;
    } catch { /* disk telemetry is observational */ }
    const worktreeDisk = measureWaitingLaneDiskBytes([preparation.worktree_root]);
    const viewDisk = measureWaitingLaneDiskBytes([
      warmedViewDbPath,
      warmedViewDbPath ? `${warmedViewDbPath}-wal` : null,
      warmedViewDbPath ? `${warmedViewDbPath}-shm` : null,
    ]);
    try {
      const action = await preparedWaitingLaneGcAction(
        projectDir,
        wi,
        preparation.worktree_root,
        preparation,
        onMsg,
        { signal },
      );
      selectedPreparationIds.add(Number(candidate.workItemId));
      if (action.removed) removed++;
      if (action.preserved) preserved++;
      recordWaitingLaneTelemetry("eviction_finished", {
        preparation,
        workItemId: candidate.workItemId,
        outcome: action.preserved ? "preserved" : (action.removed ? "removed" : "retired"),
        reason: candidate.reason,
        worktreeDiskBytes: worktreeDisk.bytes,
        viewDiskBytes: viewDisk.bytes,
        diskMeasurementTruncated: worktreeDisk.truncated || viewDisk.truncated,
        counts: {
          selected: 1,
          removed: action.removed ? 1 : 0,
          preserved: action.preserved ? 1 : 0,
        },
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      selectedPreparationIds.add(Number(candidate.workItemId));
      onMsg(`GC: failed durably selected waiting-lane eviction for WI#${candidate.workItemId}: ${error?.message || error}`);
    }
  }
  return { removed, preserved, selectedPreparationIds };
}

export async function gcWorktreesAsync(projectDir, onMsg = () => {}, {
  signal = null,
  timingSlowMs = null,
  timingNow = null,
  recoveryPruneMinIntervalMs = DEFAULT_RECOVERY_SNAPSHOT_PRUNE_MIN_INTERVAL_MS,
} = {}) {
  const timing = createGcTiming(onMsg, { slowMs: timingSlowMs, now: timingNow });
  try {
    let removed = 0;
    let cleaned = 0;
    let preserved = 0;
    const projectKey = recoverySnapshotPruneProjectKey(projectDir);
    const minIntervalMs = Math.max(0, Number(recoveryPruneMinIntervalMs) || 0);
    const lastPrunedAt = lastRecoverySnapshotPruneAtByProject.get(projectKey) || 0;
    const now = gcNowMs(timingNow);
    if (minIntervalMs === 0 || now - lastPrunedAt >= minIntervalMs) {
      // Retention must finish before this pass starts creating/reusing recovery
      // refs and deleting their source branches. Running both lanes together
      // lets pruning remove a ref while branch cleanup still trusts it.
      await timing.step("recovery snapshot prune", () => pruneRecoveredWorktreeSnapshotsAsync(projectDir, onMsg, { signal }), { gitCwd: projectDir });
      lastRecoverySnapshotPruneAtByProject.set(projectKey, gcNowMs(timingNow));
    }
    throwIfAborted(signal);

    const eviction = await evictWaitingLanePreparationsAsync(projectDir, onMsg, { signal, timingNow });
    removed += eviction.removed;
    preserved += eviction.preserved;
    const selectedPreparationIds = eviction.selectedPreparationIds;

    const root = worktreeRoot(projectDir, { disabled: true });
    if (!fs.existsSync(root)) {
      if (removed > 0 || preserved > 0) {
        onMsg(`GC: cleaned up ${removed} leftover worktree(s), reset 0 held dirty worktree(s), preserved ${preserved} snapshot(s)`);
      }
      return;
    }

    let entries;
    try {
      entries = await timing.step("worktree root readdir", () => fs.promises.readdir(root));
    } catch {
      return;
    }

    for (const entry of entries) {
      throwIfAborted(signal);
      const wtDir = path.join(root, entry);
      let stat = null;
      try { stat = await timing.step(`stat ${entry}`, () => fs.promises.stat(wtDir)); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const match = entry.match(/^wi-(\d+)(?:-|$)/);
      if (!match) continue;

      const wiId = parseInt(match[1], 10);
      if (selectedPreparationIds.has(wiId)) continue;
      let wi;
      try {
        wi = await timing.step(`WI#${wiId} status lookup`, () => {
          refreshWorkItemStatus(wiId);
          return getWorkItem(wiId);
        });
      } catch {
        continue;
      }

      let waitingPreparation = null;
      try {
        waitingPreparation = getWaitingLanePreparation(wiId);
      } catch {
        waitingPreparation = null;
      }
      if (waitingPreparation) {
        let preparedAction;
        try {
          preparedAction = await preparedWaitingLaneGcAction(
            projectDir,
            wi,
            wtDir,
            waitingPreparation,
            onMsg,
            { signal },
          );
        } catch (err) {
          if (isAbortError(err)) throw err;
          onMsg(`GC: failed prepared waiting-lane inspection for WI#${wiId}: ${err?.message || err}`);
          continue;
        }
        if (preparedAction.handled) {
          if (preparedAction.removed) removed++;
          if (preparedAction.preserved) preserved++;
          continue;
        }
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
            if (workItemHasActiveLease(wiId)) {
              onMsg(`GC: skipped dirty check for held WI#${wiId}; a leased/running job may be writing to the worktree`);
              continue;
            }
            if (await timing.step(`held WI#${wiId} dirty check`, () => worktreeNeedsRecoveryAsync(wtDir, { signal }), { gitCwd: wtDir })) {
              const snapshotDir = await timing.step(`held WI#${wiId} snapshot/reset`, () => snapshotAndResetDirtyWorktreeAsync(wtDir, projectDir, {
                reason: "startup-gc-dirty-worktree",
                branchName: wi?.branch_name || null,
                wiId,
                onMsg,
                signal,
                onResetIncomplete: ({ remainingPaths = [], operationErrors = [] }) => {
                  const preview = remainingPaths.slice(0, 10).join(", ");
                  const more = remainingPaths.length > 10 ? " ..." : "";
                  onMsg(`GC: reset incomplete for held WI#${wiId}; ${remainingPaths.length} remaining path(s), ${operationErrors.length} operation error(s)${preview ? `: ${preview}${more}` : ""}`);
                  for (const operationError of operationErrors.slice(0, 3)) {
                    onMsg(`GC: reset operation failed for held WI#${wiId}: ${operationError}`);
                  }
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
