import crypto from "crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  UNMERGED_WORK_ITEM_MERGE_STATES,
  UNMERGED_WORK_ITEM_MERGE_STATES_SQL,
} from "../../../catalog/work-item.js";
import { Scope } from "../../../shared/scope/classes/Scope.js";
import { MUTATING_JOB_TYPES, QUEUE_LOCKING_JOB_TYPES } from "../../../catalog/job.js";
import { isUnderRoot, rootsOverlap } from "../../../shared/scope/functions/path.js";
import { parseJobPayload } from "./payload.js";
import { LOCK_HOLDING_JOB_STATUSES, now, runImmediateTransaction, TERMINAL_JOB_STATUSES } from "./common.js";
import { logEvent, flushEventsNow } from "./events.js";
import { leaseNowMs } from "./lease-clock.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const JOB_LOCK_RELEASE_STATUSES = new Set(["queued", ...TERMINAL_JOB_STATUSES]);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const WI_LOCK_RELEASE_STATUSES = new Set(["failed", "canceled"]);
// A completed work item still owns file locks until its branch has actually
// merged. Lock-holding states are every merge_state other than `merged`.
const COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_LIST = UNMERGED_WORK_ITEM_MERGE_STATES;
const COMPLETE_WI_LOCK_HOLDING_MERGE_STATES = new Set(COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_LIST);
const COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_SQL = `(${UNMERGED_WORK_ITEM_MERGE_STATES_SQL})`;
const ACTIVE_INNER_LOCK_STATUSES_LIST = LOCK_HOLDING_JOB_STATUSES;
const ACTIVE_INNER_LOCK_STATUSES = new Set(ACTIVE_INNER_LOCK_STATUSES_LIST);
const ACTIVE_INNER_LOCK_STATUSES_SQL = ACTIVE_INNER_LOCK_STATUSES_LIST.map(() => "?").join(",");
const QUEUED_REPAIR_LOCK_JOB_TYPES = new Set(["fix", "promote"]);
const UNRESOLVED_SCOPE_STATUSES = new Set([
  "queued",
  ...ACTIVE_INNER_LOCK_STATUSES_LIST,
]);
const QUEUE_LOCKING_JOB_TYPES_LIST = [...QUEUE_LOCKING_JOB_TYPES];
const QUEUE_LOCKING_JOB_TYPES_SQL = QUEUE_LOCKING_JOB_TYPES_LIST.map(() => "?").join(",");

function completeWorkItemHoldsFileLocks(wi = {}) {
  return wi?.status === "complete"
    && String(wi.branch_name || "").trim()
    && COMPLETE_WI_LOCK_HOLDING_MERGE_STATES.has(wi.merge_state);
}

function normalizeScopeFromPayload(payload = {}) {
  const scope = Scope.fromPayload(payload, { cwd: process.cwd() });
  return { files: scope.allFiles(), roots: [...scope.createRoots] };
}

async function normalizeScopeFromPayloadAsync(payload = {}) {
  const scope = await Scope.fromPayloadAsync(payload, { cwd: process.cwd() });
  return { files: scope.allFiles(), roots: [...scope.createRoots] };
}

function normalizeScopeInput(scope = null) {
  if (!scope) return null;
  if (scope instanceof Scope) {
    return { files: scope.allFiles(), roots: [...scope.createRoots] };
  }
  if (Array.isArray(scope.files) || Array.isArray(scope.roots) || Array.isArray(scope.createRoots)) {
    const explicitScope = new Scope({
      modifyFiles: scope.files || [],
      createRoots: scope.roots || scope.createRoots || [],
    });
    return { files: explicitScope.allFiles(), roots: [...explicitScope.createRoots] };
  }
  return normalizeScopeFromPayload(scope);
}

function jobIsAssessOnly(job = {}) {
  const payload = parseJobPayload(job);
  return payload?._assess_only === true
    || payload?._assess_only === 1
    || payload?._assess_only === "1";
}

// DB-only jobs (task_mode:"db") mutate the project database, never worktree
// files. File locks exist to prevent cross-branch merge conflicts; DB writes
// don't merge through git, so these jobs take no file locks — and must not
// fall into the unknown-scope whole-repo promotion below.
function jobIsDbOnly(job = {}) {
  const payload = parseJobPayload(job);
  return payload?.task_mode === "db";
}

export function jobNeedsWriteLocks(job = {}) {
  return QUEUE_LOCKING_JOB_TYPES.has(job?.job_type) && !jobIsAssessOnly(job) && !jobIsDbOnly(job);
}

export function jobHasWritePermission(job = {}) {
  return MUTATING_JOB_TYPES.has(job?.job_type);
}

export function getJobWriteScope(job = {}) {
  const scope = normalizeScopeFromPayload(parseJobPayload(job));
  if (jobNeedsWriteLocks(job) && !hasWriteScope(scope)) {
    return { files: [], roots: ["*"], unknown: true };
  }
  return scope;
}

