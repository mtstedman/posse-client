// lib/domains/git/functions/worktree.js
//
// Worktree lifecycle helpers for provisioning, reuse, cleanup, and recovery
// snapshots in worker-managed git sandboxes.

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { execFileSync } from "child_process";
import { LOCK_HOLDING_JOB_STATUSES, TERMINAL_WORK_ITEM_STATUSES } from "../../queue/functions/common.js";
import { getWorkItem, listJobsByWorkItem, refreshWorkItemStatus, setMergeState, setWorkItemBranch } from "../../queue/functions/index.js";

const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { ensurePosseGitInfoExclude } from "../../runtime/functions/ignore.js";
import { isAbortError, signalAbortError, throwIfAborted } from "../../runtime/functions/yield.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { jobNeedsGitWorktree } from "./policy.js";
import { FORCE_REMOVE_OPTIONS } from "./worktree-remove-options.js";
import { contextDir, wiScopeId } from "../../artifacts/functions/index.js";
import { disposeWorkItemAtlasGraph } from "../../integrations/functions/atlas.js";
import {
  gitExec,
  gitExecAsync,
  gitGateSnapshot,
  gitHasChanges,
  gitHasChangesAsync,
  gitHasIgnoredChanges,
} from "./utils.js";
import { resolveTargetBranch } from "./target-branch.js";
import { Repo, Worktree, SnapshotRef } from "../classes/index.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "./native/invoke.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  worktreeLockPath,
  gitStashLockPath,
  gitStashLockPathAsync,
  withWorktreeLock,
  withWorktreeLockAsync,
} from "./worktree-locks.js";
import {
  safeFilename,
  parsePositiveIntSetting,
  parseBooleanSetting,
  recoveryRoot,
  snapshotRefName,
  listSnapshotRefs,
  listSnapshotRefsAsync,
  readSnapshotNote,
  readSnapshotNoteAsync,
  writeSnapshotNote,
  writeSnapshotNoteAsync,
  findExistingDedupSnapshotRef,
  findExistingDedupSnapshotRefAsync,
  pruneRecoveredWorktreeSnapshots,
  pruneRecoveredWorktreeSnapshotsAsync,
  preserveDirtyWorktreeSnapshot,
  preserveDirtyWorktreeSnapshotAsync,
  preserveBranchTipSnapshot,
  preserveBranchTipSnapshotAsync,
} from "./worktree-snapshots.js";
export { resolveTargetBranch };
export {
  acquireWorktreeLockAsync,
  releaseWorktreeLockAsync,
  withWorktreeLock,
  withWorktreeLockAsync,
  __testResolveWorktreeLockWaitMs,
} from "./worktree-locks.js";
export {
  dirSizeBytes,
  pruneRecoveredWorktreeSnapshots,
  pruneRecoveredWorktreeSnapshotsAsync,
  preserveDirtyWorktreeSnapshot,
  preserveDirtyWorktreeSnapshotAsync,
  preserveBranchTipSnapshot,
  preserveBranchTipSnapshotAsync,
} from "./worktree-snapshots.js";

const HOLDING_STATUSES = new Set(["queued", ...LOCK_HOLDING_JOB_STATUSES]);
const DEFAULT_SNAPSHOT_MAX_FILES = 500;
const DEFAULT_SNAPSHOT_MAX_COPY_BYTES = 100 * 1024 * 1024;
const DEFAULT_GC_TIMING_SLOW_MS = 1000;
const GC_TIMING_SUMMARY_LIMIT = 5;
const WORKTREE_REMOVE_RETRY_DELAYS_MS = Object.freeze(process.platform === "win32"
  ? [250, 750, 1500, 3000]
  : [100]);

