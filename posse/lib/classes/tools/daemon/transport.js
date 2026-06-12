// @ts-check
//
// Daemon transports — the one pluggable seam under the shared Daemon.
//
// A transport hosts a long-lived endpoint that consumes framed JSON request
// objects and emits framed JSON response objects. Everything above it (the
// Daemon: queueing, id correlation, lifecycle, sync access) is transport-
// agnostic; a transport only knows how to spawn its host, send a message, and
// surface incoming messages + death.
//
// Contract every transport implements:
//   start():        boolean            spawn the host; idempotent; false if unavailable
//   send(message):  void               send one request object (the transport frames it)
//   onMessage(cb):  void               register cb(responseObject) — one call per response
//   onExit(cb):     void               register cb() — called once when the host dies
//   kill():         void               terminate the host immediately
//   retire(graceMs): void              graceful stop: signal end-of-input, give the
//                                      host graceMs to drain and exit on its own,
//                                      then kill. Never blocks the caller.
//   isAlive():      boolean
//
// Two host kinds, one interface:
//   ProcessTransport — a child process speaking newline-delimited JSON on stdio
//                      (e.g. `posse-git worker --stdio`).
//   ThreadTransport  — a Node worker thread exchanging structured-clone messages.

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { recordDaemonSpawn, forgetDaemonSpawn } from "./process-ledger.js";

/**
 * @typedef {Object} Transport
 * @property {() => boolean} start
 * @property {(message: Record<string, unknown>) => void} send
 * @property {(cb: (message: Record<string, unknown>) => void) => void} onMessage
 * @property {(cb: () => void) => void} onExit
 * @property {() => void} kill
 * @property {(graceMs?: number) => void} [retire]
 * @property {() => boolean} isAlive
 * @property {() => Promise<void>} [dispose]
 * @property {() => number | null} [hostPid]
 */

/**
 * Child-process transport: spawns a binary and exchanges newline-delimited JSON
 * over stdin/stdout. Faithful to the proven posse-git worker client.
 *
 * @param {{
 *   resolveBin: () => string | null,
 *   buildArgs: () => string[],
 *   env?: () => NodeJS.ProcessEnv,
 *   spawnImpl?: typeof spawn,
 *   label?: string,
 * }} opts
 * @returns {Transport}
 */
