// Dead-letter partial-work handling.
//
// Final-attempt failures are allowed to leave useful work behind. These helpers
// classify that work against the job's declared scope, preserve it for a
// human-approved turn extension, or commit in-scope partial output for assessor
// review.

import path from "path";
import {
  applyDelegation,
  createJob,
  extendJobMaxAttempts,
  flagStallResume,
  getWorkItem,
  listActiveFileLocks,
  logEvent,
  setAttemptCommitHash,
  setJobError,
  setJobResult,
  storeArtifact,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { gitCommitAll, gitCommitAllAsync } from "../../../git/functions/commit-scope.js";
import { gitCurrentHash, gitCurrentHashAsync, gitExec, gitExecAsync, gitHasChangesAsync } from "../../../git/functions/utils.js";
import {
  snapshotAndResetDirtyWorktree,
  snapshotAndResetDirtyWorktreeAsync,
  withWorktreeLock,
  withWorktreeLockAsync,
} from "../../../git/functions/worktree.js";
import {
  acquireWorktreeLock,
  acquireWorktreeLockAsync,
  gitStashLockPath,
  gitStashLockPathAsync,
} from "../../../git/functions/worktree-locks.js";
import { MutationPolicy, scopedDeleteTargets } from "../../../../shared/scope/classes/MutationPolicy.js";
import { findActiveSiblingLockForPath } from "./shared-worktree-locks.js";
import { isTurnBudgetExhaustedDetails } from "./diagnostics.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

const PARTIAL_WORK_EXTENSION_CAP = 1;

function norm(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parsePorcelainLine(line) {
  const source = String(line || "");
  if (!source.trim()) return null;
  let status = source.slice(0, 2);
  let file = "";
  if (source.length >= 4 && source[2] === " ") {
    file = source.slice(3).trim();
  } else {
    const match = source.match(/^([MADRCU?!]{1,2})\s+(.+)$/);
    if (match) {
      status = match[1].length === 1 ? ` ${match[1]}` : match[1];
      file = match[2].trim();
    } else {
      file = source.trim().replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
    }
  }
  if (file.includes(" -> ")) file = file.split(" -> ").pop().trim();
  file = file.replace(/^"|"$/g, "").replace(/\\/g, "/");
  if (!file) return null;
  return {
    file,
    staged: status[0] && status[0] !== " " && status[0] !== "?",
    untracked: status === "??",
    deleted: status[0] === "D" || status[1] === "D",
    status,
  };
}

function parseStatusPorcelain(raw) {
  return String(raw || "")
    .split("\n")
    .map(parsePorcelainLine)
    .filter(Boolean);
}

function buildScope(job, payload, wtPath) {
  return {
    modifyFiles: payload.files_to_modify || [],
    createFiles: payload.files_to_create || [],
    deleteFiles: scopedDeleteTargets(job, payload),
    createRoots: payload.create_roots || [],
    cwd: wtPath,
  };
}

function pathIsInScope(policy, entry) {
  const file = entry?.file || "";
  if (!file) return false;
  if (entry.untracked) return policy.canCreate(file);
  if (entry.deleted) return policy.canEdit(file) || policy.canDelete(file);
  return policy.canEdit(file) || policy.canCreate(file);
}

export function collectPartialWorkState(job, wtPath) {
  if (!job?.id || !wtPath) return { hasChanges: false, paths: [], inScopePaths: [], outOfScopePaths: [], siblingPaths: [] };
  let raw = "";
  try {
    raw = gitExec(["-c", "core.quotePath=false", "status", "--porcelain"], wtPath);
  } catch {
    return { hasChanges: false, paths: [], inScopePaths: [], outOfScopePaths: [], siblingPaths: [] };
  }
  return classifyPartialWorkEntries(job, wtPath, raw);
}

function classifyPartialWorkEntries(job, wtPath, raw) {
  const entries = parseStatusPorcelain(raw);
  if (entries.length === 0) return { hasChanges: false, paths: [], inScopePaths: [], outOfScopePaths: [], siblingPaths: [] };

  const payload = parseJobPayload(job);
  const policy = MutationPolicy.fromScopeSpec(buildScope(job, payload, wtPath), { cwd: wtPath });
  const locks = listActiveFileLocks();
  const paths = [];
  const inScopePaths = [];
  const outOfScopePaths = [];
  const siblingPaths = [];
  const seen = new Set();

  for (const entry of entries) {
    const normalized = norm(entry.file);
    if (!normalized || seen.has(normalized)) continue;
    if (normalized === ".posse" || normalized.startsWith(".posse/")) continue;
    seen.add(normalized);
    paths.push(entry.file);
    const siblingLock = findActiveSiblingLockForPath(entry.file, job, { locks });
    if (siblingLock) {
      siblingPaths.push({
        file: entry.file,
        job_id: siblingLock.job_id ?? null,
        path: siblingLock.path || null,
        lock_kind: siblingLock.lock_kind || null,
      });
      continue;
    }
    if (pathIsInScope(policy, entry)) inScopePaths.push(entry.file);
    else outOfScopePaths.push(entry.file);
  }

  return {
    hasChanges: paths.length > 0,
    paths,
    inScopePaths,
    outOfScopePaths,
    siblingPaths,
    payload,
  };
}

export async function collectPartialWorkStateAsync(job, wtPath, { signal = null } = {}) {
  if (!job?.id || !wtPath) return { hasChanges: false, paths: [], inScopePaths: [], outOfScopePaths: [], siblingPaths: [] };
  let raw = "";
  try {
    raw = await gitExecAsync(["-c", "core.quotePath=false", "status", "--porcelain"], wtPath, {
      signal,
      nativeParity: { disabled: true },
    });
  } catch {
    return { hasChanges: false, paths: [], inScopePaths: [], outOfScopePaths: [], siblingPaths: [] };
  }
  return classifyPartialWorkEntries(job, wtPath, raw);
}

function nextTurnOverrideFromDetails(errorDetails = null, fallback = 36) {
  const observedMax = Number(errorDetails?.stats?.maxTurns);
  const observedTurns = Number(errorDetails?.stats?.numTurns);
  const baseline = Number.isFinite(observedMax) && observedMax > 0
    ? observedMax
    : (Number.isFinite(observedTurns) && observedTurns > 0 ? observedTurns : fallback);
  return Math.max(baseline + 8, Math.ceil(baseline * 1.5));
}

export function applyPartialWorkTurnExtension(job, {
  errorDetails = null,
  humanAnswer = "",
  maxTurnsOverride = null,
  recoveryJobId = null,
} = {}) {
  const payload = parseJobPayload(job);
  const prevCount = Number.parseInt(String(payload._partial_work_turn_extension_count || 0), 10) || 0;
  const nextCount = prevCount + 1;
  const previousOverride = Number.parseInt(String(payload._max_turns_override || payload.max_turns_override || 0), 10) || 0;
  const requestedOverride = Number.parseInt(String(maxTurnsOverride ?? ""), 10);
  const nextOverride = Math.max(
    previousOverride,
    Number.isFinite(requestedOverride) && requestedOverride > 0 ? requestedOverride : 0,
    nextTurnOverrideFromDetails(errorDetails),
  );

  payload._stall_resume = true;
  payload._partial_work_turn_extension_count = nextCount;
  payload._max_turns_override = nextOverride;
  payload.deepthink = true;
  payload.deepthink_budget = "xhigh";
  payload.research_budget = "xhigh";
  payload._partial_work_recovery = {
    original_job_id: job.id,
    recovery_job_id: recoveryJobId || null,
    action: "extend_turns",
    max_turns_override: nextOverride,
    human_answer: String(humanAnswer || ""),
    updated_at: new Date().toISOString(),
  };

  updateJobPayload(job.id, JSON.stringify(payload));
  extendJobMaxAttempts(job.id, Math.max(Number(job.max_attempts || 0), Number(job.attempt_count || 0) + 1));
  if (job.model_tier !== "strong") {
    applyDelegation(job.id, { model_tier: "strong" });
  }

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_PARTIAL_WORK_RESUME_REQUESTED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Partial work turn extension requested; maxTurns=${nextOverride}`,
    event_json: JSON.stringify({
      recovery_job_id: recoveryJobId || null,
      extension_count: nextCount,
      max_turns_override: nextOverride,
      answer: String(humanAnswer || ""),
    }),
  });

  return { maxTurns: nextOverride, extensionCount: nextCount };
}

export function shouldOfferPartialTurnExtension(job, errorDetails, state = null) {
  if (!job || !isTurnBudgetExhaustedDetails(errorDetails)) return false;
  const payload = state?.payload || parseJobPayload(job);
  const extensionCount = Number.parseInt(String(payload._partial_work_turn_extension_count || 0), 10) || 0;
  if (extensionCount >= PARTIAL_WORK_EXTENSION_CAP) return false;
  if (!Array.isArray(state?.inScopePaths) || state.inScopePaths.length === 0) return false;
  if (Array.isArray(state?.outOfScopePaths) && state.outOfScopePaths.length > 0) return false;
  if (Array.isArray(state?.siblingPaths) && state.siblingPaths.length > 0) return false;
  return true;
}

export function stashPartialWorkForExtension(job, wtPath, { projectDir = null } = {}) {
  if (!job?.id || !wtPath) return false;
  if (!projectDir) throw new Error("projectDir is required to stash partial work safely");
  return withWorktreeLock(wtPath, projectDir, () => {
    const state = collectPartialWorkState(job, wtPath);
    if (!state.hasChanges || state.inScopePaths.length === 0) return false;
    const stashLockPath = gitStashLockPath(wtPath, projectDir);
    const stashLock = acquireWorktreeLock(stashLockPath);
    if (!stashLock.acquired) {
      throw new Error(`Timed out waiting for git stash lock: ${stashLockPath}`);
    }
    try {
      gitExec([
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `posse: partial work turn extension job #${job.id}`,
        "--",
        ...state.inScopePaths,
      ], wtPath);
      flagStallResume(job.id);
      return true;
    } finally {
      stashLock.release();
    }
  });
}

