// lib/domains/worker/functions/helpers/shared-worktree-reset.js
//
// The snapshot-and-reset that a job's failure or cleanup path runs in its
// work item's worktree, which every job of the work item shares. A running
// sibling holds write locks, and the reset defers to it. A sibling parked for
// the operator, for review, or blocked has released its locks but still owns
// the uncommitted edits it left there (sweep 5 W1, 2026-11-18: a failed
// attempt erased a scope-paused sibling's work). Those paths are kept; the
// rest of the dirt is snapshotted and reset. The shutdown sweep runs the
// synchronous twin.

import fs from "fs";
import path from "path";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { gitExec, gitExecAsync, gitHasChanges, gitHasChangesAsync } from "../../../git/functions/utils.js";
import {
  isMergeInProgressAsync,
  preserveDirtyWorktreeSnapshot,
  preserveDirtyWorktreeSnapshotAsync,
  restorePathsToTree,
  restorePathsToTreeAsync,
  snapshotAndResetDirtyWorktree,
  snapshotAndResetDirtyWorktreeAsync,
  withWorktreeLock,
  withWorktreeLockAsync,
} from "../../../git/functions/worktree.js";
import { getWorkItem, logEvent } from "../../../queue/functions/index.js";
import { activeSiblingWriteLocks, siblingLockSummary } from "../../../queue/functions/sibling-locks.js";
import { parsePorcelainEntries, unfinishedSiblingDirtOwners } from "./worktree-dirty-classification.js";

const DIRTY_STATUS_ARGS = ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"];

function logCleanupDeferred(job, { label, attemptId, detail, locks }) {
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Deferred ${label} dirty cleanup; ${detail}`,
    event_json: JSON.stringify({ locks: locks.slice(0, 20) }),
  });
  log.info("worker", `Deferred ${label} dirty cleanup for job #${job.id}; sibling locks: ${siblingLockSummary(locks)}`);
}

// Dirty paths as Git names them, from the repository root, each with the
// project-relative path that scope and sibling ownership use. The project can
// be nested in its repository; a path outside it has no project path.
function describeDirtyPaths(porcelain, prefix) {
  const projectPrefix = String(prefix || "").trim();
  const files = [...new Set(parsePorcelainEntries(porcelain).map((entry) => entry.path))];
  return {
    porcelain: String(porcelain || "").replace(/\0/g, "\n"),
    paths: files.map((file) => ({
      file,
      projectPath: !projectPrefix ? file : file.startsWith(projectPrefix) ? file.slice(projectPrefix.length) : null,
    })),
  };
}

async function dirtyWorktreePathsAsync(wtPath, signal) {
  const [porcelain, prefix] = await Promise.all([
    gitExecAsync(DIRTY_STATUS_ARGS, wtPath, { signal, trim: false }),
    gitExecAsync(["rev-parse", "--show-prefix"], wtPath, { signal }),
  ]);
  return describeDirtyPaths(porcelain, prefix);
}

function dirtyWorktreePaths(wtPath) {
  return describeDirtyPaths(
    gitExec(DIRTY_STATUS_ARGS, wtPath, { trim: false }),
    gitExec(["rev-parse", "--show-prefix"], wtPath),
  );
}

// Live locks of same-WI jobs other than this one and `selfJobIds`.
function foreignActiveLocks(job, selfJobIds) {
  const self = new Set(selfJobIds.map(Number));
  return activeSiblingWriteLocks(job).filter((lock) => !self.has(Number(lock.job_id)));
}

// Which dirty paths stay because an unfinished sibling that has run owns
// them. `selfJobIds` are further same-WI jobs this reset is for, none of
// which keeps its files from the others. An unfinished sibling that has run
// with unknown scope may own any of them, so `unknownScopeIds` keeps all.
function planSharedReset(job, dirty, selfJobIds) {
  const { siblingLocks, unknownScopeIds } = unfinishedSiblingDirtOwners(
    job,
    dirty.paths.map((entry) => entry.projectPath).filter(Boolean),
    { selfJobIds },
  );
  if (unknownScopeIds.length > 0) {
    return { siblingLocks, keptPaths: dirty.paths.map((entry) => entry.file), resetPaths: [], unknownScopeIds };
  }
  const siblingPaths = new Set(siblingLocks.map((lock) => lock.path));
  const keptPaths = dirty.paths.filter((entry) => siblingPaths.has(entry.projectPath)).map((entry) => entry.file);
  const kept = new Set(keptPaths);
  return { siblingLocks, keptPaths, resetPaths: dirty.paths.map((entry) => entry.file).filter((file) => !kept.has(file)), unknownScopeIds };
}

