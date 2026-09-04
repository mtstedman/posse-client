// lib/domains/scheduler/functions/headless-recovery.js — headless human-gate
// recovery helpers.
//
// Extracted verbatim from the body of Scheduler.runLoop(). When no display is
// available, waiting_on_human / waiting_on_review jobs would otherwise sit
// forever (or trip deadlock cancellation of their dependents). These helpers
// detect stuck gates and fail or park them without silently authorizing
// downstream work. They are pure given their explicit dependencies — every queue
// function, the logger callback, the owner id, the display flag, and the
// per-run "logged once" dedupe Sets are passed in by the caller. No scheduler
// concurrency state (activeWorkers / lease / lock / dispatch) is touched.

import {
  humanGateStateAllowsAnswer,
  humanGateStateIsActive,
} from "../../../catalog/human-input.js";

/**
 * Headless human_input timeout recovery.
 *
 * If no display is available, waiting_on_human jobs will sit forever. After the
 * configured headless human timeout, fail them and cancel gated dependents so
 * an unanswered decision never becomes implicit authorization.
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
 * @param {() => boolean} [deps.isRemoteOperatorPresent] - true when a bridge
 *   heartbeat is fresh, i.e. a phone/SPA can answer gates remotely
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
  isRemoteOperatorPresent = null,
  queue: {
    hasJobs,
    listJobs,
    isPushOfferJob,
    parseJobPayload,
    getJob,
    getHumanGate,
    claimHeadlessHumanGateTimeout,
    getDependents,
    updateJobStatus,
    supersedeHumanGate,
    refreshWorkItemStatus,
    logEvent,
  },
}) {
  // Headless human_input timeout: if no display is available, waiting_on_human
  // jobs will sit forever. After the configured headless human timeout, fail them and
  // recover the chain so dependents don't get deadlock-canceled.
  //
  // Exception: while `posse serve` is heartbeating, "headless" does not mean
  // "unanswerable" — a paired phone can answer any gate. Timing gates out
  // under a live bridge silently destroys the remote workflow (the operator
  // answers 11 minutes later and gets gate_closed), so the whole sweep waits
  // as long as the bridge is present.
  if (!hasDisplay && isRemoteOperatorPresent?.()) return;
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
      // The durable contract is stronger than a stale job row. A resolver can
      // commit gate_state=resolved immediately before crashing, leaving the
      // job parked until reconciliation settles it. Timing that row out here
      // would overwrite a valid human answer and cancel already-authorized
      // dependents. Resolving/superseded contracts likewise belong to the
      // reconciliation state machine, not the unanswered-gate timeout path.
      const gateContract = getHumanGate(hj.id);
      if (!humanGateStateAllowsAnswer(gateContract?.gate_state)) continue;
      const age = (Date.now() - new Date(hj.updated_at).getTime()) / 1000;
      if (age > readHeadlessHumanTimeoutSec()) {
        // A live lease means a bridge answer is resolving this gate right
        // now. Superseding mid-resolution would yank the gate out from under
        // completeHumanGateResolution and discard the operator's answer —
        // leave it for the next sweep, which sees the settled outcome.
        const freshHj = getJob(hj.id);
        if (
          freshHj?.lease_token
          && freshHj.lease_expires_at
          && Date.parse(freshHj.lease_expires_at) > Date.now()
        ) {
          continue;
        }
        // Close the contract before canceling dependents. This CAS rechecks
        // both gate state and lease under the database write lock, eliminating
        // the race between the best-effort read above and a bridge resolver.
        // Legacy human_input rows without a contract retain the historical
        // fail-closed timeout behavior and are repaired by reconciliation.
        if (gateContract && !claimHeadlessHumanGateTimeout(
          hj.id,
          "Human gate timed out in headless mode",
        )) {
          continue;
        }
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

        // 2. Fail closed for every job gated on this unanswered decision.
        //    Removing the dependency used to turn a timeout into an implicit
        //    approval: exact operational-command plan gates, recovery gates,
        //    and clarification gates could all release their downstream work
        //    without the required answer.
        const dependents = getDependents(hj.id);
        const affectedWorkItemIds = new Set([hj.work_item_id]);
        if (dependents.length > 0) {
          const isApprovalGate = Array.isArray(humanPayload.file_requests) && humanPayload.file_requests.length > 0;
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
              event_type: isApprovalGate
                ? EVENT_TYPES.JOB_HEADLESS_APPROVAL_CANCELED
                : EVENT_TYPES.JOB_HEADLESS_GATE_DEPENDENT_CANCELED,
              actor_type: EVENT_ACTORS.SCHEDULER,
              message: `Canceled dependent job after unanswered human gate #${hj.id} timed out in headless mode`,
            });
          }
          if (canceled > 0) {
            log(`  → canceled ${canceled} dependent(s) waiting on timed-out human gate #${hj.id}`, "yellow");
          }
        }

        // 3. Now fail the human_input job itself.
        updateJobStatus(hj.id, "failed");
        if (!gateContract) {
          supersedeHumanGate(hj.id, "Human gate timed out in headless mode");
        }
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
 * failed/timed out — these are permanent traps. A live remote operator keeps a
 * headless review parked; otherwise recovery either reconstructs one gate in
 * assessment-only mode or fails the review closed.
 *
 * @param {object} deps
 * @param {boolean} deps.hasDisplay
 * @param {Set<number>} deps.headlessOrphanedReviewParkedLogged
 * @param {(msg: string, color?: string) => void} deps.log
 * @param {object} deps.eventTypes - EVENT_TYPES catalog
 * @param {object} deps.eventActors - EVENT_ACTORS catalog
 * @param {string[]} deps.deadlockTerminalStatuses - DEADLOCK_TERMINAL_STATUSES
 * @param {() => boolean} [deps.isRemoteOperatorPresent] - true while a bridge
 *   client can still resolve the parked review explicitly
 * @param {object} deps.queue - queue function bag, including durable gate lookup
 *   so stale terminal child rows are not mistaken for dead contracts
 */
