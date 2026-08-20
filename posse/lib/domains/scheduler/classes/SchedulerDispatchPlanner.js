import { findRunnableJob, expireStaleSessionLeases } from "../../queue/functions/index.js";
import { WAITING_LANE_JOB_TYPE } from "../../../catalog/waiting-lane.js";

const ATLAS_INDEXING_HOLD_EXEMPT_JOB_TYPES = new Set([
  "atlas_warm",
  WAITING_LANE_JOB_TYPE,
  "human_input",
]);

// Keeps the tick preamble and lease decisions together. The Scheduler facade
// owns callbacks and mutable run-loop state, so the planner receives it as an
// explicit port rather than duplicating that state.
export class SchedulerDispatchPlanner {
  constructor(scheduler) {
    this.scheduler = scheduler;
  }

  nextJob() {
    const scheduler = this.scheduler;
    scheduler._refreshRuntimeSettings();
    const requeued = scheduler.leaseManager.requeueExpired();
    if (requeued > 0) scheduler._log(`Requeued ${requeued} expired lease(s)`);
    const expiredSessionLeases = expireStaleSessionLeases();
    if (expiredSessionLeases > 0) scheduler._log(`Released ${expiredSessionLeases} stale session lease(s)`);
    scheduler._cancelDeadlockedJobs();
    const atlasIndexingHold = scheduler._atlasIndexingDispatchHold();
    const job = findRunnableJob();
    if (!job) return null;
    if (atlasIndexingHold && !ATLAS_INDEXING_HOLD_EXEMPT_JOB_TYPES.has(job.job_type)) return null;
    return job;
  }

  tick() {
    const scheduler = this.scheduler;
    const job = this.nextJob();
    if (!job) return null;
    const lease = scheduler.leaseManager.acquireWithLocks(job, scheduler.ownerId, null, scheduler.leaseSec);
    return lease ? { ...job, _leaseToken: lease.leaseToken } : null;
  }

  async tickAsync() {
    const scheduler = this.scheduler;
    const job = this.nextJob();
    if (!job) return null;
    const lease = await scheduler.leaseManager.acquireWithLocksAsync(job, scheduler.ownerId, null, scheduler.leaseSec);
    return lease ? { ...job, _leaseToken: lease.leaseToken } : null;
  }
}
