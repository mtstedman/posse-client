// lib/domains/git/functions/worktree-safe-remove.js
//
// Safe worktree removal: snapshot any dirt (or preserve corrupt contents),
// verify the worktree is clean, then remove via native git with a force-remove
// retry fallback. In-use worktrees are deferred (after attempting to reap
// recorded child-process holders) rather than force-fought.

import fs from "fs";
import { isAbortError } from "../../runtime/functions/yield.js";
import { reapOwnDaemonSpawnsForCwd } from "../../../classes/tools/daemon/index.js";
import { FORCE_REMOVE_OPTIONS, isWorktreeInUseError } from "./worktree-remove-options.js";
import { gitExec, gitExecAsync } from "./utils.js";
import { Worktree } from "../classes/index.js";
import { withWorktreeLock, withWorktreeLockAsync } from "./worktree-locks.js";
import {
  WORKTREE_REMOVE_RETRY_DELAYS_MS,
  sleepSyncMs,
  sleepMs,
} from "./worktree-internal.js";
import {
  worktreePorcelain,
  worktreePorcelainAsync,
  preserveCorruptWorktreeContents,
  snapshotAndResetDirtyWorktree,
  snapshotAndResetDirtyWorktreeAsync,
} from "./worktree-recovery.js";

export function removeWorktreePath(wtPath, mainCwd) {
  Worktree.at(mainCwd, wtPath).remove({ force: true, prune: true, fallbackRemove: true });
}

export function removeWorktreePathAsync(wtPath, mainCwd, options = {}) {
  return Worktree.at(mainCwd, wtPath).removeAsync({ force: true, prune: true, fallbackRemove: true, ...options });
}

export function forceRemoveWorktreePathAfterNative(wtPath, mainCwd) {
  try { gitExec(["worktree", "prune"], mainCwd); } catch {}
  try {
    fs.rmSync(wtPath, FORCE_REMOVE_OPTIONS);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw err;
  }
  try { gitExec(["worktree", "prune"], mainCwd); } catch {}
}

