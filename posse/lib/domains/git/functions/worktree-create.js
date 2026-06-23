// lib/domains/git/functions/worktree-create.js
//
// Worktree provisioning: add-or-reuse (gitWorktreeAdd*), sparse-checkout scoping
// for nested projects, detached read-only worktrees, and the reuse-deferral
// hook plumbing that lets callers postpone destructive recovery while sibling
// jobs are still active.

import fs from "fs";
import path from "path";
import { isAbortError } from "../../runtime/functions/yield.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { gitExec, gitExecAsync } from "./utils.js";
import { Worktree } from "../classes/index.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  worktreeLockPath,
} from "./worktree-locks.js";
import { randomToken } from "./worktree-internal.js";
import {
  gitBranchExists,
  gitBranchExistsAsync,
  gitCurrentBranch,
  gitCurrentBranchAsync,
  nestedProjectSubpath,
  nestedProjectSubpathAsync,
} from "./worktree-path.js";
import {
  migrateLegacyWorktreeIfNeeded,
  migrateLegacyWorktreeIfNeededAsync,
} from "./worktree-legacy.js";
import {
  worktreeNeedsRecovery,
  worktreeNeedsRecoveryAsync,
  snapshotAndResetDirtyWorktree,
  snapshotAndResetDirtyWorktreeAsync,
  preserveCorruptWorktreeContents,
} from "./worktree-recovery.js";
import { removeWorktreePath, removeWorktreePathAsync } from "./worktree-safe-remove.js";

export function configureWorktreeScope(wtDir, projectDir) {
  const rel = nestedProjectSubpath(projectDir);
  if (!rel) {
    ensurePosseGitInfoExclude(wtDir);
    return wtDir;
  }

  // Nested-project worktrees have a Git root above the scoped cwd. Runtime
  // sentinels live at that Git root, so ignore both the root and scoped dirs.
  // The sparse cone is reset on every setup for nested projects; callers that
  // need root-level files must plan them from the repo root, not the subproject
  // cwd, because Git intentionally hides paths outside this cone.
  ensurePosseGitInfoExclude(wtDir);
  gitExec(["sparse-checkout", "init", "--cone"], wtDir);
  gitExec(["sparse-checkout", "set", rel], wtDir);

  const scopedPath = path.join(wtDir, rel);
  fs.mkdirSync(scopedPath, { recursive: true });
  ensurePosseGitInfoExclude(scopedPath);
  return scopedPath;
}

export async function configureWorktreeScopeAsync(wtDir, projectDir, { signal = null } = {}) {
  const rel = await nestedProjectSubpathAsync(projectDir, { signal });
  if (!rel) {
    ensurePosseGitInfoExclude(wtDir);
    return wtDir;
  }

  ensurePosseGitInfoExclude(wtDir);
  await gitExecAsync(["sparse-checkout", "init", "--cone"], wtDir, { signal });
  await gitExecAsync(["sparse-checkout", "set", rel], wtDir, { signal });

  const scopedPath = path.join(wtDir, rel);
  await fs.promises.mkdir(scopedPath, { recursive: true });
  ensurePosseGitInfoExclude(scopedPath);
  return scopedPath;
}

export async function ensureDetachedReadOnlyWorktreeAsync(projectDir, {
  targetRef = "",
  worktreeDir = "",
  signal = null,
} = {}) {
  const ref = String(targetRef || "").trim();
  if (!ref) throw new Error("targetRef is required for detached read-only worktree");
  if (!worktreeDir) throw new Error("worktreeDir is required for detached read-only worktree");

  await fs.promises.mkdir(path.dirname(worktreeDir), { recursive: true });
  let targetDir = path.resolve(worktreeDir);
  if (fs.existsSync(targetDir)) {
    try {
      await gitExecAsync(["rev-parse", "--git-dir"], targetDir, { signal });
      await gitExecAsync(["checkout", "--detach", ref], targetDir, { signal });
      await gitExecAsync(["reset", "--hard", ref], targetDir, { signal });
      await gitExecAsync(["clean", "-fd"], targetDir, { signal });
      return targetDir;
    } catch {
      targetDir = `${targetDir}-${randomToken()}`;
    }
  }

  await gitExecAsync(["worktree", "add", "--detach", targetDir, ref], projectDir, { signal });
  return targetDir;
}

function worktreeReuseDeferredError(message) {
  const err = new Error(message);
  err.code = "WORKTREE_ACTIVE_SIBLING_LOCKS";
  err.deferWorktreeCleanup = true;
  return err;
}

function deferWorktreeReuseMutationIfRequested(opts = {}, hookName, details = {}, message = "Worktree reuse mutation deferred") {
  if (typeof opts[hookName] !== "function") return;
  if (opts[hookName](details)) {
    throw worktreeReuseDeferredError(message);
  }
}

