import {
  completeAttempt,
  logEvent,
  setJobError,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { resolveTargetBranchAsync } from "../../../git/functions/target-branch.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const SOFT_NO_WRITE_ATTEMPTS = 2;
const NO_WRITE_RETRY_BACKOFF_MS = 30_000;
const BRANCH_NET_DIFF_MAX_CHARS = 60_000;
const BRANCH_NET_DIFF_MAX_FILES = 100;

function pendingFileRequestCount(pendingFileRequests = null) {
  if (!pendingFileRequests) return 0;
  return (pendingFileRequests.autoApproved?.length || 0)
    + (pendingFileRequests.needsApproval?.length || 0);
}

export function shouldSoftRetryNoWriteAttempt(job, attemptCount) {
  const attempt = Math.max(0, Number(attemptCount || job?.attempt_count || 0) || 0);
  const maxAttempts = Math.max(1, Number(job?.max_attempts || 3) || 3);
  return attempt > 0 && attempt <= SOFT_NO_WRITE_ATTEMPTS && attempt < maxAttempts;
}

export function shouldShortCircuitNoWriteAssessment({
  job,
  hasFileChanges,
  pendingFileRequests = null,
  satisfiedNoop = false,
  verifiedNoChange = false,
} = {}) {
  if (!(job?.job_type === "dev" || job?.job_type === "fix")) return false;
  if (hasFileChanges || satisfiedNoop || verifiedNoChange) return false;
  // DB-only jobs never produce file changes; their work lives in the project
  // database and the assessor verifies it via read-lane project_db_query, so
  // a zero-diff outcome must still be assessed rather than failed as a no-op.
  if (parseJobPayload(job)?.task_mode === "db") return false;
  return pendingFileRequestCount(pendingFileRequests) === 0;
}

function normalizeGitPath(value) {
  return String(value || "").replace(/\\/g, "/").trim();
}

function compactDiff(text, maxChars = BRANCH_NET_DIFF_MAX_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[branch net diff truncated]`;
}

export async function detectBranchNetDiffForNoWriteAsync({
  wtPath = null,
  projectDir = null,
  targetBranch = null,
  scopePaths = null,
  scopeRoots = null,
  maxFiles = BRANCH_NET_DIFF_MAX_FILES,
  maxDiffChars = BRANCH_NET_DIFF_MAX_CHARS,
} = {}) {
  const cwd = wtPath || projectDir;
  if (!cwd) return { ok: false, hasDiff: false, reason: "missing cwd" };

  const target = String(targetBranch || await resolveTargetBranchAsync(projectDir || cwd)).trim() || "main";
  let mergeBase = "";
  let head = "";
  try {
    [mergeBase, head] = await Promise.all([
      gitExecAsync(["merge-base", "HEAD", target], cwd, { timeoutMs: 15_000 }),
      gitExecAsync(["rev-parse", "HEAD"], cwd, { timeoutMs: 15_000 }),
    ]);
  } catch (err) {
    return {
      ok: false,
      hasDiff: false,
      targetBranch: target,
      reason: `failed to resolve merge base: ${err?.message || String(err)}`,
    };
  }

  const base = String(mergeBase || "").trim();
  const currentHead = String(head || "").trim();
  const pathspec = [
    ...(Array.isArray(scopePaths) ? scopePaths : []),
    ...(Array.isArray(scopeRoots) ? scopeRoots : []),
  ].map(normalizeGitPath).filter(Boolean);
  if (!base || !currentHead || base === currentHead) {
    return { ok: true, hasDiff: false, targetBranch: target, mergeBase: base || null, head: currentHead || null, files: [] };
  }

  let nameStatus = "";
  try {
    nameStatus = await gitExecAsync(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-renames",
        "--name-status",
        `${base}..HEAD`,
        ...(pathspec.length > 0 ? ["--", ...pathspec] : []),
      ],
      cwd,
      { timeoutMs: 15_000, maxBuffer: 1024 * 1024 * 2 },
    );
  } catch (err) {
    return {
      ok: false,
      hasDiff: false,
      targetBranch: target,
      mergeBase: base,
      head: currentHead,
      reason: `failed to list branch diff: ${err?.message || String(err)}`,
    };
  }

  const entries = String(nameStatus || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return {
        status: parts[0] || "?",
        file: normalizeGitPath(parts[parts.length - 1]),
      };
    })
    .filter((entry) => entry.file);
  if (entries.length === 0) {
    return { ok: true, hasDiff: false, targetBranch: target, mergeBase: base, head: currentHead, files: [] };
  }

  let diff = "";
  const scopedFiles = entries.map((entry) => entry.file).slice(0, Math.max(1, maxFiles));
  try {
    diff = await gitExecAsync(
      ["-c", "core.quotePath=false", "diff", "--no-renames", "--unified=6", `${base}..HEAD`, "--", ...scopedFiles],
      cwd,
      { timeoutMs: 20_000, maxBuffer: 1024 * 1024 * 4 },
    );
  } catch {
    diff = "";
  }

  return {
    ok: true,
    hasDiff: true,
    targetBranch: target,
    mergeBase: base,
    head: currentHead,
    files: entries.map((entry) => entry.file),
    entries,
    diff: compactDiff(diff, maxDiffChars),
  };
}

export function finishNoWriteAttempt(worker, {
  attempt,
  attemptCount,
  job,
  leaseToken,
  message,
  startTime,
} = {}) {
  const softRetry = shouldSoftRetryNoWriteAttempt(job, attemptCount);
  const maxAttempts = Math.max(1, Number(job?.max_attempts || 3) || 3);
  const attemptLabel = `${attemptCount}/${maxAttempts}`;

  completeAttempt(attempt.id, {
    status: softRetry ? "interrupted" : "failed",
    duration_ms: Date.now() - startTime,
    error_text: message,
  });
  setJobError(job.id, message);

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt.id,
    event_type: softRetry ? EVENT_TYPES.JOB_NOOP_RETRY : EVENT_TYPES.JOB_NOOP_FAILURE,
    actor_type: EVENT_ACTORS.WORKER,
    message: softRetry
      ? `No scoped file changes on attempt ${attemptLabel}; requeuing without assessment`
      : message,
  });

  if (!softRetry) {
    worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: Dev produced no file changes - treating as failed${C.reset}`);
    worker._retryOrFail(job, leaseToken, message);
    return true;
  }

  const readyAt = new Date(Date.now() + NO_WRITE_RETRY_BACKOFF_MS).toISOString();
  worker.emit(
    job.id,
    `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: no scoped file changes on attempt ${attemptLabel}; requeuing without assessment${C.reset}`,
  );
  worker._releaseLease(job, leaseToken, "queued", { readyAt });
  return true;
}

export const __testNoWriteRetryBackoffMs = NO_WRITE_RETRY_BACKOFF_MS;
