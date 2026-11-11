// Lending the run screen's terminal to a foreground command and taking it
// back: the screen leaves the alternate buffer and raw mode, stops drawing and
// stops reading keys, while everything else about the display (its events,
// workers, questions, the console interception) keeps running. A command that
// has to ask the operator something on the plain terminal (a session merge's
// typed approval) runs in between, exactly as it does from the session console.

const RENDER_INTERVAL_MS = 120;

export class DisplayTerminalLease {
  /** @returns {boolean} true when the terminal was handed over. */
  lendTerminal() {
    if (!this._started || this._terminalLent) return false;
    this._terminalLent = true;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    this._renderScheduled = false;
    this._scheduledRenderAt = 0;
    for (const timer of this._rawInputFallbackTimers) clearTimeout(timer);
    this._rawInputFallbackTimers.clear();
    if (process.stdin.isTTY && this._keypressHandler) {
      process.stdin.off("keypress", this._keypressHandler);
      if (this._stdinDataHandler) process.stdin.off("data", this._stdinDataHandler);
      try { process.stdin.setRawMode(false); } catch { /* the terminal may be gone */ }
      process.stdin.pause();
    }
    if (this._usingAlternateScreen) {
      try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* the terminal may be gone */ }
      // stop() must not leave the alternate buffer a second time.
      this._usingAlternateScreen = false;
    }
    return true;
  }

  /** Take the terminal back and redraw. A display stopped meanwhile stays stopped. */
  reclaimTerminal() {
    if (!this._terminalLent) return false;
    this._terminalLent = false;
    if (!this._started) return false;
    if (process.stdin.isTTY && this._keypressHandler) {
      try { process.stdin.setRawMode(true); } catch { /* the terminal may be gone */ }
      process.stdin.resume();
      process.stdin.on("keypress", this._keypressHandler);
      if (this._stdinDataHandler) process.stdin.on("data", this._stdinDataHandler);
    }
    if (process.stdout.isTTY) {
      this._usingAlternateScreen = true;
      try { process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J"); } catch { /* the terminal may be gone */ }
    }
    // The alternate buffer is empty: draw the whole frame, not a diff.
    this._lastFrame = "";
    this._lastFrameInput = "";
    this._resetBlockingOverlayBaseFrame();
    this._interval = setInterval(() => this.requestRender({ advanceAnimation: true }), RENDER_INTERVAL_MS);
    this.requestRender({ force: true });
    return true;
  }
}
