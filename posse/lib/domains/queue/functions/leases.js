// Per-job lease primitives. Workers acquire a lease (CAS), renew it
// periodically while running, and release it to a final status when
// done. Lease tokens are compare-and-swap on the jobs row so two
// schedulers can't dispatch the same job, and a fresh ownerId can't
// release a lease it doesn't hold.
//
// Lease timestamps come from the shared monotonic-augmented clock in
// lease-clock.js so acquisition, renewal, and requeue all compare values
// from the same source.

import crypto from "crypto";
import { LeaseManager } from "../classes/LeaseManager.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  LEASE_HOLDING_STATUSES_SQL,
  TERMINAL_JOB_STATUSES_SQL,
  now,
  runImmediateTransaction,
} from "./common.js";
import { logEvent } from "./events.js";
import { isLeaseValid } from "./attempts.js";
import {
  acquireLeaseWithWriteLocks,
  acquireLeaseWithWriteLocksAsync,
  releaseJobLocksForStatus,
} from "./file-locks.js";
import {
  graceCutoff,
  leaseNowMs,
  leaseRequeueGraceSec,
} from "./lease-clock.js";
import { rollbackPendingCrossWiSyncHandoffsForJob } from "./cross-wi-deps.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

let DEFAULT_LEASE_MANAGER = null;

export {
  __testSetLeaseClockForTests,
  graceCutoff,
  leaseNowMs,
  leaseRequeueGraceSec,
} from "./lease-clock.js";

/**
 * Atomically lease a queued job. Returns { leaseToken } or null if already leased.
 */
export function acquireLease(jobId, ownerId, leaseDurationSec = 900) {
  const db = getDb();
  const leaseToken = crypto.randomUUID();
  const nowMs = leaseNowMs();
  const expiresAt = new Date(nowMs + leaseDurationSec * 1000).toISOString();

  // CAS: only lease if still queued
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'leased',
        lease_owner = ?,
        lease_token = ?,
        lease_expires_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(ownerId, leaseToken, expiresAt, now(), jobId);

  if (result.changes === 0) return null;

  logEvent({
    job_id: jobId,
    event_type: EVENT_TYPES.JOB_LEASED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    actor_id: ownerId,
    message: `Leased until ${expiresAt}`,
  });

  return { leaseToken };
}

/**
 * Extend an active lease's expiration. Used by workers to keep leases alive
 * while jobs are still running. Validates the lease token (CAS) — returns
 * false if the lease was already requeued by the scheduler.
 */
export function renewLease(jobId, leaseToken, leaseDurationSec = 900) {
  const db = getDb();
  const nowMs = leaseNowMs();
  const expiresAt = new Date(nowMs + leaseDurationSec * 1000).toISOString();
  const currentTs = now();
  const renewalCutoff = new Date(nowMs - leaseRequeueGraceSec() * 1000).toISOString();
  const result = db.prepare(`
    UPDATE jobs
    SET lease_expires_at = CASE
          WHEN lease_expires_at > ? THEN lease_expires_at
          ELSE ?
        END,
        updated_at = ?
    WHERE id = ? AND lease_token = ?
      AND status IN (${LEASE_HOLDING_STATUSES_SQL})
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at >= ?
  `).run(expiresAt, expiresAt, currentTs, jobId, leaseToken, renewalCutoff);
  return result.changes > 0;
}

/**
 * Release a lease, setting the job to a final status.
 * Validates the lease token to prevent stale releases.
 */
function releaseLeaseInternal(db, jobId, leaseToken, finalStatus, { readyAt = null } = {}) {
  const ts = now();
  const result = db.prepare(`
    UPDATE jobs
    SET status = ?,
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        finished_at = CASE WHEN ? IN (${TERMINAL_JOB_STATUSES_SQL}) THEN ? ELSE finished_at END,
        ready_at = COALESCE(?, ready_at),
        last_error = CASE WHEN ? = 'succeeded' THEN NULL ELSE last_error END,
        updated_at = ?
    WHERE id = ? AND lease_token = ? AND status IN (${LEASE_HOLDING_STATUSES_SQL})
  `).run(finalStatus, finalStatus, ts, readyAt, finalStatus, ts, jobId, leaseToken);

  if (result.changes === 0) {
    // Lease token mismatch — someone else has it or it was requeued
    return false;
  }

  logEvent({
    job_id: jobId,
    event_type: EVENT_TYPES.JOB_LEASE_RELEASED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    message: `Released with status ${finalStatus}${readyAt ? ` (retry after ${readyAt})` : ''}`,
  });

  if (finalStatus === "dead_letter" || finalStatus === "canceled") {
    rollbackPendingCrossWiSyncHandoffsForJob(jobId, `job_${finalStatus}`);
  }
  releaseJobLocksForStatus(jobId, finalStatus);
  const job = db.prepare(`SELECT work_item_id FROM jobs WHERE id = ?`).get(jobId);
  notifyQueueStateChanged({
    reason: `lease_released_${finalStatus}`,
    jobId,
    workItemId: job?.work_item_id,
  });

  return true;
}

export function releaseLease(jobId, leaseToken, finalStatus, { readyAt = null } = {}) {
  const db = getDb();
  const execute = () => releaseLeaseInternal(db, jobId, leaseToken, finalStatus, { readyAt });
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function releaseLeaseWithoutAttemptPenalty(jobId, leaseToken, finalStatus, { readyAt = null } = {}) {
  const db = getDb();
  const execute = () => {
    const released = releaseLeaseInternal(db, jobId, leaseToken, finalStatus, { readyAt });
    if (released) {
      // Inline of decrementAttemptCount to keep this module free of an
      // import back into queue/index.js.
      db.prepare(`UPDATE jobs SET attempt_count = MAX(0, attempt_count - 1), updated_at = ? WHERE id = ?`)
        .run(now(), jobId);
    }
    return released;
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function getLeaseManager({ defaultDurationSec = 900 } = {}) {
  if (!DEFAULT_LEASE_MANAGER || DEFAULT_LEASE_MANAGER.defaultDurationSec !== defaultDurationSec) {
    DEFAULT_LEASE_MANAGER = LeaseManager.fromQueueFns({
      acquireLease,
      acquireLeaseWithWriteLocks,
      acquireLeaseWithWriteLocksAsync,
      renewLease,
      releaseLease,
      releaseLeaseWithoutAttemptPenalty,
      // requeueExpiredLeases is still owned by queue/index.js so it can
      // call refreshWorkItemStatus inline. Resolve at LeaseManager use
      // time via the queue facade attached below.
      requeueExpiredLeases: requeueExpiredLeasesBridge,
      isLeaseValid,
    }, { defaultDurationSec });
  }
  return DEFAULT_LEASE_MANAGER;
}

// A lazy bridge so the LeaseManager can call the requeue-expired path
// without leases.js statically importing queue/index.js (which would
// invert the sibling-module convention). Set by queue/index.js after
// it defines requeueExpiredLeases.
let _requeueExpiredLeasesFn = null;
function requeueExpiredLeasesBridge(...args) {
  if (typeof _requeueExpiredLeasesFn !== "function") {
    throw new Error("requeueExpiredLeases bridge not registered yet — queue/index.js must wire it during module load");
  }
  return _requeueExpiredLeasesFn(...args);
}

export function __registerRequeueExpiredLeases(fn) {
  _requeueExpiredLeasesFn = fn;
}
