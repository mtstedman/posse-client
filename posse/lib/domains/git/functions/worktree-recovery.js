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

const PORCELAIN_Z_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

// `git status --porcelain=v1 -z` entries as path -> two-letter status. A
// rename or copy also records its source path, so path-scoped work covers
// both sides.
export function porcelainStatusEntries(output) {
  const entries = new Map();
  const parts = String(output || "").split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    entries.set(part.slice(3), status);
    if (/[RC]/u.test(status) && parts[index + 1]) {
      entries.set(parts[index + 1], status);
      index += 1;
    }
  }
  return entries;
}

// Paths whose status entry appeared or changed between two porcelain reads:
// what an operation run in between touched.
export function porcelainDeltaPaths(before, after) {
  const prior = porcelainStatusEntries(before);
  const delta = [];
  for (const [file, status] of porcelainStatusEntries(after)) {
    if (prior.get(file) !== status) delta.push(file);
  }
  return delta;
}

export function worktreePorcelainZ(wtPath) {
  try {
    return String(gitExec(PORCELAIN_Z_ARGS, wtPath, { trim: false }) ?? "");
  } catch {
    return null;
  }
}

export async function worktreePorcelainZAsync(wtPath, { signal = null } = {}) {
  try {
    return String(await gitExecAsync(PORCELAIN_Z_ARGS, wtPath, { signal, trim: false }) ?? "");
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

function literalPathspec(file) {
  return `:(literal)${file}`;
}

// Put each path back to its state in `tree` (index and worktree), or remove
// it when `tree` does not have it. This undoes one operation path by path in
// a worktree that sibling jobs share, where a whole-worktree reset would also
// erase their files. Returns the paths that could not be restored.
export function restorePathsToTree(wtPath, paths = [], tree = "HEAD") {
  const failed = [];
  for (const file of paths) {
    try {
      let inTree = true;
      try { gitExec(["cat-file", "-e", `${tree}:${file}`], wtPath); } catch { inTree = false; }
      if (inTree) {
        gitExec(["restore", `--source=${tree}`, "--staged", "--worktree", "--", literalPathspec(file)], wtPath);
        continue;
      }
      gitExec(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", literalPathspec(file)], wtPath);
      fs.rmSync(path.join(wtPath, file), { force: true, recursive: true });
    } catch {
      failed.push(file);
    }
  }
  return failed;
}

export async function restorePathsToTreeAsync(wtPath, paths = [], tree = "HEAD", { signal = null } = {}) {
  const failed = [];
  for (const file of paths) {
    try {
      const inTree = await gitExecAsync(["cat-file", "-e", `${tree}:${file}`], wtPath, { signal })
        .then(() => true, (err) => {
          if (isAbortError(err)) throw err;
          return false;
        });
      if (inTree) {
        await gitExecAsync(["restore", `--source=${tree}`, "--staged", "--worktree", "--", literalPathspec(file)], wtPath, { signal });
        continue;
      }
      await gitExecAsync(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", literalPathspec(file)], wtPath, { signal });
      await fs.promises.rm(path.join(wtPath, file), { force: true, recursive: true });
    } catch (err) {
      if (isAbortError(err)) throw err;
      failed.push(file);
    }
  }
  return failed;
}

// A pathspec-limited `stash push` can only name paths present in the index or
// the worktree. A staged deletion or a rename source is in neither, and
// naming it makes git fail after the stash entry is already written; those
// stay staged in place.
async function stashablePathsAsync(wtPath, paths, { signal = null } = {}) {
  if (paths.length === 0) return [];
  const indexed = new Set(String(await gitExecAsync(
    ["ls-files", "-z", "--", ...paths.map(literalPathspec)],
    wtPath,
    { signal, trim: false },
  ) || "").split("\0").filter(Boolean));
  return paths.filter((file) => indexed.has(file) || fs.existsSync(path.join(wtPath, file)));
}

// A pathspec-limited stash still records the whole index, so another job's
// staged entries (materialized placeholders) would ride along and collide
// with that job's files when this stash is applied. They are unstaged for the
// push and their exact index entries put back afterwards; their worktree
// files are never touched. Returns null when there is nothing to hide, or
// when an unmerged entry makes the round trip unsafe.
async function foreignStagedEntriesAsync(wtPath, entries, ownPaths, { signal = null } = {}) {
  const files = [...entries]
    .filter(([file, status]) => !ownPaths.has(file) && !" ?!".includes(status[0]))
    .map(([file]) => file);
  if (files.length === 0) return null;
  const saved = String(await gitExecAsync(
    ["ls-files", "-s", "-z", "--", ...files.map(literalPathspec)],
    wtPath,
    { signal, trim: false },
  ) || "").split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, object, stage] = line.slice(0, tab).split(" ");
    return { mode, object, stage, file: line.slice(tab + 1) };
  });
  if (saved.some((entry) => entry.stage !== "0")) return null;
  const savedByPath = new Map(saved.map((entry) => [entry.file, entry]));
  const zeroObject = "0".repeat(
    saved[0]?.object.length || String(await gitExecAsync(["rev-parse", "--verify", "HEAD"], wtPath, { signal }) || "").trim().length || 40,
  );
  // Mode 0 removes the path, so a staged deletion comes back as a deletion.
  const restoreInput = files.map((file) => {
    const entry = savedByPath.get(file);
    return entry ? `${entry.mode} ${entry.object}\t${file}\0` : `0 ${zeroObject}\t${file}\0`;
  }).join("");
  return { files, restoreInput };
}

async function restoreForeignStagedEntriesAsync(wtPath, hidden) {
  try {
    await gitExecAsync(["update-index", "-z", "--index-info"], wtPath, { input: hidden.restoreInput });
  } catch (err) {
    log.warn("git", "Could not restore sibling index entries after a scoped stash; their files remain in the worktree", {
      wtPath,
      paths: hidden.files.slice(0, 20),
      error: err?.message || String(err),
    });
  }
}

// There is intentionally no raw reset export. Dirty-state preservation and
// destructive cleanup are one Rust-owned mutation so callers cannot bypass
// the fail-closed snapshot invariant.
//
// `selectPaths(dirtyPaths)` limits the stash to the caller's own paths in a
// worktree that sibling jobs share. It runs under the worktree lock and
// returns null to stash everything, or the paths to stash (none: no stash).
export async function stashDirtyWorktreeAsync(
  wtPath,
  projectDir,
  message,
  { worktreeLockWaitMs = null, stashLockWaitMs = null, shouldDefer = null, selectPaths = null, signal = null } = {},
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

    let pathspec = [];
    let scopedEntries = null;
    let ownPaths = null;
    if (typeof selectPaths === "function") {
      const porcelain = await worktreePorcelainZAsync(wtPath, { signal });
      if (porcelain === null) throw new Error(`Could not read worktree status before a scoped stash: ${wtPath}`);
      const entries = porcelainStatusEntries(porcelain);
      const selected = await selectPaths([...entries.keys()]);
      if (Array.isArray(selected)) {
        ownPaths = new Set(selected.filter((file) => entries.has(file)));
        pathspec = await stashablePathsAsync(wtPath, [...ownPaths], { signal });
        if (pathspec.length === 0) return false;
        scopedEntries = entries;
      }
    }

    // refs/stash is shared by every worktree in the repository.
    const lockPath = await gitStashLockPathAsync(wtPath, mainCwd, { signal, nativeParity: { disabled: true } });
    const stashLock = await acquireWorktreeLockAsync(lockPath, {
      waitMs: stashLockWaitMs ?? worktreeLockWaitMs,
      signal,
    });
    if (!stashLock.acquired) {
      throw new Error(`Timed out waiting for git stash lock: ${lockPath}`);
    }
    let hidden = null;
    try {
      if (scopedEntries) hidden = await foreignStagedEntriesAsync(wtPath, scopedEntries, ownPaths, { signal });
      if (hidden) await gitExecAsync(["restore", "--staged", "--", ...hidden.files.map(literalPathspec)], wtPath, { signal });
      await gitExecAsync([
        "stash", "push", "--include-untracked", "-m", message,
        ...(pathspec.length > 0 ? ["--", ...pathspec.map(literalPathspec)] : []),
      ], wtPath, { signal });
      return true;
    } finally {
      if (hidden) await restoreForeignStagedEntriesAsync(wtPath, hidden);
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
    expectedHead = null,
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
    if (expectedHead) {
      const commit = String(await gitExecAsync(["rev-parse", "HEAD"], wtPath)).trim();
      let ref = null;
      try {
        ref = String(await gitExecAsync(["symbolic-ref", "--quiet", "--short", "HEAD"], wtPath)).trim() || null;
      } catch { /* detached HEAD has no symbolic ref */ }
      if (commit !== expectedHead.commit || ref !== expectedHead.ref) {
        throw new Error("worktree HEAD changed before deterministic check cleanup; refusing to reset possible concurrent sibling progress");
      }
    }
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
