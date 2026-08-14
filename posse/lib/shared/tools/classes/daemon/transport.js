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
//   dispose(opts):  Promise<void>      await every active/retired incarnation
//                                      owned by this transport.
//   isAlive():      boolean
//
// Two host kinds, one interface:
//   ProcessTransport — a child process speaking newline-delimited JSON on stdio
//                      (e.g. `posse-git worker --stdio`).
//   ThreadTransport  — a Node worker thread exchanging structured-clone messages.

import { spawn } from "node:child_process";
import { MessageChannel, Worker } from "node:worker_threads";
import { recordDaemonSpawn, forgetDaemonSpawn } from "./process-ledger.js";
import { attachNativeThreadBridge } from "./native-thread-bridge.js";
import { sanitizeWorkerExecArgv } from "../../../../domains/runtime/functions/worker-exec-argv.js";

// Ceiling for one accumulating JSONL frame. This is a malfunctioning-host
// guard, NOT a response-size budget: legitimate single-line responses reach
// tens of MB (a 320-doc scip-rows response is ~27MB, and responses amplify
// their request roughly 2x while the Rust worker accepts requests up to
// 64MB), so the cap must sit far above real traffic. A host that pushes this
// much without a newline is broken — kill it (see the overflow branch) so
// pending requests fail over immediately instead of dying by timeout.
const JSONL_BUFFER_MAX_CHARS = 256 * 1024 * 1024;

function killProcessTree(proc, { force = true, platform = process.platform, spawnImpl = spawn } = {}) {
  if (!proc || proc.exitCode != null || proc.killed) return false;
  if (platform === "win32" && proc.pid) {
    try {
      const args = ["/pid", String(proc.pid), "/T"];
      if (force) args.push("/F");
      const killer = spawnImpl("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        try { proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* ledger retains the child */ }
      };
      killer.once?.("error", fallback);
      killer.once?.("exit", (code) => { if (code !== 0) fallback(); });
      killer.unref?.();
      return true;
    } catch {
      // Fall through to child.kill best-effort.
    }
  }
  try { return !!proc.kill(force ? "SIGKILL" : "SIGTERM"); } catch { return false; }
}

/**
 * @typedef {Object} Transport
 * @property {() => boolean} start
 * @property {(message: Record<string, unknown>) => void} send
 * @property {(cb: (message: Record<string, unknown>) => void) => void} onMessage
 * @property {(cb: () => void) => void} onExit
 * @property {() => void} kill
 * @property {(graceMs?: number) => void} [retire]
 * @property {() => boolean} isAlive
 * @property {(opts?: { graceMs?: number, waitMs?: number }) => Promise<void>} [dispose]
 * @property {() => Promise<void>} [whenTerminated]
 * @property {() => number | null} [hostPid]
 */

/**
 * Await a snapshot of terminal promises without trusting unref'd host handles
 * to keep the event loop alive. The timeout is intentionally referenced while
 * awaited; transport retire timers and their child/worker handles are unref'd.
 * @param {Array<{ terminalPromise: Promise<void> }>} records
 * @param {number} timeoutMs
 */
async function waitForTerminalRecords(records, timeoutMs) {
  if (records.length === 0) return true;
  let timer = null;
  const completed = await Promise.race([
    Promise.all(records.map((record) => record.terminalPromise)).then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
}

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
 *   platform?: NodeJS.Platform,
 *   maxBufferChars?: number,
 * }} opts
 * @returns {Transport}
 */
