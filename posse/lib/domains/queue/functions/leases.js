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
  PARKED_JOB_STATUSES,
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

const HUMAN_GATE_RESUME_OPERATION_TYPE = "resume_original_job";
const HUMAN_GATE_RESUMABLE_JOB_STATUSES = new Set([
  ...PARKED_JOB_STATUSES,
  "awaiting_assessment",
]);

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pendingHumanGateResumeEffects(db, jobId) {
  return db.prepare(`
    SELECT *
    FROM human_gate_outbox
    WHERE operation_type = ?
      AND state = 'pending'
      AND json_valid(payload_json)
      AND CAST(json_extract(payload_json, '$.original_job_id') AS INTEGER) = ?
    ORDER BY id
  `).all(HUMAN_GATE_RESUME_OPERATION_TYPE, Number(jobId));
}

function settleHumanGateResumeEffects(db, effects, {
  state = "completed",
  outcome,
  error = null,
} = {}) {
  const ts = now();
  const update = db.prepare(`
    UPDATE human_gate_outbox
    SET state = ?, payload_json = ?, completed_at = ?, updated_at = ?,
        attempt_count = attempt_count + 1, last_error = ?
    WHERE id = ? AND state = 'pending'
  `);
  for (const effect of effects) {
    const payload = {
      ...parseJsonObject(effect.payload_json),
      outcome: String(outcome || state),
      settled_at: ts,
    };
    update.run(
      state,
      JSON.stringify(payload),
      state === "completed" ? ts : null,
      ts,
      error == null ? null : String(error).slice(0, 500),
      effect.id,
    );
  }
}

function logHumanGateResume(job, effects, outcome) {
  const gateJobIds = effects.map((effect) => Number(effect.gate_job_id)).filter(Number.isFinite);
  logEvent({
    work_item_id: job?.work_item_id || null,
    job_id: job?.id || null,
    event_type: EVENT_TYPES.JOB_UNBLOCKED,
    actor_type: EVENT_ACTORS.HUMAN,
    actor_id: gateJobIds.length > 0 ? `human-gate-${gateJobIds[gateJobIds.length - 1]}` : null,
    message: `Requeued after resolved human input${gateJobIds.length > 0 ? ` (gate #${gateJobIds[gateJobIds.length - 1]})` : ""}`,
    event_json: JSON.stringify({
      gate_job_ids: gateJobIds,
      outcome,
      resume_boundary: "queued_write_lock_reacquisition",
    }),
  });
}

export function consumePendingHumanGateResume(jobId, { db = getDb() } = {}) {
  const execute = () => {
    const effects = pendingHumanGateResumeEffects(db, jobId);
    if (effects.length === 0) return { resumed: false, status: null };
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(Number(jobId));
    if (!job) {
      settleHumanGateResumeEffects(db, effects, {
        state: "failed",
        outcome: "original_job_missing",
        error: "Original job disappeared before its pending human resume could run",
      });
      return { resumed: false, status: null };
    }
    if (job.status === "queued") {
      settleHumanGateResumeEffects(db, effects, { outcome: "already_queued" });
      logHumanGateResume(job, effects, "already_queued");
      return { resumed: true, status: "queued", job };
    }
    if (!HUMAN_GATE_RESUMABLE_JOB_STATUSES.has(job.status)) {
      settleHumanGateResumeEffects(db, effects, {
        state: "failed",
        outcome: "source_state_changed",
        error: `Original job became ${job.status} before its pending human resume could run`,
      });
      return { resumed: false, status: job.status, job };
    }
    if (job.lease_token != null) {
      return { resumed: false, pending: true, status: job.status, job };
    }

    const ts = now();
    const resumed = db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          finished_at = NULL,
          updated_at = ?,
          state_version = state_version + 1
      WHERE id = ?
        AND status = ?
        AND lease_token IS NULL
    `).run(ts, job.id, job.status);
    if (resumed.changes !== 1) {
      return { resumed: false, pending: true, status: job.status, job };
    }
    const fresh = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(job.id);
    settleHumanGateResumeEffects(db, effects, { outcome: "requeued" });
    logHumanGateResume(fresh, effects, "requeued");
    return { resumed: true, status: "queued", job: fresh };
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

/**
 * Durably request that a parked original job resume after a human gate.
 *
 * Never force-clear a live parked lease: the old worker may still be unwinding
 * and could write with stale in-memory state. The request stays in the human
 * gate outbox until that owner releases or its lease expires. Settlement then
 * moves the job to queued, not running, so every mutating resume must reacquire
 * write locks and an active assessment barrier can defer it without losing the
 * human's answer.
 */
export function requestParkedJobResumeAfterGate({
  gateJobId,
  originalJobId,
  operationKey,
  reason = "human_gate_resolved",
} = {}) {
  const db = getDb();
  const gateId = Number(gateJobId);
  const jobId = Number(originalJobId);
  const key = String(operationKey || "").trim();
  if (!Number.isFinite(gateId) || !Number.isFinite(jobId) || !key) {
    return { ok: false, reason: "invalid_resume_request" };
  }

  return runImmediateTransaction(db, () => {
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    if (!job) return { ok: false, reason: "original_job_missing" };
    db.prepare(`
      INSERT INTO human_gate_outbox (
        gate_job_id, operation_key, operation_type, payload_json
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(operation_key) DO NOTHING
    `).run(gateId, key, HUMAN_GATE_RESUME_OPERATION_TYPE, JSON.stringify({
      original_job_id: jobId,
      gate_job_id: gateId,
      reason: String(reason).slice(0, 240),
      requested_at: now(),
      source_status: job.status,
    }));
    const effect = db.prepare(`
      SELECT * FROM human_gate_outbox WHERE operation_key = ?
    `).get(key);
    if (!effect) return { ok: false, reason: "resume_effect_missing" };
    if (effect.state === "completed") {
      return { ok: true, pending: false, requeued: job.status === "queued", idempotent: true };
    }
    if (effect.state === "failed") {
      return { ok: false, reason: effect.last_error || "resume_effect_failed" };
    }
    if (job.status !== "queued" && !HUMAN_GATE_RESUMABLE_JOB_STATUSES.has(job.status)) {
      settleHumanGateResumeEffects(db, [effect], {
        state: "failed",
        outcome: "source_state_changed",
        error: `Original job is ${job.status}; expected a resumable parked state`,
      });
      return { ok: false, reason: "original_state_changed", status: job.status };
    }

    const result = consumePendingHumanGateResume(jobId, { db });
    if (result.resumed) {
      releaseJobLocksForStatus(jobId, "queued");
      notifyQueueStateChanged({
        reason: "human_gate_resume_queued",
        jobId,
        workItemId: result.job?.work_item_id,
      });
      return { ok: true, pending: false, requeued: true, job: result.job };
    }
    if (result.pending) {
      notifyQueueStateChanged({
        reason: "human_gate_resume_pending_lease_release",
        jobId,
        workItemId: result.job?.work_item_id,
      });
      return { ok: true, pending: true, requeued: false, job: result.job };
    }
    return { ok: false, reason: "resume_not_applied", status: result.status };
  });
}

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
  const pendingResume = consumePendingHumanGateResume(jobId, { db });
  const effectiveStatus = pendingResume.resumed ? "queued" : finalStatus;
  releaseJobLocksForStatus(jobId, effectiveStatus);
  const job = db.prepare(`SELECT work_item_id FROM jobs WHERE id = ?`).get(jobId);
  notifyQueueStateChanged({
    reason: `lease_released_${effectiveStatus}`,
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
