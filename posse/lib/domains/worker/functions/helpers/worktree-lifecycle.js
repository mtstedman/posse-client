// lib/domains/worker/functions/helpers/worktree-lifecycle.js
//
// Worktree lifecycle helpers extracted from worker.js: setup/recovery,
// creatable-file priming, and terminal cleanup.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { slugify } from "../../../../shared/format/functions/slug.js";
import { cleanupArtifactDirs, cleanupArtifactDirsAsync, isArtifactMode, contextDir, wiScopeId } from "../../../artifacts/functions/index.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../queue/functions/common.js";
import {
  completeAttempt,
  getWorkItem,
  incrementAndCreateAttempt,
  logEvent,
  setJobError,
  setWorkItemBranch,
  storeArtifact,
  updateJobPayload,
} from "../../../queue/functions/index.js";

const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const SETUP_DEFER_NOTICE_INTERVAL_MS = 30_000;
const SETUP_DEFER_RETRY_DELAY_MS = 30_000;
const SETUP_TRANSIENT_INFRA_RETRY_DELAY_MS = 5_000;
const MAX_SETUP_TRANSIENT_INFRA_RETRIES = 3;
// Debounce cache for setup-deferral notices, keyed wi:job:phase → last-emit
// ms. Bounded: once it exceeds 1000 entries, shouldEmitSetupDeferNotice
// evicts entries idle for 4× the notice interval. Stale entries are harmless
// (a finished job's key is simply never consulted again).
const setupDeferNoticeLastSeen = new Map();
import { MUTATING_JOB_TYPES, WORKTREE_JOB_TYPES } from "../../../../catalog/job.js";
import { jobNeedsGitWorktree } from "../../../git/functions/policy.js";
import {
  disposeWorkItemAtlasGraph,
  ensureWorkItemAtlasJoinAsync,
  getAtlasIntegrationConfig,
} from "../../../integrations/functions/atlas.js";
import {
  emitDevLeased as emitAtlasV2DevLeased,
  emitWiCleanup as emitAtlasV2WiCleanup,
  isAtlasV2EmissionEnabled,
} from "../../../atlas/classes/v2/PipelineHooks.js";
import {
  classifyDirtyWorktreeAsync,
  configureWorktreeScopeAsync,
  gitWorktreeAddAsync,
  isMergeInProgressAsync,
  mergeTargetIntoWorktreeAsync,
  resolveTargetBranchAsync,
  safeSnapshotAndRemoveWorktreeAsync,
  snapshotAndResetDirtyWorktreeAsync,
  withWorktreeLockAsync,
  worktreePathAsync,
} from "../../../git/functions/worktree.js";
import {
  gitCurrentHashAsync,
  gitExecAsync,
} from "../../../git/functions/utils.js";
import { isAbortError, yieldNow } from "../../../runtime/functions/yield.js";
import {
  branchStalenessCheck,
  formatBranchStalenessCheck,
} from "../../../system/functions/preflight-probes.js";
import {
  finalizePrepTrace,
  startPrepTrace,
  withPhase,
} from "./prep-telemetry.js";
import { isTransientCommitInfraFailure } from "./commit-infra.js";
import { isIterativeWorkItemActive } from "../../../planning/functions/state.js";
import {
  activeLiveSiblingWriteLocks,
  siblingLockSummary,
} from "../../../queue/functions/sibling-locks.js";
import { withBranchLockAsync } from "../../../git/functions/worktree-locks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import {
  clearActiveWorktreeSentinel,
  isSentinelProcessAlive,
  readActiveWorktreeSentinel,
  sentinelJobStillActive,
  writeActiveWorktreeSentinel,
} from "./worktree-sentinel.js";
import {
  classifyIgnorableSetupDirty,
  inspectIgnorableSetupDirty,
  isRuntimeResidualPath,
  normalizeRepoPath,
  parsePorcelainEntries,
  payloadExplicitlyClaimsPath,
  snapshotAndResetSetupBlockingPathsAsync,
  targetedSetupDirtyRecoveryEligible,
} from "./worktree-dirty-classification.js";

// Re-exported for external importers (Worker.js, tests) that previously
// imported these sentinel helpers from this module before the extraction into
// worktree-sentinel.js.
export {
  clearActiveWorktreeSentinel,
  readActiveWorktreeSentinel,
  writeActiveWorktreeSentinel,
} from "./worktree-sentinel.js";

function logTerminalCleanupFailure(worker, wi, wtDir, message, extra = {}) {
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
    actor_type: EVENT_ACTORS.WORKER,
    message,
    event_json: JSON.stringify({
      worktree_path: wtDir,
      branch: wi.branch_name || null,
      ...extra,
    }),
  });
  if (!worker.display && !worker.silent) {
    console.log(`${C.yellow}[system] WI#${wi.id} ${message}${C.reset}`);
  }
}