export async function stashPartialWorkForExtensionAsync(job, wtPath, {
  projectDir = null,
  signal = null,
} = {}) {
  if (!job?.id || !wtPath) return false;
  if (!projectDir) throw new Error("projectDir is required to stash partial work safely");
  return await withWorktreeLockAsync(wtPath, projectDir, async () => {
    const state = await collectPartialWorkStateAsync(job, wtPath, { signal });
    if (!state.hasChanges || state.inScopePaths.length === 0) return false;
    const stashLockPath = await gitStashLockPathAsync(wtPath, projectDir, { signal });
    const stashLock = await acquireWorktreeLockAsync(stashLockPath, { signal });
    if (!stashLock.acquired) {
      throw new Error(`Timed out waiting for git stash lock: ${stashLockPath}`);
    }
    try {
      await gitExecAsync([
        "stash",
        "push",
        "--include-untracked",
        "-m",
        `posse: partial work turn extension job #${job.id}`,
        "--",
        ...state.inScopePaths,
      ], wtPath, { signal });
      flagStallResume(job.id);
      return true;
    } finally {
      await stashLock.releaseAsync();
    }
  }, { signal });
}

export function spawnPartialWorkReviewJob(worker, job, {
  errorDetails = null,
  reason = "",
  state = null,
  wtPath = null,
} = {}) {
  const partialState = state || collectPartialWorkState(job, wtPath);
  const maxTurns = nextTurnOverrideFromDetails(errorDetails);
  const recoveryJob = createJob({
    work_item_id: job.work_item_id,
    job_type: "human_input",
    title: `Partial work: ${String(job.title || "").slice(0, 80)}`,
    parent_job_id: job.id,
    priority: "urgent",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      original_job_id: job.id,
      review_type: "partial_work_recovery",
      suggested_max_turns: maxTurns,
      questions: [
        [
          `Job #${job.id} "${job.title}" hit its final turn budget but left in-scope work in the worktree.`,
          "",
          "Choose one:",
          `- extend: resume the partial work with a larger turn budget (${maxTurns} turns suggested)`,
          "- commit: commit the in-scope partial output now and send it to the assessor; the assessor may spawn a fix job",
          "- revert: discard the partial output and dead-letter the job",
        ].join("\n"),
      ],
      context: [
        `Failure: ${reason || errorDetails?.summary || "turn budget exhausted"}`,
        "",
        `In-scope dirty paths (${partialState.inScopePaths.length}):`,
        ...partialState.inScopePaths.slice(0, 30).map((file) => `- ${file}`),
        partialState.outOfScopePaths.length > 0 ? "" : null,
        partialState.outOfScopePaths.length > 0 ? `Out-of-scope dirty paths (${partialState.outOfScopePaths.length}) will be reverted/snapshotted before commit:` : null,
        ...partialState.outOfScopePaths.slice(0, 30).map((file) => `- ${file}`),
      ].filter(Boolean).join("\n"),
    }),
  });

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_PARTIAL_WORK_PROMPTED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Partial work recovery prompt #${recoveryJob.id} created`,
    event_json: JSON.stringify({
      recovery_job_id: recoveryJob.id,
      suggested_max_turns: maxTurns,
      in_scope_paths: partialState.inScopePaths,
      out_of_scope_paths: partialState.outOfScopePaths,
      sibling_paths: partialState.siblingPaths,
    }),
  });

  worker?.emit?.(job.id, `${C.yellow}[partial]${C.reset} WI#${job.work_item_id} job #${job.id}: parked for partial-work decision via human_input #${recoveryJob.id}`);
  return recoveryJob;
}

