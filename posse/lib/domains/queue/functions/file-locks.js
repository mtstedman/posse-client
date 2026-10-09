import crypto from "crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  UNMERGED_WORK_ITEM_MERGE_STATES,
  UNMERGED_WORK_ITEM_MERGE_STATES_SQL,
} from "../../../catalog/work-item.js";
import { Scope } from "../../../shared/scope/classes/Scope.js";
import { DEADLOCK_TERMINAL_STATUSES, MUTATING_JOB_TYPES, QUEUE_LOCKING_JOB_TYPES } from "../../../catalog/job.js";
import { isUnderRoot, rootsOverlap } from "../../../shared/scope/functions/path.js";
import { parseJobPayload } from "./payload.js";
import {
  ACTIVE_LEASE_STATUSES,
  LEASE_HOLDING_STATUSES,
  LOCK_HOLDING_JOB_STATUSES,
  now,
  PARKED_JOB_STATUSES,
  runImmediateTransaction,
  TERMINAL_JOB_STATUSES,
} from "./common.js";
import { logDurableEvent, logEvent, flushEventsNow } from "./events.js";
import { leaseNowMs } from "./lease-clock.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import {
  sharedTrunkClaimsEnabled,
  warnForPeerClaimAtToolWrite,
} from "./cross-instance-claims.js";
import { getWorkItemMergeDependencies } from "./cross-wi-deps.js";
import { findMergeHoldingGate } from "./merge-holding-gate.js";
import {
  buildWorkItemOrder,
  findWorkItemOrderUpstream,
  WORK_ITEM_ORDER_WAIT_REASON,
} from "./work-item-order.js";