export async function forceRemoveWorktreePathAfterNativeAsync(wtPath, mainCwd, { signal = null } = {}) {
  try { await gitExecAsync(["worktree", "prune"], mainCwd, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
  try {
    await fs.promises.rm(wtPath, FORCE_REMOVE_OPTIONS);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw err;
  }
  try { await gitExecAsync(["worktree", "prune"], mainCwd, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
}

export function retryForceRemoveWorktreePathAfterNative(wtPath, mainCwd) {
  let lastError = null;
  for (let attempt = 0; attempt <= WORKTREE_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) sleepSyncMs(WORKTREE_REMOVE_RETRY_DELAYS_MS[attempt - 1]);
    try {
      forceRemoveWorktreePathAfterNative(wtPath, mainCwd);
      if (!fs.existsSync(wtPath)) return { removed: true, inUse: false };
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      // A live handle won't clear by force-fighting it; stop and defer to the
      // next GC pass instead of burning the remaining retry budget.
      if (isWorktreeInUseError(err)) break;
    }
  }
  const removed = !fs.existsSync(wtPath);
  if (!removed && lastError && !isWorktreeInUseError(lastError)) throw lastError;
  return { removed, inUse: !removed && isWorktreeInUseError(lastError) };
}

export async function retryForceRemoveWorktreePathAfterNativeAsync(wtPath, mainCwd, { signal = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= WORKTREE_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleepMs(WORKTREE_REMOVE_RETRY_DELAYS_MS[attempt - 1], { signal });
    try {
      await forceRemoveWorktreePathAfterNativeAsync(wtPath, mainCwd, { signal });
      if (!fs.existsSync(wtPath)) return { removed: true, inUse: false };
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
      // A live handle won't clear by force-fighting it; stop and defer to the
      // next GC pass instead of burning the remaining retry budget.
      if (isWorktreeInUseError(err)) break;
    }
  }
  const removed = !fs.existsSync(wtPath);
  if (!removed && lastError && !isWorktreeInUseError(lastError)) throw lastError;
  return { removed, inUse: !removed && isWorktreeInUseError(lastError) };
}

function notifySafeRemoveFailure(onFailure, detail) {
  if (typeof onFailure !== "function") return;
  try { onFailure(detail); } catch { /* cleanup failure callbacks are best-effort */ }
}

function notifySafeRemoveMessage(onMsg, message) {
  if (typeof onMsg !== "function") return;
  try { onMsg(message); } catch { /* cleanup messages are best-effort */ }
}

function notifySafeRemoveSnapshot(onSnapshot, detail) {
  if (typeof onSnapshot !== "function") return;
  try { onSnapshot(detail); } catch { /* snapshot callbacks are best-effort */ }
}

export function reapRecordedWorktreeProcessHolders(wtPath, { onMsg = null } = {}) {
  let result = { killed: 0, skipped: 0, matched: 0 };
  try {
    result = reapOwnDaemonSpawnsForCwd(wtPath, { force: true, tree: true });
  } catch {
    result = { killed: 0, skipped: 0, matched: 0 };
  }
  if (result.matched > 0 || result.killed > 0 || result.skipped > 0) {
    notifySafeRemoveMessage(
      onMsg,
      `Worktree in-use cleanup checked ${result.matched} recorded child process(es); killed ${result.killed}, skipped ${result.skipped}`,
    );
  }
  return result;
}

export function safeRemoveBaseResult(wtPath, overrides = {}) {
  return {
    wtPath,
    existed: true,
    removed: false,
    skipped: false,
    snapshotDir: null,
    snapshotSucceeded: false,
    snapshotFailed: false,
    verifiedClean: false,
    corruptMetadata: false,
    corruptPreserved: false,
    reason: null,
    error: null,
    ...overrides,
  };
}

export function safeSnapshotAndRemoveWorktree(
  wtPath,
  projectDir,
  {
    reason = "worktree-cleanup",
    branchName = null,
    wiId = null,
    onMsg = null,
    onSnapshot = null,
    onFailure = null,
    onResetIncomplete = null,
    preserveCorrupt = false,
    worktreeLockWaitMs = null,
    cleanIgnoredOverride = null,
  } = {},
) {
  return withWorktreeLock(wtPath, projectDir, () => {
    if (!fs.existsSync(wtPath)) {
      return safeRemoveBaseResult(wtPath, { existed: false, removed: true });
    }

    let preCleanupPorcelain = "";
    let snapshotDir = null;
    let snapshotSucceeded = false;
    let snapshotFailed = false;
    let corruptMetadata = false;
    let corruptPreserved = false;

    try {
      preCleanupPorcelain = worktreePorcelain(wtPath);
    } catch (err) {
      corruptMetadata = true;
      if (!preserveCorrupt) {
        const message = `Could not verify worktree cleanliness before cleanup; leaving worktree on disk: ${err?.message || String(err)}`;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "status",
          message,
          error: err?.message || String(err),
        });
        return safeRemoveBaseResult(wtPath, {
          skipped: true,
          corruptMetadata,
          reason: "status_failed",
          error: err?.message || String(err),
        });
      }
      snapshotDir = preserveCorruptWorktreeContents(wtPath, projectDir, { wiId, branchName });
      corruptPreserved = !!snapshotDir;
      if (snapshotDir) {
        notifySafeRemoveSnapshot(onSnapshot, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          snapshotDir,
          corruptMetadata: true,
        });
        if (typeof onMsg === "function") {
          try { onMsg(`Preserved corrupt worktree contents at ${snapshotDir}`); } catch { /* best effort */ }
        }
      }
      try {
        removeWorktreePath(wtPath, projectDir);
      } catch (removeErr) {
        const message = `Failed to remove corrupt worktree after preservation: ${removeErr?.message || String(removeErr)}`;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "remove",
          message,
          error: removeErr?.message || String(removeErr),
          snapshotDir,
          corruptMetadata: true,
          corruptPreserved,
        });
      }
      return safeRemoveBaseResult(wtPath, {
        removed: !fs.existsSync(wtPath),
        snapshotDir,
        snapshotSucceeded: !!snapshotDir,
        corruptMetadata,
        corruptPreserved,
        reason: "corrupt_metadata_preserved",
      });
    }

    try {
      snapshotDir = snapshotAndResetDirtyWorktree(wtPath, projectDir, {
        reason,
        branchName,
        wiId,
        onMsg,
        onResetIncomplete,
        lock: false,
        cleanIgnoredOverride,
      });
      if (snapshotDir) {
        snapshotSucceeded = true;
        notifySafeRemoveSnapshot(onSnapshot, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          snapshotDir,
          corruptMetadata: false,
        });
      }
    } catch (err) {
      snapshotFailed = true;
      const message = `Could not snapshot worktree before cleanup; leaving worktree on disk unless it verifies clean: ${err?.message || String(err)}`;
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: "snapshot",
        message,
        error: err?.message || String(err),
        porcelain: preCleanupPorcelain,
      });
    }

    let verifiedClean = false;
    try {
      verifiedClean = worktreePorcelain(wtPath) === "";
    } catch (err) {
      if (!snapshotSucceeded) {
        const message = `Could not verify worktree cleanliness before cleanup; leaving worktree on disk: ${err?.message || String(err)}`;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "verify",
          message,
          error: err?.message || String(err),
          snapshot_failed: snapshotFailed,
        });
        return safeRemoveBaseResult(wtPath, {
          skipped: true,
          snapshotDir,
          snapshotSucceeded,
          snapshotFailed,
          reason: "verify_failed",
          error: err?.message || String(err),
        });
      }
    }

    if (!snapshotSucceeded && !verifiedClean) {
      const message = "Worktree removal skipped because dirty state was not snapshotted and worktree is not clean";
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: "gate",
        message,
        porcelain: preCleanupPorcelain,
        snapshot_failed: snapshotFailed,
      });
      return safeRemoveBaseResult(wtPath, {
        skipped: true,
        snapshotDir,
        snapshotSucceeded,
        snapshotFailed,
        verifiedClean,
        reason: "dirty_not_preserved",
      });
    }

    let deferredInUse = false;
    try {
      removeWorktreePath(wtPath, projectDir);
    } catch (err) {
      deferredInUse = isWorktreeInUseError(err);
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: deferredInUse ? "defer" : "remove",
        message: deferredInUse
          ? `Worktree in use by another process; deferring removal to next GC: ${err?.message || String(err)}`
          : `Failed to remove worktree after cleanup gate passed: ${err?.message || String(err)}`,
        error: err?.message || String(err),
        inUse: deferredInUse,
        snapshotDir,
        snapshotSucceeded,
        verifiedClean,
      });
      if (deferredInUse) {
        const reaped = reapRecordedWorktreeProcessHolders(wtPath, { onMsg });
        if (reaped.killed > 0) {
          sleepSyncMs(250);
          deferredInUse = false;
        }
      }
    }

    let removed = !fs.existsSync(wtPath);
    // Don't force-fight a worktree that's actively in use — leave it for the
    // next GC pass once the holder (a daemon/conductor op or git child) releases.
    if (!removed && !deferredInUse) {
      try {
        const retry = retryForceRemoveWorktreePathAfterNative(wtPath, projectDir);
        removed = retry.removed;
        deferredInUse = retry.inUse;
      } catch (err) {
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "remove",
          message: `Force-remove retry failed after native worktree removal: ${err?.message || String(err)}`,
          error: err?.message || String(err),
          snapshotDir,
          snapshotSucceeded,
          verifiedClean,
        });
      }
    }
    if (!removed) {
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: deferredInUse ? "defer" : "remove",
        message: deferredInUse
          ? "Worktree in use; left for the next GC pass"
          : "Worktree removal command completed but path still exists",
        inUse: deferredInUse,
        snapshotDir,
        snapshotSucceeded,
        verifiedClean,
      });
    }
    return safeRemoveBaseResult(wtPath, {
      removed,
      snapshotDir,
      snapshotSucceeded,
      snapshotFailed,
      verifiedClean,
      reason: removed ? "removed" : (deferredInUse ? "deferred_in_use" : "remove_incomplete"),
    });
  }, { waitMs: worktreeLockWaitMs });
}

