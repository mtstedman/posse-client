import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "./common.js";

function isLockContentionError(err) {
  const code = err?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return code === "SQLITE_CONSTRAINT"
    && /(?:UNIQUE|PRIMARY KEY) constraint failed: scheduler_locks\.lock_name/i.test(err?.message || "");
}

export function acquireSchedulerLock(lockName, ownerId, durationSec = 60) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + durationSec * 1000).toISOString();

  try {
    runImmediateTransaction(db, () => {
      // Clean up only the lock kind we are trying to acquire.
      db.prepare(`DELETE FROM scheduler_locks WHERE lock_name = ? AND expires_at < ?`).run(lockName, now());
      db.prepare(`
        INSERT INTO scheduler_locks (lock_name, owner_id, expires_at)
        VALUES (?, ?, ?)
      `).run(lockName, ownerId, expiresAt);
    });
    return true;
  } catch (err) {
    if (isLockContentionError(err)) return false;
    throw err;
  }
}

export function renewSchedulerLock(lockName, ownerId, durationSec = 60) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + durationSec * 1000).toISOString();
  // Update acquired_at on each renewal so it acts as a heartbeat timestamp.
  // Stale-lock detection checks acquired_at age to determine if the holder is alive.
  const result = db.prepare(`
    UPDATE scheduler_locks
    SET expires_at = ?, acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE lock_name = ? AND owner_id = ?
  `).run(expiresAt, lockName, ownerId);
  return result.changes > 0;
}

export function releaseSchedulerLock(lockName, ownerId) {
  const db = getDb();
  db.prepare(`DELETE FROM scheduler_locks WHERE lock_name = ? AND owner_id = ?`).run(lockName, ownerId);
}

export function getSchedulerLockInfo(lockName) {
  const db = getDb();
  return db.prepare(`SELECT * FROM scheduler_locks WHERE lock_name = ?`).get(lockName) || null;
}

export const LIVE_SCHEDULER_LOCK_GRACE_MS = 60_000;

export function getLiveSchedulerBlockMessage(lockName = "main", { graceMs = LIVE_SCHEDULER_LOCK_GRACE_MS } = {}) {
  let lock = null;
  try {
    lock = getSchedulerLockInfo(lockName);
  } catch {
    return null;
  }
  if (!lock) return null;
  const heartbeatMs = Date.parse(lock.acquired_at || lock.updated_at || lock.expires_at || "");
  const expiresMs = Date.parse(lock.expires_at || "");
  const nowMs = Date.now();
  const heartbeatFresh = Number.isFinite(heartbeatMs) && nowMs - heartbeatMs < graceMs;
  const notExpired = Number.isFinite(expiresMs) && expiresMs > nowMs;
  if (!heartbeatFresh && !notExpired) return null;
  return `scheduler lock is live (owner=${lock.owner_id || "unknown"}). Stop the scheduler or wait for the lock to expire before running this command.`;
}

// Refuse to steal a lock whose heartbeat has advanced within this many seconds.
// Renewed every loop tick by the holder; a fresh acquired_at means the live
// holder is still ticking, so a steal would race a healthy scheduler.
const FORCE_ACQUIRE_LIVENESS_SEC = 30;

export function forceAcquireSchedulerLock(lockName, ownerId, durationSec = 60) {
  const db = getDb();
  const expiresAt = new Date(Date.now() + durationSec * 1000).toISOString();
  const heartbeatCutoff = new Date(Date.now() - FORCE_ACQUIRE_LIVENESS_SEC * 1000).toISOString();
  const result = db.prepare(`
    INSERT INTO scheduler_locks (lock_name, owner_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner_id = excluded.owner_id,
      expires_at = excluded.expires_at,
      acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE scheduler_locks.owner_id = excluded.owner_id
       OR strftime('%s', scheduler_locks.acquired_at) IS NULL
       OR scheduler_locks.acquired_at <= ?
  `).run(lockName, ownerId, expiresAt, heartbeatCutoff);
  return result.changes > 0;
}

export function acquireMergeLock(ownerId, durationSec = 120) {
  return acquireSchedulerLock("merge", ownerId, durationSec);
}

export function releaseMergeLock(ownerId) {
  releaseSchedulerLock("merge", ownerId);
}

// Merge sweeps (ATLAS indexing, retries, multi-WI auto-merge) can run long and
// nothing renews the lease mid-merge, so it must outlive the slowest sweep.
const MERGE_LOCK_LEASE_SEC = 600;
const MERGE_LOCK_OWNER = `merge-${process.pid}`;

export async function withMergeLock(fn, { ownerId = MERGE_LOCK_OWNER, durationSec = MERGE_LOCK_LEASE_SEC } = {}) {
  if (!acquireMergeLock(ownerId, durationSec)) return { acquired: false, result: undefined };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    releaseMergeLock(ownerId);
  }
}