export function ProcessTransport(opts) {
  const spawnImpl = opts.spawnImpl || spawn;
  /** @type {import("node:child_process").ChildProcess | null} */
  let proc = null;
  /** Last spawned child pid, for the process ledger (orphan reaping). */
  let spawnedPid = null;
  let buffer = "";
  /** @type {Array<(m: Record<string, unknown>) => void>} */
  const messageHandlers = [];
  /** @type {Array<() => void>} */
  const exitHandlers = [];

  const emitExit = () => {
    proc = null;
    if (spawnedPid != null) { forgetDaemonSpawn(spawnedPid); spawnedPid = null; }
    buffer = "";
    for (const cb of exitHandlers) cb();
  };

  return {
    start() {
      if (proc && !proc.killed && proc.exitCode == null) return true;
      const bin = opts.resolveBin();
      if (!bin) return false;
      try {
        proc = spawnImpl(bin, opts.buildArgs(), {
          cwd: process.cwd(),
          env: opts.env ? opts.env() : process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        proc = null;
        return false;
      }
      buffer = "";
      // Don't let an idle daemon pin the event loop: unref the child and its
      // pipes so the host process can exit when its real work is done (an
      // in-flight request's own timer keeps the loop alive meanwhile). Without
      // this, `node --test` files finish but never exit and the runner hangs.
      proc.unref();
      proc.stdout?.unref();
      proc.stderr?.unref();
      proc.stdin?.unref();
      // Hard-ledger the child so a crashed parent's orphan can be reaped at the
      // next boot (the unref above means the OS won't clean it up for us).
      spawnedPid = proc.pid ?? null;
      recordDaemonSpawn(spawnedPid, bin, { label: opts.label });
      proc.stdout?.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          for (const cb of messageHandlers) cb(message);
        }
      });
      proc.stderr?.on("data", () => { /* host diagnostics; ignored */ });
      proc.on("error", emitExit);
      proc.on("exit", emitExit);
      return true;
    },
    send(message) {
      proc?.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(cb) { messageHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
    kill() {
      const p = proc;
      proc = null;
      if (spawnedPid != null) { forgetDaemonSpawn(spawnedPid); spawnedPid = null; }
      try { p?.stdin?.end(); } catch { /* ignore */ }
      try { p?.kill(); } catch { /* ignore */ }
    },
    /**
     * Graceful stop. EOF on stdin is the stdio-host stop signal: the worker
     * loop drains its in-flight request and exits on its own — no mid-native-
     * call termination. Only if the host is still alive after `graceMs` does
     * the hard kill fire. Detaches immediately so a replacement can start
     * while the old host drains; the existing exit handler forgets the pid.
     * @param {number} [graceMs]
     */
    retire(graceMs = 2000) {
      const p = proc;
      const pid = spawnedPid;
      if (!p) return;
      // Detach now: this transport reports dead, late events are ignored by
      // the Daemon's identity guard, and a fresh host can spawn immediately.
      proc = null;
      spawnedPid = null;
      try { p.stdin?.end(); } catch { /* ignore */ }
      const timer = setTimeout(() => {
        try {
          if (p.exitCode == null && !p.killed) p.kill();
        } catch { /* ignore */ }
      }, Math.max(0, graceMs));
      // Never hold the loop open for a draining host.
      if (typeof timer.unref === "function") timer.unref();
      p.on("exit", () => {
        clearTimeout(timer);
        if (pid != null) forgetDaemonSpawn(pid);
      });
    },
    isAlive() {
      return !!proc && !proc.killed && proc.exitCode == null;
    },
    /** Current host pid (for shutdown reap exclusion), null when not running. */
    hostPid() {
      return proc?.pid ?? null;
    },
  };
}

/**
 * Worker-thread transport: spawns a Node worker module and exchanges
 * structured-clone messages. The module is expected to run a daemon host loop
 * (see thread-host.js) that answers `{ id, payload }` with `{ id, ok, data }`.
 *
 * @param {{
 *   moduleUrl: URL | string,
 *   workerData?: Record<string, unknown>,
 *   resourceLimits?: import("node:worker_threads").ResourceLimits,
 * }} opts
 * @returns {Transport}
 */
export function ThreadTransport(opts) {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {Array<(m: Record<string, unknown>) => void>} */
  const messageHandlers = [];
  /** @type {Array<() => void>} */
  const exitHandlers = [];

  const emitExit = () => {
    worker = null;
    for (const cb of exitHandlers) cb();
  };

  return {
    start() {
      if (worker) return true;
      try {
        worker = new Worker(opts.moduleUrl, {
          workerData: opts.workerData || {},
          resourceLimits: opts.resourceLimits,
        });
      } catch {
        worker = null;
        return false;
      }
      // Idle thread daemon must not pin the host process (see ProcessTransport).
      worker.unref();
      worker.on("message", (message) => {
        for (const cb of messageHandlers) cb(message);
      });
      worker.on("error", emitExit);
      worker.on("exit", emitExit);
      return true;
    },
    send(message) {
      worker?.postMessage(message);
    },
    onMessage(cb) { messageHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
    kill() {
      const w = worker;
      worker = null;
      try { w?.terminate(); } catch { /* ignore */ }
    },
    // Fully release the worker AND its communication MessagePort. In Node,
    // `worker.unref()` lets an idle worker not *block* exit, but the underlying
    // MessagePort stays an active handle until `terminate()` actually resolves —
    // so a short-lived process that used the daemon won't exit until this is
    // awaited. `kill()` is the sync best-effort variant (process-exit hook);
    // `dispose()` is for callers that need the loop to drain (tests, one-shots).
    async dispose() {
      const w = worker;
      worker = null;
      try { await w?.terminate(); } catch { /* ignore */ }
    },
    isAlive() {
      return !!worker;
    },
  };
}