function logPlanDeferred(job, plan, { label, attemptId, mergeInProgress }) {
  const owners = new Set(plan.siblingLocks.map((lock) => lock.job_id)).size;
  logCleanupDeferred(job, {
    label,
    attemptId,
    locks: plan.siblingLocks,
    detail: plan.unknownScopeIds.length > 0
      ? `unfinished same-WI job(s) ${plan.unknownScopeIds.map((id) => `#${id}`).join(", ")} have run with unknown scope`
      : mergeInProgress
      ? `a merge is in progress and ${plan.keptPaths.length} dirty path(s) belong to ${owners} unfinished same-WI job(s)`
      : `every dirty path belongs to ${owners} unfinished same-WI job(s)`,
  });
}

function scopedResetIncompleteError({ wtPath, snapshotDir, remainingPaths, operationErrors }) {
  const error = new Error(`Worktree reset incomplete for ${wtPath}: ${remainingPaths.length} path(s) remain dirty: ${remainingPaths.slice(0, 10).join(", ")}`);
  error.code = "WORKTREE_RESET_INCOMPLETE";
  error.snapshotDir = snapshotDir;
  error.remainingPaths = remainingPaths;
  error.operationErrors = operationErrors;
  return error;
}

// After a path reset: throw when a reset path is still dirty.
function settlePathReset(after, resetPaths, failed, { wtPath, projectDir, reason, branchName, wiId, snapshotDir, onResetIncomplete }) {
  const reset = new Set(resetPaths);
  const remainingPaths = after.paths.map((entry) => entry.file).filter((file) => reset.has(file));
  if (failed.length === 0 && remainingPaths.length === 0) return;
  const operationErrors = failed.map((file) => `could not restore ${file}`);
  try {
    onResetIncomplete?.({
      wtPath, projectDir, reason, branchName, wiId, snapshotDir,
      remainingPaths, postResetPorcelain: after.porcelain, operationErrors,
    });
  } catch {
    // Recovery notifications stay best-effort.
  }
  throw scopedResetIncompleteError({ wtPath, snapshotDir, remainingPaths, operationErrors });
}

/**
 * With the worktree lock held: snapshot the whole checkout, then put
 * `resetPaths` (named from the repository root) back to HEAD. Resolves to the
 * snapshot; throws with `snapshotDir` set when a path stays dirty.
 */
export async function snapshotAndRestorePathsAsync(wtPath, projectDir, resetPaths, {
  reason, branchName = null, wiId = null, onMsg = null, onResetIncomplete = null, signal = null,
} = {}) {
  // The snapshot is of the whole checkout, whose root wtPath is not when
  // the project is nested.
  const gitRoot = String(await gitExecAsync(["rev-parse", "--show-toplevel"], wtPath, { signal }) || "").trim();
  const snapshotDir = await preserveDirtyWorktreeSnapshotAsync(gitRoot, projectDir, { reason, branchName, wiId, onMsg, signal });
  if (!snapshotDir) {
    throw new Error(`Dirty worktree snapshot failed before resetting ${resetPaths.length} path(s)`);
  }
  const failed = await restorePathsToTreeAsync(wtPath, resetPaths, "HEAD", { signal });
  settlePathReset(await dirtyWorktreePathsAsync(wtPath, signal), resetPaths, failed, {
    wtPath, projectDir, reason, branchName, wiId, snapshotDir, onResetIncomplete,
  });
  return snapshotDir;
}

function snapshotAndRestorePaths(wtPath, projectDir, resetPaths, {
  reason, branchName = null, wiId = null, onMsg = null, onResetIncomplete = null,
} = {}) {
  const gitRoot = String(gitExec(["rev-parse", "--show-toplevel"], wtPath) || "").trim();
  const snapshotDir = preserveDirtyWorktreeSnapshot(gitRoot, projectDir, { reason, branchName, wiId, onMsg });
  if (!snapshotDir) {
    throw new Error(`Dirty worktree snapshot failed before resetting ${resetPaths.length} path(s)`);
  }
  const failed = restorePathsToTree(wtPath, resetPaths, "HEAD");
  settlePathReset(dirtyWorktreePaths(wtPath), resetPaths, failed, {
    wtPath, projectDir, reason, branchName, wiId, snapshotDir, onResetIncomplete,
  });
  return snapshotDir;
}