export function commitScopedPartialWork(worker, job, attempt, wtPath, {
  reason = "partial work",
  output = "",
} = {}) {
  const state = collectPartialWorkState(job, wtPath);
  if (!state.hasChanges || state.inScopePaths.length === 0) {
    return { committed: false, state };
  }

  const payload = state.payload || parseJobPayload(job);
  const headBefore = gitCurrentHash(wtPath);
  const result = gitCommitAll(`posse: partial ${job.job_type} job #${job.id} - ${job.title}`, wtPath, {
    modifyFiles: payload.files_to_modify || [],
    createFiles: payload.files_to_create || [],
    deleteFiles: scopedDeleteTargets(job, payload),
    createRoots: payload.create_roots || [],
  }, {
    projectDir: worker.projectDir,
    wiId: job.work_item_id,
    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
    snapshotReason: `partial-work-job-${job.id}`,
    taskMode: payload.task_mode || "code",
    jobId: job.id,
  });
  const commitHash = result.hash;
  if (!commitHash || commitHash === headBefore) {
    return { committed: false, state, result };
  }

  let filesCommitted = [];
  try {
    filesCommitted = gitExec(["diff", "--name-only", "--relative", headBefore, commitHash], wtPath)
      .split("\n")
      .map((line) => String(line || "").replace(/\\/g, "/").trim())
      .filter(Boolean);
  } catch {
    filesCommitted = state.inScopePaths;
  }

  if (attempt?.id) setAttemptCommitHash(attempt.id, commitHash);
  setJobResult(job.id, {
    partial_work: true,
    output_length: String(output || "").length,
    commit_hash: commitHash,
    files_committed: filesCommitted,
    reason,
  });
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt?.id || null,
    artifact_type: "log",
    content_long: [
      `Partial work committed for assessment.`,
      `Reason: ${reason}`,
      `Commit: ${commitHash}`,
      "",
      "Files committed:",
      ...filesCommitted.map((file) => `- ${file}`),
    ].join("\n"),
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt?.id || null,
    event_type: EVENT_TYPES.JOB_PARTIAL_WORK_COMMITTED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Committed partial work ${commitHash.slice(0, 8)} for assessment`,
    event_json: JSON.stringify({
      commit_hash: commitHash,
      files_committed: filesCommitted,
      reason,
      in_scope_paths: state.inScopePaths,
      out_of_scope_paths: state.outOfScopePaths,
      sibling_paths: state.siblingPaths,
    }),
  });
  worker?.emit?.(job.id, `${C.yellow}[partial]${C.reset} WI#${job.work_item_id} job #${job.id}: committed partial work ${commitHash.slice(0, 8)} for assessment`);

  return {
    committed: true,
    committedHash: commitHash,
    filesCommitted,
    filesReverted: result.reverted || [],
    state,
    result,
  };
}