export async function getJobWriteScopeAsync(job = {}) {
  const scope = await normalizeScopeFromPayloadAsync(parseJobPayload(job));
  if (jobNeedsWriteLocks(job) && !hasWriteScope(scope)) {
    return { files: [], roots: ["*"], unknown: true };
  }
  return scope;
}

export function hasWriteScope(scope = {}) {
  if (!scope) return false;
  return (Array.isArray(scope.files) && scope.files.length > 0)
    || (Array.isArray(scope.roots) && scope.roots.length > 0);
}

function scopeToLockRows(scope = {}) {
  const rows = [];
  for (const path of scope.files || []) rows.push({ path, lock_kind: "file" });
  for (const path of scope.roots || []) rows.push({ path, lock_kind: "root" });
  return rows;
}

function normalizeLockPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function fileLaneId(pathValue, lockKind = "file") {
  const normalizedPath = normalizeLockPath(pathValue);
  if (!normalizedPath || !["file", "root"].includes(lockKind)) return null;
  const digest = crypto.createHash("sha256")
    .update(`${lockKind}\0${normalizedPath}`, "utf8")
    .digest("hex");
  return `lane:sha256:${digest}`;
}

function fileLaneLabel(pathValue) {
  const normalizedPath = normalizeLockPath(pathValue);
  if (!normalizedPath || normalizedPath === "*") return "repository write scope";
  const parts = normalizedPath.split("/").filter(Boolean);
  return (parts.at(-1) || normalizedPath).slice(0, 160);
}

function normalizedWaitDescriptor(detail = {}) {
  const waiterJobId = Number(detail.waiter_job_id ?? detail.job_id);
  const waiterWorkItemId = Number(detail.waiter_work_item_id ?? detail.work_item_id);
  const holderType = String(detail.holder_type || "");
  const holderJobId = Number(detail.holder_job_id ?? detail.holder_id) || null;
  const holderWorkItemId = Number(detail.holder_work_item_id) || null;
  const lockKind = detail.lock_kind === "root" ? "root" : "file";
  const normalizedPath = normalizeLockPath(detail.path);
  if (!Number.isInteger(waiterJobId) || waiterJobId <= 0) return null;
  if (!Number.isInteger(waiterWorkItemId) || waiterWorkItemId <= 0) return null;
  if (!["job", "work_item", "active_worker"].includes(holderType)) return null;
  if (!normalizedPath) return null;
  const laneId = detail.lane_id || fileLaneId(normalizedPath, lockKind);
  const holderKey = `${holderType}:${holderJobId || holderWorkItemId || "unknown"}`;
  return {
    lane_id: laneId,
    waiter_job_id: waiterJobId,
    waiter_work_item_id: waiterWorkItemId,
    holder_type: holderType,
    holder_key: holderKey,
    holder_job_id: holderJobId,
    holder_work_item_id: holderWorkItemId,
    path: normalizedPath,
    lock_kind: lockKind,
  };
}

function waitDescriptorForConflict(job, conflict) {
  if (!job || !conflict) return null;
  const pathValue = conflict.candidate?.path || conflict.lock?.path;
  const lockKind = conflict.candidate?.lock_kind || conflict.lock?.lock_kind || "file";
  return normalizedWaitDescriptor({
    waiter_job_id: job.id,
    waiter_work_item_id: job.work_item_id,
    holder_type: conflict.type === "work_item" ? "work_item" : "job",
    holder_job_id: conflict.lock?.job_id || null,
    holder_work_item_id: conflict.lock?.work_item_id || null,
    path: pathValue,
    lock_kind: lockKind,
  });
}

function canonicalWaitState(value) {
  if (Array.isArray(value)) return value.map(canonicalWaitState);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalWaitState(value[key])]),
  );
}

function waitStateForDetail(detail, descriptor, existing = null) {
  // The scheduler records special cross-WI state before its generic lock-wait
  // bookkeeping runs. A later generic record in the same poll must preserve
  // that richer state instead of toggling the fingerprint back and re-emitting.
  if (detail.wait_state == null && existing?.state_fingerprint) {
    return {
      fingerprint: existing.state_fingerprint,
      detailJson: existing.detail_json ?? null,
    };
  }
  const state = canonicalWaitState({
    waiter_job_id: descriptor.waiter_job_id,
    waiter_work_item_id: descriptor.waiter_work_item_id,
    holder_type: descriptor.holder_type,
    holder_key: descriptor.holder_key,
    path: descriptor.path,
    lock_kind: descriptor.lock_kind,
    ...(detail.wait_state && typeof detail.wait_state === "object"
      ? { wait_state: detail.wait_state }
      : {}),
  });
  const serialized = JSON.stringify(state);
  const fingerprint = crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
  if (serialized.length <= 16_000) return { fingerprint, detailJson: serialized };
  return {
    fingerprint,
    detailJson: JSON.stringify({
      truncated: true,
      state_sha256: fingerprint,
      preview: serialized.slice(0, 15_000),
    }),
  };
}

