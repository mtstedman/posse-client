// lib/domains/git/functions/worktree-recovery.js
//
// Dirty-worktree recovery: porcelain inspection, dirty/ignored-change detection,
// untracked cleaning, hard reset (with merge/rebase/cherry-pick/revert abort),
// stash + fallback reset, corrupt-metadata content preservation, and the
// snapshot-then-reset orchestration used before reuse and removal.

import fs from "fs";
import path from "path";
import { isAbortError } from "../../runtime/functions/yield.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import {
  gitExec,
  gitExecAsync,
  gitHasChanges,
  gitHasChangesAsync,
  gitHasIgnoredChanges,
} from "./utils.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  worktreeLockPath,
  gitStashLockPathAsync,
  withWorktreeLockAsync,
} from "./worktree-locks.js";
import {
  dirtySnapshotNativePayload,
  parseBooleanSetting,
  snapshotRefFromNative,
} from "./worktree-snapshots.js";
import { worktreeRoot } from "./worktree-path.js";

export async function worktreePorcelainAsync(wtPath, { signal = null } = {}) {
  return (await gitExecAsync(["status", "--porcelain"], wtPath, { signal })).trim();
}

// Fail closed: callers treat "clean" as "leave the worktree alone", so an
// unreadable/corrupt worktree is never reset. Log it so corruption isn't
// silently invisible.
function logDirtyCheckFailure(wtPath, err) {
  log.warn("git", "Worktree dirty-state check failed; treating as clean (no recovery)", {
    wtPath,
    error: err?.message || String(err),
  });
}

export function worktreeNeedsRecovery(wtPath) {
  try {
    return gitHasChanges(wtPath)
      || (parseBooleanSetting("worktree_clean_ignored", false) && gitHasIgnoredChanges(wtPath));
  } catch (err) {
    logDirtyCheckFailure(wtPath, err);
    return false;
  }
}

export async function worktreeNeedsRecoveryAsync(wtPath, options = {}) {
  try {
    return await worktreeHasChangesNodeAsync(wtPath, options)
      || (parseBooleanSetting("worktree_clean_ignored", false) && await worktreeHasIgnoredChangesNodeAsync(wtPath, options));
  } catch (err) {
    if (isAbortError(err)) throw err;
    // strict: callers about to take a destructive action on the answer must
    // not proceed on an unknown dirty state — false-on-error is only safe for
    // callers that leave the worktree alone when "clean".
    if (options?.strict) throw err;
    logDirtyCheckFailure(wtPath, err);
    return false;
  }
}

export async function worktreeHasChangesNodeAsync(wtPath, { signal = null } = {}) {
  const status = await gitExecAsync(["status", "--porcelain"], wtPath, {
    signal,
    nativeParity: { disabled: true },
  });
  return String(status || "").trim().length > 0;
}

export async function worktreeHasIgnoredChangesNodeAsync(wtPath, { signal = null } = {}) {
  const status = await gitExecAsync(["status", "--porcelain", "--ignored=matching"], wtPath, {
    signal,
    nativeParity: { disabled: true },
  });
  return String(status || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.startsWith("!! "));
}

// There is intentionally no raw reset export. Dirty-state preservation and
// destructive cleanup are one Rust-owned mutation so callers cannot bypass
// the fail-closed snapshot invariant.
export async function stashDirtyWorktreeAsync(
  wtPath,
  projectDir,
  message,
  { worktreeLockWaitMs = null, stashLockWaitMs = null, shouldDefer = null, signal = null } = {},
) {
  if (!wtPath) return false;
  const mainCwd = projectDir || wtPath;
  return withWorktreeLockAsync(wtPath, mainCwd, async () => {
    if (typeof shouldDefer === "function") {
      let defer = false;
      try {
        defer = !!shouldDefer({ wtPath, projectDir: mainCwd, message });
      } catch {
        return false;
      }
      if (defer) return false;
    }
    if (!(await gitHasChangesAsync(wtPath, { signal }))) return false;

    // refs/stash is shared by every worktree in the repository.
    const lockPath = await gitStashLockPathAsync(wtPath, mainCwd, { signal, nativeParity: { disabled: true } });
    const stashLock = await acquireWorktreeLockAsync(lockPath, {
      waitMs: stashLockWaitMs ?? worktreeLockWaitMs,
      signal,
    });
    if (!stashLock.acquired) {
      throw new Error(`Timed out waiting for git stash lock: ${lockPath}`);
    }
    try {
      await gitExecAsync(["stash", "push", "--include-untracked", "-m", message], wtPath, { signal });
      return true;
    } finally {
      await stashLock.releaseAsync();
    }
  }, { waitMs: worktreeLockWaitMs, signal });
}

/**
 * Last-resort recovery when a worktree's git metadata is unreadable. Copies
 * the entire worktree (skipping `.git`) into a sibling recovery directory so
 * the caller can safely `git worktree remove --force` afterward without losing
 * user-visible files. Symlinks are skipped and noted in the manifest so
 * recovery never materializes target contents through a link. Returns the
 * recovery path, or null if no files or symlink notes were preserved.
 */
