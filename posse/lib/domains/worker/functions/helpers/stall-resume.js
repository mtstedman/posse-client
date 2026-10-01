// lib/domains/worker/functions/helpers/stall-resume.js
//
// Drift detection and stall-resume stash recovery helpers extracted from
// worker.js to keep execute-path orchestration lean.

import { C } from "../../../../shared/format/functions/colors.js";
import { isAbortError } from "../../../runtime/functions/yield.js";
import { getWorkItem, clearStallResume } from "../../../queue/functions/index.js";
import { siblingJobScopePaths } from "../../../queue/functions/file-locks.js";
import { activeSiblingWriteLocks } from "../../../queue/functions/sibling-locks.js";
import {
  porcelainDeltaPaths,
  porcelainStatusEntries,
  preserveStashCommitSnapshot,
  preserveStashCommitSnapshotAsync,
  restorePathsToTree,
  restorePathsToTreeAsync,
  snapshotAndResetDirtyWorktree,
  snapshotAndResetDirtyWorktreeAsync,
  withWorktreeLock,
  withWorktreeLockAsync,
  worktreePorcelainZ,
  worktreePorcelainZAsync,
} from "../../../git/functions/worktree.js";
import { acquireWorktreeLock, acquireWorktreeLockAsync, gitStashLockPath } from "../../../git/functions/worktree-locks.js";
import {
  dropStashByHash,
  dropStashByHashAsync,
  findStallStashEntry,
  findStallStashEntryAsync,
  gitExec,
  gitExecAsync,
} from "../../../git/functions/utils.js";

export function detectDrift(worker, job, files, cwd) {
  if (!files || files.length === 0 || !job.created_at || !cwd) return "";
  try {
    const commitLog = gitExec(
      ["log", "--format=%H", `--since=${job.created_at}`, "--", ...files],
      cwd,
    );
    if (!commitLog) return "";
    const commits = commitLog.split("\n").filter(Boolean);
    const oldestHash = commits[commits.length - 1];
    let diff = "";
    try {
      diff = gitExec(
        ["diff", `${oldestHash}~1..HEAD`, "--", ...files],
        cwd,
      ).trim();
    } catch {
      diff = gitExec(
        ["diff", `${oldestHash}..HEAD`, "--", ...files],
        cwd,
      ).trim();
    }
    if (!diff) return "";
    const trimmed = diff.length > 3000 ? diff.slice(0, 3000) + "\n...(truncated)" : diff;
    worker.emit(job.id, `${C.yellow}[drift]${C.reset} WI#${job.work_item_id} job #${job.id}: ${commits.length} commit(s) modified scoped files since planning`);
    return [
      "IMPORTANT — FILES CHANGED SINCE THIS TASK WAS PLANNED:",
      "The following files were modified by other tasks after your instructions were written.",
      "Your task_spec may reference code that has moved or changed. Use the CURRENT file",
      "content (provided below) as the source of truth, not line numbers in the instructions.",
      "",
      "Changes since planning:",
      trimmed,
    ].join("\n");
  } catch {
    return "";
  }
}

// The positional `stash drop stash@{N}` is the one op that needs the repo
// stash lock: refs/stash is shared by all linked worktrees, and a push from
// any lane between the hash→position lookup and the drop would retarget the
// drop. Apply-by-hash is shift-immune, and the snapshot machinery takes this
// same lock internally, so only the drops are wrapped.
function dropStallStashLocked(worker, wtPath, hash) {
  const stashLock = acquireWorktreeLock(gitStashLockPath(wtPath, worker.projectDir, { disabled: true }));
  if (!stashLock.acquired) return false;
  try {
    return dropStashByHash(wtPath, hash);
  } catch {
    return false;
  } finally {
    stashLock.release();
  }
}

