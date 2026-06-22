import { TERMINAL_JOB_STATUSES, WORKTREE_JOB_TYPES } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { listActiveFileLocks } from "../../queue/functions/index.js";
import { QUEUE_LOCKING_JOB_TYPES } from "../../../catalog/job.js";
import { parseFileScope, scopeToSchedulerLocks } from "../functions/file-scope.js";

const WORKTREE_TYPES = WORKTREE_JOB_TYPES;
const ROOT_LOCKING_JOB_TYPES = WORKTREE_JOB_TYPES;
const QUEUED_REPAIR_LOCK_JOB_TYPES = new Set(["fix", "promote"]);
const TERMINAL_JOB_STATUSES_SET = new Set(TERMINAL_JOB_STATUSES);
const LOCK_HOLDING_STATUSES = new Set([
  "leased",
  "running",
  "awaiting_assessment",
  "waiting_on_human",
  "waiting_on_review",
  "blocked",
]);

// Aggregate queue mutations (orphan sweep, expired-lease sweep, deadlock
// cancel) emit a single wake without a specific jobId / workItemId. The
// in-memory index has no way to selectively reconcile those changes, so it
// drops back to a full DB rescan.
const FULL_REFRESH_WAKE_REASONS = new Set([
  "job_orphan_requeue",
  "job_lease_expired",
  "job_deadlocked_canceled",
  "stale_file_locks_released",
]);

function jobContributesQueueLock(job = {}) {
  if (!job || !QUEUE_LOCKING_JOB_TYPES.has(job.job_type)) return false;
  if (LOCK_HOLDING_STATUSES.has(job.status)) return true;
  if (job.status === "queued") {
    return QUEUED_REPAIR_LOCK_JOB_TYPES.has(job.job_type)
      || Number(job.attempt_count || 0) > 0;
  }
  return false;
}

function lockRowsForJob(job = {}) {
  if (!jobContributesQueueLock(job)) return [];
  const scope = job._schedulerWriteScope || parseFileScope(job);
  const rows = (scope.files.length === 0 && scope.createRoots.length === 0)
    ? [{
      path: "*",
      lock_kind: "root",
      work_item_id: job.work_item_id,
      job_id: job.id,
      job_type: job.job_type,
      job_status: job.status,
    }]
    : scopeToSchedulerLocks(scope, job).map((lock) => ({
      ...lock,
      job_type: job.job_type,
      job_status: job.status,
    }));
  return rows.map((row) => ({ ...row, lock_tier: "job" }));
}

function workItemLockRowsForJob(job = {}, scope = null) {
  if (!job || !QUEUE_LOCKING_JOB_TYPES.has(job.job_type)) return [];
  const jobScope = scope || job._schedulerWriteScope || parseFileScope(job);
  const rows = (jobScope.files.length === 0 && jobScope.createRoots.length === 0)
    ? [{
      path: "*",
      lock_kind: "root",
      work_item_id: job.work_item_id,
      source_job_id: job.id,
      job_id: job.id,
      job_type: job.job_type,
      job_status: job.status,
    }]
    : scopeToSchedulerLocks(jobScope, job).map((lock) => ({
      ...lock,
      source_job_id: job.id,
      job_id: job.id,
      job_type: job.job_type,
      job_status: job.status,
    }));
  return rows.map((row) => ({ ...row, lock_tier: "work_item" }));
}

function loadQueueLockingJobs() {
  const types = [...QUEUE_LOCKING_JOB_TYPES];
  if (types.length === 0) return [];
  const terminal = [...TERMINAL_JOB_STATUSES_SET];
  return getDb().prepare(`
    SELECT id, work_item_id, parent_job_id, job_type, status, payload_json, attempt_count, created_at, updated_at, started_at
    FROM jobs
    WHERE job_type IN (${types.map(() => "?").join(",")})
      AND status NOT IN (${terminal.map(() => "?").join(",")})
  `).all(...types, ...terminal);
}

function normalizeDbLock(lock = {}) {
  if (lock.lock_tier === "work_item") {
    return {
      ...lock,
      lock_tier: "work_item",
      job_id: lock.source_job_id ?? lock.job_id ?? null,
      job_type: lock.source_job_type || lock.job_type || null,
    };
  }
  return { ...lock, lock_tier: "job" };
}