function randomToken(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

function formatGcDuration(ms) {
  const rounded = Math.max(0, Math.round(Number(ms) || 0));
  if (rounded < 1000) return `${rounded}ms`;
  const seconds = rounded / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

function sleepSyncMs(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delay);
}

function sleepMs(ms, { signal = null } = {}) {
  const delay = Math.max(0, Number(ms) || 0);
  throwIfAborted(signal);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delay);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalAbortError(signal));
    };
    function done() {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeGitGateKey(cwd) {
  const normalized = path.resolve(String(cwd || process.cwd())).replace(/\\/g, "/");
  return `git:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

function gitGatePressureSummary(cwd) {
  let state = null;
  try {
    const key = normalizeGitGateKey(cwd);
    state = gitGateSnapshot().keys.find((entry) => entry.key === key) || null;
  } catch {
    state = null;
  }
  if (!state) return null;
  const activeReaders = Number(state.activeReaders) || 0;
  const pendingReaders = Number(state.pendingReaders) || 0;
  const pendingWriters = Number(state.pendingWriters) || 0;
  const activeWriter = Boolean(state.activeWriter);
  if (!activeWriter && activeReaders === 0 && pendingReaders === 0 && pendingWriters === 0) return null;
  return [
    `readers=${activeReaders}`,
    `writer=${activeWriter ? 1 : 0}`,
    `pendingReaders=${pendingReaders}`,
    `pendingWriters=${pendingWriters}`,
  ].join(" ");
}

function resolveGcTimingSlowMs(value) {
  if (value != null) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return parsePositiveIntSetting("worktree_gc_timing_slow_ms", DEFAULT_GC_TIMING_SLOW_MS);
}

function createGcTiming(onMsg, { slowMs = null, now = null } = {}) {
  const startedAt = typeof now === "function" ? now() : Date.now();
  const nowFn = typeof now === "function" ? now : () => Date.now();
  const thresholdMs = resolveGcTimingSlowMs(slowMs);
  const entries = [];
  const notify = typeof onMsg === "function" ? onMsg : () => {};

  function emit(message) {
    try { notify(message); } catch { /* instrumentation must not affect cleanup */ }
  }

  function detailSuffix(detail = {}) {
    const parts = [];
    if (detail.gitGateBefore) parts.push(`git gate before: ${detail.gitGateBefore}`);
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
  }

  function record(label, startMs, detail = {}) {
    const durationMs = Math.max(0, Math.round(nowFn() - startMs));
    const entry = { label, durationMs, detail };
    entries.push(entry);
    if (durationMs >= thresholdMs) {
      emit(`GC timing: ${label} took ${formatGcDuration(durationMs)}${detailSuffix(detail)}`);
      try {
        log.warn("git", "Worktree GC step was slow", {
          label,
          durationMs,
          thresholdMs,
          ...(detail.gitGateBefore ? { gitGateBefore: detail.gitGateBefore } : {}),
        });
      } catch { /* instrumentation must not affect cleanup */ }
    }
  }

  async function step(label, fn, { gitCwd = null } = {}) {
    const startMs = nowFn();
    const detail = {};
    if (gitCwd) {
      const gitGateBefore = gitGatePressureSummary(gitCwd);
      if (gitGateBefore) detail.gitGateBefore = gitGateBefore;
    }
    try {
      return await fn();
    } finally {
      record(label, startMs, detail);
    }
  }

  function finish() {
    if (entries.length === 0) return;
    const totalDurationMs = Math.max(0, Math.round(nowFn() - startedAt));
    const slowEntries = entries.filter((entry) => entry.durationMs >= thresholdMs);
    if (totalDurationMs < thresholdMs && slowEntries.length === 0) return;
    const slowest = [...entries]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, GC_TIMING_SUMMARY_LIMIT)
      .map((entry) => `${entry.label} ${formatGcDuration(entry.durationMs)}`)
      .join(", ");
    emit(`GC timing: total ${formatGcDuration(totalDurationMs)}; slowest: ${slowest}`);
    try {
      log.info("git", "Worktree GC timing summary", {
        totalDurationMs,
        thresholdMs,
        slowest: [...entries]
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, GC_TIMING_SUMMARY_LIMIT)
          .map((entry) => ({ label: entry.label, durationMs: entry.durationMs })),
      });
    } catch { /* instrumentation must not affect cleanup */ }
  }

  return { step, finish };
}

function gitBranchExists(branchName, cwd) {
  return new Repo(cwd).branchExists(branchName);
}

function gitBranchExistsAsync(branchName, cwd, options = {}) {
  return new Repo(cwd).branchExistsAsync(branchName, options);
}

function gitErrorExitCode(err) {
  if (Number.isInteger(err?.status)) return err.status;
  if (Number.isInteger(err?.code)) return err.code;
  return null;
}

function gitErrorSummary(err) {
  return String(err?.stderr || err?.message || err || "unknown git error")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
    ?.slice(0, 500) || "unknown git error";
}

function isExpectedGitPredicateMiss(err) {
  return gitErrorExitCode(err) === 1;
}

function logSuppressedGitFailure(operation, err, detail = {}) {
  log.debug("git", `${operation} failed; preserving legacy fallback`, {
    ...detail,
    exitCode: gitErrorExitCode(err),
    error: gitErrorSummary(err),
  });
}

function branchIsAncestorOfTarget(branchName, targetBranch, cwd) {
  if (!branchName || !targetBranch) return false;
  try {
    gitExec(["merge-base", "--is-ancestor", branchName, targetBranch], cwd);
    return true;
  } catch (err) {
    if (!isExpectedGitPredicateMiss(err)) {
      logSuppressedGitFailure("branch ancestor check", err, { cwd, branchName, targetBranch });
    }
    return false;
  }
}

async function branchIsAncestorOfTargetAsync(branchName, targetBranch, cwd, options = {}) {
  if (!branchName || !targetBranch) return false;
  try {
    await gitExecAsync(["merge-base", "--is-ancestor", branchName, targetBranch], cwd, options);
    return true;
  } catch (err) {
    if (isAbortError(err)) throw err;
    if (!isExpectedGitPredicateMiss(err)) {
      logSuppressedGitFailure("branch ancestor check", err, { cwd, branchName, targetBranch });
    }
    return false;
  }
}

function gitCurrentBranch(cwd, nativeParity = {}) {
  return Worktree.at(cwd, cwd).currentBranch(nativeParity);
}

function gitCurrentBranchAsync(cwd, options = {}) {
  return Worktree.at(cwd, cwd).currentBranchAsync(options);
}

function removeWorktreePath(wtPath, mainCwd) {
  Worktree.at(mainCwd, wtPath).remove({ force: true, prune: true, fallbackRemove: true });
}

function removeWorktreePathAsync(wtPath, mainCwd, options = {}) {
  return Worktree.at(mainCwd, wtPath).removeAsync({ force: true, prune: true, fallbackRemove: true, ...options });
}

function forceRemoveWorktreePathAfterNative(wtPath, mainCwd) {
  try { gitExec(["worktree", "prune"], mainCwd); } catch {}
  try {
    fs.rmSync(wtPath, FORCE_REMOVE_OPTIONS);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw err;
  }
  try { gitExec(["worktree", "prune"], mainCwd); } catch {}
}

async function forceRemoveWorktreePathAfterNativeAsync(wtPath, mainCwd, { signal = null } = {}) {
  try { await gitExecAsync(["worktree", "prune"], mainCwd, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
  try {
    await fs.promises.rm(wtPath, FORCE_REMOVE_OPTIONS);
  } catch (err) {
    if (isAbortError(err)) throw err;
  }
  try { await gitExecAsync(["worktree", "prune"], mainCwd, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
}

function retryForceRemoveWorktreePathAfterNative(wtPath, mainCwd) {
  let lastError = null;
  for (let attempt = 0; attempt <= WORKTREE_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) sleepSyncMs(WORKTREE_REMOVE_RETRY_DELAYS_MS[attempt - 1]);
    try {
      forceRemoveWorktreePathAfterNative(wtPath, mainCwd);
      if (!fs.existsSync(wtPath)) return true;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return !fs.existsSync(wtPath);
}

async function retryForceRemoveWorktreePathAfterNativeAsync(wtPath, mainCwd, { signal = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= WORKTREE_REMOVE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleepMs(WORKTREE_REMOVE_RETRY_DELAYS_MS[attempt - 1], { signal });
    try {
      await forceRemoveWorktreePathAfterNativeAsync(wtPath, mainCwd, { signal });
      if (!fs.existsSync(wtPath)) return true;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return !fs.existsSync(wtPath);
}

function worktreePorcelain(wtPath) {
  return gitExec(["status", "--porcelain"], wtPath).trim();
}

async function worktreePorcelainAsync(wtPath, { signal = null } = {}) {
  return (await gitExecAsync(["status", "--porcelain"], wtPath, { signal })).trim();
}

function gitTopLevel(cwd) {
  try {
    return path.resolve(gitExec(["rev-parse", "--show-toplevel"], cwd));
  } catch (err) {
    logSuppressedGitFailure("git top-level resolution", err, { cwd });
    return path.resolve(cwd);
  }
}

async function gitTopLevelAsync(cwd, options = {}) {
  try {
    return path.resolve(await gitExecAsync(["rev-parse", "--show-toplevel"], cwd, options));
  } catch (err) {
    logSuppressedGitFailure("git top-level resolution", err, { cwd });
    return path.resolve(cwd);
  }
}

export const __testGitDiagnostics = Object.freeze({
  branchIsAncestorOfTarget,
  branchIsAncestorOfTargetAsync,
  gitTopLevel,
  gitTopLevelAsync,
  isExpectedGitPredicateMiss,
  resetDirtyWorktreeAsync,
});

function nestedProjectSubpath(projectDir) {
  const projectRoot = path.resolve(projectDir);
  const repoRoot = gitTopLevel(projectDir);
  const rel = path.relative(repoRoot, projectRoot);
  if (!rel || rel === "") return null;
  if (!isInsideRoot(projectRoot, repoRoot, { allowEqual: false, followSymlinks: false })) return null;
  return rel.replace(/\\/g, "/");
}

async function nestedProjectSubpathAsync(projectDir, options = {}) {
  const projectRoot = path.resolve(projectDir);
  const repoRoot = await gitTopLevelAsync(projectDir, options);
  const rel = path.relative(repoRoot, projectRoot);
  if (!rel || rel === "") return null;
  if (!isInsideRoot(projectRoot, repoRoot, { allowEqual: false, followSymlinks: false })) return null;
  return rel.replace(/\\/g, "/");
}


function worktreeNeedsRecovery(wtPath) {
  try {
    return gitHasChanges(wtPath)
      || (parseBooleanSetting("worktree_clean_ignored", false) && gitHasIgnoredChanges(wtPath));
  } catch (err) {
    // Fail closed: callers treat "clean" as "leave the worktree alone", so an
    // unreadable/corrupt worktree is never reset. Log it so corruption isn't
    // silently invisible.
    log.warn("git", "Worktree dirty-state check failed; treating as clean (no recovery)", {
      wtPath,
      error: err?.message || String(err),
    });
    return false;
  }
}

async function worktreeNeedsRecoveryAsync(wtPath, options = {}) {
  try {
    return await worktreeHasChangesNodeAsync(wtPath, options)
      || (parseBooleanSetting("worktree_clean_ignored", false) && await worktreeHasIgnoredChangesNodeAsync(wtPath, options));
  } catch (err) {
    if (isAbortError(err)) throw err;
    log.warn("git", "Worktree dirty-state check failed; treating as clean (no recovery)", {
      wtPath,
      error: err?.message || String(err),
    });
    return false;
  }
}

async function worktreeHasChangesNodeAsync(wtPath, { signal = null } = {}) {
  const status = await gitExecAsync(["status", "--porcelain"], wtPath, {
    signal,
    nativeParity: { disabled: true },
  });
  return String(status || "").trim().length > 0;
}

async function worktreeHasIgnoredChangesNodeAsync(wtPath, { signal = null } = {}) {
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

function cleanWorktreeUntracked(wtPath, { cleanIgnoredOverride = null } = {}) {
  const cleanIgnored = cleanIgnoredOverride == null
    ? parseBooleanSetting("worktree_clean_ignored", false)
    : !!cleanIgnoredOverride;
  if (cleanIgnored) {
    // Remove ignored artifacts too, while preserving posse runtime dirs.
    gitExec(["clean", "-fdx", "-e", ".posse/"], wtPath);
    return;
  }
  gitExec(["clean", "-fd"], wtPath);
}

async function cleanWorktreeUntrackedAsync(wtPath, { cleanIgnoredOverride = null, signal = null } = {}) {
  const cleanIgnored = cleanIgnoredOverride == null
    ? parseBooleanSetting("worktree_clean_ignored", false)
    : !!cleanIgnoredOverride;
  if (cleanIgnored) {
    await gitExecAsync(["clean", "-fdx", "-e", ".posse/"], wtPath, { signal });
    return;
  }
  await gitExecAsync(["clean", "-fd"], wtPath, { signal });
}




function parsePorcelainRemainingPaths(porcelainZ) {
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

function resetDirtyWorktree(wtPath, { cleanIgnoredOverride = null } = {}) {
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

async function resetDirtyWorktreeAsync(wtPath, { cleanIgnoredOverride = null, signal = null, nativeParity = {} } = {}) {
  const cleanIgnored = cleanIgnoredOverride == null
    ? parseBooleanSetting("worktree_clean_ignored", false)
    : !!cleanIgnoredOverride;
  return await runGitNativeMethodAsync(
    "git.worktree.resetDirty",
    { wtPath: path.resolve(wtPath), cleanIgnored },
    { ...nativeParity, signal },
  );
}

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
  disposeWorkItemAtlasGraph({ projectDir, workItemId: wiId, worktreePath, ...options });
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


export function deleteBranchPreservingTip(
  projectDir,
  branchName,
  { targetBranch = resolveTargetBranch(projectDir), reason = "branch-cleanup", wiId = null, onMsg = null } = {},
) {
  if (!branchName) {
    return { ok: true, existed: false, deleted: false, snapshotRef: null, reason: "missing_branch_name" };
  }
  if (!gitBranchExists(branchName, projectDir)) {
    return { ok: true, existed: false, deleted: false, snapshotRef: null, reason: "branch_missing" };
  }

  const ancestorSafe = branchIsAncestorOfTarget(branchName, targetBranch, projectDir);
  let snapshotRef = null;
  if (!ancestorSafe) {
    snapshotRef = preserveBranchTipSnapshot(projectDir, branchName, { reason, wiId, onMsg });
    if (!snapshotRef) {
      return { ok: false, existed: true, deleted: false, snapshotRef: null, reason: "snapshot_failed" };
    }
  }

  try {
    gitExec(["branch", ancestorSafe ? "-d" : "-D", branchName], projectDir);
  } catch (err) {
    return {
      ok: false,
      existed: true,
      deleted: false,
      snapshotRef,
      reason: "branch_delete_failed",
      error: err?.message || String(err),
    };
  }

  if (gitBranchExists(branchName, projectDir)) {
    return { ok: false, existed: true, deleted: false, snapshotRef, reason: "branch_still_exists" };
  }
  return {
    ok: true,
    existed: true,
    deleted: true,
    snapshotRef,
    reason: ancestorSafe ? "ancestor_merged" : "snapshot_preserved",
  };
}

function compactNativeDeleteBranchResult(value = {}) {
  const result = {
    ok: Boolean(value.ok),
    existed: Boolean(value.existed),
    deleted: Boolean(value.deleted),
    snapshotRef: value.snapshotRef || null,
    reason: String(value.reason || ""),
  };
  if (value.error) result.error = String(value.error);
  return result;
}

export async function deleteBranchPreservingTipAsync(
  projectDir,
  branchName,
  { targetBranch = resolveTargetBranch(projectDir), reason = "branch-cleanup", wiId = null, onMsg = null, signal = null, nativeParity = {} } = {},
) {
  const result = await runGitNativeMethodAsync(
    "git.worktree.deleteBranchPreservingTip",
    {
      projectDir: path.resolve(projectDir),
      branchName: String(branchName || ""),
      targetBranch: String(targetBranch || ""),
      reason,
      wiId: wiId == null ? null : String(wiId),
    },
    { ...nativeParity, signal },
  );
  return compactNativeDeleteBranchResult(result);
}

export function worktreeRoot(projectDir, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.root",
    { projectDir: path.resolve(projectDir), create: true },
    nativeParity,
  );
}


export function resetDirtyWorktreeFallback(wtPath, projectDir = null) {
  return withWorktreeLock(wtPath, projectDir || wtPath, () => {
    gitExec(["checkout", "--", "."], wtPath);
    gitExec(["clean", "-fd"], wtPath);
  });
}

export async function resetDirtyWorktreeFallbackAsync(wtPath, projectDir = null, { signal = null } = {}) {
  return withWorktreeLockAsync(wtPath, projectDir || wtPath, async () => {
    await gitExecAsync(["checkout", "--", "."], wtPath, { signal });
    await gitExecAsync(["clean", "-fd"], wtPath, { signal });
  }, { signal });
}

export function stashDirtyWorktree(
  wtPath,
  projectDir,
  message,
  { worktreeLockWaitMs = null, stashLockWaitMs = null, shouldDefer = null } = {},
) {
  if (!wtPath) return false;
  const mainCwd = projectDir || wtPath;
  return withWorktreeLock(wtPath, mainCwd, () => {
    if (typeof shouldDefer === "function") {
      let defer = false;
      try {
        defer = !!shouldDefer({ wtPath, projectDir: mainCwd, message });
      } catch {
        return false;
      }
      if (defer) return false;
    }
    if (!gitHasChanges(wtPath)) return false;

    // refs/stash is shared by every worktree in the repository.
    const lockPath = gitStashLockPath(wtPath, mainCwd);
    const stashLock = acquireWorktreeLock(lockPath, {
      waitMs: stashLockWaitMs ?? worktreeLockWaitMs,
    });
    if (!stashLock.acquired) {
      throw new Error(`Timed out waiting for git stash lock: ${lockPath}`);
    }
    try {
      gitExec(["stash", "push", "--include-untracked", "-m", message], wtPath);
      return true;
    } finally {
      stashLock.release();
    }
  }, { waitMs: worktreeLockWaitMs });
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
    const lockPath = await gitStashLockPathAsync(wtPath, mainCwd, { signal });
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
function preserveCorruptWorktreeContents(wtPath, projectDir, { wiId, branchName } = {}) {
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

export function worktreePath(projectDir, wiId, _wiTitle = null, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.path",
    { projectDir: path.resolve(projectDir), wiId: String(wiId) },
    nativeParity,
  );
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

export function findLegacyWorktreeForWi(projectDir, wiId, nativeParity = {}) {
  return runGitNativeMethod(
    "git.worktree.findLegacy",
    { projectDir: path.resolve(projectDir), wiId: String(wiId) },
    nativeParity,
  );
}

export function migrateLegacyWorktreeIfNeeded(canonicalPath, projectDir, wiId) {
  if (fs.existsSync(canonicalPath) || wiId == null) return null;
  const legacy = findLegacyWorktreeForWi(projectDir, wiId);
  if (!legacy) return null;
  try {
    Worktree.at(projectDir, legacy).move(canonicalPath);
    return legacy;
  } catch {
    // Fallback: rename on disk then repair git metadata.
    try {
      Worktree.at(projectDir, legacy).move(canonicalPath, { fallbackRename: true });
      return legacy;
    } catch {
      return null;
    }
  }
}

export async function migrateLegacyWorktreeIfNeededAsync(
  canonicalPath,
  projectDir,
  wiId,
  { signal = null, nativeParity = {} } = {},
) {
  if (wiId == null) return null;
  return await runGitNativeMethodAsync(
    "git.worktree.migrateLegacy",
    {
      canonicalPath: path.resolve(canonicalPath),
      projectDir: path.resolve(projectDir),
      wiId: String(wiId),
    },
    { ...nativeParity, signal },
  );
}

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
    if (!resetResult?.clean && typeof onResetIncomplete === "function") {
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

  const lockPath = worktreeLockPath(wtPath, projectDir);
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
    if (!resetResult?.clean && typeof onResetIncomplete === "function") {
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
    return snapshotDir;
  } finally {
    if (heldLock?.acquired) await heldLock.releaseAsync();
  }
}

function notifySafeRemoveFailure(onFailure, detail) {
  if (typeof onFailure !== "function") return;
  try { onFailure(detail); } catch { /* cleanup failure callbacks are best-effort */ }
}

function notifySafeRemoveSnapshot(onSnapshot, detail) {
  if (typeof onSnapshot !== "function") return;
  try { onSnapshot(detail); } catch { /* snapshot callbacks are best-effort */ }
}

function safeRemoveBaseResult(wtPath, overrides = {}) {
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

    try {
      removeWorktreePath(wtPath, projectDir);
    } catch (err) {
      const message = `Failed to remove worktree after cleanup gate passed: ${err?.message || String(err)}`;
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: "remove",
        message,
        error: err?.message || String(err),
        snapshotDir,
        snapshotSucceeded,
        verifiedClean,
      });
    }

    let removed = !fs.existsSync(wtPath);
    if (!removed) {
      try {
        removed = retryForceRemoveWorktreePathAfterNative(wtPath, projectDir);
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
        phase: "remove",
        message: "Worktree removal command completed but path still exists",
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
      reason: removed ? "removed" : "remove_incomplete",
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

    try {
      await removeWorktreePathAsync(wtPath, projectDir, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      const message = `Failed to remove worktree after cleanup gate passed: ${err?.message || String(err)}`;
      notifySafeRemoveFailure(onFailure, {
        wtPath,
        projectDir,
        reason,
        branchName,
        wiId,
        phase: "remove",
        message,
        error: err?.message || String(err),
        snapshotDir,
        snapshotSucceeded,
        verifiedClean,
      });
    }

    let removed = !fs.existsSync(wtPath);
    if (!removed) {
      try {
        removed = await retryForceRemoveWorktreePathAfterNativeAsync(wtPath, projectDir, { signal });
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
        phase: "remove",
        message: "Worktree removal command completed but path still exists",
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
      reason: removed ? "removed" : "remove_incomplete",
    });
  }, { signal, waitMs: worktreeLockWaitMs });
}

export function classifyDirtyWorktree(wtPath, { jobId = null, nativeParity = {} } = {}) {
  return runGitNativeMethod(
    "git.worktree.classifyDirty",
    { wtPath: path.resolve(wtPath), jobId: jobId == null ? null : String(jobId) },
    nativeParity,
  );
}

export async function classifyDirtyWorktreeAsync(wtPath, { jobId = null, signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.classifyDirty",
    { wtPath: path.resolve(wtPath), jobId: jobId == null ? null : String(jobId) },
    { ...nativeParity, signal },
  );
}

/**
 * Is a merge currently in progress inside this worktree? True when MERGE_HEAD
 * is set (from a `git merge` that hit conflicts or was paused before commit).
 */
export function isMergeInProgress(wtPath, nativeParity = {}) {
  return runGitNativeMethod("git.worktree.isMergeInProgress", { wtPath: path.resolve(wtPath) }, nativeParity);
}

export async function isMergeInProgressAsync(wtPath, { signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.isMergeInProgress",
    { wtPath: path.resolve(wtPath) },
    { ...nativeParity, signal },
  );
}

/**
 * List the unmerged (conflicted) paths in a worktree. Empty array when no
 * conflicts or when git errors out.
 */
export function listMergeConflicts(wtPath, nativeParity = {}) {
  return runGitNativeMethod("git.worktree.listMergeConflicts", { wtPath: path.resolve(wtPath) }, nativeParity);
}

export async function listMergeConflictsAsync(wtPath, { signal = null, nativeParity = {} } = {}) {
  return await runGitNativeMethodAsync(
    "git.worktree.listMergeConflicts",
    { wtPath: path.resolve(wtPath) },
    { ...nativeParity, signal },
  );
}

function compactNativeMergeResult(value = {}) {
  const result = { ok: Boolean(value.ok) };
  if (value.error) result.error = String(value.error);
  if (value.updated !== null && value.updated !== undefined) result.updated = Boolean(value.updated);
  if (value.mergeCommit) result.mergeCommit = String(value.mergeCommit);
  if (value.alreadyInProgress) result.alreadyInProgress = true;
  if (value.leftInTree) result.leftInTree = true;
  if (value.abortFailed) result.abortFailed = true;
  if (value.manualRecoveryRequired) result.manualRecoveryRequired = true;
  if (Array.isArray(value.conflicts) && (!result.ok || value.conflicts.length > 0)) {
    result.conflicts = value.conflicts;
  }
  if (value.message) result.message = String(value.message);
  return result;
}

/**
 * Merge the target branch (main/master) into the WI branch inside its worktree.
 * Called before mutating jobs run so the dev agent sees the current state of
 * `main` and can resolve conflicts in-context rather than at wrap-up merge time.
 *
 * Returns one of:
 *   { ok: true, updated: false }                             — already up-to-date
 *   { ok: true, updated: true, mergeCommit }                 — clean merge landed
 *   { ok: false, conflicts: [paths], leftInTree: true }      — conflicts left for the dev to resolve (leaveOnConflict)
 *   { ok: false, conflicts: [paths], message }               — conflicts; aborted cleanly
 *   { ok: false, abortFailed: true, manualRecoveryRequired: true, ... }
 *                                                            — abort failed; MERGE_HEAD still set
 *   { ok: false, alreadyInProgress: true, conflicts: [...] } — a prior merge is still in progress; no-op
 *   { ok: false, error: message }                            — non-conflict failure (target missing etc.)
 *
 * Options:
 *   leaveOnConflict — when true, on conflict the merge is NOT aborted; MERGE_HEAD
 *     and conflict markers are left in the worktree so downstream (handoff + dev)
 *     can complete the merge. When false, the merge is aborted cleanly.
 */
export async function mergeTargetIntoWorktreeAsync(wtPath, projectDir, targetBranch, {
  leaveOnConflict = false,
  initialMergeInProgress = null,
  signal = null,
  nativeParity = {},
} = {}) {
  void initialMergeInProgress;
  const result = await runGitNativeMethodAsync(
    "git.worktree.mergeTarget",
    {
      wtPath: path.resolve(wtPath),
      projectDir: path.resolve(projectDir),
      targetBranch: String(targetBranch || ""),
      leaveOnConflict: Boolean(leaveOnConflict),
    },
    { ...nativeParity, signal },
  );
  return compactNativeMergeResult(result);
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
          disposeTerminalWorkItemAtlasGraph(projectDir, wiId, wtDir, {
            includeWarmed: !shouldPreserveUnmergedCompleteAtlasView(wi),
          });
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
            disposeTerminalWorkItemAtlasGraph(projectDir, wiId, wtDir);
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
