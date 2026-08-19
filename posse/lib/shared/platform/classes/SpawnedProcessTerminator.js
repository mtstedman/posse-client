import { terminateSpawnedProcessTree } from "../functions/spawned-process.js";

/**
 * Owns a bounded graceful/forced termination sequence for one child process.
 * The terminal settle bound prevents inherited stdio held by descendants from
 * keeping a caller pending forever after both termination attempts.
 */
export class SpawnedProcessTerminator {
  constructor(proc, {
    platform = process.platform,
    processGroup = false,
    forceKillDelayMs = 250,
    settleDelayMs = 250,
    terminate = terminateSpawnedProcessTree,
  } = {}) {
    this.proc = proc;
    this.platform = platform;
    this.processGroup = processGroup;
    this.forceKillDelayMs = Math.max(1, Number(forceKillDelayMs) || 250);
    this.settleDelayMs = Math.max(1, Number(settleDelayMs) || 250);
    this.terminate = terminate;
    this.closed = false;
    this.forceKillUsed = false;
    this.forceTimer = null;
    this.settleTimer = null;
    this.terminationPromise = null;
    this.resolveTermination = null;
  }

  terminateAndWait() {
    if (this.closed) {
      return Promise.resolve({ confirmed: true, forceKillUsed: this.forceKillUsed, signal: this.proc?.signalCode || null });
    }
    if (this.terminationPromise) return this.terminationPromise;

    this.terminationPromise = new Promise((resolve) => {
      this.resolveTermination = resolve;
    });
    this.#terminate(false);
    this.forceTimer = setTimeout(() => {
      this.forceTimer = null;
      this.forceKillUsed = true;
      this.#terminate(true);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.#destroyPipes();
        this.#finish(false);
      }, this.settleDelayMs);
    }, this.forceKillDelayMs);
    return this.terminationPromise;
  }

  noteClose() {
    this.closed = true;
    this.#finish(true);
  }

  cancel() {
    this.#clearTimers();
    this.resolveTermination = null;
  }

  #terminate(force) {
    this.terminate(this.proc, {
      force,
      platform: this.platform,
      processGroup: this.processGroup,
    });
  }

  #destroyPipes() {
    for (const stream of [this.proc?.stdin, this.proc?.stdout, this.proc?.stderr]) {
      try { stream?.destroy?.(); } catch {}
    }
  }

  #clearTimers() {
    if (this.forceTimer) clearTimeout(this.forceTimer);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.forceTimer = null;
    this.settleTimer = null;
  }

  #finish(confirmed) {
    if (!this.resolveTermination) return;
    const resolve = this.resolveTermination;
    this.resolveTermination = null;
    this.#clearTimers();
    resolve({
      confirmed,
      forceKillUsed: this.forceKillUsed,
      signal: this.proc?.signalCode || (this.forceKillUsed ? "SIGKILL" : "SIGTERM"),
    });
  }
}
