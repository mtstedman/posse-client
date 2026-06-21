import { createRequire } from "module";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { trackSpawnedProcess } from "./windows-spawn.js";

const require = createRequire(import.meta.url);
const OPTIONAL_PTY_PACKAGES = [
  "node-pty",
  "@homebridge/node-pty-prebuilt-multiarch",
];
const SLOW_PTY_SPAWN_MS = 1000;

export class InteractiveCliUnavailableError extends Error {
  constructor(message = "Interactive CLI backend is unavailable") {
    super(message);
    this.name = "InteractiveCliUnavailableError";
    this.code = "INTERACTIVE_CLI_UNAVAILABLE";
  }
}

function resolveOptionalPtyModule() {
  for (const packageName of OPTIONAL_PTY_PACKAGES) {
    try {
      const mod = require(packageName);
      if (mod?.spawn) return mod;
    } catch {
      // Optional dependency; try the next known package.
    }
  }
  return null;
}

export function createNodePtyBackend({ ptyModule = null } = {}) {
  const pty = ptyModule || resolveOptionalPtyModule();
  if (!pty?.spawn) {
    throw new InteractiveCliUnavailableError(
      `Install one of ${OPTIONAL_PTY_PACKAGES.join(", ")} to enable interactive CLI sessions.`
    );
  }

  return {
    name: "node-pty",
    spawn(command, args = [], opts = {}) {
      const startedAt = Date.now();
      let proc;
      try {
        proc = pty.spawn(command, args, {
          name: opts.termName || "xterm-256color",
          cols: opts.cols || 120,
          rows: opts.rows || 40,
          cwd: opts.cwd || process.cwd(),
          env: opts.env || process.env,
        });
      } catch (err) {
        log.warn("provider", "Interactive CLI pty spawn failed", {
          backend: "node-pty",
          command,
          durationMs: Date.now() - startedAt,
          error: err?.message || String(err),
        });
        throw err;
      } finally {
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_PTY_SPAWN_MS) {
          log.warn("provider", "Interactive CLI pty spawn was slow", {
            backend: "node-pty",
            command,
            durationMs,
          });
        }
      }
      let resolveExit;
      const exitPromise = new Promise((resolve) => {
        resolveExit = resolve;
      });
      const forgetTrackedProcess = trackSpawnedProcess(proc, command, {
        label: `interactive-cli:${command}`,
        cwd: opts.cwd || process.cwd(),
      });
      proc.onExit?.((event) => {
        forgetTrackedProcess();
        resolveExit({
          exitCode: event?.exitCode ?? null,
          signal: event?.signal ?? null,
        });
      });

      return {
        pid: Number.isFinite(proc.pid) ? proc.pid : null,
        onData(callback) {
          const disposable = proc.onData((data) => callback(String(data || "")));
          return () => disposable?.dispose?.();
        },
        write(data) {
          proc.write(String(data || ""));
        },
        resize(cols, rows) {
          try { proc.resize(cols, rows); } catch {}
        },
        kill() {
          try { proc.kill(); } catch {}
        },
        exitPromise,
      };
    },
  };
}

let defaultBackend = undefined;

export function getDefaultInteractiveCliBackend() {
  if (defaultBackend !== undefined) return defaultBackend;
  try {
    defaultBackend = createNodePtyBackend();
  } catch {
    defaultBackend = null;
  }
  return defaultBackend;
}