function logScopedReset(job, plan, { reason, label, attemptId, snapshotDir }) {
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    event_type: EVENT_TYPES.WORKTREE_DIRTY_RECOVERED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Reset ${plan.resetPaths.length} ${label} dirty path(s) after snapshot; kept ${plan.keptPaths.length} owned by unfinished same-WI job(s)`,
    event_json: JSON.stringify({
      reason,
      reset_paths: plan.resetPaths.slice(0, 100),
      sibling_locks: plan.siblingLocks.slice(0, 20),
      snapshot_dir: snapshotDir,
    }),
  });
}

// A merge in progress, read without spawning the native async path. Unknown
// counts as in progress, so the caller keeps the tree.
function mergeInProgressSync(wtPath) {
  try {
    const mergeHead = String(gitExec(["rev-parse", "--git-path", "MERGE_HEAD"], wtPath) || "").trim();
    return fs.existsSync(path.resolve(wtPath, mergeHead));
  } catch {
    return true;
  }
}

/**
 * Snapshot the dirty worktree and reset this job's part of it. Resolves to
 * `{ snapshotDir, deferred, keptPaths }`: nothing dirty gives a null
 * snapshot; an active sibling lock, or dirt that all belongs to unfinished
 * siblings, defers with nothing touched. Throws like
 * `snapshotAndResetDirtyWorktreeAsync`, with `snapshotDir` set on an
 * incomplete reset. `selfJobIds` names other same-WI jobs whose dirt this
 * reset is also for (the shutdown sweep's jobs in the tree).
 */
export async function snapshotAndResetSharedWorktreeAsync(job, wtPath, projectDir, {
  reason,
  label = "dirty-worktree",
  attemptId = null,
  onMsg = null,
  onResetIncomplete = null,
  signal = null,
  selfJobIds = [],
  worktreeLockWaitMs = null,
} = {}) {
  const untouched = { snapshotDir: null, deferred: false, keptPaths: [] };
  if (!wtPath || !(await gitHasChangesAsync(wtPath, { signal }))) return untouched;
  const activeLocks = foreignActiveLocks(job, selfJobIds);
  if (activeLocks.length > 0) {
    logCleanupDeferred(job, { label, attemptId, locks: activeLocks, detail: `${activeLocks.length} same-WI job lock(s) still active` });
    return { ...untouched, deferred: true };
  }
  const wiId = job.work_item_id;
  const branchName = getWorkItem(wiId)?.branch_name || null;
  return withWorktreeLockAsync(wtPath, projectDir, async () => {
    const plan = planSharedReset(job, await dirtyWorktreePathsAsync(wtPath, signal), selfJobIds);
    if (plan.keptPaths.length === 0) {
      const snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, projectDir, {
        reason, branchName, wiId, onMsg, onResetIncomplete, signal, lock: false,
      });
      return { ...untouched, snapshotDir };
    }
    // A whole-worktree reset would abort a merge in progress; a path reset
    // cannot, so the merge and every path stay for setup recovery.
    const mergeInProgress = plan.resetPaths.length > 0 && await isMergeInProgressAsync(wtPath, { signal });
    if (plan.resetPaths.length === 0 || mergeInProgress) {
      logPlanDeferred(job, plan, { label, attemptId, mergeInProgress });
      return { ...untouched, deferred: true, keptPaths: plan.keptPaths };
    }
    const snapshotDir = await snapshotAndRestorePathsAsync(wtPath, projectDir, plan.resetPaths, {
      reason, branchName, wiId, onMsg, onResetIncomplete, signal,
    });
    logScopedReset(job, plan, { reason, label, attemptId, snapshotDir });
    return { snapshotDir, deferred: false, keptPaths: plan.keptPaths };
  }, { signal, waitMs: worktreeLockWaitMs });
}

/** Synchronous twin of `snapshotAndResetSharedWorktreeAsync`. */
export function snapshotAndResetSharedWorktree(job, wtPath, projectDir, {
  reason,
  label = "dirty-worktree",
  attemptId = null,
  onMsg = null,
  onResetIncomplete = null,
  selfJobIds = [],
  worktreeLockWaitMs = null,
} = {}) {
  const untouched = { snapshotDir: null, deferred: false, keptPaths: [] };
  if (!wtPath || !fs.existsSync(wtPath) || !gitHasChanges(wtPath)) return untouched;
  const activeLocks = foreignActiveLocks(job, selfJobIds);
  if (activeLocks.length > 0) {
    logCleanupDeferred(job, { label, attemptId, locks: activeLocks, detail: `${activeLocks.length} same-WI job lock(s) still active` });
    return { ...untouched, deferred: true };
  }
  const wiId = job.work_item_id;
  const branchName = getWorkItem(wiId)?.branch_name || null;
  return withWorktreeLock(wtPath, projectDir, () => {
    const plan = planSharedReset(job, dirtyWorktreePaths(wtPath), selfJobIds);
    if (plan.keptPaths.length === 0) {
      const snapshotDir = snapshotAndResetDirtyWorktree(wtPath, projectDir, {
        reason, branchName, wiId, onMsg, onResetIncomplete, lock: false,
      });
      return { ...untouched, snapshotDir };
    }
    const mergeInProgress = plan.resetPaths.length > 0 && mergeInProgressSync(wtPath);
    if (plan.resetPaths.length === 0 || mergeInProgress) {
      logPlanDeferred(job, plan, { label, attemptId, mergeInProgress });
      return { ...untouched, deferred: true, keptPaths: plan.keptPaths };
    }
    const snapshotDir = snapshotAndRestorePaths(wtPath, projectDir, plan.resetPaths, {
      reason, branchName, wiId, onMsg, onResetIncomplete,
    });
    logScopedReset(job, plan, { reason, label, attemptId, snapshotDir });
    return { snapshotDir, deferred: false, keptPaths: plan.keptPaths };
  }, { waitMs: worktreeLockWaitMs });
}
