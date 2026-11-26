import { getDb } from "../../../shared/storage/functions/index.js";
import { ACTIVE_LEASE_STATUSES_SQL, LEASE_HOLDING_STATUSES_SQL, now, runImmediateTransaction } from "../functions/common.js";
import { consumePendingHumanGateResume as _consumePendingHumanGateResume } from "../functions/leases.js";
import { completeAttempt } from "../functions/attempts.js";
import { releaseJobLocksForStatus } from "../functions/file-locks.js";
import { logEvent } from "../functions/events.js";
import { notifyQueueStateChanged } from "../functions/wakeups.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { ASSESS_ONLY_PAYLOAD_SQL, FORCED_EXIT_REQUEUE_BUSY_MS } from "../../../catalog/queue-recovery.js";

// Owns graceful and forced shutdown settlement. The injected status refresher
// keeps queue-store's work-item aggregation out of this transaction owner.
export class QueueShutdownRecovery {
  constructor({ refreshWorkItemStatus }) {
    this.refreshWorkItemStatus = refreshWorkItemStatus;
  }

  /**
   * Requeue a job for graceful shutdown: set status back to queued, clear lease,
   * and undo the attempt_count increment from the interrupted run.
   * Only affects jobs still in a leased/running/assessing state.
   */
  requeueForShutdown(jobId, { label = "graceful shutdown" } = {}) {
    const db = getDb();
    const ts = now();
    const requeueOne = () => runImmediateTransaction(db, () => {
      const row = db.prepare(`
        SELECT status
        FROM jobs
        WHERE id = ?
          AND status IN (${LEASE_HOLDING_STATUSES_SQL})
      `).get(jobId);
      if (!row) return { changes: 0, wasAssessing: false };

      const update = db.prepare(`
        UPDATE jobs
        SET status = 'queued',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            ready_at = ?,
            attempt_count = CASE
              WHEN status != 'running' OR NOT EXISTS (
                SELECT 1 FROM job_attempts a WHERE a.job_id = jobs.id
                  AND a.id = (SELECT MAX(id) FROM job_attempts WHERE job_id = jobs.id)
                  AND a.status = 'running' AND a.attempt_kind IN ('implementation', 'human')
              ) THEN attempt_count
              ELSE MAX(0, attempt_count - 1)
            END,
            updated_at = ?
        WHERE id = ?
          AND status IN (${LEASE_HOLDING_STATUSES_SQL})
      `).run(ts, ts, jobId);

      const wasAssessing = row.status === "awaiting_assessment";
      if (update.changes > 0 && wasAssessing) {
        db.prepare(`
          UPDATE jobs
          SET ${ASSESS_ONLY_PAYLOAD_SQL}
          WHERE id = ?
        `).run(jobId);
      }
      if (update.changes > 0) {
        _consumePendingHumanGateResume(jobId, { db });
      }

      return { changes: update.changes, wasAssessing };
    });
    const result = requeueOne();

    if (result.changes > 0) {
      releaseJobLocksForStatus(jobId, "queued");
      logEvent({
        job_id: jobId,
        event_type: EVENT_TYPES.JOB_SHUTDOWN_REQUEUE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: result.wasAssessing
          ? `Assessment interrupted by ${label}, requeued as assess-only`
          : `Requeued for ${label} (attempt not counted)`,
      });
      notifyQueueStateChanged({
        reason: "job_shutdown_requeue",
        jobId,
      });
    }
    return result.changes > 0;
  }

  // A forced exit must not stall on a contended writer: the process is leaving
  // either way, and the next boot's force-requeue recovers anything left behind.


  /**
   * Requeue the active jobs one scheduler owner leased, for a forced exit
   * (second signal, shutdown watchdog). The process terminates synchronously, so
   * interrupted workers never reach their graceful-shutdown requeue. Each job
   * gets the same no-penalty requeue as graceful shutdown and its running
   * attempt is closed as interrupted, instead of the next boot recording it as
   * "Orphaned by scheduler crash". Jobs leased by any other owner are untouched.
   * Synchronous and best-effort: never throws.
   */
  requeueOwnedJobsForForcedExit(ownerId, {
    reason = "Forced shutdown",
    busyTimeoutMs = FORCED_EXIT_REQUEUE_BUSY_MS,
  } = {}) {
    const empty = () => ({ requeued: 0, interruptedAttempts: 0, jobIds: [] });
    let summary = empty();
    if (!ownerId) return summary;
    let affectedWorkItems = new Set();
    let db;
    let prevBusyMs = null;
    try {
      db = getDb();
      prevBusyMs = Number(db.pragma("busy_timeout", { simple: true }) ?? 10000);
      db.pragma(`busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`);
      runImmediateTransaction(db, () => {
        const owned = db.prepare(`
          SELECT id, work_item_id
          FROM jobs
          WHERE lease_owner = ?
            AND status IN (${ACTIVE_LEASE_STATUSES_SQL})
          ORDER BY id
        `).all(String(ownerId));
        const runningAttempts = db.prepare(`
          SELECT id, started_at FROM job_attempts WHERE job_id = ? AND status = 'running'
        `);
        const nowMs = Date.now();
        for (const job of owned) {
          const attempts = runningAttempts.all(job.id);
          // requeueForShutdown refunds the attempt only while it is still
          // running, so the attempt is closed after the requeue.
          if (!this.requeueForShutdown(job.id, { label: "forced shutdown" })) continue;
          summary.requeued += 1;
          summary.jobIds.push(job.id);
          if (job.work_item_id != null) affectedWorkItems.add(job.work_item_id);
          for (const attempt of attempts) {
            const startedMs = Date.parse(attempt.started_at || "");
            completeAttempt(attempt.id, {
              status: "interrupted",
              duration_ms: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
              error_text: String(reason || "Forced shutdown"),
            });
            summary.interruptedAttempts += 1;
          }
        }
      });
    } catch {
      // Rolled back (or never started): the next boot's force-requeue recovers
      // these jobs, so report nothing requeued.
      summary = empty();
      affectedWorkItems = new Set();
    } finally {
      if (db && prevBusyMs != null) {
        try { db.pragma(`busy_timeout = ${prevBusyMs}`); } catch { /* connection is closing */ }
      }
    }
    for (const wiId of affectedWorkItems) {
      try { this.refreshWorkItemStatus(wiId); } catch { /* next boot refreshes status */ }
    }
    return summary;
  }

}
