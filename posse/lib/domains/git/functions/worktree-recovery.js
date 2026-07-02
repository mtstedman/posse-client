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
import { runGitNativeMethodAsync } from "./native/invoke.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  worktreeLockPath,
  gitStashLockPathAsync,
  withWorktreeLockAsync,
} from "./worktree-locks.js";
import {
  parseBooleanSetting,
  preserveDirtyWorktreeSnapshot,
  preserveDirtyWorktreeSnapshotAsync,
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

// The clean invocation is the drift surface here: `-e .posse/` preserves posse
// runtime dirs when ignored artifacts are cleared too. Both twins take their
// argv from this one builder.
function cleanUntrackedArgs(cleanIgnoredOverride) {
  const cleanIgnored = cleanIgnoredOverride == null
    ? parseBooleanSetting("worktree_clean_ignored", false)
    : !!cleanIgnoredOverride;
  return cleanIgnored ? ["clean", "-fdx", "-e", ".posse/"] : ["clean", "-fd"];
}

export function cleanWorktreeUntracked(wtPath, { cleanIgnoredOverride = null } = {}) {
  gitExec(cleanUntrackedArgs(cleanIgnoredOverride), wtPath);
}

export async function cleanWorktreeUntrackedAsync(wtPath, { cleanIgnoredOverride = null, signal = null } = {}) {
  await gitExecAsync(cleanUntrackedArgs(cleanIgnoredOverride), wtPath, { signal });
}

export function parsePorcelainRemainingPaths(porcelainZ) {
  const records = String(porcelainZ || "").split("\0").filter(Boolean);
  const remaining = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const statusXY = record.slice(0, 2);
    const firstPath = record.slice(3);
    // Porcelain status has separate index/worktree columns; includes() catches
    // rename/copy markers in either position.
    const isRenameOrCopy = statusXY.includes("R") || statusXY.includes("C");
    if (isRenameOrCopy) {
      const secondPath = records[i + 1];
      if (secondPath) {
        remaining.push(secondPath);
        i += 1;
        continue;
      }
      if (firstPath.includes(" -> ")) {
        remaining.push(firstPath.split(" -> ").pop().trim());
        continue;
      }
    }
    remaining.push(firstPath);
  }
  return remaining.filter(Boolean);
}

