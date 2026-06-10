import { logEvent } from "../../../queue/functions/index.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

export function logAttemptSkippedStaleLease(job, workerType, message) {
  try {
    logEvent({
      work_item_id: job?.work_item_id || null,
      job_id: job?.id || null,
      event_type: EVENT_TYPES.JOB_ATTEMPT_SKIPPED_STALE_LEASE,
      actor_type: EVENT_ACTORS.WORKER,
      message: message || `Skipped ${workerType || "worker"} attempt because the lease was stale or expired`,
      event_json: JSON.stringify({
        worker_type: workerType || null,
        job_status: job?.status || null,
        lease_owner: job?.lease_owner || null,
      }),
    });
  } catch {
    // If the DB is the reason the lease looks stale, do not mask the worker exit.
  }
}