export function recordFileLaneWait(detail = {}) {
  const descriptor = normalizedWaitDescriptor(detail);
  if (!descriptor) return null;
  const db = getDb();
  const waiter = db.prepare("SELECT status FROM jobs WHERE id = ? AND work_item_id = ?")
    .get(descriptor.waiter_job_id, descriptor.waiter_work_item_id);
  if (waiter?.status !== "queued") return null;
  const existing = db.prepare(`
    SELECT * FROM file_lane_waits
    WHERE waiter_job_id = ? AND lane_id = ? AND holder_key = ?
  `).get(descriptor.waiter_job_id, descriptor.lane_id, descriptor.holder_key);
  const state = waitStateForDetail(detail, descriptor, existing);
  const transition = !existing
    ? "created"
    : existing.state_fingerprint !== state.fingerprint
      ? "changed"
      : "unchanged";
  const ts = now();
  db.prepare(`
    INSERT INTO file_lane_waits (
      lane_id, waiter_job_id, waiter_work_item_id, holder_type, holder_key,
      holder_job_id, holder_work_item_id, path, lock_kind, state_fingerprint,
      detail_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(waiter_job_id, lane_id, holder_key) DO UPDATE SET
      holder_job_id = excluded.holder_job_id,
      holder_work_item_id = excluded.holder_work_item_id,
      path = excluded.path,
      lock_kind = excluded.lock_kind,
      state_fingerprint = excluded.state_fingerprint,
      detail_json = excluded.detail_json,
      updated_at = excluded.updated_at
  `).run(
    descriptor.lane_id,
    descriptor.waiter_job_id,
    descriptor.waiter_work_item_id,
    descriptor.holder_type,
    descriptor.holder_key,
    descriptor.holder_job_id,
    descriptor.holder_work_item_id,
    descriptor.path,
    descriptor.lock_kind,
    state.fingerprint,
    state.detailJson,
    existing?.created_at || ts,
    ts,
  );
  if (!existing) {
    logEvent({
      work_item_id: descriptor.waiter_work_item_id,
      job_id: descriptor.waiter_job_id,
      event_type: EVENT_TYPES.FILE_LANE_WAITING,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: "Job is waiting for a file lane",
      event_json: JSON.stringify({
        event_kind: "lane_state",
        state: "waiting",
        summary: `Waiting for file lane ${fileLaneLabel(descriptor.path)}`,
        lane_id: descriptor.lane_id,
        waiter_job_id: descriptor.waiter_job_id,
        holder_job_id: descriptor.holder_job_id,
        holder_work_item_id: descriptor.holder_work_item_id,
      }),
    });
  }
  const row = db.prepare(`
    SELECT * FROM file_lane_waits
    WHERE waiter_job_id = ? AND lane_id = ? AND holder_key = ?
  `).get(descriptor.waiter_job_id, descriptor.lane_id, descriptor.holder_key);
  return row ? { ...row, transition } : null;
}

export function recordFileLaneConflict(job, conflict) {
  const descriptor = waitDescriptorForConflict(job, conflict);
  return descriptor ? recordFileLaneWait(descriptor) : null;
}

function emitFileLaneCleared(row, reason) {
  logEvent({
    work_item_id: row.waiter_work_item_id,
    job_id: row.waiter_job_id,
    event_type: reason === "lane_acquired" ? EVENT_TYPES.FILE_LANE_ACQUIRED : EVENT_TYPES.FILE_LANE_CLEARED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    message: "File-lane wait cleared",
    event_json: JSON.stringify({
      event_kind: "lane_state",
      state: reason === "lane_acquired" ? "held" : "available",
      summary: reason === "lane_acquired"
        ? `Acquired file lane ${fileLaneLabel(row.path)}`
        : `File lane ${fileLaneLabel(row.path)} is no longer blocking`,
      lane_id: row.lane_id,
      waiter_job_id: row.waiter_job_id,
      holder_job_id: row.holder_job_id,
      reason,
    }),
  });
}

export function clearFileLaneWaitsForJob(jobId, reason = "waiter_transition") {
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const db = getDb();
  const rows = db.prepare("SELECT * FROM file_lane_waits WHERE waiter_job_id = ? ORDER BY id").all(id);
  if (rows.length === 0) return 0;
  const changes = db.prepare("DELETE FROM file_lane_waits WHERE waiter_job_id = ?").run(id).changes;
  for (const row of rows.slice(0, 128)) emitFileLaneCleared(row, reason);
  return changes;
}

export function listFileLaneWaits({ workItemId = null } = {}) {
  const db = getDb();
  if (workItemId == null) return db.prepare("SELECT * FROM file_lane_waits ORDER BY lane_id, created_at, waiter_job_id").all();
  return db.prepare(`
    SELECT * FROM file_lane_waits
    WHERE waiter_work_item_id = ? OR holder_work_item_id = ?
    ORDER BY lane_id, created_at, waiter_job_id
  `).all(Number(workItemId), Number(workItemId));
}

