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
import { gitExecAsync } from "./utils.js";
import { Worktree } from "../classes/index.js";
import {
  acquireWorktreeLockAsync,
  worktreeLockPath,
} from "./worktree-locks.js";
import { randomToken } from "./worktree-internal.js";
import {
  gitBranchExistsAsync,
  gitCurrentBranchAsync,
  nestedProjectSubpathAsync,
} from "./worktree-path.js";
import { migrateLegacyWorktreeIfNeededAsync } from "./worktree-legacy.js";
import {
  worktreeNeedsRecoveryAsync,
  snapshotAndResetDirtyWorktreeAsync,
  preserveCorruptWorktreeContents,
} from "./worktree-recovery.js";
import { removeWorktreePathAsync } from "./worktree-safe-remove.js";

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
      // The dir must BE a worktree root, not merely sit inside one:
      // `rev-parse --git-dir` resolves upward, so a stale dir that lost its
      // .git file (partial context-dir rm) resolves to the enclosing repo —
      // the main checkout, since these dirs live under <project>/.posse/ —
      // and the reset/clean below would then hit the user's working tree.
      const toplevel = String(await gitExecAsync(["rev-parse", "--show-toplevel"], targetDir, { signal }) || "").trim();
      if (!toplevel || path.resolve(toplevel).toLowerCase() !== targetDir.toLowerCase()) {
        throw new Error(`stale directory is not a worktree root (toplevel: ${toplevel || "unknown"})`);
      }
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

export async function gitWorktreeAddAsync(wtPath, branchName, mainCwd, opts = {}) {
  const signal = opts.signal || null;
  const nativeParity = opts.nativeParity || {};
  const lockPath = worktreeLockPath(wtPath, mainCwd, { disabled: true });
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
        let dirty;
        try {
          dirty = await worktreeNeedsRecoveryAsync(wtPath, { signal, strict: true });
        } catch (probeErr) {
          if (isAbortError(probeErr)) throw probeErr;
          // Unknown dirty state must defer, not fall into the corrupt-metadata
          // removal below — the probe failure is usually transient (index.lock,
          // status timeout) while the removal is permanent.
          const err = new Error(`Worktree dirty-state probe failed; deferring reuse recovery: ${probeErr?.message || String(probeErr)}`);
          err.code = "WORKTREE_DIRTY_PROBE_FAILED";
          err.deferWorktreeCleanup = true;
          throw err;
        }
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
          // The removal below is a raw force-remove. Anything the recovery
          // pass above could not capture (tolerated sibling residue, stash-
          // blind leftovers like nested repos) must block it — as must an
          // unreadable status, since removal is permanent.
          let leftover;
          try {
            leftover = String(await gitExecAsync(["status", "--porcelain"], wtPath, { signal }) || "").trim();
          } catch (statusErr) {
            if (isAbortError(statusErr)) throw statusErr;
            leftover = `status unreadable: ${statusErr?.message || String(statusErr)}`;
          }
          if (leftover) {
            const err = new Error(`Worktree on ${currentBranch || "unknown"} (expected ${branchName}) still has unpreserved changes; deferring removal`);
            err.code = "WORKTREE_DIRTY_PROBE_FAILED";
            err.deferWorktreeCleanup = true;
            throw err;
          }
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
        // A snapshot refusal is a deliberate fail-closed stop, not corrupt
        // metadata — reclassifying it here would answer "refusing to reset"
        // with a lossy copy plus force-removal.
        if (err?.code === "SNAPSHOT_REFUSED_RESET") throw err;
        const fileSnapshot = preserveCorruptWorktreeContents(wtPath, mainCwd, {
          wiId: opts.wiId || null,
          branchName,
        });
        if (fileSnapshot && opts.onDirtySnapshot) {
          opts.onDirtySnapshot(fileSnapshot, "corrupt-metadata: copied worktree contents to recovery directory");
        }
        // null means nothing was copied: either the worktree is genuinely
        // empty (a bare dir / lone .git gitfile is safe to remove) or the
        // copy itself failed — in which case removal would be the only copy's
        // destruction, so surface the original error instead.
        let removable = !!fileSnapshot;
        if (!removable) {
          try {
            const entries = fs.readdirSync(wtPath);
            removable = entries.every((name) => name === ".git" && fs.statSync(path.join(wtPath, name)).isFile());
          } catch {
            removable = false;
          }
        }
        if (!removable) throw err;
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