// resetDirtyWorktree / resetDirtyWorktreeAsync are intentionally NOT twins of
// one body: the sync fn implements the abort-merge/rebase/cherry-pick + reset
// sequence in Node, while the async fn delegates the entire semantics to the
// native Rust method (git.worktree.resetDirty). Changes here must be mirrored
// in Rust; the snapshot-and-reset twin-parity test pins the equivalence.
export function resetDirtyWorktree(wtPath, { cleanIgnoredOverride = null } = {}) {
  // Unmerged paths (MERGE_HEAD/conflicts) make `checkout -- .` fail.
  // Best effort: clear merge state first, then force-reset tracked and untracked.
  let gitMetaDir = null;
  try {
    const gitDir = gitExec(["rev-parse", "--git-dir"], wtPath, { nativeParity: { disabled: true } });
    gitMetaDir = path.isAbsolute(gitDir) ? gitDir : path.join(wtPath, gitDir);
  } catch {
    gitMetaDir = null;
  }
  if (gitMetaDir) {
    try {
      const rebaseMerge = path.join(gitMetaDir, "rebase-merge");
      const rebaseApply = path.join(gitMetaDir, "rebase-apply");
      if (fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply)) {
        try { gitExec(["rebase", "--abort"], wtPath); } catch { /* continue */ }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Best effort only.
    }
    try {
      if (fs.existsSync(path.join(gitMetaDir, "CHERRY_PICK_HEAD"))) {
        try { gitExec(["cherry-pick", "--abort"], wtPath); } catch { /* continue */ }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Best effort only.
    }
    try {
      if (fs.existsSync(path.join(gitMetaDir, "REVERT_HEAD"))) {
        try { gitExec(["revert", "--abort"], wtPath); } catch { /* continue */ }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Best effort only.
    }
  }
  try {
    gitExec(["rev-parse", "--verify", "MERGE_HEAD"], wtPath);
    try { gitExec(["merge", "--abort"], wtPath); } catch {
      try { gitExec(["reset", "--merge"], wtPath); } catch { /* continue */ }
    }
  } catch {
    // No merge in progress.
  }
  try { gitExec(["reset", "--hard", "HEAD"], wtPath); } catch {
    // Fallback for odd repo states where reset --hard is unavailable.
    try { gitExec(["checkout", "--", "."], wtPath); } catch { /* continue */ }
  }
  cleanWorktreeUntracked(wtPath, { cleanIgnoredOverride });
  try {
    const postZ = gitExec(["status", "--porcelain", "-z"], wtPath);
    const remaining = parsePorcelainRemainingPaths(postZ);
    return {
      clean: remaining.length === 0,
      postResetPorcelain: String(postZ || "").replace(/\0/g, "\n").trim(),
      remainingPaths: remaining,
    };
  } catch (err) {
    return { clean: false, postResetPorcelain: `git status failed: ${err?.message || err}`, remainingPaths: [] };
  }
}

export async function resetDirtyWorktreeAsync(wtPath, { cleanIgnoredOverride = null, signal = null, nativeParity = {} } = {}) {
  const cleanIgnored = cleanIgnoredOverride == null
    ? parseBooleanSetting("worktree_clean_ignored", false)
    : !!cleanIgnoredOverride;
  return await runGitNativeMethodAsync(
    "git.worktree.resetDirty",
    { wtPath: path.resolve(wtPath), cleanIgnored },
    { ...nativeParity, signal },
  );
}

export async function resetDirtyWorktreeFallbackAsync(wtPath, projectDir = null, { signal = null } = {}) {
  return withWorktreeLockAsync(wtPath, projectDir || wtPath, async () => {
    await gitExecAsync(["checkout", "--", "."], wtPath, { signal });
    await gitExecAsync(["clean", "-fd"], wtPath, { signal });
  }, { signal });
}

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
export function preserveCorruptWorktreeContents(wtPath, projectDir, { wiId, branchName } = {}) {
  if (!fs.existsSync(wtPath)) return null;
  const root = worktreeRoot(projectDir, { disabled: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const wiTag = wiId != null ? `wi-${wiId}-` : "";
  const recoveryDir = path.join(root, `.recovered-corrupt-${wiTag}${stamp}`);
  fs.mkdirSync(recoveryDir, { recursive: true });

  let filesCopied = 0;
  const skippedSymlinks = [];
  const walk = (srcDir, dstDir) => {
    let entries;
    try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      // Worktree-local Posse state is regenerated runtime data, not user work.
      if (path.resolve(srcDir) === path.resolve(wtPath) && entry.name === ".posse") continue;
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        try { fs.mkdirSync(dstPath, { recursive: true }); } catch { continue; }
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
        } catch { /* skip unreadable entries */ }
      }
    }
  };
  walk(wtPath, recoveryDir);

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
        reason: "git_metadata_corrupt",
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
    });
  } catch {
    // Recovery should remain best-effort.
  }
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
  } = {},
) {
  // Returns null both when there's nothing to clean and when only ignored dirt
  // was cleared (no snapshot artifact written). Callers must not treat null as
  // a strict no-op indicator.
  if (!fs.existsSync(wtPath) || !worktreeNeedsRecovery(wtPath)) return null;

  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  let heldLock = null;
  if (lock) {
    heldLock = acquireWorktreeLock(lockPath, { waitMs: worktreeLockWaitMs });
    if (!heldLock.acquired) {
      throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
    }
  }
  try {
    const hasTrackedOrUntracked = gitHasChanges(wtPath);
    const snapshotDir = hasTrackedOrUntracked
      ? preserveDirtyWorktreeSnapshot(wtPath, projectDir, { reason, branchName, wiId, onMsg })
      : null;
    if (hasTrackedOrUntracked && !snapshotDir) {
      throw new Error(`Dirty worktree snapshot failed for ${wtPath}; refusing to reset`);
    }
    const resetResult = resetDirtyWorktree(wtPath, { cleanIgnoredOverride });
    notifyResetIncomplete(onResetIncomplete, { wtPath, projectDir, reason, branchName, wiId, snapshotDir, resetResult });
    return snapshotDir;
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
  if (!(await worktreeNeedsRecoveryAsync(wtPath, { signal }))) return null;

  const lockPath = worktreeLockPath(wtPath, projectDir, { disabled: true });
  let heldLock = null;
  if (lock) {
    heldLock = await acquireWorktreeLockAsync(lockPath, { signal, waitMs: worktreeLockWaitMs });
    if (!heldLock.acquired) {
      throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
    }
  }
  try {
    const hasTrackedOrUntracked = await worktreeHasChangesNodeAsync(wtPath, { signal });
    const snapshotDir = hasTrackedOrUntracked
      ? await preserveDirtyWorktreeSnapshotAsync(wtPath, projectDir, { reason, branchName, wiId, onMsg, signal, nativeParity })
      : null;
    if (hasTrackedOrUntracked && !snapshotDir) {
      throw new Error(`Dirty worktree snapshot failed for ${wtPath}; refusing to reset`);
    }
    const resetResult = await resetDirtyWorktreeAsync(wtPath, { cleanIgnoredOverride, signal, nativeParity });
    notifyResetIncomplete(onResetIncomplete, { wtPath, projectDir, reason, branchName, wiId, snapshotDir, resetResult });
    return snapshotDir;
  } finally {
    if (heldLock?.acquired) await heldLock.releaseAsync();
  }
}
