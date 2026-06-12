// @ts-check
//
// Daemon — the shared, domain-agnostic governance layer over a Transport.
//
// One primitive backs every long-lived helper in the system (posse-git,
// posse-atlas, the ONNX encoder, the SCIP conductor). It owns everything that
// is identical regardless of what work the host does:
//   - lazy start, stop, crash-detect + restart with backoff
//   - recycle-on-key-change (rebuild the host when its identity key changes,
//     e.g. an embedding model/version swap)
//   - a request queue with id correlation, per-request timeout, abort, and a
//     backpressure cap
//
// It is async-only by construction (the event loop is never blocked). Blocking/
// sync access is a separate concern layered on top in sync-bridge.js, which
// reuses the same Transport. Domain wrappers interpret the `{ ok, data, error }`
// response shape; the Daemon stays agnostic and only surfaces transport-level
// failure markers (`_transportGone`, `_aborted`, `_timedOut`).

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING = 4096;
const DEFAULT_RESTART_BACKOFF_MS = 250;
// Circuit breaker: a host that needs this many spawns inside the window is
// crash-looping; stop respawning (callers per-call fallback) instead of
// grinding a 250ms-backoff loop forever and telling no one.
const DEFAULT_BREAKER_MAX_SPAWNS = 3;
const DEFAULT_BREAKER_WINDOW_MS = 60_000;
const DEFAULT_BREAKER_COOLDOWN_MS = 300_000;
const DEFAULT_RETIRE_GRACE_MS = 2_000;
const DEFAULT_PROBE_TIMEOUT_MS = 250;