const JOB_LOCK_RELEASE_STATUSES = new Set(["queued", ...PARKED_JOB_STATUSES, ...TERMINAL_JOB_STATUSES]);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const WI_LOCK_RELEASE_STATUSES = new Set(["failed", "canceled"]);
// A completed work item still owns file locks until its branch has actually
// merged. Lock-holding states are every merge_state other than `merged`.
const COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_LIST = UNMERGED_WORK_ITEM_MERGE_STATES;
const COMPLETE_WI_LOCK_HOLDING_MERGE_STATES = new Set(COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_LIST);
const COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_SQL = `(${UNMERGED_WORK_ITEM_MERGE_STATES_SQL})`;
const ACTIVE_INNER_LOCK_STATUSES_LIST = LOCK_HOLDING_JOB_STATUSES.filter((status) => !PARKED_JOB_STATUSES.includes(status));
const ACTIVE_INNER_LOCK_STATUSES = new Set(ACTIVE_INNER_LOCK_STATUSES_LIST);
const ACTIVE_ASSESSMENT_BARRIER_STATUSES = new Set(ACTIVE_LEASE_STATUSES);
const PARKED_JOB_STATUS_SET = new Set(PARKED_JOB_STATUSES);
const ACTIVE_INNER_LOCK_STATUSES_SQL = ACTIVE_INNER_LOCK_STATUSES_LIST.map(() => "?").join(",");
const QUEUED_REPAIR_LOCK_JOB_TYPES = new Set(["fix", "promote"]);
const OPERATOR_PARKING_GATE_KINDS = new Set([
  "dead_letter_recovery",
  "fix_chain_exhausted",
  "developer_blocked",
]);
const UNRESOLVED_SCOPE_STATUSES = new Set([
  "queued",
  ...LOCK_HOLDING_JOB_STATUSES,
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

// DB-only jobs mutate the project database, never worktree files. Artifact
// jobs are already absent from QUEUE_LOCKING_JOB_TYPES. Neither kind benefits
// from freezing the WI worktree during assessment.
function jobCanUseAssessmentBarrier(job = {}) {
  return QUEUE_LOCKING_JOB_TYPES.has(job?.job_type) && !jobIsDbOnly(job);
}

export function jobNeedsAssessmentBarrier(job = {}) {
  return jobCanUseAssessmentBarrier(job)
    && (jobIsAssessOnly(job) || job?.status === "awaiting_assessment");
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
  return jobCanUseAssessmentBarrier(job);
}

export function jobHasWritePermission(job = {}) {
  return MUTATING_JOB_TYPES.has(job?.job_type);
}

export function getJobWriteScope(job = {}) {
  if (jobNeedsAssessmentBarrier(job)) {
    return { files: [], roots: ["*"], unknown: false, assessmentBarrier: true };
  }
  const scope = normalizeScopeFromPayload(parseJobPayload(job));
  if (jobNeedsWriteLocks(job) && !hasWriteScope(scope)) {
    return { files: [], roots: ["*"], unknown: true };
  }
  return scope;
}

export async function getJobWriteScopeAsync(job = {}) {
  if (jobNeedsAssessmentBarrier(job)) {
    return { files: [], roots: ["*"], unknown: false, assessmentBarrier: true };
  }
  const scope = await normalizeScopeFromPayloadAsync(parseJobPayload(job));
  if (jobNeedsWriteLocks(job) && !hasWriteScope(scope)) {
    return { files: [], roots: ["*"], unknown: true };
  }
  return scope;
}

// Cross-WI handoff checks ask which paths this job may still touch, not which
// WI-local lease barrier it currently projects. Keep unknown payload scope
// conservative while avoiding a synthetic '*' veto for every declared path.
function getJobPathTouchScope(job = {}) {
  const scope = normalizeScopeFromPayload(parseJobPayload(job));
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
  if (!normalized) return "";
  if (normalized !== "*" && (
    normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((part) => part === ".." || part === ".")
  )) return "";
  const first = normalized.split("/", 1)[0].toLowerCase();
  if (first === ".posse" || first === ".posse-worktrees" || first === "posse-worktrees" || first.startsWith(".posse-")) return "";
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
  const descriptor = normalizedWaitDescriptor({
    waiter_job_id: job.id,
    waiter_work_item_id: job.work_item_id,
    holder_type: conflict.type === "work_item" ? "work_item" : "job",
    holder_job_id: conflict.lock?.job_id || null,
    holder_work_item_id: conflict.lock?.work_item_id || null,
    path: pathValue,
    lock_kind: lockKind,
  });
  return descriptor && conflict.wait_state ? { ...descriptor, wait_state: conflict.wait_state } : descriptor;
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
    const orderWait = descriptor.holder_type === "work_item"
      && detail.wait_state?.reason === WORK_ITEM_ORDER_WAIT_REASON;
    logEvent({
      work_item_id: descriptor.waiter_work_item_id,
      job_id: descriptor.waiter_job_id,
      event_type: EVENT_TYPES.FILE_LANE_WAITING,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: orderWait
        ? `Job is waiting for WI#${descriptor.holder_work_item_id} to merge, fail or be canceled; both plan edits to ${descriptor.path}`
        : "Job is waiting for a file lane",
      event_json: JSON.stringify({
        event_kind: "lane_state",
        state: "waiting",
        summary: orderWait
          ? `Waiting for WI#${descriptor.holder_work_item_id} to merge (${fileLaneLabel(descriptor.path)})`
          : `Waiting for file lane ${fileLaneLabel(descriptor.path)}`,
        lane_id: descriptor.lane_id,
        waiter_job_id: descriptor.waiter_job_id,
        holder_job_id: descriptor.holder_job_id,
        holder_work_item_id: descriptor.holder_work_item_id,
        ...(orderWait ? { reason: WORK_ITEM_ORDER_WAIT_REASON, upstream_work_item_id: descriptor.holder_work_item_id } : {}),
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
  if (!db.inTransaction) return runImmediateTransaction(db, () => reconcileFileLaneWaits());
  const locks = listActiveFileLocks();
  const snapshot = { ...locks, work_item_order: loadWorkItemOrder(db, { workItemLocks: locks.work_items }) };
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
      const descriptor = waitDescriptorForConflict(job, findWriteLockConflict(job, getJobWriteScope(job), snapshot));
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
  const scope = getJobPathTouchScope(job);
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

export function workItemCanReleaseFileLock(workItemId, path, lockKind = "file", {
  allowOperatorParked = false,
} = {}) {
  const db = getDb();
  const wiId = Number(workItemId);
  const normalizedPath = normalizeLockPath(path);
  if (!["file", "root"].includes(lockKind)) {
    return { ok: false, blockers: [], reason: "unsupported_lock" };
  }
  if (!Number.isFinite(wiId) || !normalizedPath) {
    return { ok: false, blockers: [], reason: "unsupported_lock" };
  }

  const activeBlockers = activeJobLocks(db, {
    workItemId: wiId,
    usePathTouchScope: true,
  }).filter((lock) =>
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
  if (scopeBlockers.length > 0 && !(allowOperatorParked && workItemOperatorParking(wiId, { db }))) {
    return { ok: false, blockers: scopeBlockers, reason: "unresolved_job_scope" };
  }

  return { ok: true, blockers: [], reason: "idle_path" };
}

const REJECTED_WRITER_VERDICTS = new Set(["fail", "needs_replan", "needs_review"]);
// Terminal without success: a writer that ended this way left nothing to sync.
const FAILED_WRITER_STATUSES = new Set(DEADLOCK_TERMINAL_STATUSES);

/**
 * Why a work item's current content of `path` must not be copied into another
 * work item, or null. Content from a failed or canceled work item is
 * abandoned, and content whose latest writer (the last job of the work item
 * that ran with the path in scope) was rejected by its assessor or did not
 * succeed is not reviewed work (NEW-H5: WI 170 synced WI 167's planner.js the
 * second its writer was assessed needs_replan).
 */
export function crossWiSyncSourceRejection(workItemId, path, lockKind = "file") {
  const db = getDb();
  const source = db.prepare(`SELECT id, status FROM work_items WHERE id = ?`).get(Number(workItemId));
  if (!source) return null;
  if (WI_LOCK_RELEASE_STATUSES.has(source.status)) return `upstream_${source.status}`;
  const normalizedPath = normalizeLockPath(path);
  if (!normalizedPath) return null;
  // Jobs that ran (or were assessed); one canceled before it ran wrote nothing.
  const writers = db.prepare(`
    SELECT *
    FROM jobs
    WHERE work_item_id = ?
      AND job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
      AND (attempt_count > 0 OR status = 'succeeded' OR assessor_verdict != 'not_assessed')
    ORDER BY id DESC
  `).all(source.id, ...QUEUE_LOCKING_JOB_TYPES_LIST);
  const latest = writers.find((job) => jobScopeTouchesPath(job, normalizedPath, lockKind === "root" ? "root" : "file"));
  if (!latest) return null;
  if (REJECTED_WRITER_VERDICTS.has(latest.assessor_verdict)) return `writer_${latest.assessor_verdict}`;
  if (FAILED_WRITER_STATUSES.has(latest.status)) return `writer_${latest.status}`;
  return null;
}

// `(workItem) => boolean`: whether this process merges a completed work item
// without an operator before its run loop ends (RunSession passes what its
// idle auto-merge merges: automatic merge on, iterative work item not still
// looping). Unset, every completed work item is assumed to merge.
let completeWorkItemAutoMergePolicy = null;

/**
 * Set how this process merges completed work items (see
 * workItemMergeParking). Accepts a predicate, a boolean, or null to reset.
 * Returns the previous policy so a caller can restore it.
 */
export function setCompleteWorkItemAutoMergePolicy(policy = null) {
  const previous = completeWorkItemAutoMergePolicy;
  if (typeof policy === "function") completeWorkItemAutoMergePolicy = policy;
  else if (typeof policy === "boolean") completeWorkItemAutoMergePolicy = () => policy;
  else completeWorkItemAutoMergePolicy = null;
  return previous;
}

function completeWorkItemAutoMerges(workItem) {
  if (!completeWorkItemAutoMergePolicy) return true;
  try {
    return completeWorkItemAutoMergePolicy(workItem) !== false;
  } catch {
    return true;
  }
}

function readWorkItemRow(db, id) {
  return db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(Number(id)) || null;
}

/**
 * Return the recovery gate that parks an unfinished work item, or null while
 * any non-terminal job can still make progress without that gate. Recovery
 * gates themselves may be leased by the interactive waiter; they remain
 * operator-owned, not executable work for scheduling purposes.
 */
export function workItemOperatorParking(workItemOrId, { db = getDb() } = {}) {
  const workItem = workItemOrId && typeof workItemOrId === "object"
    ? workItemOrId
    : readWorkItemRow(db, workItemOrId);
  if (!workItem || workItem.status === "complete" || WI_LOCK_RELEASE_STATUSES.has(workItem.status)) return null;
  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE work_item_id = ?
      AND status NOT IN (${TERMINAL_JOB_STATUSES.map(() => "?").join(",")})
    ORDER BY id
  `).all(Number(workItem.id), ...TERMINAL_JOB_STATUSES);
  if (jobs.length === 0) return null;
  const gates = db.prepare(`
    SELECT hg.*, j.status AS job_status, j.payload_json
    FROM human_gates hg
    JOIN jobs j ON j.id = hg.gate_job_id
    WHERE j.work_item_id = ?
      AND hg.gate_state IN ('open','resolving')
    ORDER BY hg.gate_job_id
  `).all(Number(workItem.id)).filter((gate) => OPERATOR_PARKING_GATE_KINDS.has(String(gate.gate_kind || "")));
  if (gates.length === 0) return null;
  const gateIds = new Set(gates.map((gate) => Number(gate.gate_job_id)));
  const dependencies = db.prepare(`
    SELECT jd.job_id, jd.depends_on_job_id
    FROM job_dependencies jd
    JOIN jobs j ON j.id = jd.job_id
    WHERE j.work_item_id = ? AND jd.dependency_kind = 'hard'
  `).all(Number(workItem.id));
  const byJob = new Map();
  for (const dep of dependencies) {
    const list = byJob.get(Number(dep.job_id)) || [];
    list.push(Number(dep.depends_on_job_id));
    byJob.set(Number(dep.job_id), list);
  }
  const reachesGate = (jobId, seen = new Set()) => {
    const id = Number(jobId);
    if (gateIds.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byJob.get(id) || []).some((depId) => reachesGate(depId, seen));
  };
  if (!jobs.every((job) => reachesGate(job.id))) return null;
  const gate = gates[0];
  return {
    work_item_id: Number(workItem.id),
    reason: "operator_gate",
    gate_job_id: Number(gate.gate_job_id),
    gate_job_ids: gates.map((entry) => Number(entry.gate_job_id)),
    gate_state: gate.gate_state,
    review_type: parseJobPayload(gate)?.review_type || null,
    gate_kind: gate.gate_kind,
    parked_at: gate.created_at || null,
  };
}

/**
 * Why a completed, unmerged work item will not merge until an operator acts,
 * or null when it merges on its own during this run (finding 1, run 1250b).
 * Such a "parked" work item is not progressing toward merge, so it must not
 * hold other work items in the work-item order: an open gate on it (a
 * cross-WI upstream disposition, a merge verification review, or any gate
 * whose answer refuses automatic merge), a failed merge, a merge dependency
 * on a failed or canceled upstream, automatic merge being off for it, or a
 * merge dependency on an upstream that is itself parked. Returns
 * `{ work_item_id, reason, ... }`; see describeWorkItemMergeParking.
 */
export function workItemMergeParking(workItemOrId, { db = getDb(), visited = null } = {}) {
  const workItem = workItemOrId && typeof workItemOrId === "object"
    ? workItemOrId
    : readWorkItemRow(db, workItemOrId);
  if (!workItem) return null;
  if (workItem.status !== "complete") return workItemOperatorParking(workItem, { db });
  if (!completeWorkItemHoldsFileLocks(workItem)) return null;
  const id = Number(workItem.id);
  // The same gate authorizeWorkItemAutoMerge refuses on (merge-holding-gate.js).
  const gate = findMergeHoldingGate(id, db);
  if (gate) {
    return {
      work_item_id: id,
      reason: "human_gate",
      gate_job_id: gate.gate_job_id,
      gate_state: gate.gate_state,
      review_type: gate.review_type,
      resolution_action: gate.resolution_action,
    };
  }
  if (workItem.merge_state === "merge_failed") return { work_item_id: id, reason: "merge_failed" };
  const seen = visited || new Set([id]);
  const liveUpstreams = [];
  for (const dep of getWorkItemMergeDependencies(workItem)) {
    const sourceId = Number(dep.source_work_item_id);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || sourceId === id) continue;
    const source = readWorkItemRow(db, sourceId);
    if (!source || source.merge_state === "merged") continue;
    if (WI_LOCK_RELEASE_STATUSES.has(source.status)) {
      return { work_item_id: id, reason: "upstream_failed", upstream_work_item_id: sourceId, upstream_status: source.status };
    }
    liveUpstreams.push(source);
  }
  if (!completeWorkItemAutoMerges(workItem)) return { work_item_id: id, reason: "not_auto_merged" };
  for (const source of liveUpstreams) {
    const sourceId = Number(source.id);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const upstream = workItemMergeParking(source, { db, visited: seen });
    if (upstream) return { work_item_id: id, reason: "upstream_parked", upstream_work_item_id: sourceId, upstream };
  }
  return null;
}

/** Operator-facing text for a workItemMergeParking result. */
export function describeWorkItemMergeParking(parking) {
  if (!parking) return "";
  const label = `WI#${parking.work_item_id}`;
  switch (parking.reason) {
    case "human_gate": {
      const kind = parking.review_type ? ` ${parking.review_type}` : "";
      return parking.gate_state === "resolved"
        ? `${label} is held out of automatic merge by gate #${parking.gate_job_id}${kind} (answered ${parking.resolution_action})`
        : `${label} waits on operator gate #${parking.gate_job_id}${kind}`;
    }
    case "operator_gate": {
      const kind = parking.review_type || parking.gate_kind;
      const suffix = kind ? ` ${kind}` : "";
      const also = Array.isArray(parking.gate_job_ids) && parking.gate_job_ids.length > 1
        ? ` (also gates ${parking.gate_job_ids.slice(1).map((id) => `#${id}`).join(", ")})`
        : "";
      return `${label} is parked on operator gate #${parking.gate_job_id}${suffix}${also}`;
    }
    case "merge_failed":
      return `${label} failed to merge and waits for an operator`;
    case "upstream_failed":
      return `${label} must merge after WI#${parking.upstream_work_item_id}, which ${parking.upstream_status}`;
    case "not_auto_merged":
      return `${label} is not merged automatically by this run (it waits for merge review)`;
    case "upstream_parked":
      return `${label} must merge after WI#${parking.upstream_work_item_id}; ${describeWorkItemMergeParking(parking.upstream)}`;
    case "auto_merge_stalled": {
      const waited = Number.isFinite(Number(parking.waited_ms)) ? ` for ${Math.round(Number(parking.waited_ms) / 1000)}s` : "";
      return `${label} completed but has not merged automatically (no merge in flight${waited}); merge or review it`;
    }
    default:
      return `${label} cannot merge without an operator`;
  }
}

function activeJobLocks(db, {
  workItemId = null,
  usePathTouchScope = false,
} = {}) {
  const wiId = Number(workItemId);
  const scopedToWorkItem = workItemId != null && Number.isFinite(wiId);
  const jobs = db.prepare(`
    SELECT *
    FROM jobs
    WHERE job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
      ${scopedToWorkItem ? "AND work_item_id = ?" : ""}
  `).all(...QUEUE_LOCKING_JOB_TYPES_LIST, ...(scopedToWorkItem ? [wiId] : []));

  const isActiveInnerLockJob = (job) => {
    if (!jobNeedsWriteLocks(job)) return false;
    // An assess-only retry owns the WI barrier from lease acquisition through
    // assessment. Parked states do not execute and must not freeze the WI.
    if (jobNeedsAssessmentBarrier(job)) return ACTIVE_ASSESSMENT_BARRIER_STATUSES.has(job.status);
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
    const scope = usePathTouchScope
      ? getJobPathTouchScope(job)
      : getJobWriteScope(job);
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

/**
 * Load the work-item order (see work-item-order.js) from queue state. A
 * work item's planned scope is the path-touch scope of its non-terminal
 * repo-writing jobs; jobs with no declared scope are left to the lock layer,
 * which already serializes them against everything. A scheduler scoped to
 * some work items passes them as `runnableWorkItemIds`: an unstarted work item
 * it will not run cannot start now, so it does not hold the scoped ones back.
 *
 * Only work items that progress toward merge on their own are ordered: active
 * ones, and completed ones this run merges. A completed work item parked
 * until an operator acts (workItemMergeParking) is left out, so it never holds
 * another work item in the order (finding 1, run 1250b: an order wait on WI
 * 169, parked behind its upstream gate, never released and the headless run
 * never finished). The lock layer still sees its held locks: a job that
 * needs one of them waits until the operator settles the parked work item
 * (the scheduler finishes the run as needs-action naming it and its gate),
 * and nothing is copied out of it (run 1250b red team 2, finding 1). The
 * parked work items are listed in `order.parked`.
 *
 * A job counts toward its work item's "can start now" tier only once its
 * ready_at has passed: a work item whose only startable job is backing off or
 * waiting out a provider quota pause does not go ahead of one that can start
 * now. (A work item that already ran a job holds its locks and keeps its place
 * by first lock time; this only reorders work items that have not started.)
 */
export function loadWorkItemOrder(db = getDb(), { workItemLocks = null, runnableWorkItemIds = null } = {}) {
  const runnable = Array.isArray(runnableWorkItemIds) && runnableWorkItemIds.length > 0
    ? new Set(runnableWorkItemIds.map(Number))
    : null;
  const activeWorkItemSql = `
    wi.status NOT IN ('failed','canceled')
    AND COALESCE(wi.merge_state, '') != 'merged'
    AND (
      wi.status != 'complete'
      OR (
        COALESCE(TRIM(wi.branch_name), '') != ''
        AND COALESCE(wi.merge_state, '') IN ${COMPLETE_WI_LOCK_HOLDING_MERGE_STATES_SQL}
      )
    )
  `;
  const candidates = db.prepare(`
    SELECT
      wi.id,
      wi.status,
      wi.merge_state,
      wi.branch_name,
      wi.metadata_json,
      (
        SELECT MIN(first_lock.acquired_at)
        FROM work_item_file_locks first_lock
        WHERE first_lock.work_item_id = wi.id
      ) AS first_lock_at
    FROM work_items wi
    WHERE ${activeWorkItemSql}
  `).all();
  const parked = new Map();
  for (const wi of candidates) {
    const parking = workItemMergeParking(wi, { db });
    if (parking) parked.set(Number(wi.id), parking);
  }
  const withParked = (order) => Object.assign(order, { parked });
  const workItems = candidates.filter((wi) => !parked.has(Number(wi.id)));
  if (workItems.length === 0) return withParked(buildWorkItemOrder([]));
  const entries = new Map(workItems.map((wi) => [Number(wi.id), {
    id: Number(wi.id),
    status: wi.status,
    merge_state: wi.merge_state ?? null,
    started: wi.first_lock_at != null,
    first_lock_at: wi.first_lock_at ?? null,
    ready: false,
    planned: [],
    held: [],
    merge_after: getWorkItemMergeDependencies(wi).map((dep) => Number(dep.source_work_item_id)),
  }]));
  // `dispatchable`: queued, past its ready_at, with every hard dependency
  // met, so it could start now (as opposed to waiting on a plan approval
  // gate, earlier jobs, a retry backoff or a provider quota pause).
  const jobs = db.prepare(`
    SELECT
      j.*,
      CASE WHEN j.status = 'queued' AND COALESCE(j.ready_at, '') <= ? AND NOT EXISTS (
        SELECT 1
        FROM job_dependencies jd
        JOIN jobs dep ON dep.id = jd.depends_on_job_id
        WHERE jd.job_id = j.id
          AND jd.dependency_kind = 'hard'
          AND dep.status != 'succeeded'
      ) THEN 1 ELSE 0 END AS dispatchable
    FROM jobs j
    JOIN work_items wi ON wi.id = j.work_item_id
    WHERE j.job_type IN (${QUEUE_LOCKING_JOB_TYPES_SQL})
      AND j.status NOT IN (${TERMINAL_JOB_STATUSES.map(() => "?").join(",")})
      AND ${activeWorkItemSql}
    ORDER BY j.id
  `).all(now(), ...QUEUE_LOCKING_JOB_TYPES_LIST, ...TERMINAL_JOB_STATUSES);
  for (const job of jobs) {
    const entry = entries.get(Number(job.work_item_id));
    if (!entry || !jobNeedsWriteLocks(job)) continue;
    if (job.dispatchable === 1 && (!runnable || runnable.has(entry.id))) entry.ready = true;
    const scope = getJobPathTouchScope(job);
    if (scope.unknown) continue;
    entry.planned.push(...scopeToLockRows(scope));
  }
  for (const lock of workItemLocks || activeWiLocks(db)) {
    entries.get(Number(lock.work_item_id))?.held.push({ path: lock.path, lock_kind: lock.lock_kind });
  }
  return withParked(buildWorkItemOrder([...entries.values()]));
}

/**
 * Work-item order gate for a repo-writing job: the earliest unmerged work
 * item ordered before this job's work item whose planned scope or held locks
 * overlap this work item's planned scope (this job's own scope included).
 * The job waits until that work item merges, fails or is canceled, then
 * starts from the target branch (dev and fix setup merges it in), so no
 * unmerged commits are synced across work items. The gate is per work item:
 * a sibling job with a disjoint scope waits too, so the work item takes no
 * work-item lock an earlier one may need later (run 1250b red team 2,
 * finding 4). Assessment barriers only re-check finished work and never wait.
 */
export function findWorkItemOrderConflict(job, order = null) {
  if (!jobNeedsWriteLocks(job) || jobNeedsAssessmentBarrier(job)) return null;
  const resolved = order || loadWorkItemOrder();
  const ownScope = getJobPathTouchScope(job);
  const hit = findWorkItemOrderUpstream(
    resolved,
    job.work_item_id,
    ownScope.unknown ? [] : scopeToLockRows(ownScope),
  );
  if (!hit) return null;
  return {
    type: "work_item",
    work_item_order: true,
    lock: {
      id: null,
      lock_tier: "work_item_order",
      job_id: null,
      work_item_id: hit.upstream.id,
      work_item_status: hit.upstream.status ?? null,
      merge_state: hit.upstream.merge_state ?? null,
      path: hit.holder.path,
      lock_kind: hit.holder.lock_kind,
    },
    candidate: { path: hit.candidate.path, lock_kind: hit.candidate.lock_kind },
    wait_state: { reason: WORK_ITEM_ORDER_WAIT_REASON, upstream_work_item_id: hit.upstream.id },
  };
}

export function findWriteLockConflict(job, scope = getJobWriteScope(job), snapshot = null, {
  workItemOrder = true,
  runnableWorkItemIds = null,
} = {}) {
  if (!jobNeedsWriteLocks(job) || !hasWriteScope(scope)) return null;
  const db = getDb();
  if (!jobNeedsAssessmentBarrier(job)) {
    if (workItemOrder) {
      const orderConflict = findWorkItemOrderConflict(
        job,
        snapshot?.work_item_order || loadWorkItemOrder(db, { runnableWorkItemIds }),
      );
      if (orderConflict) return orderConflict;
    }
    const wiConflict = locksConflict(scope, snapshot?.work_items || activeWiLocks(db), {
      allowWorkItemId: job.work_item_id,
      ignoreSameWorkItemLocks: true,
    });
    if (wiConflict) return { type: "work_item", ...wiConflict };
  }
  const sameWorkItemJobLocks = snapshot
    ? snapshot.jobs.filter((lock) => Number(lock.work_item_id) === Number(job.work_item_id))
    : activeJobLocks(db, { workItemId: job.work_item_id });
  const allowJobIds = new Set([
    ...ancestorJobIdsForJob(job, db),
    ...queuedCohortJobIdsForJob(job, db),
    ...queuedDependentJobIdsForJob(job, db),
  ]);
  const jobConflict = locksConflict(scope, sameWorkItemJobLocks, {
    allowJobId: job.id,
    allowJobIds,
    allowWorkItemId: job.work_item_id,
  });
  if (jobConflict) return { type: "job", ...jobConflict };
  return null;
}

/**
 * Atomically move a leased job into awaiting_assessment. Worktree-locking code
 * writers also widen to the WI-local assessment barrier; queued and parked
 * siblings may remain, but another live same-WI writer makes acquisition fail.
 * DB-only and non-worktree jobs transition without creating a file barrier.
 */
export function acquireAssessmentBarrier(jobId, leaseToken) {
  const db = getDb();
  const id = Number(jobId);
  const result = runImmediateTransaction(db, () => {
    const fresh = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    const leaseCutoff = new Date(leaseNowMs()).toISOString();
    if (!fresh
      || fresh.lease_token !== leaseToken
      || !LEASE_HOLDING_STATUSES.includes(fresh.status)
      || !fresh.lease_expires_at
      || fresh.lease_expires_at < leaseCutoff) {
      return { ok: false, reason: "lease_invalid", blockers: [] };
    }

    const needsBarrier = jobCanUseAssessmentBarrier(fresh);
    if (needsBarrier) {
      const blockers = activeJobLocks(db, { workItemId: fresh.work_item_id }).filter((lock) => (
        Number(lock.job_id) !== id
        && lock.job_status !== "queued"
        && !PARKED_JOB_STATUS_SET.has(lock.job_status)
      ));
      if (blockers.length > 0) {
        return { ok: false, reason: "sibling_writers", blockers };
      }
    }

    const ts = now();
    const updated = db.prepare(`
      UPDATE jobs
      SET status = 'awaiting_assessment',
          updated_at = ?,
          state_version = state_version + 1
      WHERE id = ?
        AND lease_token = ?
        AND status IN (${LEASE_HOLDING_STATUSES.map(() => "?").join(",")})
    `).run(ts, id, leaseToken, ...LEASE_HOLDING_STATUSES);
    if (updated.changes !== 1) {
      return { ok: false, reason: "lease_invalid", blockers: [] };
    }
    if (needsBarrier) {
      insertJobLocks(
        db,
        { ...fresh, status: "awaiting_assessment" },
        { files: [], roots: ["*"] },
        ts,
        "assessment_barrier",
      );
    }
    logEvent({
      work_item_id: fresh.work_item_id,
      job_id: id,
      event_type: EVENT_TYPES.JOB_STATUS_CHANGED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: "Status -> awaiting_assessment",
    });
    return { ok: true, reason: null, blockers: [], barrier: needsBarrier };
  });
  if (result.ok) {
    notifyQueueStateChanged({
      reason: "job_status_awaiting_assessment",
      jobId: id,
    });
  }
  return result;
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

// A queued job that hard-depends on `job`, directly or through other queued
// jobs, cannot run before it. Its phantom (queued-status) lock therefore
// must not block `job`: a retry promote spawned by dead-letter recovery had
// its former dependents rewired onto it, and those dependents' queued locks
// on the shared destination root then held the retry off the lane forever.
export function queuedDependentJobIdsForJob(job, db = getDb()) {
  const ids = new Set();
  if (!job?.id) return ids;
  const dependents = db.prepare(`
    SELECT jd.job_id
    FROM job_dependencies jd
    JOIN jobs j ON j.id = jd.job_id
    WHERE jd.depends_on_job_id = ?
      AND j.status = 'queued'
  `);
  const frontier = [Number(job.id)];
  while (frontier.length > 0) {
    const current = frontier.pop();
    for (const row of dependents.all(current)) {
      const id = Number(row.job_id);
      if (!Number.isFinite(id) || ids.has(id) || id === Number(job.id)) continue;
      ids.add(id);
      frontier.push(id);
    }
  }
  return ids;
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

// Paths in a work item's shared worktree that belong to another live job of
// that work item: covered by its active write locks, or created empty for it
// by handoff materialization. A test run by one job must not reset them as if
// they were its own side effects.
export function siblingOwnedWorktreePaths(jobId, paths = []) {
  const id = Number(jobId);
  const owned = new Set();
  const inputs = (Array.isArray(paths) ? paths : []).filter((value) => normalizeLockPath(value));
  if (!Number.isFinite(id) || inputs.length === 0) return owned;
  const db = getDb();
  const job = db.prepare("SELECT work_item_id FROM jobs WHERE id = ?").get(id);
  if (!job?.work_item_id) return owned;
  const locks = db.prepare(`
    SELECT l.path, l.lock_kind
    FROM job_file_locks l
    JOIN jobs j ON j.id = l.job_id
    WHERE j.work_item_id = ? AND l.job_id != ? AND l.released_at IS NULL
  `).all(job.work_item_id, id);
  const placeholders = TERMINAL_JOB_STATUSES.map(() => "?").join(",");
  const materialized = new Set(db.prepare(`
    SELECT m.path
    FROM file_materializations m
    JOIN jobs j ON j.id = m.job_id
    WHERE j.work_item_id = ? AND m.job_id != ? AND j.status NOT IN (${placeholders})
  `).all(job.work_item_id, id, ...TERMINAL_JOB_STATUSES)
    .map((row) => normalizeLockPath(row.path))
    .filter(Boolean));
  for (const input of inputs) {
    const target = normalizeLockPath(input);
    if (materialized.has(target)) {
      owned.add(input);
      continue;
    }
    const covered = locks.some((row) => {
      const lockPath = normalizeLockPath(row.path);
      if (!lockPath) return false;
      if (lockPath === "*") return true;
      if (row.lock_kind === "file") return lockPath === target;
      if (row.lock_kind === "root") return target === lockPath || isUnderRoot(target, [lockPath]);
      return false;
    });
    if (covered) owned.add(input);
  }
  return owned;
}

// Paths that belong to another unfinished job of the same work item: its live
// locks and placeholders, or its declared write scope even before it leases.
// Recovery jobs inferred from assessor or test output must not take these
// over (WI 149, 2026-10-01: a trivia fix job inherited the tarot and
// dongs-search files that sibling tasks still owned).
export function siblingJobScopePaths(jobId, paths = []) {
  const owned = siblingOwnedWorktreePaths(jobId, paths);
  const id = Number(jobId);
  const inputs = (Array.isArray(paths) ? paths : []).filter((value) => normalizeLockPath(value));
  if (!Number.isFinite(id) || inputs.length === 0) return owned;
  const db = getDb();
  const job = db.prepare("SELECT work_item_id FROM jobs WHERE id = ?").get(id);
  if (!job?.work_item_id) return owned;
  const placeholders = TERMINAL_JOB_STATUSES.map(() => "?").join(",");
  const siblings = db.prepare(`
    SELECT id, job_type, payload_json
    FROM jobs
    WHERE work_item_id = ? AND id != ? AND status NOT IN (${placeholders})
  `).all(job.work_item_id, id, ...TERMINAL_JOB_STATUSES)
    .filter((sibling) => MUTATING_JOB_TYPES.has(sibling.job_type));
  for (const sibling of siblings) {
    const scope = getJobPathTouchScope(sibling);
    if (scope.unknown) continue;
    const files = new Set((scope.files || []).map((value) => normalizeLockPath(value)).filter(Boolean));
    const roots = (scope.roots || []).map((value) => normalizeLockPath(value)).filter((value) => value && value !== "*");
    for (const input of inputs) {
      const target = normalizeLockPath(input);
      if (files.has(target) || roots.some((root) => target === root || isUnderRoot(target, [root]))) owned.add(input);
    }
  }
  return owned;
}

/** Map each requested path to unfinished sibling jobs whose declared/live scope covers it. */
export function siblingJobScopeOwners(jobId, paths = []) {
  const id = Number(jobId);
  const inputs = (Array.isArray(paths) ? paths : []).filter((value) => normalizeLockPath(value));
  const owners = new Map(inputs.map((input) => [input, new Set()]));
  if (!Number.isFinite(id) || inputs.length === 0) return owners;
  const db = getDb();
  const job = db.prepare("SELECT work_item_id FROM jobs WHERE id = ?").get(id);
  if (!job?.work_item_id) return owners;
  const placeholders = TERMINAL_JOB_STATUSES.map(() => "?").join(",");
  const siblings = db.prepare(`
    SELECT id, job_type, payload_json
    FROM jobs
    WHERE work_item_id = ? AND id != ? AND status NOT IN (${placeholders})
  `).all(job.work_item_id, id, ...TERMINAL_JOB_STATUSES)
    .filter((sibling) => MUTATING_JOB_TYPES.has(sibling.job_type));
  for (const sibling of siblings) {
    const scope = getJobPathTouchScope(sibling);
    if (scope.unknown) continue;
    const files = new Set((scope.files || []).map((value) => normalizeLockPath(value)).filter(Boolean));
    const roots = (scope.roots || []).map((value) => normalizeLockPath(value)).filter((value) => value && value !== "*");
    for (const input of inputs) {
      const target = normalizeLockPath(input);
      if (files.has(target) || roots.some((root) => target === root || isUnderRoot(target, [root]))) {
        owners.get(input)?.add(Number(sibling.id));
      }
    }
  }
  return owners;
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
  // Peer claims are an advisory warning only. Run this before the local-lock
  // fast path so a job that correctly owns its local lock still learns that a
  // different clone may be editing the same file. The authoritative local
  // lock result below is unchanged.
  if (sharedTrunkClaimsEnabled()) warnForPeerClaimAtToolWrite(job, target);
  if (jobHoldsWriteLockForPath(job.id, target)) return { ok: true, held: true };

  const scope = { files: [target], roots: [] };
  // The work-item order gates when a job starts; once running, it is only
  // refused paths that another work item or job actually holds.
  const toolTimeConflict = () => findWriteLockConflict(job, scope, null, { workItemOrder: false });
  return runImmediateTransaction(db, () => {
    if (jobHoldsWriteLockForPath(job.id, target)) return { ok: true, held: true };
    let conflict = toolTimeConflict();
    if (conflict) {
      const cleaned = cleanupStaleFileLocks();
      if (cleaned.job_locks_released > 0 || cleaned.wi_locks_released > 0) {
        conflict = toolTimeConflict();
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
  if (conflict.work_item_order) {
    return `Write scope blocked: WI#${conflict.lock.work_item_id} also plans edits to ${path} and is ordered first; waiting for it to merge`;
  }
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
    FROM queue_event_state
    WHERE job_id = ? AND event_type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(job.id, EVENT_TYPES.JOB_WRITE_LOCK_BLOCKED);
  if (previous?.message === message) return false;
  logDurableEvent({
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
  return runImmediateTransaction(db, () => {
    const fresh = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(job.id);
    if (!fresh || fresh.status !== "queued") return null;

    const assessmentBarrier = jobNeedsAssessmentBarrier(fresh);
    // The in-memory scheduler scan is advisory. Recheck transactionally even
    // when it passes skipConflictCheck so a same-WI assessment barrier cannot
    // race with a disjoint writer between the scan and lease mutation.
    if (needsWriteLocks && hasScope) {
      const conflictOpts = { runnableWorkItemIds: opts?.runnableWorkItemIds ?? null };
      let conflict = findWriteLockConflict(fresh, scope, null, conflictOpts);
      if (conflict) {
        const cleaned = cleanupStaleFileLocks();
        if (cleaned.job_locks_released > 0 || cleaned.wi_locks_released > 0) {
          conflict = findWriteLockConflict(fresh, scope, null, conflictOpts);
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
      if (!assessmentBarrier) insertMissingWiLocks(db, fresh, scope, ts);
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
  const released = releaseWorkItemFileLocks(workItemId, "work_item_merged");
  restoreExistingOrderClaimLocks(workItemId);
  return released;
}

/**
 * When a work item merges, give back the file locks that were released to it
 * in "existing order" (see the scheduler's cross-WI handoff): each releasing
 * work item still has pending edits to those paths and merges later. Without
 * the lock, another work item could take the path from the merged target and
 * edit it without those edits, which then conflict at merge. The restored
 * lock is marked hold-until-merge so it is never handed off by copy.
 */
function restoreExistingOrderClaimLocks(mergedWorkItemId) {
  const db = getDb();
  const mergedId = Number(mergedWorkItemId);
  if (!Number.isInteger(mergedId) || mergedId <= 0) return 0;
  const claims = new Map();
  for (const row of db.prepare(`SELECT id, payload_json FROM jobs WHERE work_item_id = ?`).all(mergedId)) {
    const releases = parseJobPayload(row)?._cross_wi_existing_order_releases;
    for (const entry of Array.isArray(releases) ? releases : []) {
      const claimantId = Number(entry?.source_work_item_id);
      const lockPath = normalizeLockPath(entry?.path);
      const lockKind = entry?.lock_kind === "root" ? "root" : "file";
      if (!Number.isInteger(claimantId) || claimantId <= 0 || claimantId === mergedId || !lockPath) continue;
      claims.set(`${claimantId}\0${lockKind}\0${lockPath}`, { claimantId, lockPath, lockKind, jobId: row.id });
    }
  }
  if (claims.size === 0) return 0;
  const readWorkItem = db.prepare(`SELECT id, status, branch_name, merge_state FROM work_items WHERE id = ?`);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO work_item_file_locks (work_item_id, path, lock_kind, source_job_id, acquired_at, metadata_json)
    VALUES (?, ?, ?, NULL, ?, ?)
  `);
  const ts = now();
  const restored = [];
  for (const claim of claims.values()) {
    const claimant = readWorkItem.get(claim.claimantId);
    if (!claimant || claimant.merge_state === "merged") continue;
    if (WI_LOCK_RELEASE_STATUSES.has(claimant.status)) continue;
    if (claimant.status === "complete" && !completeWorkItemHoldsFileLocks(claimant)) continue;
    const metadata = JSON.stringify({
      source: "existing_order_claim",
      hold_until_merge: true,
      restored_from_work_item_id: mergedId,
      released_via_job_id: claim.jobId,
    });
    if (insert.run(claim.claimantId, claim.lockPath, claim.lockKind, ts, metadata).changes > 0) restored.push(claim);
  }
  if (restored.length === 0) return 0;
  for (const claim of restored) {
    logEvent({
      work_item_id: claim.claimantId,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_CLAIM_RESTORED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Restored WI#${claim.claimantId}'s lock on ${claim.lockPath} after WI#${mergedId} merged; it stays until WI#${claim.claimantId} merges`,
      event_json: JSON.stringify({
        path: claim.lockPath,
        lock_kind: claim.lockKind,
        restored_from_work_item_id: mergedId,
        released_via_job_id: claim.jobId,
      }),
    });
  }
  notifyQueueStateChanged({ reason: "work_item_locks_restored:existing_order_claim" });
  reconcileFileLaneWaits();
  return restored.length;
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
