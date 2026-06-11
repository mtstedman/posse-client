// lib/scheduler.js — Job scheduler with lease-based execution
//
// The scheduler does NOT execute jobs. It:
// 1. Requeues expired leases (crashed workers)
// 2. Finds the next runnable job
// 3. Leases it
// 4. Hands it to the worker callback
// 5. Detects deadlocks
//
// Supports concurrent workers via the `concurrency` option.

import crypto from "crypto";
import { spawn } from "child_process";
import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  DEADLOCK_TERMINAL_STATUSES,
  LOCK_HOLDING_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  isPushOfferJob,
} from "../../queue/functions/common.js";
import {
  addCrossWiMergeDependency,
  ancestorJobIdsForJob,
  queuedCohortJobIdsForJob,
  requeueForShutdown,
  findRunnableJob,
  findRunnableJobsBatch,
  getLeaseManager,
  acquireSchedulerLock,
  forceAcquireSchedulerLock,
  renewSchedulerLock,
  releaseSchedulerLock,
  getSchedulerLockInfo,
  cancelDeadlockedJobsAtomic,
  getSetting,
  listJobs,
  listWorkItems,
  hasJobs,
  countJobsByStatus,
  cleanupStaleFileLocks,
  listJobsByWorkItem,
  logEvent,
  releaseWorkItemFileLockForPath,
  updateJobStatus,
  updateJobPayload,
  refreshWorkItemStatus,
  getJob,
  getDependents,
  removeDependency,
  getWorkItem,
  expireStaleSessionLeases,
  crossWiMergeDependencyWouldCycle,
  workItemCanReleaseFileLock,
  getQueueWakeGeneration,
  onQueueStateChanged,
  waitForQueueStateChangeAfter,
} from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { reapOrphanedDaemons } from "../../../classes/tools/daemon/index.js";
import { C } from "../../providers/functions/claude.js";
import { primeProviderUsageAuthAsync } from "../../providers/functions/provider.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { recordMemorySample } from "../../../shared/telemetry/functions/memory.js";
import {
  recordBootCrashResumeMarker,
  recordRunDiagnostic,
  recordSchedulerLockDiagnostic,
  recordSchedulerShutdownMarker,
  startRunHeartbeat,
} from "../../../shared/telemetry/functions/run-diagnostics.js";
import { maybeRunRuntimeRetention } from "../../ui/functions/admin/retention.js";
import { maybeRefreshModelCatalog } from "../../remote/functions/model-catalog-refresh.js";
import { describeModelCatalogWarning } from "../../providers/functions/model-catalog-validate.js";
import {
  RUNTIME_STATUS_KEYS,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { maybeExpireStuckFanoutChildren } from "../../research/functions/fanout.js";
import { yieldNow } from "../../runtime/functions/yield.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import {
  formatProviderAuthLivenessProbe,
  formatWorkspaceHealthProbe,
  providerAuthLivenessProbe,
  workspaceHealthProbeAsync,
} from "../../system/functions/preflight-probes.js";
import { QUEUE_LOCKING_JOB_TYPES } from "../../worker/functions/helpers/job-type-sets.js";
import { reconcileAtlasDriftIfIdleAsync } from "../../integrations/functions/atlas.js";
import {
  DEFAULT_LEASE_SEC,
  DEFAULT_CONCURRENCY,
  DEFAULT_POLL_MS,
  DEFAULT_REPAIR_POLL_MS,
  LOCK_RENEW_SEC,
  MAX_RUNNABLE_SCAN_PER_TICK,
  PROGRESS_TIMEOUT_SEC,
  maxJobRuntimeSecFor,
  readActiveWorktreeCap,
  readAtlasDriftCheckIntervalMs,
  readBoolSetting,
  readHeadlessHumanTimeoutSec,
} from "../functions/config.js";
import {
  collectStrictOnlyRootConflicts,
  findFileConflict,
} from "../functions/file-scope.js";
import {
  WORKTREE_TYPES,
  createHeldQueueLockIndex,
} from "../functions/held-locks.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const SCHEDULER_BOOT_MAINTENANCE_WORKER_URL = new URL("../functions/boot-maintenance-worker.js", import.meta.url);
const SCHEDULER_BOOT_THREAD_MANAGER = new ThreadManager();

function runSchedulerBootMaintenanceInWorker() {
  return SCHEDULER_BOOT_THREAD_MANAGER.run(SCHEDULER_BOOT_MAINTENANCE_WORKER_URL, {
    label: "Scheduler boot DB maintenance",
    timeoutMs: 120_000,
    workerData: {
      dbPath: getRuntimeDbPath(),
    },
  });
}

function readPositiveIntSetting(key, fallback) {
  let raw = null;
  try {
    raw = getSetting(key);
  } catch {
    raw = null;
  }
  const parsed = Number.parseInt(String(raw || fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function schedulerLockTiming(lockInfo, lockDurationMs, nowMs = Date.now()) {
  const acquiredMs = Date.parse(lockInfo?.acquired_at || "");
  const expiresMs = Date.parse(lockInfo?.expires_at || "");
  const heartbeatMs = Number.isFinite(acquiredMs)
    ? acquiredMs
    : Number.isFinite(expiresMs)
      ? expiresMs - lockDurationMs
      : NaN;

  return {
    heartbeatAge: Number.isFinite(heartbeatMs) ? nowMs - heartbeatMs : Infinity,
    expiresIn: Number.isFinite(expiresMs) ? expiresMs - nowMs : -Infinity,
    heartbeatFromExpiresAt: !Number.isFinite(acquiredMs) && Number.isFinite(expiresMs),
    heartbeatInvalid: !Number.isFinite(heartbeatMs),
  };
}

function formatSchedulerLockDuration(ms) {
  return Number.isFinite(ms) ? `${Math.ceil(ms / 1000)}s` : "invalid";
}

function formatStaleHeartbeatReason(heartbeatAge, thresholdMs) {
  if (!Number.isFinite(heartbeatAge)) return "timestamp invalid";
  return `${formatSchedulerLockDuration(heartbeatAge)} > ${thresholdMs / 1000}s threshold`;
}

function atlasWarmConcurrencyKey(job) {
  if (job?.job_type !== "atlas_warm") return null;
  const payload = parseJobPayload(job) || {};
  const target = String(
    payload.branch
    || (payload.work_item_id != null ? `wi-${payload.work_item_id}` : "")
    || payload.onto_branch
    || "main",
  ).trim();
  return target || null;
}

function terminateSchedulerChild(child, { force = false } = {}) {
  if (!child || child.exitCode != null || (!force && child.killed)) return false;
  if (process.platform === "win32" && child.pid) {
    try {
      const args = ["/pid", String(child.pid), "/T"];
      if (force) args.push("/F");
      const killer = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref?.();
      return true;
    } catch {
      // Fall through to child.kill best effort.
    }
  }
  try {
    return child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }
}

function normalizeHandoffPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

function handoffCandidateCoversPath(candidate, filePath) {
  const candidatePath = normalizeHandoffPath(candidate?.path);
  const normalizedFile = normalizeHandoffPath(filePath);
  if (!candidatePath || !normalizedFile) return false;
  if (candidate?.lock_kind === "file") return candidatePath === normalizedFile;
  if (candidate?.lock_kind !== "root") return false;
  return candidatePath === "*"
    || candidatePath === "."
    || normalizedFile === candidatePath
    || normalizedFile.startsWith(`${candidatePath}/`);
}

function prepareCrossWiFileSyncHandoff(job, conflict, ownerId) {
  if (!job || conflict?.type !== "work_item") return false;
  if (conflict.lock?.lock_kind !== "file") return false;

  const lockPath = normalizeHandoffPath(conflict.lock?.path);
  if (!lockPath || !handoffCandidateCoversPath(conflict.candidate, lockPath)) return false;
  const path = lockPath;

  const sourceWiId = Number(conflict.lock?.work_item_id);
  if (!Number.isFinite(sourceWiId) || sourceWiId === Number(job.work_item_id)) return false;

  const sourceWi = getWorkItem(sourceWiId);
  const sourceBranch = String(sourceWi?.branch_name || "").trim();
  if (!sourceWi || !sourceBranch) return false;

  const mergeOrderCheck = crossWiMergeDependencyWouldCycle(job.work_item_id, sourceWiId);
  if (mergeOrderCheck.wouldCycle) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_BLOCKED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: ownerId,
      message: `Cross-WI handoff skipped for ${path}; merge order would become cyclic`,
      event_json: JSON.stringify({
        source_work_item_id: sourceWiId,
        path,
        reason: mergeOrderCheck.reason,
        merge_order_path: mergeOrderCheck.path,
      }),
    });
    return false;
  }

  const releaseCheck = workItemCanReleaseFileLock(sourceWiId, path, "file");
  if (!releaseCheck.ok) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_BLOCKED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: ownerId,
      message: `Cross-WI handoff skipped for ${path}; WI#${sourceWiId} still has ${releaseCheck.blockers.length} unresolved writer(s)`,
      event_json: JSON.stringify({
        source_work_item_id: sourceWiId,
        path,
        reason: releaseCheck.reason,
        blockers: releaseCheck.blockers.slice(0, 10).map((blocker) => ({
          job_id: blocker.job_id ?? blocker.id ?? null,
          status: blocker.job_status ?? blocker.status ?? null,
          job_type: blocker.job_type ?? null,
          path: blocker.path ?? null,
        })),
      }),
    });
    return false;
  }

  const db = getDb();
  const applyHandoff = () => {
    const currentReleaseCheck = workItemCanReleaseFileLock(sourceWiId, path, "file");
    if (!currentReleaseCheck.ok) {
      return { ok: false, released: 0, reason: currentReleaseCheck.reason };
    }

    const released = releaseWorkItemFileLockForPath(
      sourceWiId,
      path,
      "file",
      `cross_wi_sync_to_wi_${job.work_item_id}_job_${job.id}`,
    );
    if (released <= 0) return { ok: false, released: 0 };

    const dependency = addCrossWiMergeDependency(job.work_item_id, sourceWiId, {
      path,
      source_branch: sourceBranch,
      source_lock_id: conflict.lock?.id ?? null,
      via_job_id: job.id,
    });
    if (!dependency.ok) {
      throw new Error(`Could not record cross-WI merge dependency: ${dependency.reason}`);
    }

    const freshJob = getJob(job.id) || job;
    const payload = parseJobPayload(freshJob);
    const existing = Array.isArray(payload._cross_wi_file_syncs) ? payload._cross_wi_file_syncs : [];
    if (!existing.some((entry) =>
      normalizeHandoffPath(entry?.path) === path
      && Number(entry?.source_work_item_id) === sourceWiId
    )) {
      payload._cross_wi_file_syncs = [
        ...existing,
        {
          path,
          source_work_item_id: sourceWiId,
          source_branch: sourceBranch,
          source_lock_id: conflict.lock?.id ?? null,
          prepared_at: new Date().toISOString(),
        },
      ];
      updateJobPayload(job.id, JSON.stringify(payload));
    }

    return { ok: true, released, dependency };
  };

  let handoff;
  try {
    handoff = db.inTransaction ? applyHandoff() : db.transaction(applyHandoff)();
  } catch (err) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_BLOCKED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: ownerId,
      message: `Cross-WI handoff skipped for ${path}; ${err?.message || err}`,
      event_json: JSON.stringify({
        source_work_item_id: sourceWiId,
        path,
        reason: "handoff_record_failed",
        error: err?.message || String(err),
      }),
    });
    return false;
  }
  if (!handoff.ok) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_BLOCKED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: ownerId,
      message: `Cross-WI handoff skipped for ${path}; ${handoff.reason || "source lock was no longer releasable"}`,
      event_json: JSON.stringify({
        source_work_item_id: sourceWiId,
        path,
        reason: handoff.reason || "lock_release_failed",
      }),
    });
    return false;
  }

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_PREPARED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    actor_id: ownerId,
    message: `Prepared cross-WI sync for ${path} from WI#${sourceWiId}; released idle WI file lock`,
    event_json: JSON.stringify({
      source_work_item_id: sourceWiId,
      source_branch: sourceBranch,
      path,
      released: handoff.released,
      merge_dependency_added: handoff.dependency?.added === true,
    }),
  });
  return true;
}