export function reconcileFileLaneWaits() {
  const db = getDb();
  const desired = new Map();
  let lastId = 0;
  for (;;) {
    const jobs = db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'queued'
        AND id > ?
        AND job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
      ORDER BY id
      LIMIT 250
    `).all(lastId, ...QUEUE_LOCKING_JOB_TYPES_LIST);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      lastId = Number(job.id);
      const descriptor = waitDescriptorForConflict(job, findWriteLockConflict(job));
      if (!descriptor) continue;
      desired.set(`${descriptor.waiter_job_id}|${descriptor.lane_id}|${descriptor.holder_key}`, descriptor);
    }
  }
  for (const descriptor of desired.values()) recordFileLaneWait(descriptor);
  const current = db.prepare("SELECT * FROM file_lane_waits ORDER BY id").all();
  let removed = 0;
  for (const row of current) {
    const key = `${row.waiter_job_id}|${row.lane_id}|${row.holder_key}`;
    if (desired.has(key)) continue;
    removed += db.prepare("DELETE FROM file_lane_waits WHERE id = ?").run(row.id).changes;
    emitFileLaneCleared(row, "reconciled_stale");
  }
  return { active: desired.size, removed };
}

function lockRowsTouchPath(rows = [], path, lockKind = "file") {
  const target = { path, lock_kind: lockKind };
  return rows.some((lock) => {
    if (target.lock_kind === "file" && lock.lock_kind === "file") return target.path === lock.path;
    if (target.lock_kind === "file" && lock.lock_kind === "root") return isUnderRoot(target.path, [lock.path]);
    if (target.lock_kind === "root" && lock.lock_kind === "file") return isUnderRoot(lock.path, [target.path]);
    if (target.lock_kind === "root" && lock.lock_kind === "root") return rootsOverlap(target.path, lock.path);
    return false;
  });
}

function jobScopeTouchesPath(job, path, lockKind = "file") {
  if (!jobNeedsWriteLocks(job)) return false;
  const scope = getJobWriteScope(job);
  if (!hasWriteScope(scope)) return false;
  return lockRowsTouchPath(scopeToLockRows(scope), path, lockKind);
}

function locksConflict(scope, locks, {
  allowWorkItemId = null,
  allowJobId = null,
  allowJobIds = null,
  ignoreSameWorkItemLocks = false,
} = {}) {
  const conflict = (lock, candidate) => {
    if (candidate.lock_kind === "file" && lock.lock_kind === "file") return candidate.path === lock.path;
    if (candidate.lock_kind === "file" && lock.lock_kind === "root") return isUnderRoot(candidate.path, [lock.path]);
    if (candidate.lock_kind === "root" && lock.lock_kind === "file") return isUnderRoot(lock.path, [candidate.path]);
    if (candidate.lock_kind === "root" && lock.lock_kind === "root") {
      return rootsOverlap(candidate.path, lock.path);
    }
    return false;
  };

  const candidates = scopeToLockRows(scope);
  const allowedJobIds = new Set([
    ...(allowJobIds ? [...allowJobIds] : []),
    ...(allowJobId != null ? [allowJobId] : []),
  ].map((id) => Number(id)));
  for (const lock of locks || []) {
    const sameWorkItem = allowWorkItemId != null
      && lock.work_item_id != null
      && Number(lock.work_item_id) === Number(allowWorkItemId);
    if (ignoreSameWorkItemLocks && sameWorkItem) continue;
    if (lock.job_id != null && allowedJobIds.has(Number(lock.job_id))) continue;
    const hit = candidates.find((candidate) => conflict(lock, candidate));
    if (hit) return { lock, candidate: hit };
  }
  return null;
}

function activeWiLocks(db) {
  return db.prepare(`
    SELECT
      l.*,
      l.source_job_id AS job_id,
      'work_item' AS lock_tier,
      wi.title AS work_item_title,
      wi.status AS work_item_status,
      wi.merge_state AS merge_state,
      wi.branch_name AS branch_name,
      j.job_type AS source_job_type,
      j.status AS source_job_status,
      j.title AS source_job_title
    FROM work_item_file_locks l
    JOIN work_items wi ON wi.id = l.work_item_id
    LEFT JOIN jobs j ON j.id = l.source_job_id
    WHERE l.released_at IS NULL
      AND wi.status NOT IN ('failed','canceled')
      AND (
        wi.status != 'complete'
        OR (
          COALESCE(TRIM(wi.branch_name), '') != ''
          AND COALESCE(wi.merge_state, '') IN ${COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_SQL}
        )
      )
      AND COALESCE(wi.merge_state, '') != 'merged'
      AND (l.source_job_id IS NULL OR j.job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL}))
  `).all(...QUEUE_LOCKING_JOB_TYPES_LIST);
}

export function workItemCanReleaseFileLock(workItemId, path, lockKind = "file") {
  const db = getDb();
  const wiId = Number(workItemId);
  const normalizedPath = normalizeLockPath(path);
  if (!["file", "root"].includes(lockKind)) {
    return { ok: false, blockers: [], reason: "unsupported_lock" };
  }
  if (!Number.isFinite(wiId) || !normalizedPath) {
    return { ok: false, blockers: [], reason: "unsupported_lock" };
  }

  const activeBlockers = activeJobLocks(db, { workItemId: wiId }).filter((lock) =>
    Number(lock.work_item_id) === wiId
    && lockRowsTouchPath([lock], normalizedPath, lockKind)
  );
  if (activeBlockers.length > 0) {
    return { ok: false, blockers: activeBlockers, reason: "active_job_lock" };
  }

  const unresolvedJobs = db.prepare(`
    SELECT *
    FROM jobs
    WHERE work_item_id = ?
      AND status IN (${[...UNRESOLVED_SCOPE_STATUSES].map(() => "?").join(",")})
      AND job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
    ORDER BY id
  `).all(wiId, ...UNRESOLVED_SCOPE_STATUSES, ...QUEUE_LOCKING_JOB_TYPES_LIST);
  const scopeBlockers = unresolvedJobs.filter((job) => jobScopeTouchesPath(job, normalizedPath, lockKind));
  if (scopeBlockers.length > 0) {
    return { ok: false, blockers: scopeBlockers, reason: "unresolved_job_scope" };
  }

  return { ok: true, blockers: [], reason: "idle_path" };
}

function activeJobLocks(db, { workItemId = null } = {}) {
  const wiId = Number(workItemId);
  const scopedToWorkItem = workItemId != null && Number.isFinite(wiId);
  const jobs = db.prepare(`
    SELECT *
    FROM jobs
    WHERE job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
      ${scopedToWorkItem ? "AND work_item_id = ?" : ""}
  `).all(...QUEUE_LOCKING_JOB_TYPES_LIST, ...(scopedToWorkItem ? [wiId] : []));

  const isActiveInnerLockJob = (job) => {
    if (jobIsAssessOnly(job)) return false;
    if (ACTIVE_INNER_LOCK_STATUSES.has(job.status)) return true;
    if (job.status === "queued") {
      return QUEUED_REPAIR_LOCK_JOB_TYPES.has(job.job_type)
        || Number(job.attempt_count || 0) > 0;
    }
    return false;
  };

  const rows = [];
  for (const job of jobs) {
    if (!isActiveInnerLockJob(job)) continue;
    const scope = getJobWriteScope(job);
    if (!hasWriteScope(scope)) continue;
    for (const lock of scopeToLockRows(scope)) {
      rows.push({
        id: null,
        lock_tier: "job",
        job_id: job.id,
        work_item_id: job.work_item_id,
        path: lock.path,
        lock_kind: lock.lock_kind,
        acquired_at: job.started_at || job.updated_at || job.queued_at || null,
        released_at: null,
        release_reason: null,
        metadata_json: JSON.stringify({ source: "active_job_status", job_type: job.job_type }),
        job_title: job.title,
        job_status: job.status,
        job_type: job.job_type,
      });
    }
  }
  return rows;
}

export function findWriteLockConflict(job, scope = getJobWriteScope(job)) {
  if (!jobNeedsWriteLocks(job) || !hasWriteScope(scope)) return null;
  const db = getDb();
  const wiConflict = locksConflict(scope, activeWiLocks(db), {
    allowWorkItemId: job.work_item_id,
    ignoreSameWorkItemLocks: true,
  });
  if (wiConflict) return { type: "work_item", ...wiConflict };
  const sameWorkItemJobLocks = activeJobLocks(db, { workItemId: job.work_item_id });
  const allowJobIds = new Set([
    ...ancestorJobIdsForJob(job, db),
    ...queuedCohortJobIdsForJob(job, db),
  ]);
  const jobConflict = locksConflict(scope, sameWorkItemJobLocks, {
    allowJobId: job.id,
    allowJobIds,
    allowWorkItemId: job.work_item_id,
  });
  if (jobConflict) return { type: "job", ...jobConflict };
  return null;
}

export function ancestorJobIdsForJob(job, db = getDb()) {
  const ids = new Set();
  const getParent = db.prepare(`SELECT id, parent_job_id FROM jobs WHERE id = ?`);
  let parentId = job?.parent_job_id;
  while (parentId != null) {
    const numericId = Number(parentId);
    if (!Number.isFinite(numericId) || ids.has(numericId)) break;
    ids.add(numericId);
    const parent = getParent.get(numericId);
    parentId = parent?.parent_job_id;
  }
  return ids;
}

// When an assessor failure spawns multiple fix jobs from the same parent dev
// job, all targeting the same file, those siblings would otherwise phantom-lock
// each other in `activeJobLocks` and deadlock the entire cohort. Their queued
// phantom locks should not block a sibling from leasing — they're a cohort
// designed to execute sequentially (chained via hard deps). Once a sibling
// actually leases, it transitions to leased/running and its synthesized lock
// reverts to a normal lock that *does* block (this allowance only skips
// queued-status siblings).
export function queuedCohortJobIdsForJob(job, db = getDb()) {
  if (!job?.parent_job_id) return new Set();
  const rows = db.prepare(`
    SELECT id FROM jobs
    WHERE parent_job_id = ?
      AND id != ?
      AND status = 'queued'
      AND job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
  `).all(job.parent_job_id, job.id, ...QUEUE_LOCKING_JOB_TYPES_LIST);
  return new Set(rows.map((row) => Number(row.id)));
}

function insertMissingWiLocks(db, job, scope, ts, source = "scheduler_handoff") {
  const wi = db.prepare(`
    SELECT status, branch_name, merge_state
    FROM work_items
    WHERE id = ?
  `).get(job.work_item_id);
  if (wi?.merge_state === "merged") return;
  if (wi?.status === "complete" && !completeWorkItemHoldsFileLocks(wi)) return;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO work_item_file_locks (work_item_id, path, lock_kind, source_job_id, acquired_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const metadata = JSON.stringify({ source, job_type: job.job_type });
  for (const lock of scopeToLockRows(scope)) {
    stmt.run(job.work_item_id, lock.path, lock.lock_kind, job.id, ts, metadata);
  }
}

function insertJobLocks(db, job, scope, ts, source = "scheduler_handoff") {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO job_file_locks (job_id, work_item_id, path, lock_kind, acquired_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const metadata = JSON.stringify({ source, job_type: job.job_type });
  for (const lock of scopeToLockRows(scope)) {
    stmt.run(job.id, job.work_item_id, lock.path, lock.lock_kind, ts, metadata);
  }
}

// ─── Tool-time write-lock guard primitives (defense in depth) ────────────────
//
// Locks are inserted at lease time from the payload scope and trusted
// thereafter; nothing at the write site verifies the executing job actually
// holds a lock covering the path it is about to mutate. Any drift between
// scope and lock rows — an explicit-scope lease narrower than the payload, a
// skipConflictCheck caller, a FILE_REQUEST-approved mid-job scope addition
// whose lock rows were never inserted — writes unguarded. These primitives let
// the mutating tools close that gap at the last write barrier.

export function jobHoldsWriteLockForPath(jobId, filePath) {
  const id = Number(jobId);
  const target = normalizeLockPath(filePath);
  if (!Number.isFinite(id) || !target) return false;
  const db = getDb();
  const rows = db.prepare(`
    SELECT path, lock_kind FROM job_file_locks
    WHERE job_id = ? AND released_at IS NULL
  `).all(id);
  return rows.some((row) => {
    const lockPath = normalizeLockPath(row.path);
    if (!lockPath) return false;
    if (lockPath === "*") return true;
    if (row.lock_kind === "file") return lockPath === target;
    if (row.lock_kind === "root") return target === lockPath || isUnderRoot(target, [lockPath]);
    return false;
  });
}

/**
 * Verify the job holds a write lock covering `filePath`; acquire it
 * transactionally when the row is missing and no other holder conflicts.
 * Returns { ok:true, held|acquired|skipped } or { ok:false, conflict } — a
 * conflict means another work item/job owns the path and the write must be
 * refused (the caller instructs the agent to report BLOCKED, not poll).
 */
export function verifyOrAcquireJobWriteLockForPath(jobId, filePath, { source = "tool_guard" } = {}) {
  const target = normalizeLockPath(filePath);
  if (!target) return { ok: true, skipped: "unlockable_path" };
  const db = getDb();
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(Number(jobId));
  if (!job) return { ok: true, skipped: "no_job" };
  if (!jobNeedsWriteLocks(job)) return { ok: true, skipped: "job_not_locking" };
  if (jobHoldsWriteLockForPath(job.id, target)) return { ok: true, held: true };

  const scope = { files: [target], roots: [] };
  return runImmediateTransaction(db, () => {
    if (jobHoldsWriteLockForPath(job.id, target)) return { ok: true, held: true };
    let conflict = findWriteLockConflict(job, scope);
    if (conflict) {
      const cleaned = cleanupStaleFileLocks();
      if (cleaned.job_locks_released > 0 || cleaned.wi_locks_released > 0) {
        conflict = findWriteLockConflict(job, scope);
      }
    }
    if (conflict) {
      recordFileLaneConflict(job, conflict);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_WRITE_LOCK_BLOCKED,
        actor_type: EVENT_ACTORS.WORKER,
        actor_id: `job-${job.id}`,
        message: `Tool-time write to ${target} refused: ${lockConflictMessage(job, conflict)}`,
        event_json: JSON.stringify({
          visible: false,
          source,
          conflict_type: conflict.type,
          candidate: conflict.candidate,
          holder: conflict.lock,
        }),
      });
      return { ok: false, conflict };
    }
    const ts = now();
    insertMissingWiLocks(db, job, scope, ts, source);
    insertJobLocks(db, job, scope, ts, source);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_WRITE_LOCKS_ACQUIRED,
      actor_type: EVENT_ACTORS.WORKER,
      actor_id: `job-${job.id}`,
      message: `Acquired write lock for ${target} at tool time (missing from lease scope)`,
      event_json: JSON.stringify({ files: [target], roots: [], source }),
    });
    return { ok: true, acquired: true };
  });
}

function lockConflictMessage(job, conflict) {
  if (!conflict) return null;
  const path = conflict.candidate?.path || conflict.lock?.path || "unknown";
  if (conflict.type === "work_item") {
    return `Write scope blocked: ${path} is held by WI#${conflict.lock.work_item_id}`;
  }
  const status = conflict.lock?.job_status ? ` (${conflict.lock.job_status})` : "";
  return `Write scope blocked: ${path} is held by job #${conflict.lock.job_id}${status}`;
}