async function dropStallStashLockedAsync(worker, wtPath, hash, { signal = null } = {}) {
  const stashLock = await acquireWorktreeLockAsync(gitStashLockPath(wtPath, worker.projectDir, { disabled: true }), { signal });
  if (!stashLock.acquired) return false;
  try {
    return await dropStashByHashAsync(wtPath, hash, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    return false;
  } finally {
    await stashLock.releaseAsync();
  }
}

function stallLabel(job) {
  return `WI#${job.work_item_id} job #${job.id}`;
}

function stallConflictReason(job) {
  return `stall-stash-conflict-job-${job.id}`;
}

// Paths the failed apply changed that the pre-apply index can put back. A
// path whose worktree copy was already dirty is skipped: git does not merge
// into it, and the index does not hold its content.
function stallApplyUndoPaths(before, after) {
  const prior = porcelainStatusEntries(before);
  return porcelainDeltaPaths(before, after).filter((file) => {
    const status = prior.get(file);
    return !status || status[1] === " ";
  });
}

// Sibling jobs of the work item share this worktree when one holds live write
// locks or owns a dirty path (lock, placeholder, or declared scope). A
// whole-worktree reset would erase their work.
function stallWorktreeSharedWithSiblings(job, porcelain) {
  try {
    if (activeSiblingWriteLocks(job).length > 0) return true;
    const dirtyPaths = [...porcelainStatusEntries(porcelain).keys()];
    return dirtyPaths.length > 0 && siblingJobScopePaths(job.id, dirtyPaths).size > 0;
  } catch {
    return true;
  }
}

function readIndexTree(wtPath) {
  try {
    return String(gitExec(["write-tree"], wtPath) || "").trim() || null;
  } catch {
    return null;
  }
}

async function readIndexTreeAsync(wtPath, { signal = null } = {}) {
  try {
    return String(await gitExecAsync(["write-tree"], wtPath, { signal }) || "").trim() || null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

// A failed `git stash apply` can leave the worktree untouched (git aborts
// before writing when an untracked file would be overwritten) or land part of
// the stash (conflict markers, restored untracked files). Only a change in
// `git status` says which. WI 154 job 2028 (2026-10-01): a sibling's
// re-materialized placeholder blocked the apply, the sibling's own dirt was
// taken for a landed conflict, the shared worktree was reset, and the stash
// was dropped although nothing had preserved it.
function emitUnchangedApply(worker, job, entry) {
  worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} ${stallLabel(job)}: stash apply failed without changing the worktree — keeping stash ${entry.hash.slice(0, 12)} for the next attempt`);
}

function emitLeftover(worker, job, settled, before, shared) {
  const left = settled === null ? [] : porcelainDeltaPaths(before, settled);
  const detail = left.length > 0 ? `: ${left.slice(0, 10).join(", ")}` : "";
  worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} ${stallLabel(job)}: could not fully undo the conflicted stash apply (${left.length} path(s) left${detail}); ${shared ? "sibling jobs share this worktree, so it was not reset" : "worktree status unreadable, so it was not reset"}`);
}

// The failed apply landed content. Pin the stash commit, put back only the
// paths the apply changed, and drop the stash entry only once it is pinned.
function recoverLandedStallApply(worker, job, wtPath, entry, { before, after, preApplyTree }) {
  const branchName = getWorkItem(job.work_item_id)?.branch_name || null;
  const reason = stallConflictReason(job);
  const pinned = preserveStashCommitSnapshot(worker.projectDir || wtPath, entry.hash, {
    reason,
    wiId: job.work_item_id,
    branchName,
  });
  worker.emit(job.id, `${C.yellow}[stall-resume] ${stallLabel(job)}: stash conflicts — starting fresh${C.reset}${pinned ? ` (stash ${entry.hash.slice(0, 12)} preserved at ${pinned})` : ""}`);
  if (preApplyTree) restorePathsToTree(wtPath, stallApplyUndoPaths(before, after), preApplyTree);
  const settled = worktreePorcelainZ(wtPath);
  if (settled !== before) {
    const shared = stallWorktreeSharedWithSiblings(job, settled ?? after);
    if (shared || settled === null) {
      emitLeftover(worker, job, settled, before, shared);
    } else {
      try {
        snapshotAndResetDirtyWorktree(wtPath, worker.projectDir || wtPath, {
          reason,
          branchName,
          wiId: job.work_item_id,
          lock: false,
          onMsg: (message) => worker.emit(job.id, `${C.dim}[stall-resume] ${message}${C.reset}`),
        });
      } catch (err) {
        worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} ${stallLabel(job)}: worktree reset after the conflicted apply failed: ${err?.message || err}`);
      }
    }
  }
  if (!pinned) {
    worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} ${stallLabel(job)}: stash ${entry.hash.slice(0, 12)} could not be pinned; keeping the stash entry`);
    return;
  }
  dropStallStashLocked(worker, wtPath, entry.hash);
}

async function recoverLandedStallApplyAsync(worker, job, wtPath, entry, { before, after, preApplyTree, signal = null }) {
  const branchName = getWorkItem(job.work_item_id)?.branch_name || null;
  const reason = stallConflictReason(job);
  const pinned = await preserveStashCommitSnapshotAsync(worker.projectDir || wtPath, entry.hash, {
    reason,
    wiId: job.work_item_id,
    branchName,
    signal,
  });
  worker.emit(job.id, `${C.yellow}[stall-resume] ${stallLabel(job)}: stash conflicts — starting fresh${C.reset}${pinned ? ` (stash ${entry.hash.slice(0, 12)} preserved at ${pinned})` : ""}`);
  if (preApplyTree) await restorePathsToTreeAsync(wtPath, stallApplyUndoPaths(before, after), preApplyTree, { signal });
  const settled = await worktreePorcelainZAsync(wtPath, { signal });
  if (settled !== before) {
    const shared = stallWorktreeSharedWithSiblings(job, settled ?? after);
    if (shared || settled === null) {
      emitLeftover(worker, job, settled, before, shared);
    } else {
      try {
        await snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir || wtPath, {
          reason,
          branchName,
          wiId: job.work_item_id,
          lock: false,
          signal,
          onMsg: (message) => worker.emit(job.id, `${C.dim}[stall-resume] ${message}${C.reset}`),
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} ${stallLabel(job)}: worktree reset after the conflicted apply failed: ${err?.message || err}`);
      }
    }
  }
  if (!pinned) {
    worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} ${stallLabel(job)}: stash ${entry.hash.slice(0, 12)} could not be pinned; keeping the stash entry`);
    return;
  }
  await dropStallStashLockedAsync(worker, wtPath, entry.hash, { signal });
}

function applyStallStashUnlocked(worker, job, wtPath) {
  const entry = findStallStashEntry(job.id, wtPath);
  if (!entry) {
    clearStallResume(job.id);
    return null;
  }

  const before = worktreePorcelainZ(wtPath);
  const preApplyTree = readIndexTree(wtPath);
  let applied = false;
  try {
    gitExec(["stash", "apply", entry.hash], wtPath);
    applied = true;
  } catch { /* fall through to the worktree-change gate */ }

  if (applied) {
    if (!dropStallStashLocked(worker, wtPath, entry.hash)) {
      worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} WI#${job.work_item_id} job #${job.id}: applied stash could not be dropped; orphan entry ${entry.hash.slice(0, 12)} left on the stash stack`);
    }
  } else {
    // An unchanged worktree means nothing landed (untracked collision, stale
    // index.lock, transient exec failure): the stash is the only copy of the
    // interrupted attempt — keep it and the stall flag so the next attempt
    // retries.
    const after = worktreePorcelainZ(wtPath);
    if (before === null || after === null || after === before) {
      emitUnchangedApply(worker, job, entry);
      return null;
    }
    recoverLandedStallApply(worker, job, wtPath, entry, { before, after, preApplyTree });
    clearStallResume(job.id);
    return null;
  }

  clearStallResume(job.id);

  try {
    const diff = gitExec(["diff", "HEAD"], wtPath);
    const untracked = gitExec(["ls-files", "--others", "--exclude-standard"], wtPath);

    if (!diff && !untracked) return null;

    const filesChanged = [];
    if (diff) {
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git")) {
          const match = line.match(/b\/(.+)$/);
          if (match) filesChanged.push(match[1]);
        }
      }
    }
    if (untracked) {
      filesChanged.push(...untracked.split("\n").filter(Boolean));
    }

    const MAX_DIFF_CHARS = 8000;
    const truncatedDiff = diff && diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n... (diff truncated — ${diff.length} chars total)`
      : (diff || "");

    return [
      "=== CONTINUATION: RESUMED FROM PREVIOUS ATTEMPT ===",
      "This task was previously attempted but the process was interrupted.",
      "The partial work has been restored to the worktree.",
      "Do NOT redo work that is already done — review what exists and continue.",
      "",
      "FILES ALREADY MODIFIED/CREATED:",
      ...filesChanged.map((file) => `- ${file}`),
      "",
      truncatedDiff ? `PARTIAL DIFF:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` : "",
      "=== END CONTINUATION ===",
    ].filter(Boolean).join("\n");
  } catch {
    return [
      "=== CONTINUATION: RESUMED FROM PREVIOUS ATTEMPT ===",
      "This task was resumed from an interrupted attempt. Partial work exists in the worktree.",
      "Check what files have been modified and continue from there.",
      "=== END CONTINUATION ===",
    ].join("\n");
  }
}

async function applyStallStashUnlockedAsync(worker, job, wtPath, { signal = null } = {}) {
  const entry = await findStallStashEntryAsync(job.id, wtPath, { signal });
  if (!entry) {
    clearStallResume(job.id);
    return null;
  }

  const before = await worktreePorcelainZAsync(wtPath, { signal });
  const preApplyTree = await readIndexTreeAsync(wtPath, { signal });
  let applied = false;
  try {
    await gitExecAsync(["stash", "apply", entry.hash], wtPath, { signal });
    applied = true;
  } catch (err) {
    if (isAbortError(err)) throw err;
  }

  if (applied) {
    if (!(await dropStallStashLockedAsync(worker, wtPath, entry.hash, { signal }))) {
      worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} WI#${job.work_item_id} job #${job.id}: applied stash could not be dropped; orphan entry ${entry.hash.slice(0, 12)} left on the stash stack`);
    }
  } else {
    // An unchanged worktree means nothing landed: the stash is the only copy
    // — keep it and the stall flag so the next attempt retries.
    const after = await worktreePorcelainZAsync(wtPath, { signal });
    if (before === null || after === null || after === before) {
      emitUnchangedApply(worker, job, entry);
      return null;
    }
    await recoverLandedStallApplyAsync(worker, job, wtPath, entry, { before, after, preApplyTree, signal });
    clearStallResume(job.id);
    return null;
  }

  clearStallResume(job.id);

  try {
    const diff = await gitExecAsync(["diff", "HEAD"], wtPath, { signal });
    const untracked = await gitExecAsync(["ls-files", "--others", "--exclude-standard"], wtPath, { signal });

    if (!diff && !untracked) return null;

    const filesChanged = [];
    if (diff) {
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git")) {
          const match = line.match(/b\/(.+)$/);
          if (match) filesChanged.push(match[1]);
        }
      }
    }
    if (untracked) {
      filesChanged.push(...untracked.split("\n").filter(Boolean));
    }

    const MAX_DIFF_CHARS = 8000;
    const truncatedDiff = diff && diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n... (diff truncated — ${diff.length} chars total)`
      : (diff || "");

    return [
      "=== CONTINUATION: RESUMED FROM PREVIOUS ATTEMPT ===",
      "This task was previously attempted but the process was interrupted.",
      "The partial work has been restored to the worktree.",
      "Do NOT redo work that is already done — review what exists and continue.",
      "",
      "FILES ALREADY MODIFIED/CREATED:",
      ...filesChanged.map((file) => `- ${file}`),
      "",
      truncatedDiff ? `PARTIAL DIFF:\n\`\`\`diff\n${truncatedDiff}\n\`\`\`` : "",
      "=== END CONTINUATION ===",
    ].filter(Boolean).join("\n");
  } catch {
    return [
      "=== CONTINUATION: RESUMED FROM PREVIOUS ATTEMPT ===",
      "This task was resumed from an interrupted attempt. Partial work exists in the worktree.",
      "Check what files have been modified and continue from there.",
      "=== END CONTINUATION ===",
    ].join("\n");
  }
}

export function applyStallStash(worker, job, wtPath) {
  if (!wtPath) return null;
  return withWorktreeLock(wtPath, worker.projectDir, () => applyStallStashUnlocked(worker, job, wtPath));
}

export async function applyStallStashAsync(worker, job, wtPath, opts = {}) {
  if (!wtPath) return null;
  return await withWorktreeLockAsync(
    wtPath,
    worker.projectDir,
    () => applyStallStashUnlockedAsync(worker, job, wtPath, opts),
    opts,
  );
}
