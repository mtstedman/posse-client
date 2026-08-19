import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { logEvent } from "../../queue/functions/index.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";

// Owns the scheduler-lock lifecycle while Scheduler remains the compatibility
// facade for callers that use its historical private callback hooks.
export class SchedulerLockController {
  constructor(scheduler) {
    this.scheduler = scheduler;
  }

  maybeLogStarvation(nowMs = Date.now()) {
    this.scheduler.schedulerLock.maybeLogStarvation(nowMs);
  }

  renew() {
    if (!this.scheduler._running) return false;
    return this.scheduler.schedulerLock.renewNow();
  }

  startRenewal() {
    return this.scheduler.schedulerLock.startRenewal();
  }

  stopForLoss(message, { eventType = null, eventJson = null } = {}) {
    const scheduler = this.scheduler;
    scheduler._log(message, "red");
    scheduler._lockLost = true;
    scheduler._running = false;
    scheduler.schedulerLock.stopRenewal();
    if (eventType) {
      logEvent({
        event_type: eventType,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: scheduler.ownerId,
        message,
        ...(eventJson ? { event_json: eventJson } : {}),
      });
    }
    this.abortActiveWorkers();
    scheduler._wakeSleeps();
  }

  abortActiveWorkers() {
    const scheduler = this.scheduler;
    const activeWorkers = scheduler._activeRunWorkers;
    if (!activeWorkers || activeWorkers.size === 0) return;

    const abortedIds = [];
    for (const [jobId, entry] of activeWorkers) {
      if (scheduler._lockLostKilledJobIds.has(jobId)) continue;
      scheduler._lockLostKilledJobIds.add(jobId);
      abortedIds.push(jobId);
      logEvent({
        job_id: jobId,
        work_item_id: entry?.job?.work_item_id || null,
        event_type: EVENT_TYPES.SCHEDULER_LOCK_LOST_WORKER_ABORT,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: scheduler.ownerId,
        message: "Scheduler lock lost; aborting active worker to avoid duplicate execution",
      });
      scheduler._invokeCallback("onKillJob", scheduler._lockLossKillCallback, jobId, "scheduler_lock_lost");
    }
    if (abortedIds.length > 0) {
      scheduler._log(`Lock lost — sent abort to ${abortedIds.length} active worker(s): ${abortedIds.join(", ")}`, "red");
    }
  }
}
