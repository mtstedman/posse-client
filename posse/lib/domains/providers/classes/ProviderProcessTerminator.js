import { terminateSpawnedProcess } from "../functions/shared/windows-spawn.js";

function reasonCode(reason) {
  if (reason == null) return null;
  if (typeof reason === "object") return String(reason.code || reason.name || "abort");
  return String(reason);
}

/**
 * Owns graceful/forced termination of one spawned provider process and keeps
 * the timestamps needed to prove what happened after an abort request.
 */
export class ProviderProcessTerminator {
  constructor(proc, {
    platform = process.platform,
    forceKillDelayMs = 3000,
    terminate = terminateSpawnedProcess,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.proc = proc;
    this.platform = platform;
    this.forceKillDelayMs = Math.max(1, Number(forceKillDelayMs) || 3000);
    this.terminate = terminate;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.forceKillTimer = null;
    this.state = {
      abortObserved: false,
      abortObservedAt: null,
      abortReasonCode: null,
      terminationReason: null,
      terminationRequestedAt: null,
      gracefulTerminationAttempted: false,
      forceKillTimerFired: false,
      forceKillUsed: false,
      forceKillIssuedAt: null,
      providerCloseAt: null,
    };
  }

  requestAbort(reason = null) {
    if (!this.state.abortObserved) {
      this.state.abortObserved = true;
      this.state.abortObservedAt = this.now();
      this.state.abortReasonCode = reasonCode(reason);
    }
    this.requestTermination("abort");
  }

  requestTermination(reason = "termination") {
    if (this.state.providerCloseAt != null) return this.snapshot();
    if (this.state.terminationRequestedAt == null) {
      this.state.terminationReason = String(reason || "termination");
      this.state.terminationRequestedAt = this.now();
      const forceImmediately = this.platform === "win32";
      this.state.gracefulTerminationAttempted = !forceImmediately;
      this.state.forceKillUsed = forceImmediately;
      if (forceImmediately) this.state.forceKillIssuedAt = this.state.terminationRequestedAt;
      this.terminate(this.proc, { force: forceImmediately, platform: this.platform });
      if (!forceImmediately) this.#scheduleForceKill();
    }
    return this.snapshot();
  }

  #scheduleForceKill() {
    if (this.forceKillTimer) return;
    this.forceKillTimer = this.setTimer(() => {
      this.forceKillTimer = null;
      if (this.state.providerCloseAt != null || this.proc?.exitCode != null) return;
      this.state.forceKillTimerFired = true;
      this.state.forceKillUsed = true;
      this.state.forceKillIssuedAt = this.now();
      this.terminate(this.proc, { force: true, platform: this.platform });
    }, this.forceKillDelayMs);
    this.forceKillTimer?.unref?.();
  }

  noteClose(at = this.now()) {
    if (this.state.providerCloseAt == null) this.state.providerCloseAt = at;
    this.cancelTimer();
    return this.snapshot();
  }

  cancelTimer() {
    if (!this.forceKillTimer) return;
    this.clearTimer(this.forceKillTimer);
    this.forceKillTimer = null;
  }

  snapshot() {
    const closeAfterAbortMs = this.state.providerCloseAt != null && this.state.abortObservedAt != null
      ? Math.max(0, this.state.providerCloseAt - this.state.abortObservedAt)
      : null;
    return {
      ...this.state,
      providerCloseAfterAbortMs: closeAfterAbortMs,
    };
  }
}