function logWriteLockBlockedOnce(db, job, ownerId, message, conflict) {
  // Ensure any in-flight batched events are visible before the dedupe check.
  flushEventsNow();
  const previous = db.prepare(`
    SELECT message
    FROM events
    WHERE job_id = ? AND event_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(job.id, EVENT_TYPES.JOB_WRITE_LOCK_BLOCKED);
  if (previous?.message === message) return false;
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_WRITE_LOCK_BLOCKED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    actor_id: ownerId,
    message,
    event_json: JSON.stringify({
      visible: false,
      persistent_notice: true,
      conflict_type: conflict.type,
      candidate: conflict.candidate,
      holder: conflict.lock,
    }),
  });
  return true;
}

export function acquireLeaseWithWriteLocks(job, ownerId, scopeOrLeaseDurationSec = null, leaseDurationSec = 900, opts = {}) {
  const db = getDb();
  const hasExplicitScope = scopeOrLeaseDurationSec && typeof scopeOrLeaseDurationSec === "object";
  if (!hasExplicitScope && scopeOrLeaseDurationSec != null) {
    leaseDurationSec = scopeOrLeaseDurationSec;
    opts = {};
  }
  const needsWriteLocks = jobNeedsWriteLocks(job);
  const scope = needsWriteLocks
    ? (hasExplicitScope
      ? normalizeScopeInput(scopeOrLeaseDurationSec)
      : getJobWriteScope(job))
    : null;
  const hasScope = hasWriteScope(scope);
  const skipConflictCheck = !!opts?.skipConflictCheck;

  return runImmediateTransaction(db, () => {
    const fresh = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(job.id);
    if (!fresh || fresh.status !== "queued") return null;

    if (needsWriteLocks && hasScope && !skipConflictCheck) {
      let conflict = findWriteLockConflict(fresh, scope);
      if (conflict) {
        const cleaned = cleanupStaleFileLocks();
        if (cleaned.job_locks_released > 0 || cleaned.wi_locks_released > 0) {
          conflict = findWriteLockConflict(fresh, scope);
        }
      }
      if (conflict) {
        const message = lockConflictMessage(fresh, conflict);
        logWriteLockBlockedOnce(db, fresh, ownerId, message, conflict);
        recordFileLaneConflict(fresh, conflict);
        return null;
      }
    }

    const leaseToken = crypto.randomUUID();
    const expiresAt = new Date(leaseNowMs() + leaseDurationSec * 1000).toISOString();
    const ts = now();
    const result = db.prepare(`
      UPDATE jobs
      SET status = 'leased',
          lease_owner = ?,
          lease_token = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(ownerId, leaseToken, expiresAt, ts, fresh.id);
    if (result.changes === 0) return null;

    clearFileLaneWaitsForJob(fresh.id, "lane_acquired");

    if (needsWriteLocks && hasScope) {
      insertMissingWiLocks(db, fresh, scope, ts);
      insertJobLocks(db, fresh, scope, ts);
    }

    logEvent({
      work_item_id: fresh.work_item_id,
      job_id: fresh.id,
      event_type: EVENT_TYPES.JOB_LEASED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: ownerId,
      message: `Leased until ${expiresAt}`,
    });
    if (needsWriteLocks && hasScope) {
      logEvent({
        work_item_id: fresh.work_item_id,
        job_id: fresh.id,
        event_type: EVENT_TYPES.JOB_WRITE_LOCKS_ACQUIRED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: ownerId,
        message: `Acquired ${scope.files.length} file and ${scope.roots.length} root write lock(s)`,
        event_json: JSON.stringify({ files: scope.files, roots: scope.roots }),
      });
    }

    return { leaseToken };
  });
}