function lockKey(lock = {}) {
  const tier = lock.lock_tier || "job";
  const holder = lock.job_id != null
    ? `job:${lock.job_id}`
    : `wi:${lock.work_item_id ?? "?"}:lock:${lock.id ?? `${lock.acquired_at ?? "?"}:${lock.source_job_id ?? "?"}`}`;
  return `${tier}:${holder}:${lock.lock_kind}:${lock.path}`;
}

export class HeldQueueLockIndex {
  constructor({ loadActiveLocks = listActiveFileLocks, loadJobs = loadQueueLockingJobs } = {}) {
    this._loadActiveLocks = loadActiveLocks;
    this._loadJobs = loadJobs;
    this._jobLocks = new Map();
    this._workItemLocks = new Map();
    this._jobScopes = new Map();
    this.refreshFromDb();
  }

  refreshFromDb() {
    this._jobLocks.clear();
    this._workItemLocks.clear();
    this._jobScopes.clear();
    const jobs = this._loadJobs() || [];
    for (const job of jobs) this.cacheJob(job);
    const activeLocks = this._loadActiveLocks();
    for (const lock of activeLocks.work_items || []) this.addWorkItemLock(normalizeDbLock({ ...lock, lock_tier: "work_item" }));
    for (const lock of activeLocks.jobs || []) this.addJobLock(normalizeDbLock({ ...lock, lock_tier: "job" }));
    // Repair-eligible queued jobs (fix / promote, or a dev with attempt_count>0)
    // hold no DB lock rows - their locks were released on requeue - but they
    // must still appear in the index so concurrent scans serialize against
    // their intended scope.
    for (const job of jobs) {
      if (job?.status === "queued" && jobContributesQueueLock(job)) this.addJob(job);
    }
  }

  addJobLock(lock) {
    if (!lock?.path || !lock?.lock_kind) return;
    this._jobLocks.set(lockKey({ ...lock, lock_tier: "job" }), { ...lock, lock_tier: "job" });
  }

  addWorkItemLock(lock) {
    if (!lock?.path || !lock?.lock_kind) return;
    this._workItemLocks.set(lockKey({ ...lock, lock_tier: "work_item" }), { ...lock, lock_tier: "work_item" });
  }

  addJob(job) {
    const scope = this.scopeForJob(job);
    for (const lock of lockRowsForJob({ ...job, _schedulerWriteScope: scope })) this.addJobLock(lock);
  }

  addWorkItemLocksForJob(job) {
    const scope = this.scopeForJob(job);
    for (const lock of workItemLockRowsForJob(job, scope)) this.addWorkItemLock(lock);
  }

  addLeasedJob(job) {
    const leasedJob = { ...job, status: "leased" };
    this.addJob(leasedJob);
    this.addWorkItemLocksForJob(leasedJob);
  }

  cacheJob(job = {}) {
    if (!job?.id || !QUEUE_LOCKING_JOB_TYPES.has(job.job_type)) return null;
    if (TERMINAL_JOB_STATUSES_SET.has(job.status)) {
      this._jobScopes.delete(Number(job.id));
      return null;
    }
    const parsed = parseFileScope(job);
    const scope = parsed.files.length === 0 && parsed.createRoots.length === 0
      ? { ...parsed, createRoots: ["*"] }
      : parsed;
    this._jobScopes.set(Number(job.id), scope);
    return scope;
  }

  removeJobScope(jobId) {
    if (jobId == null) return;
    this._jobScopes.delete(Number(jobId));
  }

  scopeForJob(job = {}) {
    const id = Number(job?.id);
    if (Number.isInteger(id) && this._jobScopes.has(id)) return this._jobScopes.get(id);
    return this.cacheJob(job) || parseFileScope(job);
  }

  removeJob(jobId) {
    if (jobId == null) return;
    const id = Number(jobId);
    for (const [key, lock] of this._jobLocks) {
      if (Number(lock?.job_id) === id) {
        this._jobLocks.delete(key);
      }
    }
  }

  removeWorkItem(workItemId) {
    if (workItemId == null) return;
    const id = Number(workItemId);
    for (const [key, lock] of this._workItemLocks) {
      if (Number(lock?.work_item_id) === id) {
        this._workItemLocks.delete(key);
      }
    }
  }

