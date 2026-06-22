import {
  acquireSchedulerLock,
  forceAcquireSchedulerLock,
  getSchedulerLockInfo,
  logEvent,
  releaseSchedulerLock,
  renewSchedulerLock,
} from "../../queue/functions/index.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";

export class SchedulerLockLease {
  constructor({
    lockName = "main",
    ownerId,
    renewSec = 30,
    durationSec = renewSec * 2,
    lockStarvationThresholdMs = renewSec * 1500,
    lockRenewalErrorMaxMs = renewSec * 2 * 1000,
    acquireLockFn = acquireSchedulerLock,
    forceAcquireLockFn = forceAcquireSchedulerLock,
    renewLockFn = renewSchedulerLock,
    releaseLockFn = releaseSchedulerLock,
    getLockInfoFn = getSchedulerLockInfo,
    logEventFn = logEvent,
    emit = () => {},
    onLockLost = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    nowMs = () => Date.now(),
  } = {}) {
    this.lockName = lockName;
    this.ownerId = ownerId;
    this.renewSec = Math.max(1, Number(renewSec) || 30);
    this.durationSec = Math.max(1, Number(durationSec) || this.renewSec * 2);
    this.lockStarvationThresholdMs = Math.max(1, Number(lockStarvationThresholdMs) || this.renewSec * 1500);
    this.lockRenewalErrorMaxMs = Math.max(1, Number(lockRenewalErrorMaxMs) || this.renewSec * 2 * 1000);
    this.acquireLockFn = acquireLockFn;
    this.forceAcquireLockFn = forceAcquireLockFn;
    this.renewLockFn = renewLockFn;
    this.releaseLockFn = releaseLockFn;
    this.getLockInfoFn = getLockInfoFn;
    this.logEventFn = logEventFn;
    this.emit = emit;
    this.onLockLost = onLockLost;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.nowMs = nowMs;
    this.held = false;
    this.interval = null;
    this.lastRenewedAt = 0;
    this.lastStarvedAt = 0;
    this.renewalErrorCount = 0;
    this.renewalFirstErrorAt = 0;
    this.renewalExpectedAtMs = 0;
  }

  acquire(durationSec = this.durationSec) {
    const acquired = this.acquireLockFn(this.lockName, this.ownerId, durationSec);
    if (acquired) this.markHeld();
    return acquired;
  }

  forceAcquire(durationSec = this.durationSec) {
    const acquired = this.forceAcquireLockFn(this.lockName, this.ownerId, durationSec);
    if (acquired) this.markHeld();
    return acquired;
  }

  info() {
    return this.getLockInfoFn(this.lockName);
  }

  markHeld(nowMs = this.nowMs()) {
    this.held = true;
    this.lastRenewedAt = nowMs;
    this.renewalErrorCount = 0;
    this.renewalFirstErrorAt = 0;
    return this;
  }