export async function acquireLeaseWithWriteLocksAsync(job, ownerId, scopeOrLeaseDurationSec = null, leaseDurationSec = 900, opts = {}) {
  const hasExplicitScope = scopeOrLeaseDurationSec && typeof scopeOrLeaseDurationSec === "object";
  if (!hasExplicitScope && scopeOrLeaseDurationSec != null) {
    leaseDurationSec = scopeOrLeaseDurationSec;
    opts = {};
  }
  const needsWriteLocks = jobNeedsWriteLocks(job);
  const scope = needsWriteLocks
    ? (hasExplicitScope
      ? scopeOrLeaseDurationSec
      : await getJobWriteScopeAsync(job))
    : null;
  return acquireLeaseWithWriteLocks(job, ownerId, scope, leaseDurationSec, opts);
}

export function releaseJobFileLocks(jobId, reason = "job_done") {
  const db = getDb();
  const ts = now();
  const released = db.prepare(`
    UPDATE job_file_locks
    SET released_at = ?, release_reason = ?
    WHERE job_id = ? AND released_at IS NULL
  `).run(ts, reason, jobId).changes;
  if (released > 0) {
    notifyQueueStateChanged({
      reason: `job_locks_released:${reason}`,
      jobId,
    });
    reconcileFileLaneWaits();
  }
  return released;
}