export function ProcessTransport(opts) {
  const spawnImpl = opts.spawnImpl || spawn;
  const platform = opts.platform || process.platform;
  const maxBufferChars = opts.maxBufferChars ?? JSONL_BUFFER_MAX_CHARS;
  /** @typedef {{ proc: import("node:child_process").ChildProcess, pid: number | null, buffer: string, scanFrom: number, exited: boolean, exitConfirmed: boolean, retireTimer: ReturnType<typeof setTimeout> | null, retireDeadline: number, terminalPromise: Promise<void>, resolveTerminal: () => void }} ProcessRecord */
  /** @type {ProcessRecord | null} */
  let active = null;
  /** Detached incarnations remain owned until the OS confirms their exit. */
  /** @type {Set<ProcessRecord>} */
  const retiringRecords = new Set();
  /** @type {Array<(m: Record<string, unknown>) => void>} */
  const messageHandlers = [];
  /** @type {Array<() => void>} */
  const exitHandlers = [];

  const emitExit = (record, { confirmed = false } = {}) => {
    if (confirmed && !record.exitConfirmed) {
      retiringRecords.add(record);
      record.exitConfirmed = true;
      if (record.retireTimer) clearTimeout(record.retireTimer);
      record.retireTimer = null;
      if (record.pid != null) forgetDaemonSpawn(record.pid);
      retiringRecords.delete(record);
      record.resolveTerminal();
    }
    if (record.exited) return;
    const shouldNotify = active == null || active === record;
    record.exited = true;
    if (active === record) active = null;
    record.buffer = "";
    record.scanFrom = 0;
    if (!shouldNotify) return;
    for (const cb of exitHandlers) cb();
  };

  const failAndKill = (record) => {
    if (active !== record || record.exited) return;
    retiringRecords.add(record);
    emitExit(record);
    try { record.proc.stdin?.end(); } catch { /* ignore */ }
    killProcessTree(record.proc, { force: true, platform, spawnImpl });
  };

  const transport = {
    start() {
      if (active && !active.proc.killed && active.proc.exitCode == null) return true;
      const bin = opts.resolveBin();
      if (!bin) return false;
      let proc;
      try {
        proc = spawnImpl(bin, opts.buildArgs(), {
          cwd: process.cwd(),
          env: opts.env ? opts.env() : process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        return false;
      }
      /** @type {() => void} */
      let resolveTerminal = () => {};
      const terminalPromise = new Promise((resolve) => { resolveTerminal = () => resolve(); });
      /** @type {ProcessRecord} */
      const record = {
        proc,
        pid: proc.pid ?? null,
        buffer: "",
        scanFrom: 0,
        exited: false,
        exitConfirmed: false,
        retireTimer: null,
        retireDeadline: 0,
        terminalPromise,
        resolveTerminal,
      };
      active = record;
      // Attach terminal listeners before any optional stream setup. If setup
      // below fails synchronously, the ledger remains authoritative until the
      // child actually exits instead of losing the only orphan breadcrumb.
      // ChildProcess "error" is a terminal transport signal, but it is not
      // proof that a successfully spawned pid is gone (kill/send can fail).
      // Notify waiters once while retaining the ledger until the OS "exit".
      proc.on("error", () => failAndKill(record));
      proc.on("exit", () => emitExit(record, { confirmed: true }));
      proc.on("close", () => emitExit(record, { confirmed: true }));
      recordDaemonSpawn(record.pid, bin, { label: opts.label });
      // Don't let an idle daemon pin the event loop: unref the child and its
      // pipes so the host process can exit when its real work is done (an
      // in-flight request's own timer keeps the loop alive meanwhile). Without
      // this, `node --test` files finish but never exit and the runner hangs.
      proc.unref();
      /** @type {any} */ (proc.stdout)?.unref?.();
      /** @type {any} */ (proc.stderr)?.unref?.();
      /** @type {any} */ (proc.stdin)?.unref?.();
      // Pipe errors (especially stdin EPIPE) mean this transport incarnation
      // can no longer carry requests. They are not OS exit proof, so notify the
      // daemon while retaining the ledger until the child's eventual exit.
      proc.stdin?.on?.("error", () => failAndKill(record));
      proc.stdout?.on?.("error", () => failAndKill(record));
      proc.stderr?.on?.("error", () => failAndKill(record));
      proc.stdout?.setEncoding?.("utf8");
      // Hard-ledger the child so a crashed parent's orphan can be reaped at the
      // next boot (the unref above means the OS won't clean it up for us).
      proc.stdout?.on("data", (chunk) => {
        // A retired child may continue draining after a replacement starts.
        // Its late output belongs to the old incarnation and must not be
        // decoded as a response from the replacement.
        if (active !== record || record.exited) return;
        record.buffer += chunk.toString("utf8");
        let newline;
        // Resume the delimiter scan where the last chunk left off — large
        // frames arrive in ~64KB pipe chunks, and rescanning the whole
        // accumulated buffer per chunk is quadratic in frame size.
        while ((newline = record.buffer.indexOf("\n", record.scanFrom)) >= 0) {
          const line = record.buffer.slice(0, newline);
          record.buffer = record.buffer.slice(newline + 1);
          record.scanFrom = 0;
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          for (const cb of messageHandlers) cb(message);
        }
        record.scanFrom = record.buffer.length;
        if (record.buffer.length > maxBufferChars) {
          // Never silently drop a partial frame: the line's tail would still
          // arrive, corrupt the framing, and the pending request would die by
          // timeout (a 120s stall per oversized response). A host emitting a
          // frame this large is malfunctioning — kill it so the Daemon fails
          // pending requests now and callers take their fallback path.
          failAndKill(record);
        }
      });
      proc.stderr?.on("data", () => { /* host diagnostics; ignored */ });
      return true;
    },
    send(message) {
      active?.proc.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(cb) { messageHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
    kill() {
      const record = active;
      active = null;
      if (!record) return;
      retiringRecords.add(record);
      record.retireDeadline = Date.now();
      try { record.proc.stdin?.end(); } catch { /* ignore */ }
      // Do not forget the ledger row until an OS-confirmed exit. taskkill or
      // child.kill can fail, and deleting first converts a live orphan into an
      // untracked process that neither shutdown nor the next boot can reap.
      killProcessTree(record.proc, { force: true, platform, spawnImpl });
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
      const record = active;
      if (!record) return;
      // Detach now: this transport reports dead, late events are ignored by
      // the Daemon's identity guard, and a fresh host can spawn immediately.
      active = null;
      retiringRecords.add(record);
      try { record.proc.stdin?.end(); } catch { /* ignore */ }
      const maxGraceMs = Math.max(0, Number(graceMs) || 0);
      record.retireDeadline = Date.now() + maxGraceMs;
      record.retireTimer = setTimeout(() => {
        killProcessTree(record.proc, { force: true, platform, spawnImpl });
      }, maxGraceMs);
      // Never hold the loop open for a draining host.
      record.retireTimer.unref?.();
    },
    isAlive() {
      return !!active && !active.proc.killed && active.proc.exitCode == null;
    },
    /** Current host pid (for shutdown reap exclusion), null when not running. */
    hostPid() {
      return active?.proc.pid ?? null;
    },
    whenTerminated() {
      const records = [...retiringRecords, ...(active ? [active] : [])];
      return Promise.all(records.map((record) => record.terminalPromise)).then(() => {});
    },
    async dispose(disposeOpts = {}) {
      if (active) transport.retire(disposeOpts.graceMs ?? 0);
      let records = [...retiringRecords];
      if (records.length === 0) return;
      const remainingGraceMs = records.reduce(
        (max, record) => Math.max(max, record.retireDeadline - Date.now()),
        0,
      );
      const waitMs = disposeOpts.waitMs ?? Math.max(250, remainingGraceMs + 250);
      if (await waitForTerminalRecords(records, waitMs)) return;
      // A host that ignored EOF or whose retire timer failed gets one explicit
      // hard-kill retry. Keep its ledger row fail-closed if no OS exit follows.
      records = records.filter((record) => !record.exitConfirmed);
      for (const record of records) {
        killProcessTree(record.proc, { force: true, platform, spawnImpl });
      }
      await waitForTerminalRecords(records, 250);
    },
  };
  return transport;
}

/**
 * Worker-thread transport: spawns a Node worker module and exchanges
 * structured-clone messages. The module is expected to run a daemon host loop
 * (see thread-host.js) that answers `{ id, payload }` with `{ id, ok, data }`.
 *
 * @param {{
 *   moduleUrl: URL | string,
 *   workerData?: Record<string, unknown>,
 *   transferList?: import("node:worker_threads").Transferable[],
 *   resourceLimits?: import("node:worker_threads").ResourceLimits,
 *   nativeBridge?: boolean,
 *   retirePayload?: Record<string, unknown> | null,
 * }} opts
 * @returns {Transport}
 */
export function ThreadTransport(opts) {
  /** @typedef {{ worker: Worker, bridgeDispose: null | (() => unknown | Promise<unknown>), bridgePorts: MessageChannel | null, retireTimer: ReturnType<typeof setTimeout> | null, retireDeadline: number, exited: boolean, exitConfirmed: boolean, releasePromise: Promise<void> | null, terminalPromise: Promise<void>, resolveTerminal: () => void }} ThreadRecord */
  /** @type {ThreadRecord | null} */
  let active = null;
  /** @type {Set<ThreadRecord>} */
  const retiringRecords = new Set();
  /** @type {Array<(m: Record<string, unknown>) => void>} */
  const messageHandlers = [];
  /** @type {Array<() => void>} */
  const exitHandlers = [];

  const releaseBridge = (record) => {
    if (record.releasePromise) return record.releasePromise;
    record.releasePromise = Promise.resolve()
      .then(() => record.bridgeDispose?.())
      .catch(() => {})
      .then(() => {
        try { record.bridgePorts?.port1.close(); } catch { /* already closed */ }
        try { record.bridgePorts?.port2.close(); } catch { /* transferred */ }
        record.bridgeDispose = null;
        record.bridgePorts = null;
      });
    return record.releasePromise;
  };

  const emitExit = (record, { confirmed = false } = {}) => {
    if (confirmed && !record.exitConfirmed) {
      retiringRecords.add(record);
      record.exitConfirmed = true;
      if (record.retireTimer) clearTimeout(record.retireTimer);
      record.retireTimer = null;
      void releaseBridge(record).finally(() => {
        retiringRecords.delete(record);
        record.resolveTerminal();
      });
    }
    if (record.exited) return;
    const shouldNotify = active == null || active === record;
    record.exited = true;
    if (active === record) active = null;
    if (!shouldNotify) return;
    for (const cb of exitHandlers) cb();
  };

  return {
    start() {
      if (active) return true;
      let bridgePorts = null;
      let bridgeDispose = null;
      try {
        const workerData = { ...(opts.workerData || {}) };
        /** @type {import("node:worker_threads").Transferable[]} */
        const transferList = [...(opts.transferList || [])];
        if (opts.nativeBridge === true) {
          const channel = new MessageChannel();
          bridgePorts = channel;
          bridgeDispose = attachNativeThreadBridge(channel.port1);
          workerData.nativeBridgePort = channel.port2;
          transferList.push(channel.port2);
        }
        const worker = new Worker(opts.moduleUrl, {
          workerData,
          resourceLimits: opts.resourceLimits,
          transferList,
          execArgv: sanitizeWorkerExecArgv(),
        });
        /** @type {() => void} */
        let resolveTerminal = () => {};
        const terminalPromise = new Promise((resolve) => { resolveTerminal = () => resolve(); });
        /** @type {ThreadRecord} */
        const record = {
          worker,
          bridgeDispose,
          bridgePorts,
          retireTimer: null,
          retireDeadline: 0,
          exited: false,
          exitConfirmed: false,
          releasePromise: null,
          terminalPromise,
          resolveTerminal,
        };
        active = record;
        worker.on("message", (message) => {
          if (active !== record || record.exited) return;
          for (const cb of messageHandlers) cb(message);
        });
        worker.on("error", () => {
          retiringRecords.add(record);
          emitExit(record);
          try { void record.worker.terminate().finally(() => emitExit(record, { confirmed: true })); } catch { /* exit event remains authoritative */ }
        });
        worker.on("exit", () => emitExit(record, { confirmed: true }));
        // Adding a Worker message listener starts (and references) its
        // underlying MessagePort. Unref only after all transport listeners are
        // attached so an idle daemon cannot pin short-lived processes.
        worker.unref();
      } catch {
        for (const transferable of (opts.transferList || [])) {
          try { /** @type {any} */ (transferable)?.close?.(); } catch { /* ignore */ }
        }
        try { bridgePorts?.port1.close(); } catch { /* ignore */ }
        try { bridgePorts?.port2.close(); } catch { /* ignore */ }
        try { void bridgeDispose?.(); } catch { /* ignore */ }
        active = null;
        return false;
      }
      return true;
    },
    send(message) {
      active?.worker.postMessage(message);
    },
    onMessage(cb) { messageHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
    kill() {
      const record = active;
      active = null;
      if (!record) return;
      retiringRecords.add(record);
      record.retireDeadline = Date.now();
      try { void record.worker.terminate().finally(() => emitExit(record, { confirmed: true })); } catch { emitExit(record); }
    },
    retire(graceMs = 2000) {
      const record = active;
      active = null;
      if (!record) return;
      retiringRecords.add(record);
      const maxGraceMs = Math.max(0, Number(graceMs) || 0);
      record.retireDeadline = Date.now() + maxGraceMs;
      record.retireTimer = setTimeout(() => {
        try { void record.worker.terminate().finally(() => emitExit(record, { confirmed: true })); } catch { emitExit(record); }
      }, maxGraceMs);
      record.retireTimer.unref?.();
      try {
        record.worker.postMessage({
          __posse_control: "retire",
          ...(opts.retirePayload && typeof opts.retirePayload === "object" ? { payload: opts.retirePayload } : {}),
        });
      } catch {
        try { void record.worker.terminate().finally(() => emitExit(record, { confirmed: true })); } catch { emitExit(record); }
      }
    },
    // Fully release the worker AND its communication MessagePort. In Node,
    // `worker.unref()` lets an idle worker not *block* exit, but the underlying
    // MessagePort stays an active handle until `terminate()` actually resolves —
    // so a short-lived process that used the daemon won't exit until this is
    // awaited. `kill()` is the sync best-effort variant (process-exit hook);
    // `dispose()` is for callers that need the loop to drain (tests, one-shots).
    async dispose(disposeOpts = {}) {
      if (active) this.retire(disposeOpts.graceMs ?? 0);
      let records = [...retiringRecords];
      if (records.length === 0) return;
      const remainingGraceMs = records.reduce(
        (max, record) => Math.max(max, record.retireDeadline - Date.now()),
        0,
      );
      const waitMs = disposeOpts.waitMs ?? Math.max(250, remainingGraceMs + 250);
      if (!(await waitForTerminalRecords(records, waitMs))) {
        records = records.filter((record) => !record.exitConfirmed);
        await Promise.all(records.map(async (record) => {
          try { await record.worker.terminate(); } catch { /* ignore */ }
          emitExit(record, { confirmed: true });
        }));
        await waitForTerminalRecords(records, 250);
      }
    },
    whenTerminated() {
      const records = [...retiringRecords, ...(active ? [active] : [])];
      return Promise.all(records.map((record) => record.terminalPromise)).then(() => {});
    },
    isAlive() {
      return !!active;
    },
  };
}