export function recoverOrphanedReviewJobs({
  hasDisplay,
  headlessOrphanedReviewParkedLogged,
  log,
  eventTypes: EVENT_TYPES,
  eventActors: EVENT_ACTORS,
  deadlockTerminalStatuses: DEADLOCK_TERMINAL_STATUSES,
  isRemoteOperatorPresent = null,
  queue: {
    hasJobs,
    listJobs,
    listJobsByWorkItem,
    getJob,
    getHumanGate,
    runInTransaction,
    updateJobStatus,
    updateJobPayload,
    refreshWorkItemStatus,
    logEvent,
  },
}) {
  const orphanState = (reviewJob) => {
    const children = listJobsByWorkItem(reviewJob.work_item_id).filter(j =>
      j.parent_job_id === reviewJob.id && j.job_type === "human_input"
    );
    // A failed/canceled job row is not necessarily a dead gate. Reconciliation
    // deliberately reopens terminal children whose durable contract is still
    // open (or whose resolver died mid-action). The orphan sweep runs before
    // that maintenance pass, so treating the stale child row as authoritative
    // can requeue/fail its parent and invalidate an answerable contract.
    const hasRepairableContract = children.some((child) => {
      const gate = getHumanGate(child.id);
      return gate != null && humanGateStateIsActive(gate.gate_state);
    });
    const allChildrenDead = children.length > 0 && children.every(j =>
      DEADLOCK_TERMINAL_STATUSES.includes(j.status)
    ) && !hasRepairableContract;
    const reviewAge = (Date.now() - new Date(reviewJob.updated_at).getTime()) / 1000;
    return {
      children,
      orphaned: children.length === 0
        ? reviewAge > 120
        : (allChildrenDead && reviewAge > 30),
    };
  };
  const payloadState = (job) => {
    let payload;
    try {
      payload = typeof job.payload_json === "string"
        ? JSON.parse(job.payload_json)
        : job.payload_json;
    } catch {
      payload = null;
    }
    return {
      payload,
      valid: !!payload && typeof payload === "object" && !Array.isArray(payload),
    };
  };
  const preserveInvalidPayload = (job) => {
    updateJobPayload(job.id, JSON.stringify({
      _legacy_invalid_payload_json: job.payload_json ?? null,
      _orphaned_review_recovery_failed: "invalid_payload",
    }));
  };

  // Also check for orphaned waiting_on_review jobs whose human_input
  // child has already failed/timed out — these are permanent traps.
  if (hasJobs(["waiting_on_review"])) {
    const stuckReview = listJobs(["waiting_on_review"]);
    for (const rj of stuckReview) {
      // A waiting_on_review job should have a human_input child keeping it alive.
      // If all human_input children are terminal-failed, the review job is orphaned.
      // Grace period: don't requeue during transient failures — the child
      // may be retrying. Wait at least 30s after the review job was parked.
      // Zero children is also a permanent trap (the human_input child failed
      // to create, or was pruned): nothing will ever release the gate. Use a
      // longer grace there so an in-flight child creation isn't misread.
      const { orphaned } = orphanState(rj);
      if (orphaned) {
        if (!hasDisplay) {
          let remoteOperatorPresent = false;
          try { remoteOperatorPresent = isRemoteOperatorPresent?.() === true; } catch { /* fail closed below */ }
          if (remoteOperatorPresent && !headlessOrphanedReviewParkedLogged.has(rj.id)) {
            headlessOrphanedReviewParkedLogged.add(rj.id);
            log(`WI#${rj.work_item_id} job #${rj.id} review remains parked for the remote operator (all review children terminal)`, "yellow");
            logEvent({
              work_item_id: rj.work_item_id,
              job_id: rj.id,
              event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_PARKED,
              actor_type: EVENT_ACTORS.SCHEDULER,
              message: "Left in waiting_on_review because a remote operator is present",
            });
          } else if (!remoteOperatorPresent) {
            let failed = false;
            try {
              failed = runInTransaction(() => {
                const current = getJob(rj.id);
                if (current?.status !== "waiting_on_review" || current.lease_token || !orphanState(current).orphaned) {
                  return false;
                }
                const currentPayload = payloadState(current);
                if (!currentPayload.valid) preserveInvalidPayload(current);
                const changed = updateJobStatus(current.id, "failed", {
                  expectedStatuses: ["waiting_on_review"],
                });
                if (!changed) throw new Error("orphaned review changed during no-resolver recovery");
                logEvent({
                  work_item_id: current.work_item_id,
                  job_id: current.id,
                  event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_RECOVERY_EXHAUSTED,
                  actor_type: EVENT_ACTORS.SCHEDULER,
                  message: "Orphaned review had no local or remote resolver; failed closed",
                  event_json: JSON.stringify({ reason: "no_resolver" }),
                });
                refreshWorkItemStatus(current.work_item_id);
                return true;
              });
            } catch (err) {
              log(`WI#${rj.work_item_id} job #${rj.id} orphaned review recovery deferred: ${err?.message || String(err)}`, "yellow");
              continue;
            }
            if (failed) {
              log(`WI#${rj.work_item_id} job #${rj.id} orphaned review has no local or remote resolver — failing closed`, "yellow");
            }
          }
        } else {
          let outcome;
          try {
            outcome = runInTransaction(() => {
              // The scan above is intentionally outside a transaction. Re-read
              // after taking the write lock so a bridge/CLI resolution that won
              // the race is never overwritten by orphan recovery.
              const current = getJob(rj.id);
              if (current?.status !== "waiting_on_review" || current.lease_token || !orphanState(current).orphaned) {
                return { kind: "stale" };
              }

              // parseJobPayload deliberately falls back to {} for malformed
              // JSON. That is useful to readers, but unsafe here: preserve the
              // exact legacy value in a valid wrapper before failing closed.
              // (The schema's JSON update trigger otherwise rejects even a
              // status-only transition while the old payload is malformed.)
              const currentPayload = payloadState(current);
              if (!currentPayload.valid) {
                preserveInvalidPayload(current);
                const changed = updateJobStatus(current.id, "failed", {
                  expectedStatuses: ["waiting_on_review"],
                });
                if (!changed) throw new Error("orphaned review changed during malformed-payload recovery");
                logEvent({
                  work_item_id: current.work_item_id,
                  job_id: current.id,
                  event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_RECOVERY_EXHAUSTED,
                  actor_type: EVENT_ACTORS.SCHEDULER,
                  message: "Orphaned review payload was invalid; failed closed without reconstructing the gate",
                  event_json: JSON.stringify({ reason: "invalid_payload" }),
                });
                refreshWorkItemStatus(current.work_item_id);
                return { kind: "invalid_payload" };
              }

              const payload = currentPayload.payload;
              const recoveryCount = Math.max(
                0,
                Number.parseInt(String(payload._orphaned_review_recovery_count || 0), 10) || 0,
              );
              if (recoveryCount >= 1) {
                const changed = updateJobStatus(current.id, "failed", {
                  expectedStatuses: ["waiting_on_review"],
                });
                if (!changed) throw new Error("orphaned review changed during exhausted recovery");
                logEvent({
                  work_item_id: current.work_item_id,
                  job_id: current.id,
                  event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_RECOVERY_EXHAUSTED,
                  actor_type: EVENT_ACTORS.SCHEDULER,
                  message: "Orphaned review recovery exhausted after one automatic gate reconstruction; failed closed",
                  event_json: JSON.stringify({ recovery_count: recoveryCount }),
                });
                refreshWorkItemStatus(current.work_item_id);
                return { kind: "exhausted", recoveryCount };
              }

              updateJobPayload(current.id, JSON.stringify({
                ...payload,
                _assess_only: true,
                _orphaned_review_recovery_count: recoveryCount + 1,
              }));
              const changed = updateJobStatus(current.id, "queued", {
                expectedStatuses: ["waiting_on_review"],
              });
              if (!changed) throw new Error("orphaned review changed during gate reconstruction");
              logEvent({
                work_item_id: current.work_item_id,
                job_id: current.id,
                event_type: EVENT_TYPES.JOB_ORPHANED_REVIEW_RECOVERY,
                actor_type: EVENT_ACTORS.SCHEDULER,
                message: "Requeued from waiting_on_review for one automatic gate reconstruction",
                event_json: JSON.stringify({ recovery_count: recoveryCount + 1 }),
              });
              refreshWorkItemStatus(current.work_item_id);
              return { kind: "requeued", recoveryCount: recoveryCount + 1 };
            });
          } catch (err) {
            log(`WI#${rj.work_item_id} job #${rj.id} orphaned review recovery deferred: ${err?.message || String(err)}`, "yellow");
            continue;
          }

          if (outcome.kind === "exhausted") {
            log(`WI#${rj.work_item_id} job #${rj.id} orphaned review recovery already retried — failing closed`, "yellow");
          } else if (outcome.kind === "invalid_payload") {
            log(`WI#${rj.work_item_id} job #${rj.id} orphaned review has an invalid payload — failing closed`, "yellow");
          } else if (outcome.kind === "requeued") {
            log(`WI#${rj.work_item_id} job #${rj.id} orphaned in waiting_on_review (all review children failed) — requeuing once`, "yellow");
          }
        }
      }
    }
  }
}