export class Scheduler {
  constructor(opts = {}) {
    this.ownerId = opts.ownerId || `scheduler-${crypto.randomUUID().slice(0, 8)}`;
    this.projectDir = opts.projectDir || process.cwd();
    this._pollMsExplicit = opts.pollMs != null;
    this._repairPollMsExplicit = opts.repairPollMs != null;
    this._leaseSecExplicit = opts.leaseSec != null;
    this._concurrencyExplicit = opts.concurrency != null;
    this.pollMs = this._pollMsExplicit ? opts.pollMs : readPositiveIntSetting("scheduler_poll_ms", DEFAULT_POLL_MS);
    this.repairPollMs = this._repairPollMsExplicit ? opts.repairPollMs : (this._pollMsExplicit ? this.pollMs : readPositiveIntSetting("scheduler_repair_poll_ms", DEFAULT_REPAIR_POLL_MS));
    this.leaseSec = this._leaseSecExplicit ? opts.leaseSec : readPositiveIntSetting("default_lease_seconds", DEFAULT_LEASE_SEC);
    this.concurrency = this._concurrencyExplicit ? opts.concurrency : readPositiveIntSetting("scheduler_concurrency", DEFAULT_CONCURRENCY);
    this.leaseManager = opts.leaseManager || getLeaseManager({ defaultDurationSec: this.leaseSec });
    this._hasDisplay = !!opts.hasDisplay;
    this._running = false;
    this._lockInterval = null;
    this._stopRunHeartbeat = null;
    this._stopRequested = false;
    this._stopMarked = false;
    this._sleepResolves = new Set(); // for interrupting any pending scheduler sleeps on shutdown
    this._activeRunWorkers = null;
    this._lockLossKillCallback = null;
    this._lockLost = false;
    this._lockLostKilledJobIds = new Set();
    this._reconcileAtlasDriftIfIdle = opts.reconcileAtlasDriftIfIdle || reconcileAtlasDriftIfIdleAsync;
    this._atlasDriftCheckIntervalMs = opts.atlasDriftCheckIntervalMs || null;
    this._atlasDriftReindexFailsafeMs = opts.atlasDriftReindexFailsafeMs || null;
    this._lastSchedulerLockRenewedAt = 0;
    this._lastSchedulerLockStarvedAt = 0;
    this._lockStarvationThresholdMs = opts.lockStarvationThresholdMs || LOCK_RENEW_SEC * 1500;

    // Job-dispatch gate. Holds leasing until the initial (cold) ATLAS index
    // build resolves, so the full index is built pre-flight — before the main
    // loop processes jobs. The loop still polls, renews the lock, requeues
    // expired leases, and runs deadlock detection while held, so the scheduler
    // lock cannot starve. Resolves immediately when the index is already warm
    // (no hold) and on build error (jobs proceed with degraded ATLAS rather
    // than wedging forever). Incremental re-warms during the run are NOT gated.
    this._dispatchReadyResolved = !opts.dispatchReady;
    if (opts.dispatchReady && typeof opts.dispatchReady.then === "function") {
      opts.dispatchReady.then(
        () => { this._dispatchReadyResolved = true; },
        () => { this._dispatchReadyResolved = true; },
      );
    }

    // Queue snapshot emission — pushes a {workItems, jobs, generation, at}
    // snapshot to one subscriber (typically the Display) so consumers don't
    // have to re-query the DB on every render. State-change driven via
    // onQueueStateChanged, with an N-tick safety rebuild so a missed
    // notification can't permanently stale the snapshot.
    this._onQueueSnapshot = typeof opts.onQueueSnapshot === "function" ? opts.onQueueSnapshot : null;
    this._snapshotSafetyEveryTicks = Math.max(
      1,
      Number(opts.snapshotSafetyEveryTicks) || 30,
    );
    this._snapshotTickCounter = 0;
    this._lastEmittedSnapshotGeneration = -1;

    // Cache for _nextQueuedReadyDelayMs — keyed on the queue wake
    // generation so an idle scheduler can skip the MIN(ready_at) scan
    // entirely when nothing in the queue has changed.
    this._nextReadyAtCacheGeneration = -1;
    this._nextReadyAtCacheMs = null;
  }

  /**
   * Build a queue snapshot in a single pair of DB reads. Stamps the result
   * with the current queue wake generation so consumers can dedupe.
   */
  _buildQueueSnapshot() {
    try {
      const generation = getQueueWakeGeneration();
      const workItems = listWorkItems();
      const jobs = listJobs();
      return { generation, workItems, jobs, at: Date.now() };
    } catch (err) {
      this._log?.(`Queue snapshot build failed: ${err.message}`, "yellow");
      return null;
    }
  }

  /**
   * Emit a snapshot to the subscribed consumer. Cheap when generation
   * hasn't changed — only `force: true` (safety rebuild) bypasses the
   * generation check.
   */
  _emitQueueSnapshot({ reason = "state_change", force = false } = {}) {
    if (!this._onQueueSnapshot) return;
    const currentGeneration = getQueueWakeGeneration();
    if (!force && currentGeneration === this._lastEmittedSnapshotGeneration) return;
    const snapshot = this._buildQueueSnapshot();
    if (!snapshot) return;
    this._lastEmittedSnapshotGeneration = snapshot.generation;
    try {
      this._onQueueSnapshot(snapshot, { reason });
    } catch (err) {
      this._log?.(`Queue snapshot subscriber threw: ${err.message}`, "yellow");
    }
  }

  _refreshRuntimeSettings() {
    if (!this._pollMsExplicit) this.pollMs = readPositiveIntSetting("scheduler_poll_ms", DEFAULT_POLL_MS);
    if (!this._repairPollMsExplicit) this.repairPollMs = this._pollMsExplicit
      ? this.pollMs
      : readPositiveIntSetting("scheduler_repair_poll_ms", DEFAULT_REPAIR_POLL_MS);
    if (!this._leaseSecExplicit) this.leaseSec = readPositiveIntSetting("default_lease_seconds", DEFAULT_LEASE_SEC);
    if (!this._concurrencyExplicit) this.concurrency = readPositiveIntSetting("scheduler_concurrency", DEFAULT_CONCURRENCY);
  }

  _wakeSleeps() {
    for (const wake of [...this._sleepResolves]) wake();
  }

