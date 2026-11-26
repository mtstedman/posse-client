import { FORCE_ACQUIRE_LIVENESS_SEC } from "../../queue/functions/index.js";
import { reapOrphanedDaemons } from "../../../shared/tools/classes/daemon/index.js";
import { recordMemorySample } from "../../../shared/telemetry/functions/memory.js";
import { recordBootCrashResumeMarker, recordSchedulerLockDiagnostic } from "../../../shared/telemetry/functions/run-diagnostics.js";
import { LOCK_RENEW_SEC } from "../functions/config.js";
import { formatSchedulerLockDuration, formatStaleHeartbeatReason, schedulerLockTiming } from "../functions/lock-timing.js";

// Owns boot-time lock acquisition and takeover. Scheduler retains the public
// phase methods and owns cancellation/renewal, as with SchedulerLockController.
export class SchedulerBootLockController {
  constructor(scheduler) {
    this.scheduler = scheduler;
  }

  async acquire(emitBootEvent) {
    const scheduler = this.scheduler;
    scheduler._stopRequested = false;
    scheduler._stopMarked = false;
    scheduler._lockLost = false;
    scheduler._lockLostKilledJobIds.clear();
    // Log every decision so operators can diagnose boot stalls from the event log.
    scheduler._log(`Boot: scheduler=${scheduler.ownerId} lease=${scheduler.leaseSec}s concurrency=${scheduler.concurrency} poll=${scheduler.pollMs}ms repair=${scheduler.repairPollMs}ms`);
    // Reap native-binary daemon children orphaned by a crashed prior session
    // (their ledgers' owner pid is dead). Idempotent + image-verified, so it's
    // safe to run alongside other instances. Deferred OFF the boot critical
    // path: it's best-effort cleanup whose cost scales with the ledger
    // directory (and does synchronous image checks), so it must never gate or
    // slow the scheduler coming up. Runs on the next tick instead.
    setImmediate(() => {
      try {
        const reaped = reapOrphanedDaemons();
        if (reaped.killed || reaped.ledgers) {
          scheduler._log(`Boot: reaped ${reaped.killed} orphaned daemon(s) from ${reaped.ledgers} stale ledger(s)${reaped.skipped ? ` (${reaped.skipped} skipped)` : ""}`);
        }
      } catch { /* the reaper is a safety net, never block boot on it */ }
    });
    recordBootCrashResumeMarker({
      ownerId: scheduler.ownerId,
      lease_sec: scheduler.leaseSec,
      concurrency: scheduler.concurrency,
      poll_ms: scheduler.pollMs,
      repair_poll_ms: scheduler.repairPollMs,
    });
    recordMemorySample("scheduler.boot.start", {
      owner_id: scheduler.ownerId,
      concurrency: scheduler.concurrency,
    });
    emitBootEvent("lock acquired", { section: "scheduler", status: "running" });

    let gotLock = await scheduler.schedulerLock.acquireWithRetry();
    if (gotLock) {
      scheduler._log("Boot: lock acquired (no contention)");
      recordSchedulerLockDiagnostic({
        owner_id: scheduler.ownerId,
        phase: "acquire",
        decision: "acquired_no_contention",
      });
      emitBootEvent("lock acquired", { section: "scheduler", status: "ok", detail: "no contention" });
    } else {
      const lockInfo = scheduler.schedulerLock.info();
      if (!lockInfo) {
        scheduler._log("Boot: lock acquire failed but no lock row exists — aborting", "red");
        recordSchedulerLockDiagnostic({
          owner_id: scheduler.ownerId,
          phase: "acquire",
          decision: "failed_no_lock_row",
        });
        return false;
      }

      const lockDurationMs = LOCK_RENEW_SEC * 2 * 1000;
      const {
        heartbeatAge,
        expiresIn,
        heartbeatFromExpiresAt,
        heartbeatInvalid,
      } = schedulerLockTiming(lockInfo, lockDurationMs);
      const STALE_THRESHOLD = LOCK_RENEW_SEC * 2 * 1000; // 60s — 2 missed renewals

      scheduler._log(
        `Boot: lock contention — owner=${lockInfo.owner_id} ` +
        `heartbeat_age=${formatSchedulerLockDuration(heartbeatAge)}${heartbeatFromExpiresAt ? " (from expires_at)" : ""}${heartbeatInvalid ? " (invalid)" : ""} ` +
        `expires_in=${formatSchedulerLockDuration(expiresIn)} ` +
        `stale_threshold=${STALE_THRESHOLD / 1000}s`,
        "yellow"
      );
      recordSchedulerLockDiagnostic({
        owner_id: scheduler.ownerId,
        phase: "contention",
        decision: "inspect_existing_lock",
        lockInfo,
        heartbeat_age_ms: heartbeatAge,
        expires_in_ms: expiresIn,
        heartbeat_from_expires_at: heartbeatFromExpiresAt,
        heartbeat_invalid: heartbeatInvalid,
        stale_threshold_ms: STALE_THRESHOLD,
      });

      // IMPORTANT: orphan recovery has NOT run yet. Surface this explicitly
      // so operators know the system is not yet self-healing.
      scheduler._log("Boot: ⚠ orphan recovery and worktree GC have NOT run yet (blocked by lock)", "yellow");

      if (heartbeatAge > STALE_THRESHOLD) {
        // No heartbeat in 2+ renewal cycles — holder crashed. Force-steal immediately.
        scheduler._log(`Boot: decision=FORCE_STEAL (heartbeat stale: ${formatStaleHeartbeatReason(heartbeatAge, STALE_THRESHOLD)})`, "yellow");
        recordSchedulerLockDiagnostic({
          owner_id: scheduler.ownerId,
          phase: "contention",
          decision: "force_steal_stale_heartbeat",
          lockInfo,
          heartbeat_age_ms: heartbeatAge,
          stale_threshold_ms: STALE_THRESHOLD,
        });
        gotLock = scheduler.schedulerLock.forceAcquire();
        if (!gotLock) {
          scheduler._log("Boot: decision=EXIT (lock heartbeat refreshed before force-steal — holder is alive)", "red");
          recordSchedulerLockDiagnostic({
            owner_id: scheduler.ownerId,
            phase: "contention",
            decision: "exit_heartbeat_refreshed_before_force_steal",
            lockInfo: scheduler.schedulerLock.info(),
          });
          return false;
        }
      } else if (expiresIn <= LOCK_RENEW_SEC * 1000) {
        // Lock expires within one renewal cycle — just wait for it instead of the
        // full heartbeat verification dance. Much faster for post-crash restarts.
        const waitMs = expiresIn + 1000; // 1s buffer
        scheduler._log(`Boot: decision=WAIT_FOR_EXPIRY (lock expires in ${formatSchedulerLockDuration(expiresIn)}, waiting ${formatSchedulerLockDuration(waitMs)})`, "yellow");
        recordSchedulerLockDiagnostic({
          owner_id: scheduler.ownerId,
          phase: "contention",
          decision: "wait_for_expiry",
          lockInfo,
          wait_ms: waitMs,
          expires_in_ms: expiresIn,
        });
        await scheduler._interruptibleSleep(waitMs);
        if (scheduler._stopRequested) return false;
        gotLock = scheduler.schedulerLock.acquire();
        if (!gotLock) {
          // Lock was renewed — another scheduler is alive
          scheduler._log("Boot: decision=EXIT (lock renewed during wait — another scheduler is alive)", "red");
          recordSchedulerLockDiagnostic({
            owner_id: scheduler.ownerId,
            phase: "contention",
            decision: "exit_lock_renewed_during_expiry_wait",
            lockInfo: scheduler.schedulerLock.info(),
          });
          return false;
        }
        scheduler._log("Boot: lock acquired (expired during wait)");
      } else {
        // Recent heartbeat, lock won't expire soon — another scheduler may be alive.
        // Wait one renewal cycle to confirm it's still renewing.
        const waitMs = (LOCK_RENEW_SEC + 5) * 1000; // 35s
        scheduler._log(`Boot: decision=VERIFY_LIVENESS (waiting ${Math.ceil(waitMs / 1000)}s for heartbeat change)`, "yellow");
        scheduler._log("Boot: ⚠ startup blocked — workers idle until lock resolved", "red");
        recordSchedulerLockDiagnostic({
          owner_id: scheduler.ownerId,
          phase: "contention",
          decision: "verify_liveness",
          lockInfo,
          wait_ms: waitMs,
          heartbeat_age_ms: heartbeatAge,
          expires_in_ms: expiresIn,
        });
        await scheduler._interruptibleSleep(waitMs);
        if (scheduler._stopRequested) return false;

        // Re-check heartbeat after waiting
        gotLock = scheduler.schedulerLock.acquire();
        if (gotLock) {
          scheduler._log("Boot: lock acquired (expired during wait)");
        } else {
          const updated = scheduler.schedulerLock.info();
          if (!updated) {
            gotLock = scheduler.schedulerLock.acquire();
            scheduler._log(gotLock ? "Boot: lock acquired (vanished, then claimed)" : "Boot: lock still unavailable", gotLock ? "yellow" : "red");
          } else {
            // Did the holder's heartbeat advance during our wait? Compare
            // acquired_at timestamps — a live scheduler renews on every
            // LOCK_RENEW_SEC tick, so after a full wait cycle the timestamp
            // must have changed. Checking age alone is wrong: a lock acquired
            // just before a crash has low initial age, and adding the wait
            // duration may not cross STALE_THRESHOLD in one pass.
            const { heartbeatAge: newAge } = schedulerLockTiming(updated, LOCK_RENEW_SEC * 2 * 1000);
            const heartbeatAdvanced = updated.acquired_at !== lockInfo.acquired_at;
            scheduler._log(`Boot: post-wait heartbeat_age=${formatSchedulerLockDuration(newAge)} (was ${formatSchedulerLockDuration(heartbeatAge)}) advanced=${heartbeatAdvanced}`);
            if (!heartbeatAdvanced) {
              scheduler._log(`Boot: decision=FORCE_STEAL (heartbeat did not advance during wait — holder confirmed dead)`, "yellow");
              recordSchedulerLockDiagnostic({
                owner_id: scheduler.ownerId,
                phase: "contention",
                decision: "force_steal_heartbeat_did_not_advance",
                lockInfo: updated,
                previous_heartbeat_age_ms: heartbeatAge,
                heartbeat_age_ms: newAge,
              });
              gotLock = scheduler.schedulerLock.forceAcquire();
              if (!gotLock) gotLock = await scheduler._retryForceStealAfterLivenessCutoff(updated);
              if (!gotLock && scheduler._stopRequested) return false;
              if (!gotLock) {
                scheduler._log("Boot: decision=EXIT (lock heartbeat refreshed before force-steal — holder revived)", "red");
                recordSchedulerLockDiagnostic({
                  owner_id: scheduler.ownerId,
                  phase: "contention",
                  decision: "exit_holder_revived_before_force_steal",
                  lockInfo: scheduler.schedulerLock.info(),
                });
                return false;
              }
            } else {
              scheduler._log(`Boot: decision=EXIT (heartbeat advanced — scheduler ${updated.owner_id} is alive)`, "red");
              recordSchedulerLockDiagnostic({
                owner_id: scheduler.ownerId,
                phase: "contention",
                decision: "exit_heartbeat_advanced",
                lockInfo: updated,
                previous_heartbeat_age_ms: heartbeatAge,
                heartbeat_age_ms: newAge,
              });
              return false;
            }
          }
        }
      }
    }

    if (!gotLock) {
      scheduler._log("Boot: could not acquire scheduler lock — aborting", "red");
      recordSchedulerLockDiagnostic({
        owner_id: scheduler.ownerId,
        phase: "acquire",
        decision: "failed",
        lockInfo: scheduler.schedulerLock.info(),
      });
      return false;
    }
    recordSchedulerLockDiagnostic({
      owner_id: scheduler.ownerId,
      phase: "acquire",
      decision: "held",
      lockInfo: scheduler.schedulerLock.info(),
    });

    // Some contention paths acquire the lock after waiting/stealing rather
    // than through the no-contention branch above. Always publish a terminal
    // event once we know the lock is held so the boot panel cannot leave the
    // row spinning for the rest of a long ATLAS warm.
    emitBootEvent("lock acquired", { section: "scheduler", status: "ok", detail: "held" });

    scheduler._running = true;
    if (!scheduler._startLockRenewal()) return false;
    return true;
  }