export function gitWorktreeAdd(wtPath, branchName, mainCwd, opts = {}) {
  const lockPath = worktreeLockPath(wtPath, mainCwd);
  const lock = acquireWorktreeLock(lockPath);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
  }
  try {
    if (opts.wiId != null) {
      const migratedFrom = migrateLegacyWorktreeIfNeeded(wtPath, mainCwd, opts.wiId);
      if (migratedFrom && opts.onLegacyMigrate) opts.onLegacyMigrate(migratedFrom);
    }
    if (fs.existsSync(wtPath)) {
      try {
        gitExec(["rev-parse", "--git-dir"], wtPath);
        const currentBranch = gitCurrentBranch(wtPath);
        const dirty = worktreeNeedsRecovery(wtPath);
        if (dirty) {
          const skipDirtyRecovery = typeof opts.shouldSkipDirtyRecovery === "function"
            && opts.shouldSkipDirtyRecovery({ wtPath, currentBranch, branchName });
          if (!skipDirtyRecovery) {
            const snapshotDir = snapshotAndResetDirtyWorktree(wtPath, mainCwd, {
              reason: "reused-dirty-worktree",
              branchName: currentBranch || branchName,
              wiId: opts.wiId || null,
              lock: false,
              onMsg: (msg) => {
                if (opts.onDirtySnapshot) opts.onDirtySnapshot(null, msg);
              },
              onResetIncomplete: ({ remainingPaths = [] }) => {
                const preview = remainingPaths.slice(0, 10).join(", ");
                const more = remainingPaths.length > 10 ? " ..." : "";
                if (opts.onDirtyResetIncomplete) {
                  opts.onDirtyResetIncomplete({ remainingPaths });
                } else if (opts.onDirtySnapshot) {
                  opts.onDirtySnapshot(null, `reset incomplete: ${preview}${more}`);
                }
              },
            });
            if (opts.onDirtySnapshot) opts.onDirtySnapshot(snapshotDir);
          }
        }
        if (currentBranch !== branchName) {
          deferWorktreeReuseMutationIfRequested(opts, "shouldDeferBranchMismatchRecovery", {
            wtPath,
            branchName,
            currentBranch,
          }, "Worktree branch mismatch recovery deferred");
          if (opts.onBranchMismatch) {
            opts.onBranchMismatch({ expected: branchName, actual: currentBranch || null, wtPath });
          }
          removeWorktreePath(wtPath, mainCwd);
        } else {
          let worktreeHead = null;
          let branchHead = null;
          try { worktreeHead = gitExec(["rev-parse", "HEAD"], wtPath).trim(); } catch { worktreeHead = null; }
          try { branchHead = gitExec(["rev-parse", "--verify", `${branchName}^{commit}`], mainCwd).trim(); } catch { branchHead = null; }
          if (branchHead && (!worktreeHead || worktreeHead !== branchHead)) {
            deferWorktreeReuseMutationIfRequested(opts, "shouldDeferHeadReset", {
              wtPath,
              branchName,
              currentBranch,
              worktreeHead,
              branchHead,
            }, "Worktree stale HEAD reset deferred");
            if (opts.onStaleHead) {
              if (worktreeHead) {
                opts.onStaleHead({ branchName, worktreeHead, branchHead, wtPath });
              }
            }
            gitExec(["reset", "--hard", branchHead], wtPath);
          }
          return wtPath;
        }
      } catch (err) {
        if (err?.deferWorktreeCleanup) throw err;
        // git metadata is unreadable — git-based snapshot is impossible.
        // Fall back to a raw filesystem copy so the user's uncommitted edits
        // aren't silently destroyed by the subsequent removeWorktreePath.
        const fileSnapshot = preserveCorruptWorktreeContents(wtPath, mainCwd, {
          wiId: opts.wiId || null,
          branchName,
        });
        if (fileSnapshot && opts.onDirtySnapshot) {
          opts.onDirtySnapshot(fileSnapshot, "corrupt-metadata: copied worktree contents to recovery directory");
        }
        removeWorktreePath(wtPath, mainCwd);
      }
    }
    const worktree = Worktree.at(mainCwd, wtPath, { branchName });
    const branchExists = gitBranchExists(branchName, mainCwd);
    worktree.add({ createBranch: !branchExists });
    if (!branchExists) {
      if (opts.onBranchCreated) opts.onBranchCreated({ branchName, wtPath });
    }
    return wtPath;
  } finally {
    lock.release();
  }
}

