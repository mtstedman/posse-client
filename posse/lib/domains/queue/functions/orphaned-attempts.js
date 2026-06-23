import { getDb } from "../../../shared/storage/functions/index.js";
import { LEASE_HOLDING_STATUSES_SQL, runImmediateTransaction } from "./common.js";
import { leaseNowMs } from "./lease-clock.js";
import { logEvent } from "./events.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

/**
 * Mark any job_attempts stuck in 'running' status as 'failed'.
 * Called on scheduler startup - if we hold the lock, no worker should have
 * running attempts. These are leftovers from crashed workers.
 */
export function reconcileOrphanedAttempts() {
  const db = getDb();
  const ts = new Date(leaseNowMs()).toISOString();
  const execute = () => {
    const stuck = db.prepare(`
      SELECT a.id, a.job_id
      FROM job_attempts a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = 'running'
        AND (
          j.status NOT IN (${LEASE_HOLDING_STATUSES_SQL})
          OR j.lease_expires_at IS NULL
          OR j.lease_expires_at < ?
        )
    `).all(ts);

    if (stuck.length === 0) return 0;

    const fix = db.prepare(`
      UPDATE job_attempts
      SET status = 'failed',
          finished_at = ?,
          error_text = COALESCE(error_text, 'Orphaned by scheduler crash')
      WHERE id = ? AND status = 'running'
    `);

    let reconciled = 0;
    for (const { id, job_id } of stuck) {
      const result = fix.run(ts, id);
      if (result.changes === 0) continue;
      reconciled += 1;
      logEvent({
        job_id: job_id,
        event_type: EVENT_TYPES.ATTEMPT_ORPHAN_RECONCILED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Orphaned running attempt #${id} marked as failed`,
      });
    }
    return reconciled;
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}