export async function safeSnapshotAndRemoveWorktreeAsync(
  wtPath,
  projectDir,
  {
    reason = "worktree-cleanup",
    branchName = null,
    wiId = null,
    onMsg = null,
    onSnapshot = null,
    onFailure = null,
    onResetIncomplete = null,
    preserveCorrupt = false,
    worktreeLockWaitMs = null,
    cleanIgnoredOverride = null,
    signal = null,
  } = {},
) {
  return withWorktreeLockAsync(wtPath, projectDir, async () => {
    try {
      await fs.promises.access(wtPath);
    } catch {
      return safeRemoveBaseResult(wtPath, { existed: false, removed: true });
    }

    let preCleanupPorcelain = "";
    let snapshotDir = null;
    let snapshotSucceeded = false;
    let snapshotFailed = false;
    let corruptMetadata = false;
    let corruptPreserved = false;

    try {
      preCleanupPorcelain = await worktreePorcelainAsync(wtPath, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      corruptMetadata = true;
      if (!preserveCorrupt) {
        const message = `Could not verify worktree cleanliness before cleanup; leaving worktree on disk: ${err?.message || String(err)}`;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "status",
          message,
          error: err?.message || String(err),
        });
        return safeRemoveBaseResult(wtPath, {
          skipped: true,
          corruptMetadata,
          reason: "status_failed",
          error: err?.message || String(err),
        });
      }
      snapshotDir = preserveCorruptWorktreeContents(wtPath, projectDir, { wiId, branchName });
      corruptPreserved = !!snapshotDir;
      if (snapshotDir) {
        notifySafeRemoveSnapshot(onSnapshot, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          snapshotDir,
          corruptMetadata: true,
        });
        if (typeof onMsg === "function") {
          try { onMsg(`Preserved corrupt worktree contents at ${snapshotDir}`); } catch { /* best effort */ }
        }
      }
      try {
        await removeWorktreePathAsync(wtPath, projectDir, { signal });
      } catch (removeErr) {
        if (isAbortError(removeErr)) throw removeErr;
        const message = `Failed to remove corrupt worktree after preservation: ${removeErr?.message || String(removeErr)}`;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "remove",
          message,
          error: removeErr?.message || String(removeErr),
          snapshotDir,
          corruptMetadata: true,
          corruptPreserved,
        });
      }
      return safeRemoveBaseResult(wtPath, {
        removed: !fs.existsSync(wtPath),
        snapshotDir,
        snapshotSucceeded: !!snapshotDir,
        corruptMetadata,
        corruptPreserved,
        reason: "corrupt_metadata_preserved",
      });
    }

    try {
      snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, projectDir, {
        reason,
        branchName,
        wiId,
        onMsg,
        onResetIncomplete,
        lock: false,
        cleanIgnoredOverride,
        signal,
      });
      if (snapshotDir) {
        snapshotSucceeded = true;
        notifySafeRemoveSnapshot(onSnapshot, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          snapshotDir,
          corruptMetadata: false,
        });
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      snapshotFailed = true;
      const message = `Could not snapshot worktree before cleanup; leaving worktree on disk unless it verifies clean: ${err?.message || String(err)}`;
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: "snapshot",
        message,
        error: err?.message || String(err),
        porcelain: preCleanupPorcelain,
      });
    }

    let verifiedClean = false;
    try {
      verifiedClean = await worktreePorcelainAsync(wtPath, { signal }) === "";
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (!snapshotSucceeded) {
        const message = `Could not verify worktree cleanliness before cleanup; leaving worktree on disk: ${err?.message || String(err)}`;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "verify",
          message,
          error: err?.message || String(err),
          snapshot_failed: snapshotFailed,
        });
        return safeRemoveBaseResult(wtPath, {
          skipped: true,
          snapshotDir,
          snapshotSucceeded,
          snapshotFailed,
          reason: "verify_failed",
          error: err?.message || String(err),
        });
      }
    }

    if (!snapshotSucceeded && !verifiedClean) {
      const message = "Worktree removal skipped because dirty state was not snapshotted and worktree is not clean";
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: "gate",
        message,
        porcelain: preCleanupPorcelain,
        snapshot_failed: snapshotFailed,
      });
      return safeRemoveBaseResult(wtPath, {
        skipped: true,
        snapshotDir,
        snapshotSucceeded,
        snapshotFailed,
        verifiedClean,
        reason: "dirty_not_preserved",
      });
    }

    let deferredInUse = false;
    try {
      await removeWorktreePathAsync(wtPath, projectDir, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      deferredInUse = isWorktreeInUseError(err);
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: deferredInUse ? "defer" : "remove",
        message: deferredInUse
          ? `Worktree in use by another process; deferring removal to next GC: ${err?.message || String(err)}`
          : `Failed to remove worktree after cleanup gate passed: ${err?.message || String(err)}`,
        error: err?.message || String(err),
        inUse: deferredInUse,
        snapshotDir,
        snapshotSucceeded,
        verifiedClean,
      });
      if (deferredInUse) {
        const reaped = reapRecordedWorktreeProcessHolders(wtPath, { onMsg });
        if (reaped.killed > 0) {
          await sleepMs(250, { signal });
          deferredInUse = false;
        }
      }
    }

    let removed = !fs.existsSync(wtPath);
    // Don't force-fight a worktree that's actively in use — leave it for the
    // next GC pass once the holder (a daemon/conductor op or git child) releases.
    if (!removed && !deferredInUse) {
      try {
        const retry = await retryForceRemoveWorktreePathAfterNativeAsync(wtPath, projectDir, { signal });
        removed = retry.removed;
        deferredInUse = retry.inUse;
      } catch (err) {
        if (isAbortError(err)) throw err;
        notifySafeRemoveFailure(onFailure, {
          wtPath,
          projectDir,
          reason,
          branchName,
          wiId,
          phase: "remove",
          message: `Force-remove retry failed after native worktree removal: ${err?.message || String(err)}`,
          error: err?.message || String(err),
          snapshotDir,
          snapshotSucceeded,
          verifiedClean,
        });
      }
    }
    if (!removed) {
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: deferredInUse ? "defer" : "remove",
        message: deferredInUse
          ? "Worktree in use; left for the next GC pass"
          : "Worktree removal command completed but path still exists",
        inUse: deferredInUse,
        snapshotDir,
        snapshotSucceeded,
        verifiedClean,
      });
    }
    return safeRemoveBaseResult(wtPath, {
      removed,
      snapshotDir,
      snapshotSucceeded,
      snapshotFailed,
      verifiedClean,
      reason: removed ? "removed" : (deferredInUse ? "deferred_in_use" : "remove_incomplete"),
    });
  }, { signal, waitMs: worktreeLockWaitMs });
}