export async function commitScopedPartialWorkAsync(worker, job, attempt, wtPath, {
  reason = "partial work",
  output = "",
} = {}) {
  const state = await collectPartialWorkStateAsync(job, wtPath);
  if (!state.hasChanges || state.inScopePaths.length === 0) {
    return { committed: false, state };
  }

  const payload = state.payload || parseJobPayload(job);
  const headBefore = await gitCurrentHashAsync(wtPath);
  const result = await gitCommitAllAsync(`posse: partial ${job.job_type} job #${job.id} - ${job.title}`, wtPath, {
    modifyFiles: payload.files_to_modify || [],
    createFiles: payload.files_to_create || [],
    deleteFiles: scopedDeleteTargets(job, payload),
    createRoots: payload.create_roots || [],
  }, {
    projectDir: worker.projectDir,
    wiId: job.work_item_id,
    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
    snapshotReason: `partial-work-job-${job.id}`,
    taskMode: payload.task_mode || "code",
    jobId: job.id,
  });
  const commitHash = result.hash;
  if (!commitHash || commitHash === headBefore) {
    return { committed: false, state, result };
  }

  let filesCommitted = [];
  try {
    filesCommitted = (await gitExecAsync(["diff", "--name-only", "--relative", headBefore, commitHash], wtPath))
      .split("\n")
      .map((line) => String(line || "").replace(/\\/g, "/").trim())
      .filter(Boolean);
  } catch {
    filesCommitted = state.inScopePaths;
  }

  if (attempt?.id) setAttemptCommitHash(attempt.id, commitHash);
  setJobResult(job.id, {
    partial_work: true,
    output_length: String(output || "").length,
    commit_hash: commitHash,
    files_committed: filesCommitted,
    reason,
  });
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt?.id || null,
    artifact_type: "log",
    content_long: [
      `Partial work committed for assessment.`,
      `Reason: ${reason}`,
      `Commit: ${commitHash}`,
      "",
      "Files committed:",
      ...filesCommitted.map((file) => `- ${file}`),
    ].join("\n"),
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt?.id || null,
    event_type: EVENT_TYPES.JOB_PARTIAL_WORK_COMMITTED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Committed partial work ${commitHash.slice(0, 8)} for assessment`,
    event_json: JSON.stringify({
      commit_hash: commitHash,
      files_committed: filesCommitted,
      reason,
      in_scope_paths: state.inScopePaths,
      out_of_scope_paths: state.outOfScopePaths,
      sibling_paths: state.siblingPaths,
    }),
  });
  worker?.emit?.(job.id, `${C.yellow}[partial]${C.reset} WI#${job.work_item_id} job #${job.id}: committed partial work ${commitHash.slice(0, 8)} for assessment`);

  return {
    committed: true,
    committedHash: commitHash,
    filesCommitted,
    filesReverted: result.reverted || [],
    state,
    result,
  };
}