  removeWorkItemLocksForSourceJob(jobId) {
    if (jobId == null) return;
    const id = Number(jobId);
    for (const [key, lock] of this._workItemLocks) {
      if (Number(lock?.source_job_id ?? lock?.job_id) === id) {
        this._workItemLocks.delete(key);
      }
    }
  }

  removeWorkItemLockForPath(workItemId, path, lockKind = null) {
    if (workItemId == null || !path) return;
    const wiId = Number(workItemId);
    for (const [key, lock] of this._workItemLocks) {
      if (Number(lock?.work_item_id) !== wiId) continue;
      if (lock.path !== path) continue;
      if (lockKind != null && lock.lock_kind !== lockKind) continue;
      this._workItemLocks.delete(key);
    }
  }

  removeJobLocksForWorkItem(workItemId) {
    if (workItemId == null) return;
    const wiId = Number(workItemId);
    for (const [key, lock] of this._jobLocks) {
      if (Number(lock?.work_item_id) === wiId) {
        this._jobLocks.delete(key);
      }
    }
  }

  reconcileJob(jobId, readJob) {
    if (jobId == null || typeof readJob !== "function") return;
    this.removeJob(jobId);
    const job = readJob(jobId);
    this.cacheJob(job);
    if (jobContributesQueueLock(job)) {
      this.addJob(job);
      // Re-add work-item lock rows when the job is in a status that actually
      // holds DB-side WI locks. Without this, an out-of-band transition into
      // a leased / running / parked status leaves the index missing the WI
      // tier until the next full refresh.
      if (LOCK_HOLDING_STATUSES.has(job?.status)) {
        this.removeWorkItemLocksForSourceJob(jobId);
        this.addWorkItemLocksForJob(job);
      }
    }
  }

  applyWake(payload = {}, { readJob = null } = {}) {
    const reason = String(payload.reason || "");
    if (payload.jobId != null) {
      const jobStatus = reason.startsWith("job_status_") ? reason.slice("job_status_".length) : null;
      const leaseStatus = reason.startsWith("lease_released_") ? reason.slice("lease_released_".length) : null;
      if (
        reason === "job_created"
        || reason === "job_payload_updated"
        || reason === "job_shutdown_requeue"
        || jobStatus === "queued"
        || leaseStatus === "queued"
      ) {
        this.reconcileJob(payload.jobId, readJob);
      } else if (
        reason.startsWith("job_locks_released:")
        || TERMINAL_JOB_STATUSES_SET.has(jobStatus)
        || TERMINAL_JOB_STATUSES_SET.has(leaseStatus)
      ) {
        this.removeJob(payload.jobId);
        this.removeJobScope(payload.jobId);
      } else if (leaseStatus) {
        this.reconcileJob(payload.jobId, readJob);
      } else if (reason.startsWith("job_status_")) {
        this.reconcileJob(payload.jobId, readJob);
      } else if (reason.startsWith("work_item_locks_released:")) {
        this.removeWorkItemLocksForSourceJob(payload.jobId);
      }
    }
    if (
      payload.workItemId != null
      && (
        reason.startsWith("work_item_locks_released:")
        || reason === "work_item_rejected"
      )
    ) {
      this.removeWorkItem(payload.workItemId);
    }
    if (payload.workItemId != null && reason.startsWith("work_item_lock_released:")) {
      this.removeWorkItemLockForPath(payload.workItemId, payload.path, payload.lockKind);
    }
    if (FULL_REFRESH_WAKE_REASONS.has(reason)) {
      this.refreshFromDb();
    }
  }

  snapshot() {
    const lockedFiles = new Set();
    const lockedRoots = new Set();
    const activeWorktreeWIs = new Set();
    const heldLocks = [...this._workItemLocks.values(), ...this._jobLocks.values()];
    for (const lock of heldLocks) {
      if (lock.lock_tier === "job" && WORKTREE_TYPES.has(lock.job_type)) activeWorktreeWIs.add(lock.work_item_id);
      if (lock.lock_kind === "file") lockedFiles.add(lock.path);
      if (ROOT_LOCKING_JOB_TYPES.has(lock.job_type) && lock.lock_kind === "root") lockedRoots.add(lock.path);
    }
    return { lockedFiles, lockedRoots, activeWorktreeWIs, heldLocks };
  }

  counts() {
    return {
      jobs: this._jobLocks.size,
      workItems: this._workItemLocks.size,
      jobScopes: this._jobScopes.size,
    };
  }
}
