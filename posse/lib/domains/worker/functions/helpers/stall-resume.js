// lib/worker/helpers/stall-resume.js
//
// Drift detection and stall-resume stash recovery helpers extracted from
// worker.js to keep execute-path orchestration lean.

import { C } from "../../../../shared/format/functions/colors.js";
import { getWorkItem, clearStallResume } from "../../../queue/functions/index.js";
import { preserveDirtyWorktreeSnapshot, withWorktreeLock, withWorktreeLockAsync } from "../../../git/functions/worktree.js";
import { findStallStash, findStallStashAsync, gitExec, gitExecAsync } from "../../../git/functions/utils.js";

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

function applyStallStashUnlocked(worker, job, wtPath) {
  const stashRef = findStallStash(job.id, wtPath);
  if (!stashRef) {
    clearStallResume(job.id);
    return null;
  }

  try {
    gitExec(["stash", "pop", stashRef], wtPath);
  } catch {
    try {
      gitExec(["stash", "apply", stashRef], wtPath);
    } catch {
      worker.emit(job.id, `${C.yellow}[stall-resume] WI#${job.work_item_id} job #${job.id}: stash conflicts — starting fresh${C.reset}`);
      const branchName = getWorkItem(job.work_item_id)?.branch_name || null;
      const snapshotDir = preserveDirtyWorktreeSnapshot(wtPath, worker.projectDir, {
        reason: `stall-stash-conflict-job-${job.id}`,
        branchName,
        wiId: job.work_item_id,
      });
      if (snapshotDir) {
        worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} WI#${job.work_item_id} job #${job.id}: preserved conflicted snapshot at ${snapshotDir}`);
      }
      try {
        gitExec(["reset", "--hard", "HEAD"], wtPath);
        gitExec(["clean", "-fd"], wtPath);
      } catch { /* ignore */ }
      try { gitExec(["stash", "drop", stashRef], wtPath); } catch { /* ignore */ }
      clearStallResume(job.id);
      return null;
    }
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
  const stashRef = await findStallStashAsync(job.id, wtPath, { signal });
  if (!stashRef) {
    clearStallResume(job.id);
    return null;
  }

  try {
    await gitExecAsync(["stash", "pop", stashRef], wtPath, { signal });
  } catch {
    try {
      await gitExecAsync(["stash", "apply", stashRef], wtPath, { signal });
    } catch {
      worker.emit(job.id, `${C.yellow}[stall-resume] WI#${job.work_item_id} job #${job.id}: stash conflicts — starting fresh${C.reset}`);
      const branchName = getWorkItem(job.work_item_id)?.branch_name || null;
      const snapshotDir = preserveDirtyWorktreeSnapshot(wtPath, worker.projectDir, {
        reason: `stall-stash-conflict-job-${job.id}`,
        branchName,
        wiId: job.work_item_id,
      });
      if (snapshotDir) {
        worker.emit(job.id, `${C.yellow}[stall-resume]${C.reset} WI#${job.work_item_id} job #${job.id}: preserved conflicted snapshot at ${snapshotDir}`);
      }
      try {
        await gitExecAsync(["reset", "--hard", "HEAD"], wtPath, { signal });
        await gitExecAsync(["clean", "-fd"], wtPath, { signal });
      } catch { /* ignore */ }
      try { await gitExecAsync(["stash", "drop", stashRef], wtPath, { signal }); } catch { /* ignore */ }
      clearStallResume(job.id);
      return null;
    }
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