export function releaseWorkItemFileLocks(workItemId, reason = "work_item_done") {
  const db = getDb();
  const ts = now();
  const released = db.prepare(`
    UPDATE work_item_file_locks
    SET released_at = ?, release_reason = ?
    WHERE work_item_id = ? AND released_at IS NULL
  `).run(ts, reason, workItemId).changes;
  if (released > 0) {
    notifyQueueStateChanged({
      reason: `work_item_locks_released:${reason}`,
      workItemId,
    });
    reconcileFileLaneWaits();
  }
  return released;
}

export function releaseWorkItemFileLocksForSourceJob(jobId, reason = "source_job_done") {
  const db = getDb();
  const ts = now();
  const released = db.prepare(`
    UPDATE work_item_file_locks
    SET released_at = ?, release_reason = ?
    WHERE source_job_id = ? AND released_at IS NULL
  `).run(ts, reason, jobId).changes;
  if (released > 0) {
    notifyQueueStateChanged({
      reason: `work_item_locks_released:${reason}`,
      jobId,
    });
    reconcileFileLaneWaits();
  }
  return released;
}

export function releaseWorkItemFileLockForPath(workItemId, path, lockKind = "file", reason = "path_handoff") {
  const db = getDb();
  const ts = now();
  const normalizedPath = normalizeLockPath(path);
  if (!normalizedPath) return 0;
  const released = db.prepare(`
    UPDATE work_item_file_locks
    SET released_at = ?, release_reason = ?
    WHERE work_item_id = ?
      AND path = ?
      AND lock_kind = ?
      AND released_at IS NULL
  `).run(ts, reason, workItemId, normalizedPath, lockKind).changes;
  if (released > 0) {
    notifyQueueStateChanged({
      reason: `work_item_lock_released:${reason}`,
      workItemId,
      path: normalizedPath,
      lockKind,
    });
    reconcileFileLaneWaits();
  }
  return released;
}