function transientSetupRetryCount(worker, job) {
  try {
    const payload = worker.parsePayload(job) || {};
    const value = Number(payload?._transient_infra_retries?.worktree_setup || 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function bumpTransientSetupRetry(worker, job) {
  const payload = worker.parsePayload(job) || {};
  const current = Number(payload?._transient_infra_retries?.worktree_setup || 0);
  const next = (Number.isFinite(current) && current > 0 ? Math.floor(current) : 0) + 1;
  payload._transient_infra_retries = {
    ...(payload._transient_infra_retries || {}),
    worktree_setup: next,
  };
  updateJobPayload(job.id, JSON.stringify(payload));
  return next;
}

function pendingCrossWiFileSyncs(payload = {}) {
  return (Array.isArray(payload?._cross_wi_file_syncs) ? payload._cross_wi_file_syncs : [])
    .map((entry) => ({
      ...entry,
      path: normalizeRepoPath(entry?.path),
      source_branch: String(entry?.source_branch || "").trim(),
      source_work_item_id: Number(entry?.source_work_item_id),
    }))
    .filter((entry) => entry.path && entry.source_branch && Number.isFinite(entry.source_work_item_id));
}

function logToleratedUntrackedResidual(worker, job, wi, residuals, phase) {
  const paths = residuals.paths || [];
  const runtimePaths = paths.filter(isRuntimeResidualPath);
  const visiblePaths = paths.filter((entry) => !isRuntimeResidualPath(entry));
  const visibleEntries = (residuals.entries || []).filter((entry) => !isRuntimeResidualPath(entry.path));
  const runtimeOnly = paths.length > 0 && visiblePaths.length === 0;
  const preview = visiblePaths.slice(0, 10).join(", ");
  const more = visiblePaths.length > 10 ? " ..." : "";
  if (!runtimeOnly) {
    worker.emit(job.id, `${C.dim}[system] WI#${wi.id} leaving ${visiblePaths.length} out-of-scope untracked residual(s) for terminal cleanup${preview ? `: ${preview}${more}` : ""}${C.reset}`);
  }
  logEvent({
    work_item_id: wi.id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORKTREE_UNTRACKED_RESIDUAL_TOLERATED,
    actor_type: EVENT_ACTORS.WORKER,
    message: runtimeOnly
      ? `Ignored ${runtimePaths.length} runtime residual(s) during setup`
      : `Leaving ${visiblePaths.length} out-of-scope untracked residual(s) for terminal cleanup`,
    event_json: JSON.stringify({
      phase,
      paths: visiblePaths.slice(0, 100),
      entries: visibleEntries.slice(0, 100),
      runtime_paths: runtimePaths.slice(0, 100),
      runtime_only: runtimeOnly,
    }),
  });
}

function logSiblingSetupDirtyReuse(worker, job, wi, dirty, phase) {
  const entries = dirty.siblingEntries || [];
  if (entries.length === 0) return;
  const preview = entries.slice(0, 5).map((entry) => `${entry.path} by #${entry.job_id || "?"}`).join(", ");
  const more = entries.length > 5 ? " ..." : "";
  const message = `Reused worktree with ${entries.length} sibling-owned dirty path(s): ${preview}${more}`;
  worker.emit(job.id, `${C.dim}[system] WI#${wi.id} ${message}${C.reset}`);
  logEvent({
    work_item_id: wi.id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_SCOPE_SIBLING_DIRTY_SKIPPED,
    actor_type: EVENT_ACTORS.WORKER,
    message,
    event_json: JSON.stringify({
      phase,
      visible: false,
      entries: entries.slice(0, 20),
    }),
  });
}

function setupCleanupPrecedenceJobId(job, siblingLocks = []) {
  const ids = [
    Number(job?.id),
    ...siblingLocks.map((lock) => Number(lock?.job_id)),
  ].filter((id) => Number.isFinite(id));
  return ids.length > 0 ? Math.min(...ids) : null;
}

function jobHasSetupCleanupPrecedence(job, siblingLocks = []) {
  const jobId = Number(job?.id);
  const winnerId = setupCleanupPrecedenceJobId(job, siblingLocks);
  return Number.isFinite(jobId) && winnerId != null && jobId === winnerId;
}

function markCrossWiSyncsApplied(job, payload, appliedPaths) {
  const applied = new Set([...appliedPaths].map((value) => normalizeRepoPath(value)));
  const remaining = (Array.isArray(payload._cross_wi_file_syncs) ? payload._cross_wi_file_syncs : [])
    .filter((entry) => !applied.has(normalizeRepoPath(entry?.path)));
  if (remaining.length > 0) payload._cross_wi_file_syncs = remaining;
  else delete payload._cross_wi_file_syncs;
  const payloadJson = JSON.stringify(payload);
  updateJobPayload(job.id, payloadJson);
  job.payload_json = payloadJson;
}

async function assertCrossWiSyncSourceBranchAsync(sourceBranch, projectDir, { signal = null } = {}) {
  try {
    await gitExecAsync(["rev-parse", "--verify", `${sourceBranch}^{commit}`], projectDir, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error(`Cross-WI sync source branch missing: ${sourceBranch}`);
  }
}

async function gitObjectHashAsync(cwd, ref, repoPath, { signal = null } = {}) {
  try {
    const out = await gitExecAsync(["rev-parse", `${ref}:./${repoPath}`], cwd, { signal });
    return String(out || "").trim() || null;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return null;
  }
}

async function gitLsFilesIncludesPathAsync(cwd, repoPath, { signal = null } = {}) {
  const out = await gitExecAsync(["ls-files", "-z", "--", repoPath], cwd, { signal });
  return String(out || "").split("\0").filter(Boolean).includes(repoPath);
}

// A handoff copy is only safe while the target branch still holds the path at
// its merge-base content. If the target committed its own changes to the path
// after the handoff was prepared, checking out the source version would
// silently discard those commits — the caller must skip the copy and let the
// recorded cross-WI merge dependency resolve the overlap at merge time.
async function crossWiSyncTargetGuardAsync(wtPath, sync, { signal = null } = {}) {
  const headObject = await gitObjectHashAsync(wtPath, "HEAD", sync.path, { signal });
  const sourceObject = await gitObjectHashAsync(wtPath, sync.source_branch, sync.path, { signal });
  if (headObject == null && sourceObject == null) {
    if (await gitLsFilesIncludesPathAsync(wtPath, sync.path, { signal })) {
      throw new Error(`Cross-WI sync could not resolve tracked path in HEAD or ${sync.source_branch}: ${sync.path}`);
    }
    return {
      clobbers: false,
      head_object: null,
      source_object: null,
      base_object: null,
      merge_base: null,
      absent_in_both_refs: true,
    };
  }
  if (headObject === sourceObject) {
    return { clobbers: false, head_object: headObject, source_object: sourceObject, base_object: null, merge_base: null };
  }
  let mergeBase = null;
  try {
    mergeBase = String(await gitExecAsync(["merge-base", "HEAD", sync.source_branch], wtPath, { signal }) || "").trim() || null;
  } catch (err) {
    if (isAbortError(err)) throw err;
  }
  const baseObject = mergeBase ? await gitObjectHashAsync(wtPath, mergeBase, sync.path, { signal }) : null;
  return {
    clobbers: headObject !== baseObject,
    head_object: headObject,
    source_object: sourceObject,
    base_object: baseObject,
    merge_base: mergeBase,
  };
}

function recordWorktreeSetupFailureAttempt(job, leaseToken, message) {
  const created = incrementAndCreateAttempt(job.id, leaseToken, "system", "worktree-setup", null);
  if (!created?.attempt?.id) return null;
  completeAttempt(created.attempt.id, {
    status: "failed",
    error_text: message,
    notes: "Git worktree setup failed before provider execution.",
  });
  return created;
}

function worktreeLockTimeoutInfo(error) {
  const text = [error?.message, error?.stderr].filter(Boolean).join("\n");
  if (!/Timed out waiting for worktree lock/i.test(text)) return { timeout: false };
  const match = text.match(/Timed out waiting for worktree lock:\s*([^\r\n]+)/i)
    || text.match(/([^\s"'`]*worktree-locks[\\/][^\s"'`]+\.lock)/i);
  const lockPath = match?.[1] ? String(match[1]).trim() : null;
  let lockStat = null;
  if (lockPath) {
    try {
      const stat = fs.statSync(lockPath);
      lockStat = {
        exists: true,
        mtime: stat.mtime.toISOString(),
        age_ms: Math.max(0, Date.now() - stat.mtimeMs),
        size: stat.size,
      };
    } catch {
      lockStat = { exists: false };
    }
  }
  return { timeout: true, lockPath, lockStat };
}

function activeSiblingSetupError(locks = []) {
  const err = new Error(`Worktree setup deferred; ${locks.length} same-WI job lock(s) still active`);
  err.code = "WORKTREE_ACTIVE_SIBLING_LOCKS";
  err.deferWorktreeCleanup = true;
  err.siblingLocks = locks;
  return err;
}

function shouldEmitSetupDeferNotice(job, wi, phase, nowMs = Date.now()) {
  const key = `${wi?.id ?? job?.work_item_id ?? "?"}:${job?.id ?? "?"}:${phase || "setup"}`;
  const last = Number(setupDeferNoticeLastSeen.get(key) || 0);
  if (last > 0 && nowMs - last < SETUP_DEFER_NOTICE_INTERVAL_MS) return false;
  setupDeferNoticeLastSeen.set(key, nowMs);
  if (setupDeferNoticeLastSeen.size > 1000) {
    for (const [entryKey, seenAt] of setupDeferNoticeLastSeen) {
      if (nowMs - Number(seenAt || 0) > SETUP_DEFER_NOTICE_INTERVAL_MS * 4) {
        setupDeferNoticeLastSeen.delete(entryKey);
      }
    }
  }
  return true;
}

function deferSetupIfLiveSiblingLocks(worker, job, wi, phase, locks = null) {
  const siblingLocks = locks || activeLiveSiblingWriteLocks(job);
  if (siblingLocks.length === 0) return;
  const summary = siblingLockSummary(siblingLocks);
  if (shouldEmitSetupDeferNotice(job, wi, phase)) {
    worker.emit(job.id, `${C.dim}[system] WI#${wi.id} worktree setup deferred during ${phase}; ${siblingLocks.length} same-WI lock(s) active${summary ? ` (${summary})` : ""}${C.reset}`);
    logEvent({
      work_item_id: wi.id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Deferred setup ${phase}; ${siblingLocks.length} same-WI job lock(s) still active`,
      event_json: JSON.stringify({
        phase,
        locks: siblingLocks.slice(0, 20),
      }),
    });
  }
  throw activeSiblingSetupError(siblingLocks);
}

async function rollbackCrossWiSyncPathsAsync(wtPath, paths = [], { signal = null } = {}) {
  const uniquePaths = [...new Set(paths.map(normalizeRepoPath).filter(Boolean))];
  if (uniquePaths.length === 0) return;
  try { await gitExecAsync(["reset", "HEAD", "--", ...uniquePaths], wtPath, { signal }); } catch (err) { if (isAbortError(err)) throw err; }
  for (const repoPath of uniquePaths) {
    try {
      await gitExecAsync(["checkout", "HEAD", "--", repoPath], wtPath, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      try { await gitExecAsync(["rm", "--ignore-unmatch", "--", repoPath], wtPath, { signal }); } catch (rmErr) { if (isAbortError(rmErr)) throw rmErr; }
      try { await gitExecAsync(["clean", "-fd", "--", repoPath], wtPath, { signal }); } catch (cleanErr) { if (isAbortError(cleanErr)) throw cleanErr; }
    }
  }
  const status = await gitExecAsync(["status", "--porcelain", "--", ...uniquePaths], wtPath, { signal });
  if (String(status || "").trim()) {
    const dirtyPaths = status.split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    const preview = dirtyPaths.slice(0, 10).join(", ");
    const more = dirtyPaths.length > 10 ? " ..." : "";
    throw new Error(`Cross-WI sync rollback left dirty path(s): ${preview}${more}`);
  }
}

async function applyPendingCrossWiFileSyncsAsync(worker, job, wtPath, { signal = null } = {}) {
  if (!wtPath) return;
  const payload = worker.parsePayload(job);
  const syncs = pendingCrossWiFileSyncs(payload);
  if (syncs.length === 0) return;
  if (await isMergeInProgressAsync(wtPath, { signal })) {
    throw new Error("Cannot apply cross-WI file sync while merge conflicts are pending");
  }

  const skippedSyncs = [];
  await withWorktreeLockAsync(wtPath, worker.projectDir, async () => {
    const branchName = String(await gitExecAsync(["branch", "--show-current"], wtPath, { signal }) || "").trim();
    const runSync = async () => {
      const paths = [];
      const copiedPaths = [];
      const headBeforeSync = await gitCurrentHashAsync(wtPath, { signal });
      try {
        for (const sync of syncs) {
          if (!payloadExplicitlyClaimsPath(payload, sync.path)) {
            throw new Error(`Cross-WI sync path is outside this job's explicit file scope: ${sync.path}`);
          }
          const preStatus = await gitExecAsync(["status", "--porcelain", "--", sync.path], wtPath, { signal });
          if (String(preStatus || "").trim()) {
            throw new Error(`Cross-WI sync path is dirty before sync: ${sync.path}`);
          }
          await assertCrossWiSyncSourceBranchAsync(sync.source_branch, worker.projectDir, { signal });
          const guard = await crossWiSyncTargetGuardAsync(wtPath, sync, { signal });
          if (guard.clobbers) {
            skippedSyncs.push({ sync, guard });
            continue;
          }
          paths.push(sync.path);
          if (guard.source_object != null) {
            await gitExecAsync(["checkout", sync.source_branch, "--", sync.path], wtPath, { signal });
            copiedPaths.push(sync.path);
          } else {
            // git rm stages the deletion itself; the path is gone from both
            // index and worktree afterwards, so a later `git add` on it fatals.
            await gitExecAsync(["rm", "--ignore-unmatch", "--", sync.path], wtPath, { signal });
          }
        }

        const status = paths.length > 0
          ? await gitExecAsync(["status", "--porcelain", "--", ...paths], wtPath, { signal })
          : "";
        if (String(status || "").trim()) {
          if (copiedPaths.length > 0) {
            await gitExecAsync(["add", "--", ...copiedPaths], wtPath, { signal });
          }
          const headBeforeCommit = await gitCurrentHashAsync(wtPath, { signal });
          if (headBeforeCommit && headBeforeSync && headBeforeCommit !== headBeforeSync) {
            const err = new Error(`Branch HEAD moved during cross-WI sync (${headBeforeSync.slice(0, 12)} -> ${headBeforeCommit.slice(0, 12)}); refusing stale commit`);
            err.code = "BRANCH_HEAD_MOVED";
            throw err;
          }
          await gitExecAsync(["commit", "-m", `posse: sync cross-WI file handoff for job #${job.id}`], wtPath, { signal });
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        try {
          await rollbackCrossWiSyncPathsAsync(wtPath, paths, { signal });
        } catch (rollbackErr) {
          rollbackErr.cause = err;
          throw rollbackErr;
        }
        throw err;
      }

      // Skipped syncs are cleared from the pending list too: the target's own
      // content is deliberately kept, and retrying the copy later would still
      // clobber it. The cross-WI merge dependency stays recorded.
      markCrossWiSyncsApplied(job, payload, [...paths, ...skippedSyncs.map((entry) => entry.sync.path)]);
    };
    if (branchName && branchName !== "HEAD") {
      await withBranchLockAsync(wtPath, branchName, worker.projectDir, runSync, { signal });
    } else {
      await runSync();
    }
  }, { signal });
  const skippedPathSet = new Set(skippedSyncs.map((entry) => entry.sync.path));
  for (const sync of syncs) {
    if (skippedPathSet.has(sync.path)) continue;
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_SYNC_APPLIED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Synced ${sync.path} from WI#${sync.source_work_item_id} before editing`,
      event_json: JSON.stringify({
        source_work_item_id: sync.source_work_item_id,
        source_branch: sync.source_branch,
        path: sync.path,
      }),
    });
  }
  for (const { sync, guard } of skippedSyncs) {
    worker.emit(job.id, `${C.yellow}[system] WI#${job.work_item_id} kept its own ${sync.path}; skipped cross-WI copy from WI#${sync.source_work_item_id} (target branch changed the path since handoff)${C.reset}`);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_SYNC_SKIPPED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Skipped cross-WI sync of ${sync.path} from WI#${sync.source_work_item_id}; target branch has newer changes to the path`,
      event_json: JSON.stringify({
        source_work_item_id: sync.source_work_item_id,
        source_branch: sync.source_branch,
        path: sync.path,
        head_object: guard.head_object,
        source_object: guard.source_object,
        base_object: guard.base_object,
        merge_base: guard.merge_base,
      }),
    });
  }
}

function deferTerminalCleanupIfActiveWork(wi, wtDir) {
  const siblingLocks = activeLiveSiblingWriteLocks({ work_item_id: wi.id });
  const sentinel = readActiveWorktreeSentinel(wtDir);
  let sentinelBlocks = sentinel?.payload?.jobId != null
    && isSentinelProcessAlive(sentinel.payload) === true;
  if (sentinelBlocks && !sentinelJobStillActive(sentinel.payload)) {
    // The sentinel pid is this orchestrator process (workers run in-process),
    // so pid liveness cannot distinguish "job still using the worktree" from
    // "job finished but its finally block has not cleared the sentinel yet".
    // The queue is authoritative: a terminal job no longer owns the worktree.
    clearActiveWorktreeSentinel(wtDir, { jobId: sentinel.payload.jobId });
    sentinelBlocks = false;
  }
  if (siblingLocks.length === 0 && !sentinelBlocks) return false;
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Deferred terminal worktree cleanup; ${siblingLocks.length} same-WI job lock(s) active${sentinelBlocks ? " and active sentinel present" : ""}`,
    event_json: JSON.stringify({
      locks: siblingLocks.slice(0, 20),
      sentinel: sentinel?.payload || null,
    }),
  });
  return true;
}

export async function setUpWorktreeForJobAsync(worker, job, leaseToken, { signal = null } = {}) {
  // The catalog is the authoritative coarse boundary. Avoid invoking the
  // key-gated native Git policy for jobs that can never own a worktree; the
  // native method only needs to resolve the finer task-mode policy within
  // this eligible subset.
  if (!WORKTREE_JOB_TYPES.has(job?.job_type)) {
    return { ok: true, wtPath: null, branchName: null, sentinelPath: null };
  }
  const earlyPayload = MUTATING_JOB_TYPES.has(job.job_type) ? worker.parsePayload(job) : null;
  const isArtifactJob = earlyPayload
    ? (job.job_type === "artificer" || isArtifactMode(earlyPayload.task_mode || "code"))
    : false;
  // Artifact jobs are a coarse local classification and never need native Git.
  if (isArtifactJob) {
    return { ok: true, wtPath: null, branchName: null, sentinelPath: null };
  }

  let wtPath = null;
  let branchName = null;
  let prepTrace = null;
  let toleratedResidualLogged = false;
  let toleratedSiblingDirtyLogged = false;
  try {
    if (!jobNeedsGitWorktree(job)) {
      return { ok: true, wtPath: null, branchName: null, sentinelPath: null };
    }
    const wi = getWorkItem(job.work_item_id);
    prepTrace = startPrepTrace({
      workItemId: wi?.id ?? job.work_item_id ?? null,
      jobId: job.id ?? null,
      leaseAcquiredAtMs: job._leaseAcquiredAtMs ?? null,
      actorId: worker.ownerId ?? null,
      onPhase: (phaseEvent) => {
        if (job.id != null && worker.display?.updateWorkerSetupPhase) {
          worker.display.updateWorkerSetupPhase(job.id, phaseEvent);
        }
      },
    });
    const slug = slugify(wi.title, { maxLength: 40 });
    branchName = wi.branch_name || `posse/wi-${wi.id}-${slug}`;
    const wtDir = await worktreePathAsync(worker.projectDir, wi.id, wi.title, { signal });
    const shouldSkipReusedDirtyRecovery = async ({ wtPath: candidatePath, currentBranch = null, branchName: expectedBranch = null }) => {
      if (!earlyPayload) return false;
      const actual = String(currentBranch || "").trim();
      const expected = String(expectedBranch || "").trim();
      if (actual && expected && actual !== expected) return false;
      const siblingLocks = activeLiveSiblingWriteLocks(job);
      const dirty = await inspectIgnorableSetupDirty(candidatePath, earlyPayload, siblingLocks, { signal });
      if (!dirty.tolerated) {
        return siblingLocks.length > 0
          && jobHasSetupCleanupPrecedence(job, siblingLocks)
          && targetedSetupDirtyRecoveryEligible(dirty);
      }
      if ((dirty.residualEntries || []).length > 0 && !toleratedResidualLogged) {
        logToleratedUntrackedResidual(worker, job, wi, {
          ...dirty,
          entries: dirty.residualEntries,
          paths: dirty.residualEntries.map((entry) => entry.path),
        }, "reused-worktree-cleanup");
        toleratedResidualLogged = true;
      }
      if ((dirty.siblingEntries || []).length > 0 && !toleratedSiblingDirtyLogged) {
        logSiblingSetupDirtyReuse(worker, job, wi, dirty, "reused-worktree-cleanup");
        toleratedSiblingDirtyLogged = true;
      }
      return true;
    };

    if (job._worktreePath) {
      wtPath = await withPhase("worktree_add", prepTrace, async () => {
        const configured = await configureWorktreeScopeAsync(job._worktreePath, worker.projectDir, { signal });
        try {
          branchName = (await gitExecAsync(["branch", "--show-current"], configured, { signal })).trim() || branchName;
        } catch {
          // keep planned branch name
        }
        return configured;
      });
    } else {
      if (!wi.branch_name) {
        const mergeBase = await withPhase("worktree_add", prepTrace, async () => {
          const base = await gitCurrentHashAsync(worker.projectDir, { signal });
          await gitWorktreeAddAsync(wtDir, branchName, worker.projectDir, {
            wiId: wi.id,
            signal,
            shouldDeferDirtyRecovery: () => {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "reused-worktree-cleanup");
              return false;
            },
            shouldDeferBranchMismatchRecovery: () => {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "branch-mismatch");
              return false;
            },
            shouldDeferHeadReset: () => {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "stale-head-reset");
              return false;
            },
            shouldSkipDirtyRecovery: shouldSkipReusedDirtyRecovery,
            onDirtySnapshot: (snapshotDir) => {
              if (snapshotDir) {
                worker.emit(job.id, `${C.dim}[system] WI#${wi.id} preserved dirty worktree snapshot: ${snapshotDir}${C.reset}`);
              }
            },
          });
          return base;
        });
        setWorkItemBranch(wi.id, branchName, mergeBase);
        worker.emit(job.id, `${C.dim}[system] WI#${wi.id} New worktree: ${branchName} (base: ${mergeBase.slice(0, 8)})${C.reset}`);
      } else {
        const recreatedMergeBase = await withPhase("worktree_add", prepTrace, async () => {
          const base = await gitCurrentHashAsync(worker.projectDir, { signal });
          let recreatedMissingBranch = false;
          await gitWorktreeAddAsync(wtDir, branchName, worker.projectDir, {
            wiId: wi.id,
            signal,
            shouldDeferDirtyRecovery: () => {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "reused-worktree-cleanup");
              return false;
            },
            shouldDeferBranchMismatchRecovery: () => {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "branch-mismatch");
              return false;
            },
            shouldDeferHeadReset: () => {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "stale-head-reset");
              return false;
            },
            shouldSkipDirtyRecovery: shouldSkipReusedDirtyRecovery,
            onDirtySnapshot: (snapshotDir) => {
              if (snapshotDir) {
                worker.emit(job.id, `${C.dim}[system] WI#${wi.id} preserved dirty worktree snapshot: ${snapshotDir}${C.reset}`);
              }
            },
            onBranchMismatch: ({ expected, actual }) => {
              worker.emit(job.id, `${C.yellow}[system] WI#${wi.id} discarded stale worktree branch ${actual || "(detached)"}; expected ${expected}${C.reset}`);
              logEvent({
                work_item_id: wi.id,
                job_id: job.id,
                event_type: EVENT_TYPES.WORKTREE_BRANCH_MISMATCH,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Discarded stale worktree branch ${actual || "(detached)"}; expected ${expected}`,
              });
            },
            onStaleHead: ({ branchName: staleBranch, worktreeHead, branchHead }) => {
              worker.emit(job.id, `${C.yellow}[system] WI#${wi.id} refreshed stale worktree checkout for ${staleBranch}: ${String(worktreeHead || "").slice(0, 8)} -> ${String(branchHead || "").slice(0, 8)}${C.reset}`);
              logEvent({
                work_item_id: wi.id,
                job_id: job.id,
                event_type: EVENT_TYPES.WORKTREE_STALE_HEAD_RESET,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Refreshed stale worktree checkout for ${staleBranch}`,
                event_json: JSON.stringify({ branch: staleBranch, worktreeHead, branchHead }),
              });
            },
            onBranchCreated: () => {
              recreatedMissingBranch = true;
            },
          });
          return { base, recreatedMissingBranch };
        });
        if (recreatedMergeBase.recreatedMissingBranch) {
          setWorkItemBranch(wi.id, branchName, recreatedMergeBase.base);
          worker.emit(job.id, `${C.yellow}[system] WI#${wi.id} recreated missing branch: ${branchName} (base: ${recreatedMergeBase.base.slice(0, 8)})${C.reset}`);
          logEvent({
            work_item_id: wi.id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_BRANCH_RECREATED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Recreated missing WI branch ${branchName} from ${recreatedMergeBase.base}`,
          });
        } else {
          worker.emit(job.id, `${C.dim}[system] WI#${wi.id} Rejoined worktree: ${wi.branch_name}${C.reset}`);
        }
      }

      wtPath = await withPhase("worktree_add", prepTrace, () => configureWorktreeScopeAsync(wtDir, worker.projectDir, { signal }));
    }

    await yieldNow({ signal });
    let dirtyState = { dirtyPost: "", ignoredDirty: false, ignoredPost: "", mergeInProgress: false };
    await withWorktreeLockAsync(wtPath, worker.projectDir, async () => {
      dirtyState = await withPhase("dirty_detect", prepTrace, async () => {
        const dirtyPost = await gitExecAsync(["status", "--porcelain", "--untracked-files=all"], wtPath, { signal });
        const ignoredPost = await gitExecAsync(["status", "--porcelain", "--ignored=matching", "--untracked-files=all"], wtPath, { signal });
        return {
          dirtyPost,
          ignoredPost,
          ignoredDirty: parsePorcelainEntries(ignoredPost).some((entry) => entry.status === "!!"),
          mergeInProgress: await isMergeInProgressAsync(wtPath, { signal }),
        };
      });
      if ((dirtyState.dirtyPost || dirtyState.ignoredDirty) && !dirtyState.mergeInProgress) {
        const siblingLocks = activeLiveSiblingWriteLocks(job);
        const ignorableDirty = earlyPayload
          ? classifyIgnorableSetupDirty(earlyPayload, dirtyState.dirtyPost, dirtyState.ignoredPost, siblingLocks)
          : { tolerated: false, residualEntries: [], siblingEntries: [] };
        if (ignorableDirty.tolerated) {
          if ((ignorableDirty.residualEntries || []).length > 0 && !toleratedResidualLogged) {
            logToleratedUntrackedResidual(worker, job, wi, {
              ...ignorableDirty,
              entries: ignorableDirty.residualEntries,
              paths: ignorableDirty.residualEntries.map((entry) => entry.path),
            }, "setup-dirty-detect");
            toleratedResidualLogged = true;
          }
          if ((ignorableDirty.siblingEntries || []).length > 0 && !toleratedSiblingDirtyLogged) {
            logSiblingSetupDirtyReuse(worker, job, wi, ignorableDirty, "setup-dirty-detect");
            toleratedSiblingDirtyLogged = true;
          }
          return;
        }
        if (siblingLocks.length > 0) {
          if (jobHasSetupCleanupPrecedence(job, siblingLocks) && targetedSetupDirtyRecoveryEligible(ignorableDirty)) {
            const dirtyClass = await classifyDirtyWorktreeAsync(wtPath, { jobId: job.id, signal });
            if (dirtyClass.primary === "external_edit") {
              try {
                await withPhase("dirty_recover_targeted", prepTrace, async () => {
                  await snapshotAndResetSetupBlockingPathsAsync(worker, job, wi, wtPath, {
                    branchName,
                    dirty: { ...ignorableDirty, siblingLocks },
                    signal,
                  });
                });
                return;
              } catch (targetedErr) {
                if (isAbortError(targetedErr)) throw targetedErr;
                worker.emit(job.id, `${C.dim}[system] WI#${wi.id} targeted setup cleanup skipped: ${targetedErr.message.split("\n")[0]}${C.reset}`);
              }
            }
          }
          const summary = siblingLockSummary(siblingLocks);
          worker.emit(job.id, `${C.dim}[system] WI#${wi.id} dirty worktree cleanup deferred; ${siblingLocks.length} same-WI lock(s) active${summary ? ` (${summary})` : ""}${C.reset}`);
          logEvent({
            work_item_id: wi.id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Deferred setup dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
            event_json: JSON.stringify({
              locks: siblingLocks.slice(0, 20),
              porcelain: dirtyState.dirtyPost,
              ignored_dirty: !!dirtyState.ignoredDirty,
            }),
          });
          throw activeSiblingSetupError(siblingLocks);
        }
        await withPhase("dirty_recover", prepTrace, async () => {
          const dirtyClass = await classifyDirtyWorktreeAsync(wtPath, { jobId: job.id, signal });
          logEvent({
            work_item_id: wi.id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_DIRTY_CLASSIFIED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Dirty worktree classifier: ${dirtyClass.primary}`,
            event_json: JSON.stringify(dirtyClass),
          });
          worker.emit(job.id, `${C.dim}[system] WI#${wi.id} worktree has uncommitted changes — snapshotting and resetting${C.reset}`);
          try {
            const snapshotDir = await snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
              reason: `dirty-worktree-setup-wi-${wi.id}-job-${job.id}`,
              branchName,
              wiId: wi.id,
              signal,
              lock: false,
              onMsg: (msg) => {
                worker.emit(job.id, `${C.dim}[system] WI#${wi.id} ${msg}${C.reset}`);
              },
              onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir: resetSnapshotDir = null }) => {
                const preview = remainingPaths.slice(0, 10).join(", ");
                const more = remainingPaths.length > 10 ? " ..." : "";
                logEvent({
                  work_item_id: wi.id,
                  job_id: job.id,
                  event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: `Worktree reset left ${remainingPaths.length} path(s): ${preview}${more}`,
                  event_json: JSON.stringify({
                    remaining_paths: remainingPaths,
                    porcelain: postResetPorcelain,
                    snapshot_dir: resetSnapshotDir,
                  }),
                });
              },
            });
            if (snapshotDir) {
              worker.emit(job.id, `${C.dim}[system] WI#${wi.id} preserved dirty worktree snapshot: ${snapshotDir}${C.reset}`);
              logEvent({
                work_item_id: wi.id,
                job_id: job.id,
                event_type: EVENT_TYPES.WORKTREE_DIRTY_RECOVERED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Snapshotted dirty worktree state before next job: ${snapshotDir}`,
              });
            }
          } catch (err) {
            if (isAbortError(err)) throw err;
            worker.emit(job.id, `${C.yellow}[system] WI#${wi.id} dirty worktree snapshot/reset failed; leaving changes in place (${err.message.split("\n")[0]})${C.reset}`);
            throw err;
          }
        });
      }
    }, { signal });

    await yieldNow({ signal });
    const rebaseEligible = job.job_type === "dev" || job.job_type === "fix";
    if (rebaseEligible) {
      await withPhase("target_merge", prepTrace, async () => {
        await withWorktreeLockAsync(wtPath, worker.projectDir, async () => {
          try {
            const targetBranch = await resolveTargetBranchAsync(worker.projectDir, { signal });
            const staleness = branchStalenessCheck({
              projectDir: worker.projectDir,
              branchName,
              targetBranch,
            });
            if (staleness.status === "stale") {
              worker.emit(job.id, `${C.yellow}[system] WI#${wi.id} ${formatBranchStalenessCheck(staleness)}${C.reset}`);
            }
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              event_type: EVENT_TYPES.JOB_BRANCH_STALENESS_CHECK,
              actor_type: EVENT_ACTORS.WORKER,
              message: formatBranchStalenessCheck(staleness),
              event_json: JSON.stringify(staleness),
            });
            const siblingLocks = activeLiveSiblingWriteLocks(job);
            // `mergeTargetIntoWorktreeAsync` is a no-op when the WI branch is
            // fresh; only defer behind live siblings when the staleness probe
            // says a real target merge would mutate the shared worktree.
            if (siblingLocks.length > 0 && staleness?.needs_rebase) {
              deferSetupIfLiveSiblingLocks(worker, job, wi, "target-merge", siblingLocks);
            }
            const result = await mergeTargetIntoWorktreeAsync(wtPath, worker.projectDir, targetBranch, {
              leaveOnConflict: true,
              initialMergeInProgress: dirtyState.mergeInProgress,
              signal,
            });
            if (result.ok && result.updated) {
              worker.emit(job.id, `${C.dim}[system] WI#${wi.id} rebased onto ${targetBranch} (${(result.mergeCommit || "").slice(0, 8)})${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.JOB_REBASE_APPLIED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Merged ${targetBranch} into WI branch before job start`,
              });
            } else if (!result.ok && result.abortFailed) {
              const conflictList = (result.conflicts || []).slice(0, 10).join(", ");
              const more = (result.conflicts || []).length > 10 ? " …" : "";
              worker.emit(job.id, `${C.red}[system] WI#${wi.id} rebase abort failed; manual cleanup required (conflicts: ${conflictList}${more})${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.JOB_REBASE_ABORT_FAILED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Rebase abort failed after merge from ${targetBranch}; manual cleanup required: ${result.message || "unknown"}`,
              });
              throw new Error(result.message || "rebase abort failed; manual cleanup required");
            } else if (!result.ok && (result.leftInTree || result.alreadyInProgress)) {
              const conflictList = (result.conflicts || []).slice(0, 10).join(", ");
              const more = (result.conflicts || []).length > 10 ? " …" : "";
              const reason = result.alreadyInProgress ? "prior merge still in progress" : "rebase hit conflicts";
              worker.emit(job.id, `${C.yellow}[system] WI#${wi.id} ${reason}; handing merge to dev (conflicts: ${conflictList}${more})${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.JOB_REBASE_CONFLICT,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Rebase onto ${targetBranch} left conflicts in worktree for dev to resolve: ${conflictList}${more}`,
              });
            } else if (!result.ok) {
              worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} rebase-on-lease skipped: ${result.error || "unknown"}${C.reset}`);
            }
          } catch (rebaseErr) {
            if (isAbortError(rebaseErr)) throw rebaseErr;
            worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} rebase-on-lease skipped: ${rebaseErr.message.split("\n")[0]}${C.reset}`);
          }
        }, { signal });
      });
    }

    await withPhase("cross_wi_sync", prepTrace, async () => {
      await applyPendingCrossWiFileSyncsAsync(worker, job, wtPath, { signal });
    });

    job._worktreePath = wtPath;
    await withPhase("sentinel_write", prepTrace, async () => {
      try {
        job._activeWorktreeSentinel = writeActiveWorktreeSentinel(wtPath, {
          pid: process.pid,
          jobId: job.id ?? null,
          wiId: wi.id,
          branchName,
        });
      } catch {
        job._activeWorktreeSentinel = null;
      }
    });

    await yieldNow({ signal });
    await withPhase("atlas_join", prepTrace, async () => {
      try {
        if (await isMergeInProgressAsync(wtPath, { signal })) {
          worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} join check skipped while merge is in progress${C.reset}`);
        } else {
          worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} preparing worktree graph before dev join${C.reset}`);
          let joined = null;
          try {
            joined = await ensureWorkItemAtlasJoinAsync({
              projectDir: worker.projectDir,
              worktreePath: wtPath,
              workItemId: wi.id,
              config: getAtlasIntegrationConfig(),
              signal,
              onStatus: ({ ok, error, status }) => {
                if (ok) {
                  worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} worktree graph refresh complete${C.reset}`);
                } else {
                  const detail = error || (status != null ? `exit ${status}` : "unknown");
                  worker.emit(job.id, `${C.yellow}[atlas] WI#${wi.id} worktree graph refresh failed: ${detail}${C.reset}`);
                }
              },
            });
            job._atlasConfig = joined.config || null;
            job._atlasGraphDbPath = joined.graphDbPath || null;
            job._atlasDisabledForWorkItem = !!joined.disableAtlas;
            if (joined.state === "up_to_date") {
              worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} worktree graph up to date${C.reset}`);
            } else if (joined.state === "seeded_refresh") {
              const refreshReady = joined.refreshWait?.completed && joined.refreshWait?.ok !== false;
              let refreshState = joined.attempted ? "started" : "queued/skipped";
              if (refreshReady) refreshState = "complete";
              else if (joined.refreshWait?.skipped === "refresh_wait_timeout") refreshState = "still running after wait";
              worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} seeded worktree graph; refresh ${refreshState}${C.reset}`);
            } else if (joined.state === "refresh") {
              const refreshReady = joined.refreshWait?.completed && joined.refreshWait?.ok !== false;
              let refreshState = joined.attempted ? "started" : "queued/skipped";
              if (refreshReady) refreshState = "complete";
              else if (joined.refreshWait?.skipped === "refresh_wait_timeout") refreshState = "still running after wait";
              worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} worktree graph refresh ${refreshState}${C.reset}`);
            } else if (joined.state === "primary_graph_absent") {
              worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} no primary graph available; ATLAS disabled for this worktree join${C.reset}`);
            } else if (joined.state === "seed_busy") {
              worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} graph seed busy; ATLAS disabled for this worktree join${C.reset}`);
            }
          } finally {
            try { joined?.view?.close?.(); } catch { /* best effort */ }
          }
        }
      } catch (atlasErr) {
        if (isAbortError(atlasErr)) throw atlasErr;
        job._atlasConfig = null;
        job._atlasDisabledForWorkItem = true;
        worker.emit(job.id, `${C.dim}[atlas] WI#${wi.id} worktree join skipped: ${atlasErr.message.split("\n")[0]}${C.reset}`);
      }
    });

    finalizePrepTrace(prepTrace, { ok: true });
    if (isAtlasV2EmissionEnabled()) {
      emitAtlasV2DevLeased({
        payload: {
          wi_id: Number(wi.id),
          branch: String(branchName || ""),
          worktree_path: String(wtPath || ""),
          job_id: Number(job.id),
        },
        onError: () => { /* outbox failure must not block lease */ },
      });
    }
    return { ok: true, wtPath, branchName, sentinelPath: job._activeWorktreeSentinel || null };
  } catch (gitErr) {
    if (prepTrace) finalizePrepTrace(prepTrace, { ok: false, error: gitErr?.message || String(gitErr) });
    if (isAbortError(gitErr)) {
      worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} worktree setup aborted${C.reset}`);
      throw gitErr;
    }
    if (gitErr?.code === "WORKTREE_ACTIVE_SIBLING_LOCKS") {
      const readyAt = new Date(Date.now() + SETUP_DEFER_RETRY_DELAY_MS).toISOString();
      if (shouldEmitSetupDeferNotice(job, { id: job.work_item_id }, "retry-queued")) {
        worker.emit(job.id, `${C.yellow}[system] WI#${job.work_item_id} worktree setup deferred behind same-WI work; retrying after active same-WI work releases${C.reset}`);
      }
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
      return { ok: false, wtPath: null, branchName: null, sentinelPath: job._activeWorktreeSentinel || null };
    }
    const lockTimeout = worktreeLockTimeoutInfo(gitErr);
    if (lockTimeout.timeout) {
      const readyAt = new Date(Date.now() + 5000).toISOString();
      worker.emit(job.id, `${C.yellow}[system] WI#${job.work_item_id} worktree setup waiting on a stale lock; retrying shortly${C.reset}`);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_WORKTREE_LOCK_TIMEOUT,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Worktree setup blocked by lock timeout: ${gitErr.message}`,
        event_json: JSON.stringify({
          phase: "worktree_setup",
          lock_path: lockTimeout.lockPath,
          lock_stat: lockTimeout.lockStat,
        }),
      });
      setJobError(job.id, `Git worktree setup blocked by worktree lock timeout: ${gitErr.message}`);
      worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
      return { ok: false, wtPath: null, branchName: null, sentinelPath: job._activeWorktreeSentinel || null };
    }
    if (isTransientCommitInfraFailure(gitErr)) {
      const retryCount = transientSetupRetryCount(worker, job);
      if (retryCount < MAX_SETUP_TRANSIENT_INFRA_RETRIES) {
        const nextRetry = bumpTransientSetupRetry(worker, job);
        const readyAt = new Date(Date.now() + SETUP_TRANSIENT_INFRA_RETRY_DELAY_MS).toISOString();
        const message = `Transient git/native infrastructure fault during worktree setup; retrying (${nextRetry}/${MAX_SETUP_TRANSIENT_INFRA_RETRIES})`;
        worker.emit(job.id, `${C.yellow}[system] WI#${job.work_item_id} ${message}${C.reset}`);
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          event_type: EVENT_TYPES.JOB_COMMIT_INFRA_RETRY,
          actor_type: EVENT_ACTORS.WORKER,
          message,
          event_json: JSON.stringify({
            phase: "worktree_setup",
            retry: nextRetry,
            max_retries: MAX_SETUP_TRANSIENT_INFRA_RETRIES,
            error: String(gitErr?.message || gitErr).slice(0, 500),
          }),
        });
        setJobError(job.id, `Git worktree setup transient infra fault: ${gitErr.message}`);
        worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
        return { ok: false, wtPath: null, branchName: null, sentinelPath: job._activeWorktreeSentinel || null };
      }
    }
    worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} worktree setup failed: ${gitErr.message.split("\n")[0]}${C.reset}`);
    const cleanupStart = Date.now();
    let cleanupOk = true;
    try {
      await yieldNow({ signal }).catch(() => {});
      const wi = getWorkItem(job.work_item_id);
      const wtDir = await worktreePathAsync(worker.projectDir, wi.id, wi.title, { signal });
      if (fs.existsSync(wtDir)) {
        const siblingLocks = activeLiveSiblingWriteLocks(job);
        const sentinel = readActiveWorktreeSentinel(wtDir);
        const sentinelBlocks = sentinel?.payload?.jobId != null
          && Number(sentinel.payload.jobId) !== Number(job.id)
          && isSentinelProcessAlive(sentinel.payload) === true;
        if (siblingLocks.length > 0 || sentinelBlocks) {
          cleanupOk = false;
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Skipped setup-failure worktree removal; ${siblingLocks.length} same-WI job lock(s) active${sentinelBlocks ? " and active sentinel owned by another job" : ""}`,
            event_json: JSON.stringify({
              locks: siblingLocks.slice(0, 20),
              sentinel: sentinel?.payload || null,
            }),
          });
        } else {
          worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} cleaning up partial worktree at ${wtDir}${C.reset}`);
          const cleanupResult = await safeSnapshotAndRemoveWorktreeAsync(wtDir, worker.projectDir, {
            reason: "setup-failure-worktree-cleanup",
            branchName: branchName || wi?.branch_name || null,
            wiId: wi?.id || job.work_item_id,
            signal,
            onMsg: (msg) => {
              worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${msg}${C.reset}`);
            },
            onSnapshot: ({ snapshotDir, corruptMetadata }) => {
              worker.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} preserved setup-failed worktree snapshot: ${snapshotDir}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.WORKTREE_DIRTY_RECOVERED,
                actor_type: EVENT_ACTORS.WORKER,
                message: corruptMetadata
                  ? `Copied corrupt setup-failed worktree contents before cleanup: ${snapshotDir}`
                  : `Snapshotted setup-failed worktree before cleanup: ${snapshotDir}`,
                event_json: JSON.stringify({
                  snapshot_dir: snapshotDir,
                  corrupt_metadata: !!corruptMetadata,
                }),
              });
            },
            onFailure: ({ message, ...extra }) => {
              cleanupOk = false;
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
                actor_type: EVENT_ACTORS.WORKER,
                message,
                event_json: JSON.stringify({
                  worktree_path: wtDir,
                  branch: branchName || wi?.branch_name || null,
                  ...extra,
                }),
              });
              worker.emit(job.id, `${C.yellow}[system] WI#${job.work_item_id} ${message}${C.reset}`);
            },
            onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir: resetSnapshotDir = null }) => {
              const preview = remainingPaths.slice(0, 10).join(", ");
              const more = remainingPaths.length > 10 ? " ..." : "";
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Setup-failure cleanup left ${remainingPaths.length} path(s): ${preview}${more}`,
                event_json: JSON.stringify({
                  remaining_paths: remainingPaths,
                  porcelain: postResetPorcelain,
                  snapshot_dir: resetSnapshotDir,
                }),
              });
            },
          });
          cleanupOk = cleanupOk && !cleanupResult.skipped && (!cleanupResult.existed || cleanupResult.removed);
        }
      }
      await yieldNow({ signal }).catch(() => {});
    } catch {
      cleanupOk = false;
      // best effort cleanup
    } finally {
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.WORKER_SETUP_CLEANUP_TIMING,
        actor_type: EVENT_ACTORS.WORKER,
        event_json: {
          duration_ms: Date.now() - cleanupStart,
          ok: cleanupOk,
        },
      });
    }
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_GIT_ERROR,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Git worktree setup failed: ${gitErr.message}`,
    });
    setJobError(job.id, `Git worktree setup failed: ${gitErr.message}`);
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      artifact_type: "log",
      content_long: `Git worktree setup failed (job #${job.id}, ${job.job_type}): ${gitErr.message}`,
    });
    recordWorktreeSetupFailureAttempt(job, leaseToken, `Git worktree setup failed: ${gitErr.message}`);
    worker._retryOrFail(job, leaseToken, `Git worktree setup failed: ${gitErr.message}`);
    return { ok: false, wtPath: null, branchName: null, sentinelPath: job._activeWorktreeSentinel || null };
  }
}