export async function revertPartialWork(worker, job, wtPath, {
  attemptId = null,
  reason = "partial-work-revert",
} = {}) {
  if (!wtPath || !(await gitHasChangesAsync(wtPath))) return { reverted: false };
  const snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, worker?.projectDir || wtPath, {
    reason,
    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
    wiId: job.work_item_id,
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    event_type: EVENT_TYPES.JOB_PARTIAL_WORK_REVERTED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Reverted partial work after snapshot${snapshotDir ? ` ${path.relative(worker?.projectDir || wtPath, snapshotDir).replace(/\\/g, "/")}` : ""}`,
    event_json: JSON.stringify({
      snapshot_dir: snapshotDir || null,
      reason,
    }),
  });
  return { reverted: true, snapshotDir };
}

export function recordPartialWorkDetected(job, attemptId, state, reason) {
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId || null,
    event_type: EVENT_TYPES.JOB_PARTIAL_WORK_DETECTED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Detected partial work before final failure handling: ${state.inScopePaths.length} in-scope, ${state.outOfScopePaths.length} out-of-scope`,
    event_json: JSON.stringify({
      reason,
      paths: state.paths,
      in_scope_paths: state.inScopePaths,
      out_of_scope_paths: state.outOfScopePaths,
      sibling_paths: state.siblingPaths,
    }),
  });
}

export function setPartialWorkError(job, message) {
  setJobError(job.id, message);
}