  _interruptibleSleep(ms, { requireRunning = false } = {}) {
    return new Promise((resolve) => {
      if (requireRunning && !this._running) {
        resolve();
        return;
      }
      let done = false;
      let timer = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._sleepResolves.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, Math.max(0, Number(ms) || 0));
      this._sleepResolves.add(finish);
    });
  }

  /**
   * Find the next queued job's ready_at timestamp. Result is cached and
   * keyed on the queue wake generation so consecutive idle ticks don't
   * re-run the MIN(ready_at) scan against the jobs table. The cache is
   * invalidated whenever notifyQueueStateChanged bumps the generation
   * (which happens on every job insert/state change), so the cached
   * value is always at least as fresh as the queue itself.
   *
   * Returns ms-until-ready (clamped to >= 0), or null if no queued job
   * has a future ready_at.
   */
  _nextQueuedReadyDelayMs() {
    try {
      const currentGeneration = getQueueWakeGeneration();
      if (
        this._nextReadyAtCacheGeneration === currentGeneration
        && this._nextReadyAtCacheMs != null
      ) {
        // Use the cached absolute ready_at and recompute delta against
        // the current Date.now(). This is the cheap path that idle
        // polls hit when nothing has changed.
        const cachedReadyAtMs = this._nextReadyAtCacheMs;
        if (cachedReadyAtMs === Infinity) return null;
        const delayMs = cachedReadyAtMs - Date.now();
        if (delayMs > 0) return delayMs;
        // The cached job is now due. Re-query below so a due-but-blocked
        // job does not keep returning 0ms forever and spin the idle loop.
      }
      const ts = new Date().toISOString();
      const row = getDb().prepare(`
        SELECT MIN(ready_at) AS ready_at
        FROM jobs
        WHERE status = 'queued'
          AND ready_at IS NOT NULL
          AND ready_at > ?
      `).get(ts);
      this._nextReadyAtCacheGeneration = currentGeneration;
      if (!row?.ready_at) {
        this._nextReadyAtCacheMs = Infinity;
        return null;
      }
      const readyAtMs = Date.parse(row.ready_at);
      if (!Number.isFinite(readyAtMs)) {
        this._nextReadyAtCacheMs = Infinity;
        return null;
      }
      this._nextReadyAtCacheMs = readyAtMs;
      return Math.max(0, readyAtMs - Date.now());
    } catch {
      return null;
    }
  }

  _idleSleepMs() {
    const repairMs = Math.max(1, Number(this.repairPollMs || this.pollMs || DEFAULT_REPAIR_POLL_MS));
    const readyDelayMs = this._nextQueuedReadyDelayMs();
    if (readyDelayMs == null) return repairMs;
    return Math.max(0, Math.min(repairMs, readyDelayMs));
  }

  async _sleepUntilQueueWakeOrRepair(generation) {
    const sleepMs = this._idleSleepMs();
    if (sleepMs <= 0) return { reason: "ready_at" };
    const controller = new AbortController();
    try {
      return await Promise.race([
        waitForQueueStateChangeAfter(generation, { signal: controller.signal }),
        this._interruptibleSleep(sleepMs, { requireRunning: true }).then(() => ({
          reason: this._running ? "repair_timer" : "stopped",
          generation: getQueueWakeGeneration(),
        })),
      ]);
    } finally {
      controller.abort();
    }
  }

  _maybeLogSchedulerLockStarvation(nowMs = Date.now()) {
    if (!this._lastSchedulerLockRenewedAt) return;
    const elapsedMs = nowMs - this._lastSchedulerLockRenewedAt;
    if (elapsedMs <= this._lockStarvationThresholdMs) return;
    if (this._lastSchedulerLockStarvedAt >= this._lastSchedulerLockRenewedAt) return;

    this._lastSchedulerLockStarvedAt = nowMs;
    const message = `Scheduler lock renewal starved for ${Math.ceil(elapsedMs / 1000)}s`;
    this._log(message, "yellow");
    logEvent({
      event_type: EVENT_TYPES.SCHEDULER_LOCK_STARVED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: this.ownerId,
      message,
      event_json: {
        elapsed_ms: elapsedMs,
        threshold_ms: this._lockStarvationThresholdMs,
        lock_renew_sec: LOCK_RENEW_SEC,
      },
    });
  }

  _renewSchedulerLock() {
    if (!this._running) return false;
    const nowMs = Date.now();
    this._maybeLogSchedulerLockStarvation(nowMs);
    let renewed;
    try {
      renewed = renewSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
    } catch (err) {
      // A transient DB error (e.g. SQLITE_BUSY from a concurrent maintenance
      // connection) is NOT lock loss. This runs inside a bare setInterval with
      // no catch, so a throw becomes an uncaughtException → recordFatalCrash →
      // process.exit(1). Keep running and let the next interval retry; the lock
      // is still valid for ~LOCK_RENEW_SEC after the last successful renew. (B2)
      this._log(`Scheduler lock renewal errored (transient — will retry next interval): ${err?.message || err}`, "yellow");
      log.warn("scheduler", "scheduler lock renewal errored (transient)", { error: err?.message || String(err) });
      return true;
    }
    if (!renewed) {
      this._log("Lock stolen by another scheduler - stopping", "red");
      this._lockLost = true;
      this._running = false;
      if (this._lockInterval) {
        clearInterval(this._lockInterval);
        this._lockInterval = null;
      }
      this._abortActiveWorkersForLockLoss();
      this._wakeSleeps();
      return false;
    }
    this._lastSchedulerLockRenewedAt = nowMs;
    return true;
  }

  _abortActiveWorkersForLockLoss() {
    const activeWorkers = this._activeRunWorkers;
    if (!activeWorkers || activeWorkers.size === 0) return;

    const abortedIds = [];
    for (const [jobId, entry] of activeWorkers) {
      if (this._lockLostKilledJobIds.has(jobId)) continue;
      this._lockLostKilledJobIds.add(jobId);
      abortedIds.push(jobId);
      logEvent({
        job_id: jobId,
        work_item_id: entry?.job?.work_item_id || null,
        event_type: EVENT_TYPES.SCHEDULER_LOCK_LOST_WORKER_ABORT,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: this.ownerId,
        message: "Scheduler lock lost; aborting active worker to avoid duplicate execution",
      });
      this._invokeCallback("onKillJob", this._lockLossKillCallback, jobId, "scheduler_lock_lost");
    }

    if (abortedIds.length > 0) {
      this._log(`Lock lost — sent abort to ${abortedIds.length} active worker(s): ${abortedIds.join(", ")}`, "red");
    }
  }

  _startLockRenewal() {
    if (this._lockInterval) return true;
    if (!this._renewSchedulerLock()) return false;
    this._lockInterval = setInterval(() => {
      this._renewSchedulerLock();
    }, LOCK_RENEW_SEC * 1000);
    return true;
  }

  _invokeCallback(name, fn, ...args) {
    if (!fn) return;
    try {
      fn(...args);
    } catch (err) {
      const message = err?.message || String(err);
      this._log(`${name} callback failed: ${message}`, "red");
      log.warn("scheduler", `${name} callback failed`, { error: message });
    }
  }

  /**
   * One tick of the scheduler loop.
   * Returns a leased job or null.
   */
  tick() {
    this._refreshRuntimeSettings();
    // 1. Requeue any expired leases
    const requeued = this.leaseManager.requeueExpired();
    if (requeued > 0) {
      this._log(`Requeued ${requeued} expired lease(s)`);
    }
    const expiredSessionLeases = expireStaleSessionLeases();
    if (expiredSessionLeases > 0) {
      this._log(`Released ${expiredSessionLeases} stale session lease(s)`);
    }

    // 2. Deadlock detection
    this._cancelDeadlockedJobs();

    // 2b. Hold dispatch until the initial (cold) ATLAS index build is ready.
    // The loop above (lock renewal, expired-lease requeue, deadlock checks)
    // keeps running, so holding here cannot starve the scheduler lock.
    if (!this._dispatchReadyResolved) return null;

    // 3. Find next runnable job
    const job = findRunnableJob();
    if (!job) return null;

    // 4. Lease it
    const lease = this.leaseManager.acquireWithLocks(job, this.ownerId, null, this.leaseSec);
    if (!lease) {
      // Race condition: someone else got it
      return null;
    }

    // Return the job with lease info attached
    return { ...job, _leaseToken: lease.leaseToken };
  }

  /**
   * Boot phase only — acquire lock, run orphan recovery, onBeforeLoop hooks,
   * provider health. Returns true on success. Split from runLoop() so the
   * caller can emit boot output to plain stdout before attaching a TUI.
   *
   * @param {object} opts
   * @param {function} opts.onBeforeLoop - called after lock + orphan recovery
   * @param {boolean} opts.onBeforeLoopFatal - return false and release the scheduler lock if the pre-loop hook fails
   * @returns {Promise<boolean>} true if booted, false if lock unavailable
   */
  /**
   * Phase 1 — scheduler lock acquisition. Extracted from boot() so the
   * orchestrator can fire it in parallel with other readiness checks (it has
   * no external dependencies; it only needs the scheduler-lock SQLite row).
   * Mutates this._running and starts lock renewal on success.
   *
   * @param {{ onBootEvent?: ((evt: any) => void) | null }} opts
   * @returns {Promise<boolean>} true if the lock is now held
   */
  async acquireBootLock({ onBootEvent = null } = {}) {
    const emitBootEvent = (label, patch) => {
      if (typeof onBootEvent !== "function") return;
      try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
    };
    this._stopRequested = false;
    this._stopMarked = false;
    this._lockLost = false;
    this._lockLostKilledJobIds.clear();
    // Log every decision so operators can diagnose boot stalls from the event log.
    this._log(`Boot: scheduler=${this.ownerId} lease=${this.leaseSec}s concurrency=${this.concurrency} poll=${this.pollMs}ms repair=${this.repairPollMs}ms`);
    // Reap native-binary daemon children orphaned by a crashed prior session
    // (their ledgers' owner pid is dead). Idempotent + image-verified, so it's
    // safe to run alongside other instances. Deferred OFF the boot critical
    // path: it's best-effort cleanup whose cost scales with the ledger
    // directory (and does synchronous image checks), so it must never gate or
    // slow the scheduler coming up. Runs on the next tick instead.
    setImmediate(() => {
      try {
        const reaped = reapOrphanedDaemons();
        if (reaped.killed || reaped.ledgers) {
          this._log(`Boot: reaped ${reaped.killed} orphaned daemon(s) from ${reaped.ledgers} stale ledger(s)${reaped.skipped ? ` (${reaped.skipped} skipped)` : ""}`);
        }
      } catch { /* the reaper is a safety net, never block boot on it */ }
    });
    recordBootCrashResumeMarker({
      ownerId: this.ownerId,
      lease_sec: this.leaseSec,
      concurrency: this.concurrency,
      poll_ms: this.pollMs,
      repair_poll_ms: this.repairPollMs,
    });
    recordMemorySample("scheduler.boot.start", {
      owner_id: this.ownerId,
      concurrency: this.concurrency,
    });
    emitBootEvent("lock acquired", { section: "scheduler", status: "running" });

    let gotLock = acquireSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
    if (gotLock) {
      this._log("Boot: lock acquired (no contention)");
      recordSchedulerLockDiagnostic({
        owner_id: this.ownerId,
        phase: "acquire",
        decision: "acquired_no_contention",
      });
      emitBootEvent("lock acquired", { section: "scheduler", status: "ok", detail: "no contention" });
    } else {
      const lockInfo = getSchedulerLockInfo("main");
      if (!lockInfo) {
        this._log("Boot: lock acquire failed but no lock row exists — aborting", "red");
        recordSchedulerLockDiagnostic({
          owner_id: this.ownerId,
          phase: "acquire",
          decision: "failed_no_lock_row",
        });
        return false;
      }

      const lockDurationMs = LOCK_RENEW_SEC * 2 * 1000;
      const {
        heartbeatAge,
        expiresIn,
        heartbeatFromExpiresAt,
        heartbeatInvalid,
      } = schedulerLockTiming(lockInfo, lockDurationMs);
      const STALE_THRESHOLD = LOCK_RENEW_SEC * 2 * 1000; // 60s — 2 missed renewals

      this._log(
        `Boot: lock contention — owner=${lockInfo.owner_id} ` +
        `heartbeat_age=${formatSchedulerLockDuration(heartbeatAge)}${heartbeatFromExpiresAt ? " (from expires_at)" : ""}${heartbeatInvalid ? " (invalid)" : ""} ` +
        `expires_in=${formatSchedulerLockDuration(expiresIn)} ` +
        `stale_threshold=${STALE_THRESHOLD / 1000}s`,
        "yellow"
      );
      recordSchedulerLockDiagnostic({
        owner_id: this.ownerId,
        phase: "contention",
        decision: "inspect_existing_lock",
        lockInfo,
        heartbeat_age_ms: heartbeatAge,
        expires_in_ms: expiresIn,
        heartbeat_from_expires_at: heartbeatFromExpiresAt,
        heartbeat_invalid: heartbeatInvalid,
        stale_threshold_ms: STALE_THRESHOLD,
      });

      // IMPORTANT: orphan recovery has NOT run yet. Surface this explicitly
      // so operators know the system is not yet self-healing.
      this._log("Boot: ⚠ orphan recovery and worktree GC have NOT run yet (blocked by lock)", "yellow");

      if (heartbeatAge > STALE_THRESHOLD) {
        // No heartbeat in 2+ renewal cycles — holder crashed. Force-steal immediately.
        this._log(`Boot: decision=FORCE_STEAL (heartbeat stale: ${formatStaleHeartbeatReason(heartbeatAge, STALE_THRESHOLD)})`, "yellow");
        recordSchedulerLockDiagnostic({
          owner_id: this.ownerId,
          phase: "contention",
          decision: "force_steal_stale_heartbeat",
          lockInfo,
          heartbeat_age_ms: heartbeatAge,
          stale_threshold_ms: STALE_THRESHOLD,
        });
        gotLock = forceAcquireSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
        if (!gotLock) {
          this._log("Boot: decision=EXIT (lock heartbeat refreshed before force-steal — holder is alive)", "red");
          recordSchedulerLockDiagnostic({
            owner_id: this.ownerId,
            phase: "contention",
            decision: "exit_heartbeat_refreshed_before_force_steal",
            lockInfo: getSchedulerLockInfo("main"),
          });
          return false;
        }
      } else if (expiresIn <= LOCK_RENEW_SEC * 1000) {
        // Lock expires within one renewal cycle — just wait for it instead of the
        // full heartbeat verification dance. Much faster for post-crash restarts.
        const waitMs = expiresIn + 1000; // 1s buffer
        this._log(`Boot: decision=WAIT_FOR_EXPIRY (lock expires in ${formatSchedulerLockDuration(expiresIn)}, waiting ${formatSchedulerLockDuration(waitMs)})`, "yellow");
        recordSchedulerLockDiagnostic({
          owner_id: this.ownerId,
          phase: "contention",
          decision: "wait_for_expiry",
          lockInfo,
          wait_ms: waitMs,
          expires_in_ms: expiresIn,
        });
        await this._interruptibleSleep(waitMs);
        if (this._stopRequested) return false;
        gotLock = acquireSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
        if (!gotLock) {
          // Lock was renewed — another scheduler is alive
          this._log("Boot: decision=EXIT (lock renewed during wait — another scheduler is alive)", "red");
          recordSchedulerLockDiagnostic({
            owner_id: this.ownerId,
            phase: "contention",
            decision: "exit_lock_renewed_during_expiry_wait",
            lockInfo: getSchedulerLockInfo("main"),
          });
          return false;
        }
        this._log("Boot: lock acquired (expired during wait)");
      } else {
        // Recent heartbeat, lock won't expire soon — another scheduler may be alive.
        // Wait one renewal cycle to confirm it's still renewing.
        const waitMs = (LOCK_RENEW_SEC + 5) * 1000; // 35s
        this._log(`Boot: decision=VERIFY_LIVENESS (waiting ${Math.ceil(waitMs / 1000)}s for heartbeat change)`, "yellow");
        this._log("Boot: ⚠ startup blocked — workers idle until lock resolved", "red");
        recordSchedulerLockDiagnostic({
          owner_id: this.ownerId,
          phase: "contention",
          decision: "verify_liveness",
          lockInfo,
          wait_ms: waitMs,
          heartbeat_age_ms: heartbeatAge,
          expires_in_ms: expiresIn,
        });
        await this._interruptibleSleep(waitMs);
        if (this._stopRequested) return false;

        // Re-check heartbeat after waiting
        gotLock = acquireSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
        if (gotLock) {
          this._log("Boot: lock acquired (expired during wait)");
        } else {
          const updated = getSchedulerLockInfo("main");
          if (!updated) {
            gotLock = acquireSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
            this._log(gotLock ? "Boot: lock acquired (vanished, then claimed)" : "Boot: lock still unavailable", gotLock ? "yellow" : "red");
          } else {
            // Did the holder's heartbeat advance during our wait? Compare
            // acquired_at timestamps — a live scheduler renews on every
            // LOCK_RENEW_SEC tick, so after a full wait cycle the timestamp
            // must have changed. Checking age alone is wrong: a lock acquired
            // just before a crash has low initial age, and adding the wait
            // duration may not cross STALE_THRESHOLD in one pass.
            const { heartbeatAge: newAge } = schedulerLockTiming(updated, LOCK_RENEW_SEC * 2 * 1000);
            const heartbeatAdvanced = updated.acquired_at !== lockInfo.acquired_at;
            this._log(`Boot: post-wait heartbeat_age=${formatSchedulerLockDuration(newAge)} (was ${formatSchedulerLockDuration(heartbeatAge)}) advanced=${heartbeatAdvanced}`);
            if (!heartbeatAdvanced) {
              this._log(`Boot: decision=FORCE_STEAL (heartbeat did not advance during wait — holder confirmed dead)`, "yellow");
              recordSchedulerLockDiagnostic({
                owner_id: this.ownerId,
                phase: "contention",
                decision: "force_steal_heartbeat_did_not_advance",
                lockInfo: updated,
                previous_heartbeat_age_ms: heartbeatAge,
                heartbeat_age_ms: newAge,
              });
              gotLock = forceAcquireSchedulerLock("main", this.ownerId, LOCK_RENEW_SEC * 2);
              if (!gotLock) {
                this._log("Boot: decision=EXIT (lock heartbeat refreshed before force-steal — holder revived)", "red");
                recordSchedulerLockDiagnostic({
                  owner_id: this.ownerId,
                  phase: "contention",
                  decision: "exit_holder_revived_before_force_steal",
                  lockInfo: getSchedulerLockInfo("main"),
                });
                return false;
              }
            } else {
              this._log(`Boot: decision=EXIT (heartbeat advanced — scheduler ${updated.owner_id} is alive)`, "red");
              recordSchedulerLockDiagnostic({
                owner_id: this.ownerId,
                phase: "contention",
                decision: "exit_heartbeat_advanced",
                lockInfo: updated,
                previous_heartbeat_age_ms: heartbeatAge,
                heartbeat_age_ms: newAge,
              });
              return false;
            }
          }
        }
      }
    }

    if (!gotLock) {
      this._log("Boot: could not acquire scheduler lock — aborting", "red");
      recordSchedulerLockDiagnostic({
        owner_id: this.ownerId,
        phase: "acquire",
        decision: "failed",
        lockInfo: getSchedulerLockInfo("main"),
      });
      return false;
    }
    recordSchedulerLockDiagnostic({
      owner_id: this.ownerId,
      phase: "acquire",
      decision: "held",
      lockInfo: getSchedulerLockInfo("main"),
    });

    // Some contention paths acquire the lock after waiting/stealing rather
    // than through the no-contention branch above. Always publish a terminal
    // event once we know the lock is held so the boot panel cannot leave the
    // row spinning for the rest of a long ATLAS warm.
    emitBootEvent("lock acquired", { section: "scheduler", status: "ok", detail: "held" });

    this._running = true;
    if (!this._startLockRenewal()) return false;
    return true;
  }

  /**
   * Phase 2 — orphan recovery + stale lock cleanup. Requires the scheduler
   * lock to be held (acquireBootLock() returned true). Safe to call from the
   * orchestrator after worktree cleanup so requeued jobs land on validated
   * worktree state.
   *
   * @param {{ onBootEvent?: ((evt: any) => void) | null }} opts
   * @returns {Promise<{orphaned: number, reconciledAttempts: number, staleLocks: Record<string,number>, awaitingAssessmentCount: number} | null>}
   */
  async recoverOrphans({ onBootEvent = null } = {}) {
    const emitBootEvent = (label, patch) => {
      if (typeof onBootEvent !== "function") return;
      try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
    };
    this._log("Boot: running orphan recovery...");
    emitBootEvent("orphan recovery", { section: "scheduler", status: "running" });
    await yieldNow();

    // Force-requeue every held job: we hold the scheduler lock, so any leased/
    // running/awaiting_assessment row belongs to a previous (now dead) process.
    // Without force, jobs killed by Ctrl+C stay locked until their 120s lease
    // expires naturally — preventing the user from rejoining work on restart.
    //
    // This SQLite maintenance is intentionally run in a worker thread. The DB
    // library is synchronous, so doing this on the parent event loop can freeze
    // boot indicators, signal handling, and scheduler-lock renewal.
    const bootMaintenance = await runSchedulerBootMaintenanceInWorker();
    const orphaned = Number(bootMaintenance?.orphaned || 0);
    if (orphaned > 0) {
      this._log(`Boot: recovered ${orphaned} orphaned job(s) from previous run`);
    }
    emitBootEvent("orphan recovery", {
      section: "scheduler",
      status: "ok",
      detail: orphaned > 0 ? `recovered ${orphaned}` : "",
    });

    const reconciledAttempts = Number(bootMaintenance?.reconciledAttempts || 0);
    if (reconciledAttempts > 0) {
      this._log(`Boot: reconciled ${reconciledAttempts} orphaned running attempt(s)`);
    }

    const staleLocks = bootMaintenance?.staleLocks || {};
    if (staleLocks.job_locks_released > 0 || staleLocks.wi_locks_released > 0) {
      this._log(`Boot: released ${staleLocks.job_locks_released} stale job lock(s), ${staleLocks.wi_locks_released} stale WI lock(s)`);
    }
    const staleSessionLeases = Number(bootMaintenance?.staleSessionLeases || 0);
    if (staleSessionLeases > 0) {
      this._log(`Boot: released ${staleSessionLeases} stale session lease(s)`);
    }

    // Log any jobs stuck in awaiting_assessment — these look like "running" in the
    // UI but no worker is executing them. Helps diagnose "looks active but idle" states.
    const assessingJobs = Number(bootMaintenance?.awaitingAssessmentCount || 0);
    if (assessingJobs > 0) {
      this._log(`Boot: ${assessingJobs} job(s) in awaiting_assessment — will be requeued by orphan pass`, "yellow");
    }
    return {
      orphaned,
      reconciledAttempts,
      staleLocks,
      awaitingAssessmentCount: assessingJobs,
    };
  }

  /**
   * Thin orchestrator wrapper around acquireBootLock() + recoverOrphans()
   * preserving the original boot() signature. New callers should drive the
   * DAG explicitly (see run-session.js) and call acquireBootLock /
   * recoverOrphans individually so worktree cleanup can interleave between
   * them.
   */
  /**
   * Phase 4a — workspace health probe. Lock-gated by convention (the
   * orchestrator only runs it once the lock is held) but the probe itself is
   * off-event-loop (workspaceHealthProbeAsync). Emits the `workspace health`
   * row start→terminal.
   *
   * @param {{ onBootEvent?: ((evt: any) => void) | null }} opts
   * @returns {Promise<any>} the workspace-health probe result
   */
  async probeWorkspaceHealth({ onBootEvent = null } = {}) {
    const emitBootEvent = (label, patch) => {
      if (typeof onBootEvent !== "function") return;
      try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
    };
    emitBootEvent("workspace health", { section: "workspace", status: "running" });
    const workspaceHealth = await workspaceHealthProbeAsync(this.projectDir);
    const workspaceHealthTag = workspaceHealth.status === "critical" ? "red" : workspaceHealth.status === "warning" ? "yellow" : "green";
    this._log(`Boot: workspace health: ${formatWorkspaceHealthProbe(workspaceHealth)}`, workspaceHealthTag);
    // A "warning" is a COMPLETED, non-blocking check (stale locks, recovered
    // worktree backlog, low-ish disk) — render it as a clear ✓ done, not the
    // yellow "/" deferred glyph that reads like a spinner mid-spin (which made
    // workspace health look like it never finished). The advisory detail is
    // still logged above + persisted via logEvent below; only a genuinely
    // critical result fails the row.
    emitBootEvent("workspace health", {
      section: "workspace",
      status: workspaceHealth.status === "critical" ? "failed" : "ok",
      detail: workspaceHealth.status === "critical" ? (workspaceHealth.summary || "critical") : "",
    });
    try {
      logEvent({
        event_type: EVENT_TYPES.SYSTEM_PREFLIGHT_PROBE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Workspace health: ${workspaceHealth.status}`,
        event_json: JSON.stringify(workspaceHealth),
      });
    } catch {
      // Best-effort boot telemetry.
    }
    return workspaceHealth;
  }

  /**
   * Phase 4b — per-provider auth liveness. Reads liveness WITHOUT priming
   * (primeAuth:false): the caller is expected to have already run the async
   * provider-auth prime (e.g. the `provider auth` boot node, or runHealthChecks
   * below). Emits per-provider chips so the panel renders `✓ claude  ✓ openai
   * / codex` rather than one rolled-up row.
   *
   * @param {{ onBootEvent?: ((evt: any) => void) | null }} opts
   * @returns {Promise<any>} the provider-liveness probe result
   */
  async probeProviderLiveness({ onBootEvent = null } = {}) {
    const emitBootEvent = (label, patch) => {
      if (typeof onBootEvent !== "function") return;
      try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
    };
    const providerLiveness = providerAuthLivenessProbe({ projectDir: this.projectDir, primeAuth: false });
    this._log(`Boot: provider auth liveness: ${formatProviderAuthLivenessProbe(providerLiveness)}`, providerLiveness.ok ? "green" : "yellow");
    for (const h of providerLiveness.providers) {
      const tag = h.status === "available" ? "green" : h.status === "unavailable" ? "red" : "yellow";
      const detail = h.detail ? ` (${h.detail})` : "";
      this._log(`Boot: ${h.provider}: ${h.status}${detail}`, tag);
      const providerStatus = h.status === "available" ? "ok"
        : h.status === "unavailable" ? "failed"
        : "deferred";
      emitBootEvent(String(h.provider || "").toLowerCase(), {
        section: "providers",
        status: providerStatus,
        detail: h.detail || "",
      });
    }
    return providerLiveness;
  }

  /**
   * Phase 4 — workspace health + provider liveness. Thin wrapper that primes
   * provider auth (off the event loop) then composes the two split probes.
   * Retained so the legacy `boot()` orchestrator and existing tests keep a
   * single entry point; new callers should drive the two probes individually
   * (the `provider auth` node owns priming).
   *
   * @param {{ onBootEvent?: ((evt: any) => void) | null }} opts
   * @returns {Promise<{ workspaceHealth: any, providerLiveness: any }>}
   */
  async runHealthChecks({ onBootEvent = null } = {}) {
    const workspaceHealth = await this.probeWorkspaceHealth({ onBootEvent });
    // Prime provider auth on the ASYNC path so the Claude OAuth warm runs off
    // the event loop, then read liveness WITHOUT re-priming.
    try {
      await primeProviderUsageAuthAsync({ cwd: this.projectDir });
    } catch { /* prime failure is non-fatal; the liveness read still proceeds */ }
    const providerLiveness = await this.probeProviderLiveness({ onBootEvent });
    return { workspaceHealth, providerLiveness };
  }

  /**
   * Phase 5 — log the boot-complete line. Final node in the boot DAG.
   *
   * @param {{ onBootEvent?: ((evt: any) => void) | null }} opts
   */
  markBootComplete({ onBootEvent = null } = {}) {
    const emitBootEvent = (label, patch) => {
      if (typeof onBootEvent !== "function") return;
      try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
    };
    this._log("Boot: complete — entering main loop");
    emitBootEvent("boot complete", { section: "scheduler", status: "ok", detail: "entering main loop" });
    log.info("scheduler", "Boot complete", { concurrency: this.concurrency, pollMs: this.pollMs, leaseSec: this.leaseSec });
  }

  async boot({ onBeforeLoop, onBeforeLoopFatal = false, onBootEvent = null } = {}) {
    const emitBootEvent = (label, patch) => {
      if (typeof onBootEvent !== "function") return;
      try { onBootEvent({ label, ...patch }); } catch { /* observational */ }
    };
    if (!(await this.acquireBootLock({ onBootEvent }))) return false;
    // ── BOOT PHASES 2 & 3 in parallel ───────────────────────────────────────
    // Orphan recovery touches the orchestrator DB (jobs / job_attempts /
    // *_locks). Pre-loop hooks (provider warmups, ATLAS warmup) touch the
    // network and .posse/atlas/* files. Disjoint storage, no write contention
    // — so they race instead of serializing. This is what unblocks the
    // per-language indexers from waiting on orphan recovery to finish.
    /** @type {Error | null} */
    let preLoopErr = null;
    const recoverP = this.recoverOrphans({ onBootEvent }).catch((err) => {
      this._log(`Boot: orphan recovery failed: ${err?.message || err}`, "red");
      throw err;
    });
    const preLoopP = (async () => {
      if (!onBeforeLoop) return;
      this._log("Boot: running pre-loop hooks...");
      emitBootEvent("pre-loop hooks", { section: "scheduler", status: "running" });
      try {
        await onBeforeLoop();
        emitBootEvent("pre-loop hooks", { section: "scheduler", status: "ok" });
      } catch (err) {
        this._log(`Boot: onBeforeLoop failed: ${err.message}`, "yellow");
        emitBootEvent("pre-loop hooks", { section: "scheduler", status: "failed", detail: err.message });
        if (onBeforeLoopFatal) preLoopErr = err;
      }
    })();
    // Outer boot timeout — last-resort wedge backstop. Per-step soft timeouts
    // (bootWarmup softTimeoutMs, internal worker timeouts) handle ordinary
    // slow paths. This 45-min race ceiling only fires if ALL of those failed
    // to arm — e.g. a sync DB lock that froze the event loop before any
    // timer could be registered. Boot fails loudly instead of hanging forever.
    const SCHEDULER_BOOT_OUTER_TIMEOUT_MS = 45 * 60 * 1000;
    /** @type {NodeJS.Timeout | null} */
    let bootTimeoutTimer = null;
    const bootRace = Promise.race([
      Promise.all([recoverP, preLoopP]),
      new Promise((_, reject) => {
        bootTimeoutTimer = setTimeout(() => {
          const err = new Error(`Scheduler boot exceeded outer ${SCHEDULER_BOOT_OUTER_TIMEOUT_MS / 60000}min timeout — a step is wedged`);
          /** @type {any} */ (err).code = "SCHEDULER_BOOT_TIMEOUT";
          reject(err);
        }, SCHEDULER_BOOT_OUTER_TIMEOUT_MS);
        bootTimeoutTimer?.unref?.();
      }),
    ]);
    try {
      await bootRace;
    } catch (err) {
      if (bootTimeoutTimer) clearTimeout(bootTimeoutTimer);
      if (/** @type {any} */ (err)?.code === "SCHEDULER_BOOT_TIMEOUT") {
        this._log(`Boot: ${err.message}`, "red");
        emitBootEvent("pre-loop hooks", { section: "scheduler", status: "failed", detail: err.message });
        log.warn("scheduler", "Scheduler boot outer timeout fired", { timeoutMs: SCHEDULER_BOOT_OUTER_TIMEOUT_MS });
        this.stop();
        return false;
      }
      throw err;
    }
    if (bootTimeoutTimer) clearTimeout(bootTimeoutTimer);
    if (preLoopErr) {
      this._log("Boot: decision=EXIT (fatal pre-loop hook failed)", "red");
      this.stop();
      return false;
    }
    if (this._stopRequested) {
      this._log("Boot: decision=EXIT (stop requested during pre-loop hooks)", "yellow");
      return false;
    }
    await this.runHealthChecks({ onBootEvent });
    this.markBootComplete({ onBootEvent });
    return true;
  }

  /**
   * Thin wrapper preserving the original start() signature. Runs boot()
   * followed by runLoop(). Returns early if boot fails.
   */
  async start(workerCallback, opts = {}) {
    const ok = await this.boot({ onBeforeLoop: opts.onBeforeLoop, onBeforeLoopFatal: opts.onBeforeLoopFatal });
    if (!ok) return;
    await this.runLoop(workerCallback, opts);
  }

  /**
   * Main scheduling loop. Requires boot() to have already run successfully
   * (scheduler lock held, orphan recovery complete, providers checked).
   *
   * @param {function} workerCallback - async job executor
   * @param {object} opts
   */
  async runLoop(workerCallback, { onIdle, onDone, onJobStart, onJobEnd, onSlotStatus, onKillJob } = {}) {
    // boot() starts renewal immediately after lock acquisition so long
    // pre-loop hooks cannot let the scheduler lock expire.
    if (!this._running) {
      const message = "Scheduler runLoop called before successful boot()";
      this._log(message, "red");
      logEvent({
        event_type: EVENT_TYPES.SCHEDULER_RUN_LOOP_NOT_BOOTED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: this.ownerId,
        message,
      });
      throw new Error(message);
    }
    if (!this._startLockRenewal()) {
      const message = "Scheduler runLoop could not renew scheduler lock";
      this._log(message, "red");
      logEvent({
        event_type: EVENT_TYPES.SCHEDULER_LOCK_RENEWAL_FAILED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: this.ownerId,
        message,
      });
      throw new Error(message);
    }

    logEvent({
      event_type: EVENT_TYPES.SCHEDULER_STARTED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: this.ownerId,
      message: `Scheduler started (poll=${this.pollMs}ms, repair=${this.repairPollMs}ms, lease=${this.leaseSec}s, concurrency=${this.concurrency})`,
    });

    const activeWorkers = new Map(); // jobId -> { promise, job, startTime }
    const queueLockIndex = createHeldQueueLockIndex();
    const unsubscribeQueueWake = onQueueStateChanged((payload) => {
      queueLockIndex.applyWake(payload, { readJob: getJob });
      // Re-emit the queue snapshot whenever real state changes. The
      // generation guard inside _emitQueueSnapshot suppresses duplicate
      // emissions if multiple listeners fire for the same wake.
      this._emitQueueSnapshot({ reason: payload?.reason || "state_change" });
    });
    // Initial snapshot so the consumer starts with a populated view
    // instead of waiting for the first wake event.
    this._emitQueueSnapshot({ reason: "scheduler_start", force: true });
    this._activeRunWorkers = activeWorkers;
    this._lockLossKillCallback = onKillJob || null;
    this._lockLost = false;
    this._lockLostKilledJobIds.clear();
    this._stopRunHeartbeat = startRunHeartbeat({
      ownerId: this.ownerId,
      activeWorkersProvider: () => activeWorkers,
    });
    recordRunDiagnostic("scheduler.run_loop_started", {
      owner_id: this.ownerId,
      concurrency: this.concurrency,
      poll_ms: this.pollMs,
      repair_poll_ms: this.repairPollMs,
      lease_sec: this.leaseSec,
    });
    let atlasDriftReindexInFlight = false;
    let atlasDriftReindexStartedAt = 0;
    let atlasDriftReindexChild = null;
    let atlasDriftReindexDisabledUntilRestart = false;
    const killedForRuntime = new Set(); // jobIds already killed by runtime watchdog

    // Plan 12(c): periodic ATLAS-drift reconciliation. Flag-gated via the
    // DB-backed atlas_drift_check setting. Cheap no-op when disabled or when
    // HEAD matches the indexed commit. Skips reindex while workers are busy.
    let lastAtlasDriftCheck = Date.now();

    // Periodic stale file-lock sweep. cleanupStaleFileLocks runs once at boot
    // and otherwise only when LeaseManager.acquireWithLocks hits a conflict. A
    // hung worker whose lease is requeued by the scheduler still leaves the
    // older lock rows in place if no conflict surfaces them — over time the
    // table grows. A 60s sweep keeps it bounded without measurable overhead.
    let lastStaleLockSweep = Date.now();
    const STALE_LOCK_SWEEP_MS = 60_000;

    try {
      let idleCount = 0;
      let lastProgressTime = Date.now(); // progress watchdog
      const headlessNonHumanWaitingLogged = new Set();
      const headlessOrphanedReviewParkedLogged = new Set();

      while (this._running) {
        try {
        const lapStartQueueGeneration = getQueueWakeGeneration();
        this._refreshRuntimeSettings();
        // Read once per tick: the candidate scan below can touch ~100 jobs
        // per lap, and each readBoolSetting call is a synchronous DB read.
        const shadowConflictMetricsEnabled = readBoolSetting("scheduler_shadow_conflict_metrics", true);

        // Periodic safety-rebuild of the queue snapshot. State-change
        // emission is the primary path; this catches the rare case where
        // a mutation forgot to call notifyQueueStateChanged or where the
        // subscriber missed an event. Cheap when there are no consumers.
        this._snapshotTickCounter += 1;
        if (
          this._onQueueSnapshot
          && this._snapshotTickCounter >= this._snapshotSafetyEveryTicks
        ) {
          this._snapshotTickCounter = 0;
          this._emitQueueSnapshot({ reason: "safety_rebuild", force: true });
        }

        // Housekeeping tick (requeue, deadlock detection) — always run
        // but only lease if we have capacity
        const requeued = this.leaseManager.requeueExpired();
        if (requeued > 0) this._log(`Requeued ${requeued} expired lease(s)`);
        const expiredSessionLeases = expireStaleSessionLeases();
        if (expiredSessionLeases > 0) this._log(`Released ${expiredSessionLeases} stale session lease(s)`);

        if (Date.now() - lastStaleLockSweep > STALE_LOCK_SWEEP_MS) {
          lastStaleLockSweep = Date.now();
          try {
            const swept = cleanupStaleFileLocks();
            if (swept.job_locks_released > 0 || swept.wi_locks_released > 0) {
              this._log(`Released ${swept.job_locks_released} stale job lock(s), ${swept.wi_locks_released} stale WI lock(s)`);
            }
          } catch (sweepErr) {
            this._log(`Stale lock sweep failed: ${sweepErr.message}`, "yellow");
          }
        }

        const retention = maybeRunRuntimeRetention();
        if (retention.attempted && retention.ok && retention.totalDeleted > 0) {
          this._log(`Runtime retention pruned ${retention.totalDeleted} old DB row(s)`);
        } else if (retention.attempted && retention.ok === false) {
          this._log(`Runtime retention failed: ${retention.error}`, "yellow");
        }

        // Heartbeat + queue-depth mirror for bridge instance_status (max
        // 1/10s; one GROUP BY over jobs — cheap). Read by the serve process.
        if (Date.now() - (this._lastRuntimeStatusWriteAt || 0) > 10_000) {
          this._lastRuntimeStatusWriteAt = Date.now();
          try {
            const counts = countJobsByStatus();
            writeRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER, {
              active_workers: activeWorkers.size,
              running_jobs:
                (counts.running || 0) + (counts.leased || 0) + (counts.awaiting_assessment || 0),
              queued_jobs: counts.queued || 0,
              owner_id: this.ownerId,
            });
          } catch { /* status telemetry is best-effort */ }
        }

        // Keep the remote model catalog fresh. TTL-gated internally (24h
        // default + failure backoff) and fully async — never blocks the loop.
        maybeRefreshModelCatalog()
          .then((refresh) => {
            if (!refresh?.attempted || !refresh.ok) return;
            for (const warning of refresh.staleWarnings || []) {
              this._log(`Model catalog: ${describeModelCatalogWarning(warning)}`, "yellow");
            }
          })
          .catch(() => { /* best-effort */ });

        // Expire fanout children stuck in `queued` past timeout so synthesis
        // can run with N-1 branches instead of blocking forever on one stuck
        // branch. Throttled internally; safe to call every tick.
        const fanoutSweep = maybeExpireStuckFanoutChildren();
        if (fanoutSweep.attempted && fanoutSweep.ok && fanoutSweep.expired > 0) {
          this._log(`Fanout timeout sweep expired ${fanoutSweep.expired} stuck child(ren) so synthesis can proceed`);
        } else if (fanoutSweep.attempted && fanoutSweep.ok === false) {
          this._log(`Fanout timeout sweep failed: ${fanoutSweep.error}`, "yellow");
        }

        // Headless human_input timeout: if no display is available, waiting_on_human
        // jobs will sit forever. After the configured headless human timeout, fail them and
        // recover the chain so dependents don't get deadlock-canceled.
        if (!this._hasDisplay && hasJobs(["waiting_on_human"])) {
          const stuckHuman = listJobs(["waiting_on_human"]);
          for (const hj of stuckHuman) {
            // Push-offer gates wait indefinitely for the phone/CLI by
            // design — never time them out, headless or not.
            if (isPushOfferJob(hj)) continue;
            if (hj.job_type !== "human_input") {
              if (!headlessNonHumanWaitingLogged.has(hj.id)) {
                headlessNonHumanWaitingLogged.add(hj.id);
                this._log(`WI#${hj.work_item_id} job #${hj.id} is waiting_on_human with type ${hj.job_type}; leaving parked in headless mode`, "yellow");
                logEvent({
                  work_item_id: hj.work_item_id,
                  job_id: hj.id,
                  event_type: EVENT_TYPES.JOB_HEADLESS_NON_HUMAN_WAITING_ON_HUMAN,
                  actor_type: EVENT_ACTORS.SCHEDULER,
                  actor_id: this.ownerId,
                  message: `Non-human job type ${hj.job_type} is waiting_on_human in headless mode; scheduler left it parked`,
                });
              }
              continue;
            }
            const age = (Date.now() - new Date(hj.updated_at).getTime()) / 1000;
            if (age > readHeadlessHumanTimeoutSec()) {
              this._log(`WI#${hj.work_item_id} job #${hj.id} stuck in waiting_on_human for ${Math.ceil(age)}s — recovering (headless timeout)`, "yellow");
              let humanPayload = {};

              // 1. If this human_input was unblocking an original job, do NOT
              //    auto-requeue the original job in headless mode. Re-running a
              //    task that already needs human input/review just creates a loop
              //    (run -> review gate -> timeout -> run again). Leave the
              //    original job parked and fail only the timed-out human_input.
              try {
                humanPayload = parseJobPayload(hj);
                if (humanPayload.original_job_id) {
                  const origJob = getJob(humanPayload.original_job_id);
                  if (origJob && ["waiting_on_review", "waiting_on_human", "blocked"].includes(origJob.status)) {
                    logEvent({
                      work_item_id: hj.work_item_id,
                      job_id: origJob.id,
                      event_type: EVENT_TYPES.JOB_HEADLESS_RECOVERY,
                      actor_type: EVENT_ACTORS.SCHEDULER,
                      message: `Left parked in ${origJob.status} after human_input #${hj.id} timed out in headless mode`,
                    });
                    this._log(`  → left original job #${origJob.id} parked in ${origJob.status}`, "yellow");
                  }
                }
              } catch (err) {
                this._log(`  -> headless recovery lookup failed for human_input #${hj.id}: ${err?.message || String(err)}`, "red");
              }

              // 2. Rewire dependents of this human_input job so they don't get
              //    deadlock-canceled. Create a skip marker so the chain can continue.
              const dependents = getDependents(hj.id);
              const affectedWorkItemIds = new Set([hj.work_item_id]);
              if (dependents.length > 0) {
                const isApprovalGate = Array.isArray(humanPayload.file_requests) && humanPayload.file_requests.length > 0;
                if (isApprovalGate) {
                  let canceled = 0;
                  for (const dep of dependents) {
                    const depJob = getJob(dep.job_id);
                    if (!depJob) continue;
                    if (depJob.work_item_id) affectedWorkItemIds.add(depJob.work_item_id);
                    if (TERMINAL_JOB_STATUSES.includes(depJob.status)) continue;
                    updateJobStatus(depJob.id, "canceled");
                    canceled++;
                    logEvent({
                      work_item_id: depJob.work_item_id,
                      job_id: depJob.id,
                      event_type: EVENT_TYPES.JOB_HEADLESS_APPROVAL_CANCELED,
                      actor_type: EVENT_ACTORS.SCHEDULER,
                      message: `Canceled dependent job after approval gate #${hj.id} timed out in headless mode`,
                    });
                  }
                  if (canceled > 0) {
                    this._log(`  → canceled ${canceled} dependent(s) waiting on timed-out approval gate #${hj.id}`, "yellow");
                  }
                } else {
                  for (const dep of dependents) {
                    const depJob = getJob(dep.job_id);
                    if (depJob?.work_item_id) affectedWorkItemIds.add(depJob.work_item_id);
                    // Remove the hard dep on the timed-out human job so the
                    // dependent becomes runnable again (its other deps may be met).
                    try {
                      removeDependency(dep.job_id, hj.id, {
                        actorType: "scheduler",
                        actorId: this.ownerId,
                        message: `Removed dependency on timed-out human_input #${hj.id} in headless recovery`,
                      });
                    } catch (err) {
                      this._log(`  -> failed to remove dependency ${dep.job_id}->${hj.id}: ${err?.message || String(err)}`, "red");
                    }
                  }
                  this._log(`  → unwired ${dependents.length} dependent(s) from timed-out human_input #${hj.id}`, "yellow");
                }
              }

              // 3. Now fail the human_input job itself.
              updateJobStatus(hj.id, "failed");
              logEvent({
                work_item_id: hj.work_item_id,
                job_id: hj.id,
                event_type: EVENT_TYPES.JOB_HEADLESS_TIMEOUT,
                actor_type: EVENT_ACTORS.SCHEDULER,
                message: `Human input job timed out after ${Math.ceil(age)}s in headless mode`,
              });
              for (const workItemId of affectedWorkItemIds) {
                refreshWorkItemStatus(workItemId);
              }
            }
          }
        }

        // Also check for orphaned waiting_on_review jobs whose human_input
        // child has already failed/timed out — these are permanent traps.
        if (hasJobs(["waiting_on_review"])) {
          const stuckReview = listJobs(["waiting_on_review"]);
          for (const rj of stuckReview) {
            // A waiting_on_review job should have a human_input child keeping it alive.
            // If all human_input children are terminal-failed, the review job is orphaned.
            const children = listJobsByWorkItem(rj.work_item_id).filter(j =>
              j.parent_job_id === rj.id && j.job_type === "human_input"
            );
            const allChildrenDead = children.length > 0 && children.every(j =>
              DEADLOCK_TERMINAL_STATUSES.includes(j.status)
            );
            // Grace period: don't requeue during transient failures — the child
            // may be retrying. Wait at least 30s after the review job was parked.
            const reviewAge = (Date.now() - new Date(rj.updated_at).getTime()) / 1000;
            if (allChildrenDead && reviewAge > 30) {
              if (!this._hasDisplay) {
                if (!headlessOrphanedReviewParkedLogged.has(rj.id)) {
                  headlessOrphanedReviewParkedLogged.add(rj.id);
                  this._log(`WI#${rj.work_item_id} job #${rj.id} review remains parked in headless mode (all review children terminal)`, "yellow");
                  logEvent({
                    work_item_id: rj.work_item_id,
                    job_id: rj.id,
                    event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_PARKED,
                    actor_type: EVENT_ACTORS.SCHEDULER,
                    message: `Left in waiting_on_review in headless mode — all human_input children are terminal`,
                  });
                }
              } else {
                this._log(`WI#${rj.work_item_id} job #${rj.id} orphaned in waiting_on_review (all review children failed) — requeuing`, "yellow");
                updateJobStatus(rj.id, "queued");
                logEvent({
                  work_item_id: rj.work_item_id,
                  job_id: rj.id,
                  event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_RECOVERY,
                  actor_type: EVENT_ACTORS.SCHEDULER,
                  message: `Requeued from waiting_on_review — all human_input children are terminal`,
                });
                refreshWorkItemStatus(rj.work_item_id);
              }
            }
          }
        }

        this._cancelDeadlockedJobs();

        const atlasDriftReindexFailsafeMs = this._atlasDriftReindexFailsafeMs
          || Math.max(15 * 60 * 1000, (this._atlasDriftCheckIntervalMs || readAtlasDriftCheckIntervalMs()) * 2);
        if (
          atlasDriftReindexInFlight &&
          atlasDriftReindexStartedAt > 0 &&
          Date.now() - atlasDriftReindexStartedAt > atlasDriftReindexFailsafeMs
        ) {
          let killResult = null;
          let forceKillScheduled = false;
          if (atlasDriftReindexChild && typeof atlasDriftReindexChild.kill === "function") {
            const childForForceKill = atlasDriftReindexChild;
            killResult = terminateSchedulerChild(childForForceKill, { force: false });
            forceKillScheduled = true;
            setTimeout(() => {
              const forced = terminateSchedulerChild(childForForceKill, { force: true });
              if (forced) {
                log.warn("atlas", "Forced ATLAS drift reindex child shutdown after failsafe grace", {
                  pid: childForForceKill?.pid || null,
                });
              }
            }, 3000).unref?.();
          }
          atlasDriftReindexDisabledUntilRestart = true;
          log.warn("atlas", "Drift reindex did not report completion before failsafe; requested child shutdown and disabled drift reindex until restart", {
            inFlightMs: Date.now() - atlasDriftReindexStartedAt,
            failsafeMs: atlasDriftReindexFailsafeMs,
            pid: atlasDriftReindexChild?.pid || null,
            killResult,
            forceKillScheduled,
            disabledUntilRestart: true,
          });
          atlasDriftReindexInFlight = false;
          atlasDriftReindexStartedAt = 0;
          atlasDriftReindexChild = null;
        }

        if (atlasDriftReindexInFlight && activeWorkers.size === 0) {
          this._invokeCallback("onSlotStatus", onSlotStatus, {
            idle: this.concurrency,
            blockedByLock: 0,
            blockedLockDetails: [{ message: "ATLAS drift reindex is running" }],
          });
          await this._interruptibleSleep(this.pollMs, { requireRunning: true });
          continue;
        }

        // Try to fill worker slots
        // File-level conflict detection: repo/worktree queue-locking jobs are
        // blocked if their file scope overlaps with any active queue-locking job.
        // Scope = files_to_modify + files_to_create (exact) + create_roots (directory prefixes).
        // Jobs with no scope are treated as unknown and serialize against active
        // repo mutations because we cannot reason about their commit surface.
        let { lockedFiles, lockedRoots, activeWorktreeWIs, heldLocks } = queueLockIndex.snapshot();
        const activeAtlasWarmKeys = new Set();
        for (const entry of activeWorkers.values()) {
          const key = atlasWarmConcurrencyKey(entry?.job);
          if (key) activeAtlasWarmKeys.add(key);
        }
        const activeWorktreeCap = readActiveWorktreeCap();

        const skipJobIds = new Set();
        let launched = false;
        // human_input jobs just wait for user I/O — don't count them against concurrency
        let computeWorkerCount = [...activeWorkers.values()].filter(e => e.job.job_type !== "human_input").length;

        // Batched lookahead keeps each query bounded while allowing the
        // scheduler to scan past a blocked head-of-queue batch.
        const scanExcludeJobIds = new Set();
        const maxCandidateScan = MAX_RUNNABLE_SCAN_PER_TICK * 4;
        let candidateCount = 0;
        let stopCandidateScan = false;
        const blockedLockDetails = [];
        const rememberBlockedLock = (detail) => {
          if (!detail) return;
          if (blockedLockDetails.some((entry) =>
            entry.job_id === detail.job_id
            && entry.path === detail.path
            && entry.holder_type === detail.holder_type
            && entry.holder_id === detail.holder_id)) return;
          blockedLockDetails.push(detail);
        };
        while (!stopCandidateScan && candidateCount < maxCandidateScan) {
          const fetchLimit = Math.min(MAX_RUNNABLE_SCAN_PER_TICK, maxCandidateScan - candidateCount);
          const scanHumanOnly = computeWorkerCount >= this.concurrency;
          const candidates = findRunnableJobsBatch(fetchLimit, {
            excludeJobIds: [...scanExcludeJobIds],
            onlyJobTypes: scanHumanOnly ? ["human_input"] : [],
          });
          if (candidates.length === 0) break;

          for (const job of candidates) {
            candidateCount++;
            scanExcludeJobIds.add(job.id);
            if (activeWorkers.has(job.id)) {
              skipJobIds.add(job.id);
              continue;
            }
            let strictShadowOverlaps = [];
            const warmKey = atlasWarmConcurrencyKey(job);
            if (warmKey && activeAtlasWarmKeys.has(warmKey)) {
              rememberBlockedLock({
                job_id: job.id,
                work_item_id: job.work_item_id,
                holder_type: "atlas_warm",
                holder_id: null,
                path: warmKey,
                message: `#${job.id} waits for existing ATLAS warm on ${warmKey}`,
              });
              skipJobIds.add(job.id);
              continue;
            }
            // Enforce concurrency for compute jobs; human_input always passes through
            // since they only wait for user I/O and don't consume CPU/memory.
            if (job.job_type !== "human_input") {
              if (computeWorkerCount >= this.concurrency) {
                // All compute slots are full. The next outer scan switches to a
                // human_input-only query so human gates surface even behind a long
                // compute tail.
                skipJobIds.add(job.id);
                break;
              }
            }

            // File-level conflict check for repo/worktree queue-locking jobs.
            if (QUEUE_LOCKING_JOB_TYPES.has(job.job_type)) {
              // Optional activation cap: when enabled, a new WI worktree can only
              // start if there is a free worktree slot. This is a scheduler
              // predicate, not a worker-side counter, so skipped jobs do not lease
              // and the scan can still find other runnable work.
              if (WORKTREE_TYPES.has(job.job_type)
                && activeWorktreeCap != null
                && activeWorktreeWIs.size >= activeWorktreeCap
                && !activeWorktreeWIs.has(job.work_item_id)) {
                rememberBlockedLock({
                  job_id: job.id,
                  work_item_id: job.work_item_id,
                  holder_type: "worktree_cap",
                  holder_id: null,
                  path: `active_worktrees/${activeWorktreeWIs.size}/${activeWorktreeCap}`,
                  message: `#${job.id} waits for a worktree slot (${activeWorktreeWIs.size}/${activeWorktreeCap} active)`,
                });
                skipJobIds.add(job.id);
                continue;
              }
              // Cross-WI conflict check: file scope overlap. Write paths are
              // cached in queueLockIndex and updated by queue-state wakeups.
              const jobScope = queueLockIndex.scopeForJob(job);
              // Allow ancestors + queued cohort siblings (same parent_job_id) so
              // sibling fix jobs spawned from one assessment don't phantom-lock
              // each other into deadlock. Cohort siblings serialize via hard
              // deps; the allowance only covers queued-status siblings.
              const allowJobIds = new Set([
                ...ancestorJobIdsForJob(job),
                ...queuedCohortJobIdsForJob(job),
              ]);
              if (jobScope.files.length > 0 || jobScope.createRoots.length > 0) {
                const conflict = findFileConflict(jobScope, heldLocks, { allowJobIds });
                if (conflict) {
                  const conflictType = conflict.lock?.lock_tier === "work_item" ? "work_item" : "job";
                  if (conflictType === "work_item" && prepareCrossWiFileSyncHandoff(job, { type: "work_item", ...conflict }, this.ownerId)) {
                    ({ lockedFiles, lockedRoots, activeWorktreeWIs, heldLocks } = queueLockIndex.snapshot());
                  } else {
                  const conflictPath = conflict.candidate?.path || conflict.lock?.path || jobScope.files[0] || jobScope.createRoots[0] || "unknown";
                  rememberBlockedLock({
                    job_id: job.id,
                    work_item_id: job.work_item_id,
                    holder_type: conflictType,
                    holder_id: conflict.lock?.job_id || null,
                    holder_work_item_id: conflict.lock?.work_item_id || null,
                    path: conflictPath,
                    message: conflictType === "work_item"
                      ? `#${job.id} waits on ${conflictPath}; held by WI#${conflict.lock?.work_item_id}`
                      : `#${job.id} waits on ${conflictPath}; held by job #${conflict.lock?.job_id}`,
                  });
                  skipJobIds.add(job.id);
                  continue;
                  }
                }
                if (shadowConflictMetricsEnabled) {
                  strictShadowOverlaps = collectStrictOnlyRootConflicts(jobScope, lockedRoots);
                }
              } else if (lockedFiles.size > 0 || lockedRoots.size > 0) {
                // Empty scope on a queue-locking job means "we don't know what it
                // will touch." Serialize it against held repo mutations.
                const unknownScopeConflict = findFileConflict({
                  files: [],
                  createRoots: ["*"],
                  workItemId: job.work_item_id,
                  jobId: job.id,
                }, heldLocks, { allowJobIds });
                if (unknownScopeConflict) {
                  rememberBlockedLock({
                    job_id: job.id,
                    work_item_id: job.work_item_id,
                    holder_type: "active_worker",
                    holder_id: unknownScopeConflict.lock?.job_id || unknownScopeConflict.lock?.work_item_id || null,
                    holder_work_item_id: unknownScopeConflict.lock?.work_item_id || null,
                    path: "*",
                    message: `#${job.id} waits on unknown write scope; held by active work in this run`,
                  });
                  skipJobIds.add(job.id);
                  continue;
                }
              }
            }

          const leaseScope = QUEUE_LOCKING_JOB_TYPES.has(job.job_type)
            ? queueLockIndex.scopeForJob(job)
            : null;
          let lease = this.leaseManager.acquireWithLocks(job, this.ownerId, leaseScope, this.leaseSec, { skipConflictCheck: true });
          if (!lease) {
            skipJobIds.add(job.id);
            continue;
          } // race, try next

          if (strictShadowOverlaps.length > 0) {
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              event_type: EVENT_TYPES.SCHEDULER_SCOPE_WOULD_HAVE_CONFLICTED,
              actor_type: EVENT_ACTORS.SCHEDULER,
              message: `Relaxed root overlap allowed; strict mode would block (${strictShadowOverlaps.length} overlap${strictShadowOverlaps.length === 1 ? "" : "s"})`,
              event_json: JSON.stringify({
                overlaps: strictShadowOverlaps.slice(0, 8),
                overlap_count: strictShadowOverlaps.length,
              }),
            });
          }

          // Track file scope AFTER successful lease — prevents polluting
          // the lock set when lease acquisition fails (race with another scheduler).
          if (QUEUE_LOCKING_JOB_TYPES.has(job.job_type)) {
            queueLockIndex.addLeasedJob({ ...job, status: "leased" });
            ({ lockedFiles, lockedRoots, activeWorktreeWIs, heldLocks } = queueLockIndex.snapshot());
          }

          const leasedJob = { ...(getJob(job.id) || job), _leaseToken: lease.leaseToken, _leaseAcquiredAtMs: Date.now() };
          if (warmKey) activeAtlasWarmKeys.add(warmKey);
          launched = true;
          idleCount = 0;
          lastProgressTime = Date.now();

          this._invokeCallback("onJobStart", onJobStart, leasedJob);

          const workerPromise = workerCallback(leasedJob)
            .catch((err) => {
              this._log(`WI#${job.work_item_id} worker error on job #${job.id}: ${err.message}`, "red");
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                event_type: EVENT_TYPES.SCHEDULER_WORKER_ERROR,
                actor_type: EVENT_ACTORS.SCHEDULER,
                message: err.message,
              });
              const retryAt = new Date(Date.now() + 1000).toISOString();
              const released = this.leaseManager.releaseWithoutAttemptPenalty(
                { jobId: leasedJob.id, token: leasedJob._leaseToken || lease.leaseToken },
                "queued",
                { readyAt: retryAt },
              );
              if (released) {
                this._log(`WI#${job.work_item_id} worker error on job #${job.id}: released lease and requeued`, "yellow");
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  event_type: EVENT_TYPES.SCHEDULER_WORKER_ERROR,
                  actor_type: EVENT_ACTORS.SCHEDULER,
                  message: `Worker promise rejected; released lease and requeued: ${err.message}`,
                });
              }
            })
            .finally(() => {
              if (activeWorkers.get(job.id)?.promise === workerPromise) {
                activeWorkers.delete(job.id);
                killedForRuntime.delete(job.id);
              }
              lastProgressTime = Date.now(); // job completion counts as progress
              this._invokeCallback("onJobEnd", onJobEnd, leasedJob);
              this._wakeSleeps();
            });

          activeWorkers.set(job.id, { promise: workerPromise, job: leasedJob, startTime: Date.now() });
          if (job.job_type !== "human_input") computeWorkerCount++;
          if (computeWorkerCount >= this.concurrency) {
            await yieldNow();
          }
        }
          if (candidates.length < fetchLimit) break;
        }

        // Report idle slot breakdown to display
        const openSlots = this.concurrency - computeWorkerCount;
        const blockedByLock = Math.min(blockedLockDetails.length, openSlots);
        this._invokeCallback("onSlotStatus", onSlotStatus, {
          idle: openSlots - blockedByLock,
          blockedByLock,
          blockedLockDetails: blockedLockDetails.slice(0, 5),
        });

        if (!launched && activeWorkers.size === 0) {
          // Nothing running and nothing to start — fold the 3 hasJobs probes +
          // the runnableNow re-query into one GROUP BY snapshot plus the batch
          // result we already have in hand.
          const trackedStatuses = ["queued", ...LOCK_HOLDING_JOB_STATUSES];
          const statusCounts = countJobsByStatus();
          const anyTracked = trackedStatuses.some((s) => (statusCounts[s] || 0) > 0);
          if (!anyTracked) {
            this._invokeCallback("onDone", onDone);
            break;
          }

          // candidateCount tracks findRunnableJob's rules (queued + ready_at
          // + hard deps met). Non-zero here means we saw eligible jobs, but
          // all were blocked by concurrency or file-scope conflict.
          const runnableNow = candidateCount > 0;
          const hasActive =
            (statusCounts.leased || 0) > 0
            || (statusCounts.running || 0) > 0
            || (statusCounts.awaiting_assessment || 0) > 0
            || (statusCounts.waiting_on_human || 0) > 0
            || (statusCounts.waiting_on_review || 0) > 0;
          const hasQueued = (statusCounts.queued || 0) > 0;
          const canProgress = runnableNow || hasActive || hasQueued;
          if (!canProgress) {
            this._invokeCallback("onDone", onDone);
            break;
          }

          idleCount++;
          if (onIdle && idleCount === 1) {
            this._invokeCallback("onIdle", onIdle, listJobs(trackedStatuses));
          }
        }

        // ── Max job runtime watchdog ──
        // Kill workers that exceed their role runtime cap — the job is likely stuck
        // (producing output so the stall detector doesn't fire, but making no real
        // progress). Requeue with consumed attempt so model tier escalates.
        if (onKillJob) {
          const now = Date.now();
          for (const [jobId, entry] of activeWorkers) {
            if (entry.job.job_type === "human_input") continue;
            if (killedForRuntime.has(jobId)) continue; // already killed, waiting for cleanup
            const runtimeSec = (now - entry.startTime) / 1000;
            const runtimeLimitSec = maxJobRuntimeSecFor(entry.job);
            if (runtimeSec > runtimeLimitSec) {
              killedForRuntime.add(jobId);
              this._log(`WI#${entry.job.work_item_id} job #${jobId} exceeded max runtime (${Math.ceil(runtimeSec)}s > ${runtimeLimitSec}s) — killing for escalation`, "red");
              logEvent({
                job_id: jobId,
                work_item_id: entry.job.work_item_id,
                event_type: EVENT_TYPES.JOB_RUNTIME_EXCEEDED,
                actor_type: EVENT_ACTORS.SCHEDULER,
                actor_id: this.ownerId,
                message: `Job exceeded max runtime (${Math.ceil(runtimeSec)}s > ${runtimeLimitSec}s) — killing for model escalation`,
              });
              this._invokeCallback("onKillJob", onKillJob, jobId, "runtime_exceeded");
            }
          }
        }

        // Progress watchdog — detect soft-deadlocks where jobs exist but none progress.
        // Workers completing jobs also counts as progress (they remove from activeWorkers,
        // allowing the next tick to dispatch and reset lastProgressTime).
        const progressAge = (Date.now() - lastProgressTime) / 1000;
        if (progressAge > PROGRESS_TIMEOUT_SEC && !launched && activeWorkers.size === 0) {
          const queuedJobs = listJobs(["queued"]);
          if (queuedJobs.length > 0) {
            this._log(`No progress in ${Math.ceil(progressAge)}s with ${queuedJobs.length} queued job(s) — running extended deadlock detection`, "red");
            this._cancelDeadlockedJobs();
            // Reset timer so we don't spam warnings every tick
            lastProgressTime = Date.now();
            logEvent({
              event_type: EVENT_TYPES.SCHEDULER_NO_PROGRESS,
              actor_type: EVENT_ACTORS.SCHEDULER,
              actor_id: this.ownerId,
              message: `No progress in ${Math.ceil(progressAge)}s. ${queuedJobs.length} queued, ${activeWorkers.size} active, ${skipJobIds.size} skipped (file conflicts)`,
            });
          }
        }

        // Plan 12(c): periodic ATLAS-drift reconciliation. Runs in a try/catch
        // so a transient git or fs error never crashes the scheduler loop.
        const atlasDriftCheckIntervalMs = this._atlasDriftCheckIntervalMs || readAtlasDriftCheckIntervalMs();
        if (!atlasDriftReindexDisabledUntilRestart && Date.now() - lastAtlasDriftCheck >= atlasDriftCheckIntervalMs) {
          lastAtlasDriftCheck = Date.now();
          try {
            let statusReportedSynchronously = false;
            const outcome = await this._reconcileAtlasDriftIfIdle({
              cwd: process.cwd(),
              isWorkerIdle: () => activeWorkers.size === 0,
              onStatus: ({ ok, error, repoId }) => {
                statusReportedSynchronously = true;
                atlasDriftReindexInFlight = false;
                atlasDriftReindexStartedAt = 0;
                atlasDriftReindexChild = null;
                log[ok ? "info" : "warn"]("atlas", ok ? "Drift reindex complete" : "Drift reindex failed", {
                  repoId: repoId || null, error: error || null,
                });
              },
            });
            const reindexChild = outcome.reindex?.child || outcome.child || null;
            if (outcome.attempted && reindexChild && !statusReportedSynchronously) {
              atlasDriftReindexInFlight = true;
              atlasDriftReindexStartedAt = Date.now();
              atlasDriftReindexChild = reindexChild;
              this._log(`ATLAS drift reindex started (HEAD ${String(outcome.head || "").slice(0, 8)} != ${String(outcome.lastIndexed || "").slice(0, 8)})`);
            } else if (outcome.skipped === "workers_busy") {
              log.debug("atlas", "Drift reindex deferred", { head: outcome.head, lastIndexed: outcome.lastIndexed });
            }
          } catch (err) {
            log.warn("atlas", "Drift reconciliation errored", { error: err?.message || String(err) });
          }
        }

        if (launched) {
          await yieldNow();
          continue;
        }

        const lapEndQueueGeneration = getQueueWakeGeneration();
        if (lapEndQueueGeneration !== lapStartQueueGeneration) {
          await yieldNow();
          continue;
        }

        const sleepResult = await this._sleepUntilQueueWakeOrRepair(lapEndQueueGeneration);
        // Repair-timer ticks are our defense-in-depth path: if a wake was
        // dropped (listener exception, deferred-emit flush skipped, etc.)
        // the index can drift. Reconciling against the DB on every idle
        // timeout is cheap and bounds drift to one repair interval.
        if (sleepResult?.reason === "repair_timer") {
          queueLockIndex.refreshJobScopesFromDb();
          queueLockIndex.refreshFromDb();
        }
        } catch (loopErr) {
          const msg = loopErr?.stack || loopErr?.message || String(loopErr);
          this._log(`Scheduler loop tick failed: ${msg.split("\n")[0]}`, "yellow");
          logEvent({
            event_type: EVENT_TYPES.SCHEDULER_LOOP_ERROR,
            actor_type: EVENT_ACTORS.SCHEDULER,
            actor_id: this.ownerId,
            message: msg.slice(0, 2000),
          });
          await this._interruptibleSleep(Math.min(this.pollMs || 1000, 1000), { requireRunning: true });
        }
      }

      // Wait for any still-running workers to finish (with timeout)
      if (activeWorkers.size > 0) {
        this._log(`Waiting for ${activeWorkers.size} worker(s) to finish (15s timeout)...`);
        const workersDone = Promise.all([...activeWorkers.values()].map((w) => w.promise));
        let shutdownTimer = null;
        const timeout = new Promise((r) => { shutdownTimer = setTimeout(r, 15000); });
        try {
          await Promise.race([workersDone, timeout]);
        } finally {
          if (shutdownTimer) clearTimeout(shutdownTimer);
        }
        if (activeWorkers.size > 0 && this._lockLost) {
          const abandonedIds = [...activeWorkers.keys()];
          this._log(`${activeWorkers.size} worker(s) still running after scheduler lock loss — not requeueing from stale owner. Jobs: ${abandonedIds.join(", ")}`, "red");
          logEvent({
            event_type: EVENT_TYPES.SCHEDULER_WORKERS_LEFT_AFTER_LOCK_LOSS,
            actor_type: EVENT_ACTORS.SCHEDULER,
            actor_id: this.ownerId,
            message: `Lock loss shutdown left ${activeWorkers.size} worker(s) running; stale owner did not requeue. Jobs: ${abandonedIds.join(", ")}`,
          });
        } else if (activeWorkers.size > 0) {
          // Signal workers to abort BEFORE requeueing. Otherwise a worker that
          // is still mid-call when we flip its job back to `queued` may keep
          // writing state (commit, completeAttempt) on a job another scheduler
          // can now lease. Reuse the lock-loss kill path — onKillJob is the
          // same callback the lock-loss and runtime-exceeded watchdogs use.
          if (onKillJob) {
            for (const [jobId] of activeWorkers) {
              try { this._invokeCallback("onKillJob", onKillJob, jobId, "shutdown"); } catch { /* best-effort */ }
            }
          }
          let requeued = 0;
          const abandonedIds = [];
          for (const [jobId] of activeWorkers) {
            abandonedIds.push(jobId);
            if (requeueForShutdown(jobId)) requeued++;
          }
          this._log(`${activeWorkers.size} worker(s) still running \u2014 requeued ${requeued} (attempts not counted). Jobs: ${abandonedIds.join(", ")}`);
          logEvent({
            event_type: EVENT_TYPES.SCHEDULER_WORKERS_ABANDONED,
            actor_type: EVENT_ACTORS.SCHEDULER,
            actor_id: this.ownerId,
            message: `Shutdown timeout: ${activeWorkers.size} worker(s) abandoned and requeued. Jobs: ${abandonedIds.join(", ")}`,
          });
        }
      }

    } finally {
      unsubscribeQueueWake();
      const shutdownReason = this._lockLost ? "lock_lost" : (this._stopRequested ? "stop_requested" : "run_loop_exit");
      this.stop({ activeWorkers, reason: shutdownReason });
      this._activeRunWorkers = null;
      this._lockLossKillCallback = null;
      this._lockLostKilledJobIds.clear();
    }
  }

  /**
   * Ask the scheduler loop to stop without doing database cleanup inline.
   */
  requestStop() {
    this._stopRequested = true;
    this._running = false;
    // Interrupt the poll sleep so the loop exits immediately
    this._wakeSleeps();
    if (this._lockInterval) {
      clearInterval(this._lockInterval);
      this._lockInterval = null;
    }
  }

  /**
   * Stop the scheduler loop and release the lock.
   */
  stop({ activeWorkers = this._activeRunWorkers, reason = "scheduler_stop" } = {}) {
    if (this._stopMarked) {
      this.requestStop();
      return;
    }
    this._stopMarked = true;
    this.requestStop();
    if (this._stopRunHeartbeat) {
      const stopHeartbeat = this._stopRunHeartbeat;
      this._stopRunHeartbeat = null;
      try { stopHeartbeat(reason); } catch { /* observational */ }
    }
    try {
      recordSchedulerShutdownMarker({
        ownerId: this.ownerId,
        reason,
        activeWorkers,
      });
    } catch { /* observational */ }
    releaseSchedulerLock("main", this.ownerId);

    logEvent({
      event_type: EVENT_TYPES.SCHEDULER_STOPPED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: this.ownerId,
      message: "Scheduler stopped",
    });
  }

  /**
   * Check if the scheduler is currently running.
   */
  get running() {
    return this._running;
  }

  /**
   * Cancel jobs whose hard dependencies are all in terminal-failed states.
   * Single source of truth for deadlock detection — called from start() loop.
   */
  _cancelDeadlockedJobs() {
    const { canceled, affectedWorkItemIds } = cancelDeadlockedJobsAtomic(this.ownerId);
    for (const job of canceled) {
      const depInfo = job.failed_deps ? ` (blocked by: ${job.failed_deps})` : "";
      this._log(`WI#${job.work_item_id} deadlocked job #${job.id}: ${job.title} → canceled${depInfo}`, "red");
    }
    for (const wiId of affectedWorkItemIds) {
      refreshWorkItemStatus(wiId);
    }
  }

  _log(msg, color = "yellow") {
    if (this._onEvent) this._onEvent(msg, color);
    else console.log(`  ${C[color] || ""}[scheduler] ${msg}${C.reset}`);
  }

  /**
   * Optional: set an event handler for display integration.
   * When set, scheduler messages go to this callback instead of console.
   */
  set onEvent(fn) {
    this._onEvent = fn;
  }

  get onEvent() {
    return this._onEvent;
  }
}

export function __testCollectStrictOnlyRootConflicts(jobScope, lockedRoots = new Set()) {
  return collectStrictOnlyRootConflicts(jobScope, lockedRoots);
}

export function __testMaxJobRuntimeSecFor(job) {
  return maxJobRuntimeSecFor(job);
}
