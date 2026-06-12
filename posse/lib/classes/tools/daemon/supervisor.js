// @ts-check
//
// DaemonSupervisor — the single process-wide owner of daemon host lifecycle.
//
// Before this existed, every Daemon self-managed: each instance installed its
// own process-exit hook, worker threads minted their own module-graph
// "singletons" (one stranded host per thread), and a clean shutdown was
// whatever each creator remembered to do. The supervisor inverts that:
//
//   - Registry: get-or-create daemons keyed by (kind, identity) so there is
//     exactly one per identity per module graph, with a label for attribution.
//   - Lifecycle telemetry: spawn / retire / breaker events from every
//     registered daemon flow through one observable hook.
//   - Shutdown: shutdownAll() retires every registered daemon gracefully,
//     then reaps ANY pid still on this process's daemon ledger — including
//     hosts minted by worker threads whose module graphs never registered
//     here. That ledger sweep is the safety net for the leak class where a
//     thread dies without observing its child's exit (the "118 stranded
//     posse-git.exe" incident).
//
// Worker-thread note: module state is per-thread, so a thread that imports
// this gets its own supervisor. That is fine — thread-local registries keep
// thread-local daemons deduped, and the MAIN thread's shutdownAll ledger sweep
// covers every thread's hosts because the ledger file is per-PROCESS.

import { Daemon } from "./Daemon.js";
import { listOwnDaemonSpawns, reapOwnDaemonSpawns } from "./process-ledger.js";

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

export class DaemonSupervisor {
  constructor() {
    /** @type {Map<string, { daemon: Daemon, label: string, createdAt: number }>} */
    this._entries = new Map();
    /** @type {Array<(event: { kind: string, label: string, detail?: Record<string, unknown> }) => void>} */
    this._lifecycleListeners = [];
    this._exitHookInstalled = false;
  }

  /** @param {(event: { kind: string, label: string, detail?: Record<string, unknown> }) => void} cb */
  onLifecycle(cb) {
    if (typeof cb === "function") this._lifecycleListeners.push(cb);
  }

  /** @param {{ kind: string, label: string, detail?: Record<string, unknown> }} event */
  #emit(event) {
    for (const cb of this._lifecycleListeners) {
      try { cb(event); } catch { /* observational */ }
    }
  }

  /**
   * Get-or-create the daemon for `(kind, identity)`. The factory runs only on
   * first request; subsequent callers share the instance. The daemon's
   * lifecycle events are routed into the supervisor's listeners.
   *
   * @param {{ kind: string, identity?: string, label?: string, create: () => Daemon }} spec
   * @returns {Daemon}
   */
  daemon(spec) {
    const kind = String(spec?.kind || "");
    if (!kind) throw new TypeError("DaemonSupervisor.daemon requires a kind");
    if (typeof spec?.create !== "function") throw new TypeError("DaemonSupervisor.daemon requires a create factory");
    const key = `${kind}::${String(spec.identity || "default")}`;
    let entry = this._entries.get(key);
    if (!entry) {
      const daemon = spec.create();
      entry = { daemon, label: String(spec.label || daemon.label || key), createdAt: Date.now() };
      this.register(key, daemon, { label: entry.label });
    }
    return entry.daemon;
  }

  /**
   * Register an externally constructed daemon so shutdownAll/telemetry cover
   * it (e.g. the conductor and ONNX daemons, which need bespoke construction).
   *
   * @param {string} key
   * @param {Daemon} daemon
   * @param {{ label?: string }} [meta]
   */
  register(key, daemon, meta = {}) {
    const label = String(meta.label || daemon?.label || key);
    this._entries.set(String(key), { daemon, label, createdAt: Date.now() });
    // Chain lifecycle events upward without clobbering an existing handler.
    const prior = daemon._onLifecycle;
    daemon._onLifecycle = (event) => {
      if (prior) { try { prior(event); } catch { /* observational */ } }
      this.#emit(event);
    };
    this.#installExitHook();
  }

  /** Drop a registration (the caller owns the daemon's actual teardown). */
  unregister(key) {
    this._entries.delete(String(key));
  }

  /** @returns {Array<{ key: string, label: string, alive: boolean, hostPid: number | null, breakerTrips: number }>} */
  list() {
    return [...this._entries.entries()].map(([key, e]) => ({
      key,
      label: e.label,
      alive: e.daemon.isHostAlive?.() ?? false,
      hostPid: e.daemon.hostPid?.() ?? null,
      breakerTrips: e.daemon.breakerTrips ?? 0,
    }));
  }

  /**
   * One-line health summary for closeout/diagnostics; null when nothing to say.
   * @returns {{ registered: number, alive: number, breakerTrips: number, ledgered: number } }
   */
  stats() {
    const rows = this.list();
    return {
      registered: rows.length,
      alive: rows.filter((r) => r.alive).length,
      breakerTrips: rows.reduce((n, r) => n + r.breakerTrips, 0),
      ledgered: listOwnDaemonSpawns().length,
    };
  }

  /**
   * Graceful shutdown of everything this process owns:
   *   1. retire() every registered daemon (EOF + grace, no mid-call kills);
   *   2. wait out the grace window;
   *   3. reap any pid STILL on this process's ledger — strays from worker
   *      threads or crashed creators that never registered.
   * Returns a summary for the closeout line.
   *
   * @param {{ graceMs?: number }} [opts]
   * @returns {Promise<{ retired: number, reaped: number, strays: number }>}
   */
  async shutdownAll(opts = {}) {
    const graceMs = opts.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    let retired = 0;
    const retiringPids = [];
    for (const { daemon } of this._entries.values()) {
      try {
        const pid = daemon.hostPid?.() ?? null;
        if (pid != null) retiringPids.push(pid);
        if (daemon.isHostAlive?.()) { daemon.retire({ graceMs }); retired++; }
        else daemon.stop();
      } catch { /* best effort */ }
    }
    // Give retired hosts their drain window before the hard sweep. The retire
    // timers are unref'd, so this wait is what actually grants the grace.
    if (retired > 0 && graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs + 100));
    }
    // Safety net: anything still ledgered now is a stray (thread-minted host,
    // crashed creator) or a retiree that ignored EOF — kill and forget.
    const before = listOwnDaemonSpawns().length;
    const { killed } = reapOwnDaemonSpawns();
    const strays = Math.max(0, before - retiringPids.length);
    this.#emit({ kind: "shutdown", label: "supervisor", detail: { retired, reaped: killed, strays } });
    return { retired, reaped: killed, strays };
  }

  /**
   * One process-exit hook for the whole registry (replaces one-hook-per-daemon
   * accumulation). Sync best-effort only: stop() every daemon, then sweep the
   * ledger so a normal exit never leaves hosts behind.
   */
  #installExitHook() {
    if (this._exitHookInstalled) return;
    this._exitHookInstalled = true;
    process.once("exit", () => {
      for (const { daemon } of this._entries.values()) {
        try { daemon.stop(); } catch { /* best effort */ }
      }
      try { reapOwnDaemonSpawns(); } catch { /* best effort */ }
    });
  }
}

/**
 * Shared per-module-graph supervisor. The main thread's instance is the
 * authoritative one; worker threads get thread-local instances whose hosts the
 * main thread's shutdown ledger sweep still covers.
 */
export const daemonSupervisor = new DaemonSupervisor();