export function releaseJobLocksForStatus(jobId, status) {
  if (!JOB_LOCK_RELEASE_STATUSES.has(status)) return 0;
  if (TERMINAL_JOB_STATUS_SET.has(status)) clearFileLaneWaitsForJob(jobId, `job_${status}`);
  const reason = `job_${status}`;
  return releaseJobFileLocks(jobId, reason);
}

export function releaseWorkItemLocksForStatus(workItemId, status) {
  if (!WI_LOCK_RELEASE_STATUSES.has(status)) return 0;
  return releaseWorkItemFileLocks(workItemId, `work_item_${status}`);
}

export function releaseWorkItemLocksForMergeState(workItemId, mergeState) {
  if (mergeState !== "merged") return 0;
  return releaseWorkItemFileLocks(workItemId, "work_item_merged");
}

export function cleanupStaleFileLocks() {
  const db = getDb();
  const ts = now();
  const releaseJobs = db.prepare(`
    UPDATE job_file_locks
    SET released_at = ?, release_reason = 'stale_job_lock_cleanup'
    WHERE released_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.id = job_file_locks.job_id
          AND jobs.status IN (${ACTIVE_INNER_LOCK_STATUSES_SQL})
      )
  `).run(ts, ...ACTIVE_INNER_LOCK_STATUSES_LIST).changes;
  const releaseWis = db.prepare(`
    UPDATE work_item_file_locks
    SET released_at = ?, release_reason = 'stale_wi_lock_cleanup'
    WHERE released_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM work_items
        WHERE work_items.id = work_item_file_locks.work_item_id
          AND work_items.status NOT IN ('failed','canceled')
          AND (
            work_items.status != 'complete'
            OR (
              COALESCE(TRIM(work_items.branch_name), '') != ''
              AND COALESCE(work_items.merge_state, '') IN ${COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_SQL}
            )
          )
          AND COALESCE(work_items.merge_state, '') != 'merged'
      )
  `).run(ts).changes;
  if (releaseJobs > 0 || releaseWis > 0) {
    notifyQueueStateChanged({
      reason: "stale_file_locks_released",
    });
    reconcileFileLaneWaits();
  }
  return { job_locks_released: releaseJobs, wi_locks_released: releaseWis };
}

export function listActiveFileLocks() {
  const db = getDb();
  return {
    work_items: activeWiLocks(db),
    jobs: activeJobLocks(db),
  };
}