  /**
   * The verify wait showed the holder's heartbeat did not advance, but a holder
   * that crashed within ~10 s of its last renewal is still inside
   * forceAcquire's FORCE_ACQUIRE_LIVENESS_SEC cutoff when that 35 s wait ends.
   * Wait out the rest of the cutoff (or to lock expiry, if sooner) and try once
   * more. The cutoff still guards the steal itself: a holder that renews in the
   * meantime is refused.
   *
   * @param {any} observed the lock row whose heartbeat did not advance
   * @returns {Promise<boolean>} true if the lock is now held
   */
  async retryAfterLivenessCutoff(observed) {
    const scheduler = this.scheduler;
    const current = scheduler.schedulerLock.info();
    if (!current) return scheduler.schedulerLock.acquire();
    // A changed heartbeat means the holder did revive; leave it alone.
    if (current.owner_id !== observed?.owner_id || current.acquired_at !== observed?.acquired_at) return false;
    const { heartbeatAge, expiresIn } = schedulerLockTiming(current, LOCK_RENEW_SEC * 2 * 1000);
    const untilCutoffMs = FORCE_ACQUIRE_LIVENESS_SEC * 1000 - heartbeatAge;
    const waitMs = Math.max(0, Math.min(untilCutoffMs, expiresIn)) + 1000; // 1s buffer
    scheduler._log(`Boot: decision=WAIT_FOR_FORCE_STEAL_CUTOFF (heartbeat_age=${formatSchedulerLockDuration(heartbeatAge)} is inside the ${FORCE_ACQUIRE_LIVENESS_SEC}s force-steal cutoff, waiting ${formatSchedulerLockDuration(waitMs)})`, "yellow");
    recordSchedulerLockDiagnostic({
      owner_id: scheduler.ownerId,
      phase: "contention",
      decision: "wait_for_force_steal_liveness_cutoff",
      lockInfo: current,
      wait_ms: waitMs,
      heartbeat_age_ms: heartbeatAge,
      expires_in_ms: expiresIn,
    });
    await scheduler._interruptibleSleep(waitMs);
    if (scheduler._stopRequested) return false;
    return scheduler.schedulerLock.acquire() || scheduler.schedulerLock.forceAcquire();
  }

}
