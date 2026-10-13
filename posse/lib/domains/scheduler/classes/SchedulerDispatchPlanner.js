import { expireStaleSessionLeases } from "../../queue/functions/index.js";
import { RunnableCandidateScan } from "./RunnableCandidateScan.js";
import { resolveReviewedCircularOwnership } from "../functions/reviewed-circular-release.js";
import { MAX_RUNNABLE_SCAN_PER_TICK } from "../functions/config.js";
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
    this.scan = new RunnableCandidateScan();
  }

  prepare() {
    const scheduler = this.scheduler;
    scheduler._refreshRuntimeSettings();
    const requeued = scheduler.leaseManager.requeueExpired();
    if (requeued > 0) scheduler._log(`Requeued ${requeued} expired lease(s)`);
    const expiredSessionLeases = expireStaleSessionLeases();
    if (expiredSessionLeases > 0) scheduler._log(`Released ${expiredSessionLeases} stale session lease(s)`);
    scheduler._cancelDeadlockedJobs();
    const atlasIndexingHold = scheduler._atlasIndexingDispatchHold();
    this.scan.beginPass();
    return atlasIndexingHold;
  }

  *candidates() {
    const hold = this.prepare();
    const seen = new Set();
    for (let batch = 0; batch < 4; batch++) {
      const jobs = this.scan.next(MAX_RUNNABLE_SCAN_PER_TICK, {
        excludeJobIds: [...seen], onlyWorkItemIds: this.scheduler.onlyWorkItemIds || [],
        onlyJobTypes: hold ? [...ATLAS_INDEXING_HOLD_EXEMPT_JOB_TYPES] : [],
      });
      if (!jobs.length) break;
      for (const job of jobs) { seen.add(job.id); yield job; }
    }
  }

  nextJob() {
    return this.candidates().next().value || null;
  }

  tick() {
    const scheduler = this.scheduler;
    for (const job of this.candidates()) {
      if (resolveReviewedCircularOwnership(job, scheduler.ownerId).conflict) continue;
      const lease = scheduler.leaseManager.acquireWithLocks(job, scheduler.ownerId, null, scheduler.leaseSec);
      if (lease) return { ...job, _leaseToken: lease.leaseToken };
    }
    return null;
  }

  async tickAsync() {
    const scheduler = this.scheduler;
    for (const job of this.candidates()) {
      if (resolveReviewedCircularOwnership(job, scheduler.ownerId).conflict) continue;
      const lease = await scheduler.leaseManager.acquireWithLocksAsync(job, scheduler.ownerId, null, scheduler.leaseSec);
      if (lease) return { ...job, _leaseToken: lease.leaseToken };
    }
    return null;
  }
}
