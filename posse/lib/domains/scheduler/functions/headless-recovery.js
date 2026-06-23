// lib/domains/scheduler/functions/headless-recovery.js — headless human-gate
// recovery helpers.
//
// Extracted verbatim from the body of Scheduler.runLoop(). When no display is
// available, waiting_on_human / waiting_on_review jobs would otherwise sit
// forever (or trip deadlock cancellation of their dependents). These helpers
// detect the stuck gates, fail/park them, unwire dependents and recover the
// chain. They are pure given their explicit dependencies — every queue
// function, the logger callback, the owner id, the display flag, and the
// per-run "logged once" dedupe Sets are passed in by the caller. No scheduler
// concurrency state (activeWorkers / lease / lock / dispatch) is touched.

/**
 * Headless human_input timeout recovery.
 *
 * If no display is available, waiting_on_human jobs will sit forever. After the
 * configured headless human timeout, fail them and recover the chain so
 * dependents don't get deadlock-canceled.
 *
 * Mutates `headlessNonHumanWaitingLogged` (per-run "logged once" Set) the same
 * way the inline loop did.
 *
 * @param {object} deps
 * @param {boolean} deps.hasDisplay
 * @param {Set<number>} deps.headlessNonHumanWaitingLogged
 * @param {string} deps.ownerId
 * @param {(msg: string, color?: string) => void} deps.log
 * @param {object} deps.eventTypes - EVENT_TYPES catalog
 * @param {object} deps.eventActors - EVENT_ACTORS catalog
 * @param {string[]} deps.terminalJobStatuses - TERMINAL_JOB_STATUSES
 * @param {() => number} deps.readHeadlessHumanTimeoutSec
 * @param {object} deps.queue - queue function bag (see destructure below)
 */
export function recoverHeadlessHumanTimeouts({
  hasDisplay,
  headlessNonHumanWaitingLogged,
  ownerId,
  log,
  eventTypes: EVENT_TYPES,
  eventActors: EVENT_ACTORS,
  terminalJobStatuses: TERMINAL_JOB_STATUSES,
  readHeadlessHumanTimeoutSec,
  queue: {
    hasJobs,
    listJobs,
    isPushOfferJob,
    parseJobPayload,
    getJob,
    getDependents,
    updateJobStatus,
    removeDependency,
    refreshWorkItemStatus,
    logEvent,
  },
}) {
  // Headless human_input timeout: if no display is available, waiting_on_human
  // jobs will sit forever. After the configured headless human timeout, fail them and
  // recover the chain so dependents don't get deadlock-canceled.
  if (!hasDisplay && hasJobs(["waiting_on_human"])) {
    const stuckHuman = listJobs(["waiting_on_human"]);
    for (const hj of stuckHuman) {
      // Push-offer gates wait indefinitely for the phone/CLI by
      // design — never time them out, headless or not.
      if (isPushOfferJob(hj)) continue;
      if (hj.job_type !== "human_input") {
        if (!headlessNonHumanWaitingLogged.has(hj.id)) {
          headlessNonHumanWaitingLogged.add(hj.id);
          log(`WI#${hj.work_item_id} job #${hj.id} is waiting_on_human with type ${hj.job_type}; leaving parked in headless mode`, "yellow");
          logEvent({
            work_item_id: hj.work_item_id,
            job_id: hj.id,
            event_type: EVENT_TYPES.JOB_HEADLESS_NON_HUMAN_WAITING_ON_HUMAN,
            actor_type: EVENT_ACTORS.SCHEDULER,
            actor_id: ownerId,
            message: `Non-human job type ${hj.job_type} is waiting_on_human in headless mode; scheduler left it parked`,
          });
        }
        continue;
      }
      const age = (Date.now() - new Date(hj.updated_at).getTime()) / 1000;
      if (age > readHeadlessHumanTimeoutSec()) {
        log(`WI#${hj.work_item_id} job #${hj.id} stuck in waiting_on_human for ${Math.ceil(age)}s — recovering (headless timeout)`, "yellow");
        let humanPayload = {};

        // 1. If this human_input was unblocking an original job, do NOT
        //    auto-requeue the original job in headless mode. Re-running a
        //    task that already needs human input/review just creates a loop
        //    (run -> review gate -> timeout -> run again). Leave the
        //    original job parked and fail only the timed-out human_input.
        try {
          humanPayload = parseJobPayload(hj);
          if (humanPayload.original_job_id) {
            const origJob = getJob(humanPayload.original_job_id);
            if (origJob && ["waiting_on_review", "waiting_on_human", "blocked"].includes(origJob.status)) {
              logEvent({
                work_item_id: hj.work_item_id,
                job_id: origJob.id,
                event_type: EVENT_TYPES.JOB_HEADLESS_RECOVERY,
                actor_type: EVENT_ACTORS.SCHEDULER,
                message: `Left parked in ${origJob.status} after human_input #${hj.id} timed out in headless mode`,
              });
              log(`  → left original job #${origJob.id} parked in ${origJob.status}`, "yellow");
            }
          }
        } catch (err) {
          log(`  -> headless recovery lookup failed for human_input #${hj.id}: ${err?.message || String(err)}`, "red");
        }

        // 2. Rewire dependents of this human_input job so they don't get
        //    deadlock-canceled. Create a skip marker so the chain can continue.
        const dependents = getDependents(hj.id);
        const affectedWorkItemIds = new Set([hj.work_item_id]);
        if (dependents.length > 0) {
          const isApprovalGate = Array.isArray(humanPayload.file_requests) && humanPayload.file_requests.length > 0;
          if (isApprovalGate) {
            let canceled = 0;
            for (const dep of dependents) {
              const depJob = getJob(dep.job_id);
              if (!depJob) continue;
              if (depJob.work_item_id) affectedWorkItemIds.add(depJob.work_item_id);
              if (TERMINAL_JOB_STATUSES.includes(depJob.status)) continue;
              updateJobStatus(depJob.id, "canceled");
              canceled++;
              logEvent({
                work_item_id: depJob.work_item_id,
                job_id: depJob.id,
                event_type: EVENT_TYPES.JOB_HEADLESS_APPROVAL_CANCELED,
                actor_type: EVENT_ACTORS.SCHEDULER,
                message: `Canceled dependent job after approval gate #${hj.id} timed out in headless mode`,
              });
            }
            if (canceled > 0) {
              log(`  → canceled ${canceled} dependent(s) waiting on timed-out approval gate #${hj.id}`, "yellow");
            }
          } else {
            for (const dep of dependents) {
              const depJob = getJob(dep.job_id);
              if (depJob?.work_item_id) affectedWorkItemIds.add(depJob.work_item_id);
              // Remove the hard dep on the timed-out human job so the
              // dependent becomes runnable again (its other deps may be met).
              try {
                removeDependency(dep.job_id, hj.id, {
                  actorType: "scheduler",
                  actorId: ownerId,
                  message: `Removed dependency on timed-out human_input #${hj.id} in headless recovery`,
                });
              } catch (err) {
                log(`  -> failed to remove dependency ${dep.job_id}->${hj.id}: ${err?.message || String(err)}`, "red");
              }
            }
            log(`  → unwired ${dependents.length} dependent(s) from timed-out human_input #${hj.id}`, "yellow");
          }
        }

        // 3. Now fail the human_input job itself.
        updateJobStatus(hj.id, "failed");
        logEvent({
          work_item_id: hj.work_item_id,
          job_id: hj.id,
          event_type: EVENT_TYPES.JOB_HEADLESS_TIMEOUT,
          actor_type: EVENT_ACTORS.SCHEDULER,
          message: `Human input job timed out after ${Math.ceil(age)}s in headless mode`,
        });
        for (const workItemId of affectedWorkItemIds) {
          refreshWorkItemStatus(workItemId);
        }
      }
    }
  }
}