export function stripTerminalControls(text) {
  let value = String(text || "");
  value = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  value = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  value = value.replace(/\x1b[()][A-Za-z0-9]/g, "");
  value = value.replace(/\x1b[=>]/g, "");
  value = value.replace(/\r/g, "");
  while (/[^\n]\x08/.test(value)) {
    value = value.replace(/[^\n]\x08/g, "");
  }
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

export class InteractiveCliSession {
  constructor({
    command,
    args = [],
    cwd = null,
    env = process.env,
    backend = null,
    timeoutMs = 15_000,
    quietMs = 250,
    cols = 120,
    rows = 40,
  } = {}) {
    this.command = command;
    this.args = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
    this.cwd = cwd || process.cwd();
    this.env = env || process.env;
    this.backend = backend || getDefaultInteractiveCliBackend();
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 15_000;
    this.quietMs = Number.isFinite(quietMs) ? Math.max(0, quietMs) : 250;
    this.cols = cols || 120;
    this.rows = rows || 40;
    this.proc = null;
    this.transcript = "";
    this.lastDataAt = 0;
    this.startedAt = 0;
    this.waiters = new Set();
    this.dataUnsubscribe = null;
  }

  start() {
    if (this.proc) return this;
    if (!this.command) throw new Error("Interactive CLI session requires a command.");
    if (!this.backend?.spawn) {
      throw new InteractiveCliUnavailableError();
    }
    this.startedAt = Date.now();
    this.lastDataAt = this.startedAt;
    this.proc = this.backend.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      cols: this.cols,
      rows: this.rows,
    });
    this.dataUnsubscribe = this.proc.onData?.((data) => this.#handleData(data)) || null;
    return this;
  }

  write(data) {
    this.start();
    this.proc.write(String(data || ""));
  }

  sendLine(line = "") {
    this.write(`${String(line)}\r`);
  }

  getTranscript({ clean = false } = {}) {
    return clean ? stripTerminalControls(this.transcript) : this.transcript;
  }

  cleanTranscript() {
    return this.getTranscript({ clean: true });
  }

  waitFor(predicate, { timeoutMs = this.timeoutMs } = {}) {
    this.start();
    if (typeof predicate !== "function") {
      throw new Error("Interactive CLI waitFor requires a predicate function.");
    }

    const current = this.getTranscript();
    if (predicate(current, this)) return Promise.resolve(current);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for interactive CLI output.`));
      }, Math.max(1, timeoutMs || this.timeoutMs));
      waiter.timer.unref?.();
      this.waiters.add(waiter);
    });
  }

  async waitForQuiet({ quietMs = this.quietMs, timeoutMs = this.timeoutMs } = {}) {
    this.start();
    const started = Date.now();
    const resolvedQuietMs = Math.max(0, quietMs || 0);
    const resolvedTimeoutMs = Math.max(1, timeoutMs || this.timeoutMs);
    while (Date.now() - started <= resolvedTimeoutMs) {
      if (Date.now() - this.lastDataAt >= resolvedQuietMs) return this.getTranscript();
      await delay(Math.min(50, Math.max(10, resolvedQuietMs || 10)));
    }
    throw new Error(`Timed out after ${resolvedTimeoutMs}ms waiting for interactive CLI quiet period.`);
  }

  async runScript(steps = [], { finalQuietMs = null } = {}) {
    this.start();
    for (const step of steps) {
      if (typeof step === "string") {
        this.sendLine(step);
        continue;
      }
      if (!step || typeof step !== "object") continue;
      if (step.send != null) this.write(step.send);
      if (step.sendLine != null) this.sendLine(step.sendLine);
      if (step.waitForText != null) {
        const needle = String(step.waitForText);
        await this.waitFor(
          (text) => stripTerminalControls(text).includes(needle),
          { timeoutMs: step.timeoutMs || this.timeoutMs }
        );
      }
      if (typeof step.waitFor === "function") {
        await this.waitFor(step.waitFor, { timeoutMs: step.timeoutMs || this.timeoutMs });
      }
      if (step.quietMs != null) {
        await this.waitForQuiet({
          quietMs: step.quietMs,
          timeoutMs: step.timeoutMs || this.timeoutMs,
        });
      }
      if (step.delayMs != null) await delay(step.delayMs);
    }
    if (finalQuietMs != null) {
      await this.waitForQuiet({ quietMs: finalQuietMs, timeoutMs: this.timeoutMs });
    }
    return this.getTranscript();
  }

  async close({ gracefulMs = 500, kill = true } = {}) {
    const proc = this.proc;
    if (!proc) return;
    try { this.dataUnsubscribe?.(); } catch {}
    this.dataUnsubscribe = null;
    if (proc.exitPromise && gracefulMs > 0) {
      try {
        const exited = await Promise.race([
          proc.exitPromise.then(() => true, () => true),
          delay(gracefulMs).then(() => false),
        ]);
        if (exited) return;
      } catch {
        // Close is cleanup only; callers should keep the original failure.
      }
    }
    if (kill) {
      try { proc.kill?.(); } catch {}
    }
  }

  #handleData(data) {
    this.transcript += String(data || "");
    this.lastDataAt = Date.now();
    for (const waiter of Array.from(this.waiters)) {
      let matched = false;
      try {
        matched = !!waiter.predicate(this.transcript, this);
      } catch (err) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.reject(err);
        continue;
      }
      if (!matched) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(this.transcript);
    }
  }
}
