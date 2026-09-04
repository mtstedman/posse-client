const TERMINAL_HANDOFF_ABORT_CODE = "POSSE_AGENT_HANDOFF_TERMINAL";

function reasonCode(reason) {
  if (reason == null) return null;
  if (typeof reason === "object") return String(reason.code || reason.name || "abort");
  return String(reason);
}

/**
 * Gives Codex a tightly bounded chance to emit the usage event that follows a
 * terminal tool result. Other aborts remain immediate.
 */
export class CodexTerminalUsageFlush {
  constructor(requestAbort, {
    timeoutMs = 250,
    pollIntervalMs = 25,
    pollUsage = null,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setPollTimer = setInterval,
    clearPollTimer = clearInterval,
  } = {}) {
    if (typeof requestAbort !== "function") {
      throw new TypeError("CodexTerminalUsageFlush requires an abort callback");
    }
    this.requestAbort = requestAbort;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 250);
    this.pollIntervalMs = Math.max(1, Number(pollIntervalMs) || 25);
    this.pollUsage = typeof pollUsage === "function" ? pollUsage : null;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setPollTimer = setPollTimer;
    this.clearPollTimer = clearPollTimer;
    this.timer = null;
    this.pollTimer = null;
    this.pendingReason = null;
    this.state = {
      attempted: false,
      completed: false,
      timedOut: false,
      startedAt: null,
      finishedAt: null,
    };
  }

  request(reason = null) {
    if (reasonCode(reason) !== TERMINAL_HANDOFF_ABORT_CODE) {
      this.requestAbort(reason);
      return { delayed: false, reason: "non_terminal_abort" };
    }
    if (this.pendingReason || this.state.finishedAt != null) {
      return { delayed: true, reason: "already_pending" };
    }
    this.pendingReason = reason;
    this.state.attempted = true;
    this.state.startedAt = this.now();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.state.timedOut = true;
      this.#finish();
    }, this.timeoutMs);
    this.timer?.unref?.();
    this.#startUsagePolling();
    return { delayed: true, reason: "terminal_usage_flush" };
  }

  setUsagePoller(pollUsage) {
    this.pollUsage = typeof pollUsage === "function" ? pollUsage : null;
    this.#startUsagePolling();
  }

  noteUsage() {
    if (!this.pendingReason || this.state.finishedAt != null) return false;
    this.state.completed = true;
    this.#finish();
    return true;
  }

  cancel() {
    this.#clearTimers();
    this.pendingReason = null;
  }

  snapshot() {
    const durationMs = this.state.startedAt != null && this.state.finishedAt != null
      ? Math.max(0, this.state.finishedAt - this.state.startedAt)
      : null;
    return {
      terminalUsageFlushAttempted: this.state.attempted,
      terminalUsageFlushCompleted: this.state.completed,
      terminalUsageFlushTimedOut: this.state.timedOut,
      terminalUsageFlushDurationMs: durationMs,
      terminalUsageFlushTimeoutMs: this.timeoutMs,
    };
  }

  #finish() {
    if (!this.pendingReason || this.state.finishedAt != null) return;
    this.#clearTimers();
    const reason = this.pendingReason;
    this.pendingReason = null;
    this.state.finishedAt = this.now();
    this.requestAbort(reason);
  }

  #startUsagePolling() {
    if (!this.pendingReason || this.state.finishedAt != null || !this.pollUsage || this.pollTimer) return;
    if (this.#pollForUsage()) return;
    this.pollTimer = this.setPollTimer(() => this.#pollForUsage(), this.pollIntervalMs);
    this.pollTimer?.unref?.();
  }

  #pollForUsage() {
    if (!this.pendingReason || this.state.finishedAt != null || !this.pollUsage) return false;
    let foundUsage = false;
    try {
      foundUsage = this.pollUsage() === true;
    } catch {
      return false;
    }
    return foundUsage ? this.noteUsage() : false;
  }

  #clearTimers() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.pollTimer) {
      this.clearPollTimer(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