  renewNow() {
    if (!this.held && !this.adoptIfHeldByOwner()) return false;
    const nowMs = this.nowMs();
    let renewed;
    try {
      this.maybeLogStarvation(nowMs);
    } catch (err) {
      const errorText = err?.message || String(err);
      this.emit(`Scheduler lock starvation telemetry failed: ${errorText}`, "yellow");
      log.warn("scheduler", "scheduler lock starvation telemetry failed", { error: errorText });
    }
    try {
      renewed = this.renewLockFn(this.lockName, this.ownerId, this.durationSec);
    } catch (err) {
      this.renewalErrorCount += 1;
      if (!this.renewalFirstErrorAt) this.renewalFirstErrorAt = nowMs;
      const lastGoodMs = this.lastRenewedAt || this.renewalFirstErrorAt;
      const elapsedSinceSuccessMs = nowMs - lastGoodMs;
      const errorText = err?.message || String(err);
      if (elapsedSinceSuccessMs >= this.lockRenewalErrorMaxMs) {
        const message = `Scheduler lock renewal errored for ${Math.ceil(elapsedSinceSuccessMs / 1000)}s; treating scheduler lock as lost`;
        log.warn("scheduler", "scheduler lock renewal errored past safety window", {
          error: errorText,
          errorCount: this.renewalErrorCount,
          elapsedSinceSuccessMs,
          maxErrorMs: this.lockRenewalErrorMaxMs,
        });
        this.#loseLock(message, {
          eventType: EVENT_TYPES.SCHEDULER_LOCK_RENEWAL_FAILED,
          eventJson: {
            error: errorText,
            error_count: this.renewalErrorCount,
            elapsed_since_success_ms: elapsedSinceSuccessMs,
            max_error_ms: this.lockRenewalErrorMaxMs,
            lock_renew_sec: this.renewSec,
          },
        });
        return false;
      }
      this.emit(`Scheduler lock renewal errored (transient - will retry next interval): ${errorText}`, "yellow");
      log.warn("scheduler", "scheduler lock renewal errored (transient)", {
        error: errorText,
        errorCount: this.renewalErrorCount,
        elapsedSinceSuccessMs,
        maxErrorMs: this.lockRenewalErrorMaxMs,
      });
      return true;
    }
    if (!renewed) {
      this.#loseLock("Lock stolen by another scheduler - stopping");
      return false;
    }
    this.renewalErrorCount = 0;
    this.renewalFirstErrorAt = 0;
    this.lastRenewedAt = nowMs;
    return true;
  }

  maybeLogStarvation(nowMs = this.nowMs()) {
    if (!this.lastRenewedAt) return;
    const elapsedMs = nowMs - this.lastRenewedAt;
    if (elapsedMs <= this.lockStarvationThresholdMs) return;
    if (this.lastStarvedAt >= this.lastRenewedAt) return;

    this.lastStarvedAt = nowMs;
    const message = `Scheduler lock renewal starved for ${Math.ceil(elapsedMs / 1000)}s`;
    this.emit(message, "yellow");
    this.logEventFn({
      event_type: EVENT_TYPES.SCHEDULER_LOCK_STARVED,
      actor_type: EVENT_ACTORS.SCHEDULER,
      actor_id: this.ownerId,
      message,
      event_json: {
        elapsed_ms: elapsedMs,
        threshold_ms: this.lockStarvationThresholdMs,
        lock_renew_sec: this.renewSec,
      },
    });
  }

  startRenewal() {
    if (this.interval) return true;
    if (!this.held && !this.adoptIfHeldByOwner()) return false;
    if (!this.renewNow()) return false;
    this.renewalExpectedAtMs = this.nowMs() + this.renewSec * 1000;
    this.interval = this.setIntervalFn(() => {
      const nowMs = this.nowMs();
      const lateMs = nowMs - this.renewalExpectedAtMs;
      if (lateMs > this.renewSec * 1000) {
        this.emit(`Lock renewal timer fired ${Math.round(lateMs / 1000)}s late - main thread was blocked`, "yellow");
        log.warn("scheduler", "lock renewal timer fired late (event loop blocked)", {
          lateMs,
          intervalMs: this.renewSec * 1000,
        });
      }
      this.renewalExpectedAtMs = nowMs + this.renewSec * 1000;
      this.renewNow();
    }, this.renewSec * 1000);
    this.interval?.unref?.();
    return true;
  }

  stopRenewal() {
    if (this.interval) {
      this.clearIntervalFn(this.interval);
      this.interval = null;
    }
    return this;
  }

  release() {
    this.stopRenewal();
    this.held = false;
    this.releaseLockFn(this.lockName, this.ownerId);
  }

  adoptIfHeldByOwner() {
    const lockInfo = this.info();
    if (lockInfo?.owner_id !== this.ownerId) return false;
    this.markHeld();
    return true;
  }

  #loseLock(message, options = {}) {
    this.held = false;
    this.stopRenewal();
    this.onLockLost(message, options);
  }
}