/**
 * Orphaned waiting_on_review recovery.
 *
 * Checks for waiting_on_review jobs whose human_input child has already
 * failed/timed out — these are permanent traps. In headless mode they are left
 * parked (logged once via `headlessOrphanedReviewParkedLogged`); with a display
 * they are requeued.
 *
 * @param {object} deps
 * @param {boolean} deps.hasDisplay
 * @param {Set<number>} deps.headlessOrphanedReviewParkedLogged
 * @param {(msg: string, color?: string) => void} deps.log
 * @param {object} deps.eventTypes - EVENT_TYPES catalog
 * @param {object} deps.eventActors - EVENT_ACTORS catalog
 * @param {string[]} deps.deadlockTerminalStatuses - DEADLOCK_TERMINAL_STATUSES
 * @param {object} deps.queue - queue function bag (see destructure below)
 */
export function recoverOrphanedReviewJobs({
  hasDisplay,
  headlessOrphanedReviewParkedLogged,
  log,
  eventTypes: EVENT_TYPES,
  eventActors: EVENT_ACTORS,
  deadlockTerminalStatuses: DEADLOCK_TERMINAL_STATUSES,
  queue: {
    hasJobs,
    listJobs,
    listJobsByWorkItem,
    updateJobStatus,
    refreshWorkItemStatus,
    logEvent,
  },
}) {
  // Also check for orphaned waiting_on_review jobs whose human_input
  // child has already failed/timed out — these are permanent traps.
  if (hasJobs(["waiting_on_review"])) {
    const stuckReview = listJobs(["waiting_on_review"]);
    for (const rj of stuckReview) {
      // A waiting_on_review job should have a human_input child keeping it alive.
      // If all human_input children are terminal-failed, the review job is orphaned.
      const children = listJobsByWorkItem(rj.work_item_id).filter(j =>
        j.parent_job_id === rj.id && j.job_type === "human_input"
      );
      const allChildrenDead = children.length > 0 && children.every(j =>
        DEADLOCK_TERMINAL_STATUSES.includes(j.status)
      );
      // Grace period: don't requeue during transient failures — the child
      // may be retrying. Wait at least 30s after the review job was parked.
      const reviewAge = (Date.now() - new Date(rj.updated_at).getTime()) / 1000;
      if (allChildrenDead && reviewAge > 30) {
        if (!hasDisplay) {
          if (!headlessOrphanedReviewParkedLogged.has(rj.id)) {
            headlessOrphanedReviewParkedLogged.add(rj.id);
            log(`WI#${rj.work_item_id} job #${rj.id} review remains parked in headless mode (all review children terminal)`, "yellow");
            logEvent({
              work_item_id: rj.work_item_id,
              job_id: rj.id,
              event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_PARKED,
              actor_type: EVENT_ACTORS.SCHEDULER,
              message: `Left in waiting_on_review in headless mode — all human_input children are terminal`,
            });
          }
        } else {
          log(`WI#${rj.work_item_id} job #${rj.id} orphaned in waiting_on_review (all review children failed) — requeuing`, "yellow");
          updateJobStatus(rj.id, "queued");
          logEvent({
            work_item_id: rj.work_item_id,
            job_id: rj.id,
            event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_RECOVERY,
            actor_type: EVENT_ACTORS.SCHEDULER,
            message: `Requeued from waiting_on_review — all human_input children are terminal`,
          });
          refreshWorkItemStatus(rj.work_item_id);
        }
      }
    }
  }
}