export async function setUpWorktreeForJob(worker, job, leaseToken, options = {}) {
  return setUpWorktreeForJobAsync(worker, job, leaseToken, options);
}

export function primeCreatableFiles(cwd, filesToCreate = []) {
  const created = [];
  for (const relPath of filesToCreate) {
    if (!relPath || typeof relPath !== "string") continue;
    const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
    if (fs.existsSync(absPath)) continue;
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    try {
      fs.writeFileSync(absPath, "", { flag: "wx" });
    } catch (err) {
      if (err?.code === "EEXIST") continue;
      throw err;
    }
    created.push(relPath);
  }
  return created;
}

function shouldPreserveUnmergedCompleteAtlasView(wi) {
  return wi?.status === "complete" && wi?.merge_state !== "merged";
}

function shouldDeferBranchBackedCompleteCleanupUntilMerge(wi) {
  return wi?.status === "complete" && !!wi?.branch_name && wi?.merge_state !== "merged";
}

function logCompleteCleanupDeferredUntilMerge(wi) {
  logEvent({
    work_item_id: wi.id,
    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Deferred terminal worktree cleanup until WI merge; branch ${wi.branch_name} is still pending review`,
    event_json: JSON.stringify({
      branch_name: wi.branch_name,
      merge_state: wi.merge_state || null,
      reason: "complete_branch_pending_merge",
    }),
  });
}

function atlasCleanupDisposition(wi) {
  if (shouldPreserveUnmergedCompleteAtlasView(wi)) return null;
  if (wi.status === "complete") return "merged";
  if (wi.status === "canceled") return "abandoned";
  return "purged";
}


export async function cleanupWorktreeIfDoneAsync(worker, workItemId, { signal = null } = {}) {
  try {
    const wi = getWorkItem(workItemId);
    if (!wi) return;

    if (!TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status)) return;
    if (isIterativeWorkItemActive(wi)) return;
    if (shouldDeferBranchBackedCompleteCleanupUntilMerge(wi)) {
      logCompleteCleanupDeferredUntilMerge(wi);
      return;
    }

    const wtDir = await worktreePathAsync(worker.projectDir, wi.id, wi.title, { signal });
    if (deferTerminalCleanupIfActiveWork(wi, wtDir)) return;
    let atlasDisposed = false;
    const disposeAtlas = () => {
      if (atlasDisposed) return;
      atlasDisposed = true;
      disposeWorkItemAtlasGraph({
        projectDir: worker.projectDir,
        workItemId: wi.id,
        worktreePath: wtDir,
        includeWarmed: !shouldPreserveUnmergedCompleteAtlasView(wi),
      });
    };
    let wtExists = false;
    try {
      await fs.promises.access(wtDir);
      wtExists = true;
    } catch {
      wtExists = false;
    }
    if (wtExists) {
      disposeAtlas();
      const cleanupResult = await safeSnapshotAndRemoveWorktreeAsync(wtDir, worker.projectDir, {
        reason: "terminal-worktree-cleanup",
        branchName: wi.branch_name || null,
        wiId: wi.id,
        signal,
        onMsg: (msg) => {
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORKTREE_SNAPSHOT_WARNING,
            actor_type: EVENT_ACTORS.WORKER,
            message: msg,
          });
          if (!worker.display && !worker.silent) {
            console.log(`${C.dim}[system] WI#${wi.id} ${msg}${C.reset}`);
          }
        },
        onSnapshot: ({ snapshotDir }) => {
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORKTREE_TERMINAL_SNAPSHOT,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Preserved terminal dirty worktree snapshot: ${snapshotDir}`,
          });
          if (!worker.display && !worker.silent) {
            console.log(`${C.dim}[system] WI#${wi.id} preserved terminal dirty worktree snapshot: ${snapshotDir}${C.reset}`);
          }
        },
        onFailure: ({ message, ...extra }) => {
          logTerminalCleanupFailure(worker, wi, wtDir, message, extra);
        },
        onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "", snapshotDir: resetSnapshotDir = null }) => {
          logEvent({
            work_item_id: wi.id,
            event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Terminal cleanup left ${remainingPaths.length} path(s) in worktree`,
            event_json: JSON.stringify({
              remaining_paths: remainingPaths,
              porcelain: postResetPorcelain,
              snapshot_dir: resetSnapshotDir,
            }),
          });
        },
      });
      if (cleanupResult.skipped) return;
    }

    disposeAtlas();
    if (isAtlasV2EmissionEnabled()) {
      const disposition = atlasCleanupDisposition(wi);
      if (disposition) {
        emitAtlasV2WiCleanup({
          payload: {
            wi_id: Number(wi.id),
            branch: String(wi.branch_name || ""),
            disposition,
          },
          onError: () => { /* outbox failure must not block cleanup */ },
        });
      }
    }

    const ctxDir = contextDir(wiScopeId(wi.id), worker.projectDir);
    try {
      await fs.promises.rm(ctxDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    const artifactCleanup = wi.status === "complete"
      ? await cleanupArtifactDirsAsync(wiScopeId(wi.id), worker.projectDir, { keepArtifacts: true })
      : null;
    if (artifactCleanup?.removed?.length > 0) {
      logEvent({
        work_item_id: wi.id,
        event_type: EVENT_TYPES.ARTIFACTS_TRANSIENT_DIRS_CLEANED,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Removed ${artifactCleanup.removed.length} transient artifact resource dir(s) after WI completion`,
        event_json: JSON.stringify({ dirs: artifactCleanup.removed }),
      });
    }
  } catch (err) {
    const message = err?.message || String(err);
    logEvent({
      work_item_id: workItemId,
      event_type: EVENT_TYPES.WORKTREE_CLEANUP_FAILED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Terminal worktree cleanup failed: ${message}`,
    });
  }
}

// Test hook: exercises the cross-WI file sync application (including the
// target-divergence guard) against a real git worktree without booting a
// full Worker.
export { applyPendingCrossWiFileSyncsAsync as __testApplyPendingCrossWiFileSyncsAsync };
