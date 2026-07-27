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
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (typeof requestAbort !== "function") {
      throw new TypeError("CodexTerminalUsageFlush requires an abort callback");
    }
    this.requestAbort = requestAbort;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 250);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
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
    return { delayed: true, reason: "terminal_usage_flush" };
  }

  noteUsage() {
    if (!this.pendingReason || this.state.finishedAt != null) return false;
    this.state.completed = true;
    this.#finish();
    return true;
  }

  cancel() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
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
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const reason = this.pendingReason;
    this.pendingReason = null;
    this.state.finishedAt = this.now();
    this.requestAbort(reason);
  }
}