export function preserveCorruptWorktreeContents(wtPath, projectDir, {
  wiId,
  branchName,
  recoveryRoot = null,
  reason = "git_metadata_corrupt",
} = {}) {
  if (!fs.existsSync(wtPath)) return null;
  const root = recoveryRoot ? path.resolve(recoveryRoot) : worktreeRoot(projectDir, { disabled: true });
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wiTag = wiId != null ? `wi-${wiId}-` : "";
  const recoveryDir = path.join(root, `.recovered-corrupt-${wiTag}${stamp}`);
  fs.mkdirSync(recoveryDir, { recursive: true });

  let filesCopied = 0;
  const skippedSymlinks = [];
  const copyErrors = [];
  const walk = (srcDir, dstDir) => {
    let entries;
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch (err) {
      copyErrors.push({
        path: path.relative(wtPath, srcDir).replace(/\\/g, "/") || ".",
        error: err?.message || String(err),
      });
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      // Worktree-local Posse state is regenerated runtime data, not user work.
      if (path.resolve(srcDir) === path.resolve(wtPath) && entry.name === ".posse") continue;
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        try {
          fs.mkdirSync(dstPath, { recursive: true });
        } catch (err) {
          copyErrors.push({
            path: path.relative(wtPath, srcPath).replace(/\\/g, "/"),
            error: err?.message || String(err),
          });
          continue;
        }
        walk(srcPath, dstPath);
      } else if (entry.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(srcPath); } catch { /* best effort */ }
        skippedSymlinks.push({
          path: path.relative(wtPath, srcPath).replace(/\\/g, "/"),
          target,
        });
      } else if (entry.isFile()) {
        try {
          fs.copyFileSync(srcPath, dstPath);
          filesCopied++;
        } catch (err) {
          copyErrors.push({
            path: path.relative(wtPath, srcPath).replace(/\\/g, "/"),
            error: err?.message || String(err),
          });
        }
      } else {
        copyErrors.push({
          path: path.relative(wtPath, srcPath).replace(/\\/g, "/"),
          error: "unsupported filesystem entry",
        });
      }
    }
  };
  walk(wtPath, recoveryDir);

  if (copyErrors.length > 0) {
    try { fs.rmSync(recoveryDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
  if (filesCopied === 0 && skippedSymlinks.length === 0) {
    try { fs.rmdirSync(recoveryDir); } catch { /* ignore */ }
    return null;
  }

  try {
    fs.writeFileSync(
      path.join(recoveryDir, ".posse-recovery-info.json"),
      JSON.stringify({
        recovered_at: new Date().toISOString(),
        source_worktree: wtPath,
        branch_name: branchName || null,
        work_item_id: wiId ?? null,
        reason,
        files_copied: filesCopied,
        skipped_symlink_count: skippedSymlinks.length,
        skipped_symlinks: skippedSymlinks,
      }, null, 2),
    );
  } catch { /* metadata is best-effort */ }

  return recoveryDir;
}

// Shared post-reset notification for the snapshot-and-reset twins: the
// callback payload shape is API surface (worker/GC log messages key on it),
// so it is built in exactly one place.
function notifyResetIncomplete(onResetIncomplete, { wtPath, projectDir, reason, branchName, wiId, snapshotDir, resetResult }) {
  if (resetResult?.clean || typeof onResetIncomplete !== "function") return;
  try {
    onResetIncomplete({
      wtPath,
      projectDir,
      reason,
      branchName,
      wiId,
      snapshotDir,
      remainingPaths: resetResult?.remainingPaths || [],
      postResetPorcelain: resetResult?.postResetPorcelain || "",
      operationErrors: resetResult?.operationErrors || [],
    });
  } catch {
    // Recovery should remain best-effort.
  }
}

function incompleteResetError({ wtPath, snapshotDir, resetResult }) {
  const remainingPaths = Array.isArray(resetResult?.remainingPaths)
    ? resetResult.remainingPaths
    : [];
  const operationErrors = Array.isArray(resetResult?.operationErrors)
    ? resetResult.operationErrors
    : [];
  const detail = [
    operationErrors.length > 0
      ? `${operationErrors.length} Git cleanup operation(s) failed: ${operationErrors.slice(0, 3).join("; ")}`
      : null,
    remainingPaths.length > 0
      ? `${remainingPaths.length} path(s) remain dirty: ${remainingPaths.slice(0, 10).join(", ")}`
      : null,
  ].filter(Boolean).join("; ") || "native reset did not verify a clean worktree";
  const error = new Error(`Worktree reset incomplete for ${wtPath}: ${detail}`);
  error.code = "WORKTREE_RESET_INCOMPLETE";
  error.snapshotDir = snapshotDir;
  error.resetResult = resetResult || null;
  error.remainingPaths = remainingPaths;
  error.operationErrors = operationErrors;
  error.postResetPorcelain = resetResult?.postResetPorcelain || "";
  return error;
}

function snapshotAndResetNativePayload(
  wtPath,
  projectDir,
  { reason, branchName, wiId, cleanIgnoredOverride },
) {
  return {
    ...dirtySnapshotNativePayload(wtPath, projectDir, { reason, branchName, wiId }),
    cleanIgnored: cleanIgnoredOverride == null
      ? parseBooleanSetting("worktree_clean_ignored", false)
      : !!cleanIgnoredOverride,
  };
}

function resolveGitWorktreeRoot(wtPath) {
  const resolved = String(gitExec(
    ["rev-parse", "--show-toplevel"],
    wtPath,
    { nativeParity: { disabled: true } },
  ) || "").trim();
  if (!resolved) throw new Error(`Could not resolve Git worktree root for ${wtPath}`);
  return path.resolve(resolved);
}

async function resolveGitWorktreeRootAsync(wtPath, { signal = null } = {}) {
  const resolved = String(await gitExecAsync(
    ["rev-parse", "--show-toplevel"],
    wtPath,
    { signal, nativeParity: { disabled: true } },
  ) || "").trim();
  if (!resolved) throw new Error(`Could not resolve Git worktree root for ${wtPath}`);
  return path.resolve(resolved);
}

function markSnapshotRefusal(err) {
  if (/SNAPSHOT_REFUSED_RESET/.test(String(err?.message || err || ""))) {
    err.code = "SNAPSHOT_REFUSED_RESET";
  }
  return err;
}

function adaptSnapshotAndResetResult(
  nativeResult,
  { wtPath, projectDir, reason, branchName, wiId, onResetIncomplete, onMsg },
) {
  const snapshotDir = snapshotRefFromNative(nativeResult?.snapshot, {
    metadata: { reason, wiId, branchName },
  });
  const resetResult = nativeResult?.reset || null;
  if (snapshotDir && typeof onMsg === "function") {
    onMsg(`preserved dirty worktree at ${snapshotDir.value}`);
  }
  if (nativeResult?.recovered) {
    notifyResetIncomplete(onResetIncomplete, {
      wtPath,
      projectDir,
      reason,
      branchName,
      wiId,
      snapshotDir,
      resetResult,
    });
  }
  if (resetResult && resetResult.clean !== true) {
    throw incompleteResetError({ wtPath, snapshotDir, resetResult });
  }
  return snapshotDir;
}

export function snapshotAndResetDirtyWorktree(
  wtPath,
  projectDir,
  {
    reason = "dirty-worktree",
    branchName = null,
    wiId = null,
    onResetIncomplete = null,
    onMsg = null,
    lock = true,
    worktreeLockWaitMs = null,
    cleanIgnoredOverride = null,
    nativeParity = {},
  } = {},
) {
  // Returns null both when there is nothing to clean and when only ignored
  // dirt was cleared. Rust makes that decision while owning the snapshot/reset
  // mutation; Node owns only the surrounding process lock and notifications.
  if (!fs.existsSync(wtPath)) return null;

  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  let heldLock = null;
  if (lock) {
    heldLock = acquireWorktreeLock(lockPath, { waitMs: worktreeLockWaitMs });
    if (!heldLock.acquired) {
      throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
    }
  }
  try {
    const nativeWtPath = resolveGitWorktreeRoot(wtPath);
    const nativeResult = runGitNativeMethod(
      "git.worktree.snapshotAndResetDirty",
      snapshotAndResetNativePayload(nativeWtPath, projectDir, {
        reason,
        branchName,
        wiId,
        cleanIgnoredOverride,
      }),
      nativeParity,
    );
    return adaptSnapshotAndResetResult(nativeResult, {
      wtPath,
      projectDir,
      reason,
      branchName,
      wiId,
      onResetIncomplete,
      onMsg,
    });
  } catch (err) {
    throw markSnapshotRefusal(err);
  } finally {
    if (heldLock?.acquired) heldLock.release();
  }
}

export async function snapshotAndResetDirtyWorktreeAsync(
  wtPath,
  projectDir,
  {
    reason = "dirty-worktree",
    branchName = null,
    wiId = null,
    onResetIncomplete = null,
    onMsg = null,
    lock = true,
    cleanIgnoredOverride = null,
    signal = null,
    worktreeLockWaitMs = null,
    nativeParity = {},
  } = {},
) {
  try {
    await fs.promises.access(wtPath);
  } catch {
    return null;
  }

  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  let heldLock = null;
  if (lock) {
    heldLock = await acquireWorktreeLockAsync(lockPath, { signal, waitMs: worktreeLockWaitMs });
    if (!heldLock.acquired) {
      throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
    }
  }
  try {
    const nativeWtPath = await resolveGitWorktreeRootAsync(wtPath, { signal });
    const nativeResult = await runGitNativeMethodAsync(
      "git.worktree.snapshotAndResetDirty",
      snapshotAndResetNativePayload(nativeWtPath, projectDir, {
        reason,
        branchName,
        wiId,
        cleanIgnoredOverride,
      }),
      { ...nativeParity, signal },
    );
    return adaptSnapshotAndResetResult(nativeResult, {
      wtPath,
      projectDir,
      reason,
      branchName,
      wiId,
      onResetIncomplete,
      onMsg,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw markSnapshotRefusal(err);
  } finally {
    if (heldLock?.acquired) await heldLock.releaseAsync();
  }
}