export async function gitWorktreeAddAsync(wtPath, branchName, mainCwd, opts = {}) {
  const signal = opts.signal || null;
  const nativeParity = opts.nativeParity || {};
  const lockPath = worktreeLockPath(wtPath, mainCwd);
  const lockOpts = { signal };
  if (opts.lockWaitMs != null) lockOpts.waitMs = opts.lockWaitMs;
  const lock = await acquireWorktreeLockAsync(lockPath, lockOpts);
  if (!lock.acquired) {
    throw new Error(`Timed out waiting for worktree lock: ${lockPath}`);
  }
  try {
    if (opts.wiId != null) {
      const migratedFrom = await migrateLegacyWorktreeIfNeededAsync(wtPath, mainCwd, opts.wiId, { signal, nativeParity });
      if (migratedFrom && opts.onLegacyMigrate) opts.onLegacyMigrate(migratedFrom);
    }
    if (fs.existsSync(wtPath)) {
      try {
        await gitExecAsync(["rev-parse", "--git-dir"], wtPath, { signal });
        const currentBranch = await gitCurrentBranchAsync(wtPath, { signal });
        const dirty = await worktreeNeedsRecoveryAsync(wtPath, { signal });
        if (dirty) {
          const skipDirtyRecovery = typeof opts.shouldSkipDirtyRecovery === "function"
            && await opts.shouldSkipDirtyRecovery({ wtPath, currentBranch, branchName });
          if (!skipDirtyRecovery && typeof opts.shouldDeferDirtyRecovery === "function" && opts.shouldDeferDirtyRecovery({ wtPath, branchName: currentBranch || branchName })) {
            const err = new Error("Dirty reused worktree cleanup deferred because a same-WI job is still active");
            err.code = "WORKTREE_ACTIVE_SIBLING_LOCKS";
            err.deferWorktreeCleanup = true;
            throw err;
          }
          if (!skipDirtyRecovery) {
            const snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, mainCwd, {
              reason: "reused-dirty-worktree",
              branchName: currentBranch || branchName,
              wiId: opts.wiId || null,
              lock: false,
              signal,
              nativeParity,
              onMsg: (msg) => {
                if (opts.onDirtySnapshot) opts.onDirtySnapshot(null, msg);
              },
              onResetIncomplete: ({ remainingPaths = [] }) => {
                const preview = remainingPaths.slice(0, 10).join(", ");
                const more = remainingPaths.length > 10 ? " ..." : "";
                if (opts.onDirtyResetIncomplete) {
                  opts.onDirtyResetIncomplete({ remainingPaths });
                } else if (opts.onDirtySnapshot) {
                  opts.onDirtySnapshot(null, `reset incomplete: ${preview}${more}`);
                }
              },
            });
            if (opts.onDirtySnapshot) opts.onDirtySnapshot(snapshotDir);
          }
        }
        if (currentBranch !== branchName) {
          deferWorktreeReuseMutationIfRequested(opts, "shouldDeferBranchMismatchRecovery", {
            wtPath,
            branchName,
            currentBranch,
          }, "Worktree branch mismatch recovery deferred");
          if (opts.onBranchMismatch) {
            opts.onBranchMismatch({ expected: branchName, actual: currentBranch || null, wtPath });
          }
          await removeWorktreePathAsync(wtPath, mainCwd, { signal });
        } else {
          let worktreeHead = null;
          let branchHead = null;
          try { worktreeHead = (await gitExecAsync(["rev-parse", "HEAD"], wtPath, { signal })).trim(); } catch (err) { if (isAbortError(err)) throw err; worktreeHead = null; }
          try { branchHead = (await gitExecAsync(["rev-parse", "--verify", `${branchName}^{commit}`], mainCwd, { signal })).trim(); } catch (err) { if (isAbortError(err)) throw err; branchHead = null; }
          if (branchHead && (!worktreeHead || worktreeHead !== branchHead)) {
            deferWorktreeReuseMutationIfRequested(opts, "shouldDeferHeadReset", {
              wtPath,
              branchName,
              currentBranch,
              worktreeHead,
              branchHead,
            }, "Worktree stale HEAD reset deferred");
            if (opts.onStaleHead) {
              if (worktreeHead) {
                opts.onStaleHead({ branchName, worktreeHead, branchHead, wtPath });
              }
            }
            await gitExecAsync(["reset", "--hard", branchHead], wtPath, { signal });
          }
          return wtPath;
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (err?.deferWorktreeCleanup) throw err;
        const fileSnapshot = preserveCorruptWorktreeContents(wtPath, mainCwd, {
          wiId: opts.wiId || null,
          branchName,
        });
        if (fileSnapshot && opts.onDirtySnapshot) {
          opts.onDirtySnapshot(fileSnapshot, "corrupt-metadata: copied worktree contents to recovery directory");
        }
        await removeWorktreePathAsync(wtPath, mainCwd, { signal });
      }
    }
    const worktree = Worktree.at(mainCwd, wtPath, { branchName });
    const branchExists = await gitBranchExistsAsync(branchName, mainCwd, { signal, nativeParity });
    await worktree.addAsync({ createBranch: !branchExists, signal, nativeParity });
    if (!branchExists) {
      if (opts.onBranchCreated) opts.onBranchCreated({ branchName, wtPath });
    }
    return wtPath;
  } finally {
    await lock.releaseAsync();
  }
}
