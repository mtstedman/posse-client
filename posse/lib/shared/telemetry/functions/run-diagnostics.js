import {
  appendRunTelemetry,
  listRunTelemetryManifests,
  updateRunTelemetryManifest,
} from "./run-telemetry.js";
import { collectMemorySnapshot } from "./memory.js";
import { getDb } from "../../storage/functions/index.js";
import { getRuntimeDbPath } from "../../../domains/runtime/functions/paths.js";
import { LEASE_HOLDING_STATUSES_SQL } from "../../../catalog/job.js";

const DEFAULT_HEARTBEAT_MS = 30_000;
let _heartbeatTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, tableName) {
  try {
    return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(tableName);
  } catch {
    return false;
  }
}

function one(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; } catch { return null; }
}

function all(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function summarizeLock(lock) {
  if (!lock) return null;
  return {
    lock_name: lock.lock_name || null,
    owner_id: lock.owner_id || null,
    acquired_at: lock.acquired_at || null,
    expires_at: lock.expires_at || null,
    updated_at: lock.updated_at || null,
  };
}

function summarizeActiveWorkers(activeWorkers) {
  let value = activeWorkers;
  try {
    if (typeof value === "function") value = value();
  } catch {
    value = null;
  }
  if (!value) return { count: 0, jobs: [] };
  if (value instanceof Map) {
    const jobs = Array.from(value.entries()).slice(0, 20).map(([jobId, item]) => ({
      job_id: Number(jobId),
      work_item_id: item?.job?.work_item_id ?? null,
      job_type: item?.job?.job_type ?? null,
      status: item?.job?.status ?? null,
      started_at_ms: Number.isFinite(item?.startTime) ? item.startTime : null,
      running_ms: Number.isFinite(item?.startTime) ? Math.max(0, Date.now() - item.startTime) : null,
    }));
    return { count: value.size, jobs };
  }
  if (Array.isArray(value)) return { count: value.length, jobs: value.slice(0, 20) };
  return { count: 0, jobs: [] };
}

function collectDbHeartbeat() {
  let db;
  try { db = getDb(); } catch { return { ok: false }; }
  const out = {
    ok: true,
    db_path: getRuntimeDbPath(),
  };
  if (tableExists(db, "jobs")) {
    out.job_status_counts = all(db, `
      SELECT status, COUNT(*) AS count
      FROM jobs
      GROUP BY status
      ORDER BY status
    `).map((row) => ({ status: row.status, count: Number(row.count || 0) }));
    out.active_jobs = all(db, `
      SELECT id, work_item_id, job_type, status, lease_owner, lease_expires_at, started_at, updated_at
      FROM jobs
      WHERE lease_owner IS NOT NULL
         OR status IN (${LEASE_HOLDING_STATUSES_SQL})
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
      LIMIT 20
    `);
  }
  if (tableExists(db, "scheduler_locks")) {
    out.scheduler_lock = summarizeLock(one(db, `SELECT * FROM scheduler_locks WHERE lock_name = ?`, ["main"]));
  }
  if (tableExists(db, "events")) {
    out.head_event_id = Number(one(db, `SELECT COALESCE(MAX(id), 0) AS id FROM events`)?.id || 0);
  }
  if (tableExists(db, "agent_calls")) {
    out.running_agent_calls = Number(one(db, `SELECT COUNT(*) AS count FROM agent_calls WHERE status = 'running'`)?.count || 0);
  }
  return out;
}

export function recordRunDiagnostic(kind, data = {}) {
  const entry = {
    kind: String(kind || "diagnostic"),
    ...data,
  };
  appendRunTelemetry("diagnostics", entry);
  return entry;
}

export function getPreviousRunManifest() {
  const manifests = listRunTelemetryManifests({ includeCurrent: false });
  return manifests.length > 0 ? manifests[manifests.length - 1] : null;
}

export function recordBootCrashResumeMarker(data = {}) {
  const previous = getPreviousRunManifest();
  const previousManifest = previous?.manifest || null;
  const entry = recordRunDiagnostic("boot.start", {
    owner_id: data.ownerId || data.owner_id || null,
    previous_run: previousManifest ? {
      run_id: previousManifest.run_id || previous.run_id,
      started_at: previousManifest.started_at || null,
      ended_at: previousManifest.ended_at || null,
      clean_exit: previousManifest.clean_exit === true,
      last_heartbeat_at: previousManifest.last_heartbeat_at || null,
      scheduler_clean_shutdown_at: previousManifest.scheduler_clean_shutdown_at || null,
    } : null,
    memory: collectMemorySnapshot().memory,
    ...data,
  });
  updateRunTelemetryManifest({
    boot_owner_id: entry.owner_id || null,
    previous_run_id: entry.previous_run?.run_id || null,
    previous_run_clean_exit: entry.previous_run?.clean_exit ?? null,
  });
  return entry;
}

export function recordSchedulerLockDiagnostic(data = {}) {
  const { lock, lockInfo, ...rest } = data;
  return recordRunDiagnostic("scheduler.lock", {
    ...rest,
    lock: summarizeLock(lock || lockInfo || null),
  });
}

export function recordRunHeartbeat({
  ownerId = null,
  reason = "heartbeat",
  activeWorkers = null,
} = {}) {
  const workerSummary = summarizeActiveWorkers(activeWorkers);
  const db = collectDbHeartbeat();
  const entry = {
    kind: "heartbeat",
    owner_id: ownerId,
    reason,
    active_workers: workerSummary,
    db,
    memory: collectMemorySnapshot().memory,
  };
  appendRunTelemetry("heartbeats", entry);
  updateRunTelemetryManifest({
    last_heartbeat_at: nowIso(),
    last_heartbeat_reason: reason,
    last_active_worker_count: workerSummary.count,
    last_db_active_job_count: Array.isArray(db.active_jobs) ? db.active_jobs.length : null,
  });
  return entry;
}

export function startRunHeartbeat({
  ownerId = null,
  intervalMs = DEFAULT_HEARTBEAT_MS,
  activeWorkersProvider = null,
} = {}) {
  stopRunHeartbeat({ ownerId, reason: "replaced" });
  const safeInterval = Math.max(5_000, Number(intervalMs) || DEFAULT_HEARTBEAT_MS);
  const readActiveWorkers = () => {
    if (typeof activeWorkersProvider !== "function") return null;
    return activeWorkersProvider();
  };
  recordRunHeartbeat({ ownerId, reason: "start", activeWorkers: readActiveWorkers });
  _heartbeatTimer = setInterval(() => {
    try {
      recordRunHeartbeat({ ownerId, reason: "timer", activeWorkers: readActiveWorkers });
    } catch {
      // Observational only.
    }
  }, safeInterval);
  _heartbeatTimer.unref?.();
  return (reason = "stop") => stopRunHeartbeat({ ownerId, reason, activeWorkers: readActiveWorkers });
}

export function stopRunHeartbeat({
  ownerId = null,
  reason = "stop",
  activeWorkers = null,
} = {}) {
  if (!_heartbeatTimer) return false;
  clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
  recordRunHeartbeat({ ownerId, reason, activeWorkers });
  return true;
}

export function recordSchedulerShutdownMarker({
  ownerId = null,
  reason = "scheduler_stop",
  activeWorkers = null,
} = {}) {
  const entry = recordRunDiagnostic("scheduler.shutdown", {
    owner_id: ownerId,
    reason,
    active_workers: summarizeActiveWorkers(activeWorkers),
    memory: collectMemorySnapshot().memory,
  });
  updateRunTelemetryManifest({
    scheduler_clean_shutdown_at: nowIso(),
    scheduler_shutdown_reason: reason,
  });
  return entry;
}