export class Daemon {
  /**
   * @param {{
   *   transportFactory: (key: unknown) => import("./transport.js").Transport,
   *   key?: () => unknown,
   *   label?: string,
   *   timeoutMs?: number,
   *   maxPending?: number,
   *   restartBackoffMs?: number,
   *   breakerMaxSpawns?: number,
   *   breakerWindowMs?: number,
   *   breakerCooldownMs?: number,
   *   onLifecycle?: (event: { kind: string, label: string, detail?: Record<string, unknown> }) => void,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    if (typeof opts?.transportFactory !== "function") {
      throw new TypeError("Daemon requires a transportFactory");
    }
    this._transportFactory = opts.transportFactory;
    this._key = opts.key || (() => null);
    this.label = String(opts.label || "daemon");
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
    this._restartBackoffMs = opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this._breakerMaxSpawns = opts.breakerMaxSpawns ?? DEFAULT_BREAKER_MAX_SPAWNS;
    this._breakerWindowMs = opts.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS;
    this._breakerCooldownMs = opts.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this._onLifecycle = typeof opts.onLifecycle === "function" ? opts.onLifecycle : null;
    this._now = opts.now || (() => Date.now());

    /** @type {import("./transport.js").Transport | null} */
    this._transport = null;
    this._runningKey = null;
    this._nextId = 1;
    /** @type {Map<number, { finish: (response: Record<string, unknown>) => void, onProgress: ((event: unknown) => void) | null }>} */
    this._pending = new Map();
    this._lastExitAt = 0;
    /** @type {number[]} spawn timestamps inside the breaker window */
    this._spawnTimes = [];
    /** Breaker open until this timestamp; 0 = closed. */
    this._breakerOpenUntil = 0;
    /** How many times the breaker has tripped (telemetry). */
    this.breakerTrips = 0;
    this._exitHookInstalled = false;
    /** @type {(() => void) | null} the process-exit cleanup handler, kept so it can be removed on stop/dispose */
    this._exitHandler = null;
  }

  /** @param {string} kind @param {Record<string, unknown>} [detail] */
  #emitLifecycle(kind, detail) {
    if (!this._onLifecycle) return;
    try { this._onLifecycle({ kind, label: this.label, detail }); } catch { /* observational */ }
  }

  /**
   * Remove the process-exit cleanup hook. Called from stop()/dispose() so a
   * daemon that is torn down and recreated (e.g. the idle-evicted conductor)
   * does not leak a `process.once("exit")` listener per lifecycle — left
   * unremoved they accumulate into a MaxListenersExceededWarning.
   */
  #removeExitHook() {
    if (this._exitHandler) {
      try { process.removeListener("exit", this._exitHandler); } catch { /* ignore */ }
      this._exitHandler = null;
    }
    this._exitHookInstalled = false;
  }

  /**
   * Circuit breaker state. Open = stop respawning so callers take their
   * per-call fallback instead of feeding a crash loop. Half-opens after the
   * cooldown: the next #ensureTransport is allowed one probe spawn.
   * @returns {boolean} true when spawning is currently forbidden
   */
  #breakerForbidsSpawn() {
    const now = this._now();
    if (this._breakerOpenUntil > now) return true;
    if (this._breakerOpenUntil !== 0) {
      // Cooldown elapsed → half-open: allow one spawn attempt with a clean
      // window so a healthy comeback doesn't instantly re-trip.
      this._breakerOpenUntil = 0;
      this._spawnTimes = [];
      this.#emitLifecycle("breaker_half_open");
    }
    return false;
  }

  /** Record a spawn for breaker accounting; trips the breaker on a crash loop. */
  #noteSpawn() {
    const now = this._now();
    this._spawnTimes = this._spawnTimes.filter((t) => now - t < this._breakerWindowMs);
    this._spawnTimes.push(now);
    if (this._spawnTimes.length > this._breakerMaxSpawns) {
      this._breakerOpenUntil = now + this._breakerCooldownMs;
      this.breakerTrips += 1;
      this._spawnTimes = [];
      this.#emitLifecycle("breaker_open", {
        spawns_in_window: this._breakerMaxSpawns + 1,
        window_ms: this._breakerWindowMs,
        cooldown_ms: this._breakerCooldownMs,
      });
    }
  }

  /** Build (or rebuild) the transport when absent or when the key changed. */
  #ensureTransport() {
    const desiredKey = this._key();
    if (this._transport && this._transport.isAlive() && sameKey(this._runningKey, desiredKey)) {
      return true;
    }
    // Key changed or host dead/absent: tear down and rebuild.
    if (this._transport && !sameKey(this._runningKey, desiredKey)) {
      this.#teardown();
    }
    if (this._transport && !this._transport.isAlive()) {
      // Backoff so a crash-looping host can't be respawned in a tight loop.
      if (this._now() - this._lastExitAt < this._restartBackoffMs) return false;
      this._transport = null;
    }
    if (!this._transport) {
      if (this.#breakerForbidsSpawn()) return false;
      const transport = this._transportFactory(desiredKey);
      // Guard handlers on identity: a torn-down transport's delayed exit/message
      // events must not clobber the transport that replaced it.
      transport.onMessage((message) => { if (this._transport === transport) this.#onMessage(message); });
      transport.onExit(() => { if (this._transport === transport) this.#onExit(); });
      if (!transport.start()) return false;
      this.#noteSpawn();
      this.#emitLifecycle("spawn", { pid: transport.hostPid?.() ?? null });
      this._transport = transport;
      this._runningKey = desiredKey;
      if (!this._exitHookInstalled) {
        this._exitHookInstalled = true;
        this._exitHandler = () => this.stop();
        process.once("exit", this._exitHandler);
      }
    }
    return true;
  }

  /** @param {Record<string, unknown>} message */
  #onMessage(message) {
    const id = Number(message?.id);
    const entry = this._pending.get(id);
    if (!entry) return;
    // Intermediate progress: `{ id, progress }` with no terminal `ok`. Route to
    // the caller's onProgress (observational) and keep the request pending.
    if (message && "progress" in message && !("ok" in message)) {
      if (entry.onProgress) {
        try { entry.onProgress(message.progress); } catch { /* progress is observational */ }
      }
      return;
    }
    this._pending.delete(id);
    entry.finish(message);
  }

  #onExit() {
    this._transport = null;
    this._lastExitAt = this._now();
    const waiters = [...this._pending.values()];
    this._pending.clear();
    for (const entry of waiters) {
      entry.finish({ ok: false, error: { message: "daemon transport exited" }, _transportGone: true });
    }
  }

  #teardown() {
    const transport = this._transport;
    this._transport = null;
    this._runningKey = null;
    try { transport?.kill(); } catch { /* ignore */ }
  }

  /**
   * Send one request and resolve with the host's JSON response. Never rejects:
   * transport-level problems resolve to a structured marker so the caller can
   * decide whether to fall back. Domain `{ ok: false }` responses pass through
   * untouched for the wrapper to interpret.
   *
   * @param {Record<string, unknown>} payload
   * @param {{ signal?: AbortSignal, timeoutMs?: number, onProgress?: (event: unknown) => void }} [opts]
   * @returns {Promise<Record<string, unknown>>}
   */
  request(payload, opts = {}) {
    if (!this.#ensureTransport() || !this._transport) {
      return Promise.resolve({ ok: false, error: { message: "daemon unavailable" }, _transportGone: true });
    }
    if (opts.signal?.aborted) {
      return Promise.resolve({ ok: false, error: { message: "aborted" }, _aborted: true });
    }
    if (this._pending.size >= this._maxPending) {
      return Promise.resolve({ ok: false, error: { message: "daemon overloaded" }, _overloaded: true });
    }
    const id = this._nextId++;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
        this._pending.delete(id);
        resolve(response);
      };
      this._pending.set(id, { finish, onProgress: typeof opts.onProgress === "function" ? opts.onProgress : null });

      const timeoutMs = opts.timeoutMs ?? this._timeoutMs;
      const timer = timeoutMs > 0
        ? setTimeout(() => finish({ ok: false, error: { message: `daemon request timed out after ${timeoutMs}ms` }, _timedOut: true }), timeoutMs)
        : null;
      const onAbort = opts.signal
        ? () => finish({ ok: false, error: { message: "aborted" }, _aborted: true })
        : null;
      if (opts.signal && onAbort) opts.signal.addEventListener("abort", onAbort, { once: true });

      try {
        this._transport.send({ ...payload, id });
      } catch (err) {
        finish({ ok: false, error: { message: String(err?.message || err) }, _transportGone: true });
      }
    });
  }

  /** Force a recycle (e.g. after a settings change). Next request respawns. */
  recycle() {
    this.#teardown();
  }

  /**
   * Graceful replace: detach the current host and let it drain (EOF on stdin,
   * `graceMs` to exit on its own, hard kill only as the deadline backstop) —
   * never a mid-native-call terminate. Pending requests are failed with
   * `_transportGone` so idempotent callers retry on the replacement host; the
   * next request spawns that replacement immediately (no restart backoff —
   * a retire is deliberate, not a crash).
   * @param {{ graceMs?: number }} [opts]
   */
  retire(opts = {}) {
    const transport = this._transport;
    if (!transport) return;
    this._transport = null;
    this._runningKey = null;
    this.#emitLifecycle("retire", { pid: transport.hostPid?.() ?? null });
    const waiters = [...this._pending.values()];
    this._pending.clear();
    for (const entry of waiters) {
      entry.finish({ ok: false, error: { message: "daemon host retired" }, _transportGone: true });
    }
    if (typeof transport.retire === "function") {
      try { transport.retire(opts.graceMs ?? DEFAULT_RETIRE_GRACE_MS); } catch { /* best effort */ }
    } else {
      try { transport.kill(); } catch { /* best effort */ }
    }
  }

  /**
   * Liveness probe: decide, don't infer. Sends `payload` with a short deadline
   * and classifies the outcome. ANY reply — including a structured error like
   * "unknown method" — proves the host's request loop is alive; only silence
   * past the deadline says it is wedged. So this works against hosts that
   * predate a real ping handler.
   * @param {Record<string, unknown>} payload
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<"alive" | "silent" | "gone">}
   */
  async probe(payload, opts = {}) {
    if (!this._transport || !this._transport.isAlive()) return "gone";
    const response = await this.request(payload, { timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS });
    if (response?._timedOut === true) return "silent";
    if (response?._transportGone === true) return "gone";
    return "alive";
  }

  /** Pid of the live host process, if any (ProcessTransport hosts only). */
  hostPid() {
    return this._transport?.hostPid?.() ?? null;
  }

  /** Whether a host is currently up for this daemon. */
  isHostAlive() {
    return !!this._transport && this._transport.isAlive();
  }

  stop() {
    this.#removeExitHook();
    this.#onExit();
    this.#teardown();
  }

  /**
   * Async teardown that fully releases the transport (awaits worker
   * termination / child exit). Use this when the caller needs the event loop to
   * drain so a short-lived process can exit — `worker.unref()` alone leaves the
   * communication MessagePort as an active handle until terminate() resolves.
   * `stop()` remains the sync best-effort variant for the process-exit hook.
   */
  async dispose() {
    // Capture the transport BEFORE releasing pending waiters — #onExit() nulls
    // this._transport, so reading it afterwards would lose the handle and skip
    // the terminate (leaving the MessagePort pinned).
    const transport = this._transport;
    this._runningKey = null;
    this.#removeExitHook();
    this.#onExit();
    if (transport?.dispose) {
      try { await transport.dispose(); } catch { /* ignore */ }
    } else {
      try { transport?.kill(); } catch { /* ignore */ }
    }
  }
}

function sameKey(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
