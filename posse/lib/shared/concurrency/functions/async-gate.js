// @ts-check
//
// Small async gate/queue primitive for synchronous or low-surface operations
// that still need ordered access: SQLite writes, ATLAS tool calls, git commands,
// and similar resource-scoped work.

const DEFAULT_WAIT_MS = 30000;

/** @typedef {{ name?: string, maxConcurrency?: number }} QueueOptions */
/** @typedef {"read-priority" | "fifo"} GatePolicy */
/** @typedef {{ name?: string, policy?: GatePolicy }} ProtectedAssetGateOptions */
/** @typedef {{ label?: string, waitMs?: number, onBeforeRelease?: ((info: QueueInfo & { key?: string, status?: "fulfilled" | "rejected", error?: unknown }) => void | Promise<void>) | null, onRelease?: ((info: QueueInfo & { key?: string, status?: "fulfilled" | "rejected", error?: unknown }) => void) | null, onCancel?: ((info: QueueInfo & { key?: string, error?: unknown }) => void) | null }} RunOptions */
/** @typedef {{ waitMs: number, depthAtEnqueue: number, inFlightAtEnqueue: number, label: string, key?: string, mode?: "blocking" | "non-blocking" }} QueueInfo */

export class AsyncWorkQueue {
  #name;
  #maxConcurrency;
  #inFlight = 0;
  #pending = [];
  #nextId = 1;

  /**
   * @param {QueueOptions} [options]
   */
  constructor({ name, maxConcurrency = 1 } = {}) {
    this.#name = name || "async work";
    this.#maxConcurrency = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
  }

  snapshot() {
    return {
      name: this.#name,
      maxConcurrency: this.#maxConcurrency,
      inFlight: this.#inFlight,
      pending: this.#pending.filter((task) => !task.cancelled).length,
    };
  }

  /**
   * @template T
   * @param {(info: QueueInfo) => T | Promise<T>} fn
   * @param {RunOptions} [options]
   * @returns {Promise<T>}
   */
  run(fn, { label = "work", waitMs = DEFAULT_WAIT_MS, onBeforeRelease = null, onRelease = null, onCancel = null } = {}) {
    const requestedAt = Date.now();
    const maxWaitMs = Math.max(0, Number(waitMs) || 0);
    return new Promise((resolve, reject) => {
      const task = {
        id: this.#nextId++,
        label,
        fn,
        requestedAt,
        depthAtEnqueue: this.#pending.filter((entry) => !entry.cancelled).length,
        inFlightAtEnqueue: this.#inFlight,
        resolve,
        reject,
        timer: null,
        cancelled: false,
        started: false,
        onBeforeRelease,
        onRelease,
        onCancel,
      };
      if (maxWaitMs > 0) {
        task.timer = setTimeout(() => {
          task.cancelled = true;
          this.#pending = this.#pending.filter((entry) => entry !== task);
          const err = new AsyncGateBusyError(
            `${this.#name} queue wait timed out after ${maxWaitMs}ms (${label})`,
            { label },
          );
          err.code = "ASYNC_GATE_TIMEOUT";
          reject(err);
          this.#notifyCancel(task, err, maxWaitMs);
        }, maxWaitMs);
        task.timer.unref?.();
      }
      this.#pending.push(task);
      this.#drain();
      if (maxWaitMs === 0 && !task.started) {
        task.cancelled = true;
        this.#pending = this.#pending.filter((entry) => entry !== task);
        const err = new AsyncGateBusyError(
          `${this.#name} queue wait timed out after 0ms (${label})`,
          { label },
        );
        err.code = "ASYNC_GATE_TIMEOUT";
        reject(err);
        this.#notifyCancel(task, err, 0);
      }
    });
  }

  #drain() {
    while (this.#inFlight < this.#maxConcurrency && this.#pending.length > 0) {
      const task = this.#pending.shift();
      if (!task || task.cancelled) continue;
      task.started = true;
      if (task.timer) clearTimeout(task.timer);
      this.#inFlight += 1;
      const startedAt = Date.now();
      const queueInfo = {
        waitMs: Math.max(0, startedAt - task.requestedAt),
        depthAtEnqueue: task.depthAtEnqueue,
        inFlightAtEnqueue: task.inFlightAtEnqueue,
        label: task.label,
      };
      let finalStatus = /** @type {"fulfilled" | "rejected"} */ ("fulfilled");
      let finalError = undefined;
      // Keep work on an async boundary even when callers pass synchronous
      // functions; this makes queue telemetry and immediate-busy behavior
      // deterministic for callers that enqueue and then attach observers.
      Promise.resolve()
        .then(() => new Promise((resolve) => setImmediate(resolve)))
        .then(async () => {
          let status = /** @type {"fulfilled" | "rejected"} */ ("fulfilled");
          let value;
          let error;
          try {
            value = await task.fn(queueInfo);
          } catch (err) {
            status = "rejected";
            error = err;
          }
          ({ status, error } = await this.#runBeforeRelease(task, queueInfo, status, error));
          return { status, value, error };
        })
        .then(({ status, value, error }) => {
          finalStatus = status;
          finalError = error;
          if (status === "fulfilled") task.resolve(value);
          else task.reject(error);
        })
        .catch((error) => {
          finalStatus = "rejected";
          finalError = error;
          task.reject(error);
        })
        .finally(() => {
          this.#inFlight = Math.max(0, this.#inFlight - 1);
          if (typeof task.onRelease === "function") {
            try {
              task.onRelease({
                ...queueInfo,
                status: finalStatus,
                ...(finalError === undefined ? {} : { error: finalError }),
              });
            } catch {
              // Release hooks are observational; never break queue progress.
            }
          }
          this.#drain();
        });
    }
  }

  /**
   * @param {any} task
   * @param {QueueInfo} queueInfo
   * @param {"fulfilled" | "rejected"} status
   * @param {unknown} error
   * @returns {Promise<{ status: "fulfilled" | "rejected", error: unknown }>}
   */
  async #runBeforeRelease(task, queueInfo, status, error) {
    if (typeof task.onBeforeRelease !== "function") return { status, error };
    try {
      await task.onBeforeRelease({
        ...queueInfo,
        status,
        ...(error === undefined ? {} : { error }),
      });
      return { status, error };
    } catch (cleanupError) {
      if (status === "rejected" && error && typeof error === "object") {
        try {
          /** @type {any} */ (error).cleanupError = cleanupError;
        } catch {
          // Best-effort diagnostic only.
        }
        return { status, error };
      }
      return { status: "rejected", error: cleanupError };
    }
  }

  /**
   * @param {any} task
   * @param {unknown} error
   * @param {number} waitMs
   */
  #notifyCancel(task, error, waitMs) {
    if (typeof task?.onCancel !== "function") return;
    try {
      task.onCancel({
        waitMs,
        depthAtEnqueue: task.depthAtEnqueue,
        inFlightAtEnqueue: task.inFlightAtEnqueue,
        label: task.label,
        error,
      });
    } catch {
      // Cancellation hooks are observational; never break queue progress.
    }
  }
}

export class KeyedAsyncGate {
  #name;
  #maxConcurrency;
  #queues = new Map();

  /**
   * @param {QueueOptions} [options]
   */
  constructor({ name = "async gate", maxConcurrency = 1 } = {}) {
    this.#name = name;
    this.#maxConcurrency = maxConcurrency;
  }

  /**
   * @template T
   * @param {unknown} key
   * @param {(info: QueueInfo & { key: string }) => T | Promise<T>} fn
   * @param {RunOptions} [options]
   * @returns {Promise<T>}
   */
  run(key, fn, { label = "work", waitMs = DEFAULT_WAIT_MS, onBeforeRelease = null, onRelease = null, onCancel = null } = {}) {
    const normalized = normalizeGateKey(key);
    let queue = this.#queues.get(normalized);
    if (!queue) {
      queue = new AsyncWorkQueue({
        name: `${this.#name}:${normalized}`,
        maxConcurrency: this.#maxConcurrency,
      });
      this.#queues.set(normalized, queue);
    }
    return queue.run(
      (info) => fn({ ...info, key: normalized }),
      {
        label,
        waitMs,
        onBeforeRelease: typeof onBeforeRelease === "function"
          ? (info) => onBeforeRelease({ ...info, key: normalized })
          : null,
        onCancel: typeof onCancel === "function"
          ? (info) => onCancel({ ...info, key: normalized })
          : null,
        onRelease: (info) => {
          try {
            onRelease?.({ ...info, key: normalized });
          } catch {
            // Release hooks are observational; never break queue progress.
          }
          const state = queue.snapshot();
          if (state.inFlight === 0 && state.pending === 0) {
            queueMicrotask(() => {
              const latest = this.#queues.get(normalized);
              if (latest === queue && latest.snapshot().inFlight === 0 && latest.snapshot().pending === 0) {
                this.#queues.delete(normalized);
              }
            });
          }
        },
      },
    );
  }

  isBusy(key) {
    const queue = this.#queues.get(normalizeGateKey(key));
    if (!queue) return false;
    const state = queue.snapshot();
    return state.inFlight > 0 || state.pending > 0;
  }

  snapshot() {
    return {
      name: this.#name,
      keys: Array.from(this.#queues.entries()).map(([key, queue]) => ({
        key,
        ...queue.snapshot(),
      })),
    };
  }
}

export class AsyncGateBusyError extends Error {
  /**
   * @param {string} message
   * @param {{ key?: string, label?: string }} [details]
   */
  constructor(message, { key = "global", label = "work" } = {}) {
    super(message);
    this.name = "AsyncGateBusyError";
    this.key = key;
    this.label = label;
    this.code = "ASYNC_GATE_BUSY";
  }
}

/**
 * Reader/writer gate with a pluggable queue policy.
 *
 * Policies:
 *   - "read-priority" (default): readers that arrive while a writer owns the
 *     asset are inserted ahead of queued writers, so read bursts can clear
 *     between writes. Optimizes for read-dominated workloads; writer fairness
 *     is bounded only by each writer's `waitMs`.
 *   - "fifo": tasks run in arrival order. Consecutive readers at the head
 *     still run concurrently; the only behavior change is that a reader
 *     arriving while a writer is queued goes to the back of the queue
 *     instead of jumping ahead.
 *
 * Pick "fifo" when bounded writer fairness matters more than read throughput.
 * Otherwise stick with the default.
 */
export class ProtectedAssetGate {
  #name;
  /** @type {GatePolicy} */
  #policy;
  #states = new Map();

  /**
   * @param {ProtectedAssetGateOptions} [options]
   */
  constructor({ name = "protected asset", policy = "read-priority" } = {}) {
    this.#name = name;
    this.#policy = policy === "fifo" ? "fifo" : "read-priority";
  }

  /**
   * Run a writer/owner operation.
   *
   * @template T
   * @param {unknown} key
   * @param {(info: QueueInfo & { key: string, mode: "blocking" }) => T | Promise<T>} fn
   * @param {RunOptions} [options]
   * @returns {Promise<T>}
   */
  runBlocking(key, fn, { label = "work", waitMs = DEFAULT_WAIT_MS, onBeforeRelease = null, onRelease = null, onCancel = null } = {}) {
    return this.#enqueue(key, "blocking", fn, { label, waitMs, onBeforeRelease, onRelease, onCancel });
  }

  /**
   * Run an opportunistic read. Reads run concurrently with other reads.
   * Insertion order against queued writers depends on the gate's policy
   * (see the class docstring).
   *
   * @template T
   * @param {unknown} key
   * @param {(info: QueueInfo & { key: string, mode: "non-blocking" }) => T | Promise<T>} fn
   * @param {RunOptions} [options]
   * @returns {Promise<T>}
   */
  runNonBlocking(key, fn, { label = "work", waitMs = DEFAULT_WAIT_MS, onBeforeRelease = null, onRelease = null, onCancel = null } = {}) {
    return this.#enqueue(key, "non-blocking", fn, { label, waitMs, onBeforeRelease, onRelease, onCancel });
  }

  snapshot() {
    return {
      name: this.#name,
      keys: Array.from(this.#states.entries()).map(([key, state]) => ({
        key,
        activeReaders: state.activeReaders,
        activeWriter: state.activeWriter,
        pendingReaders: state.queue.filter((task) => !task.cancelled && task.mode === "non-blocking").length,
        pendingWriters: state.queue.filter((task) => !task.cancelled && task.mode === "blocking").length,
      })),
    };
  }

  /**
   * @template T
   * @param {unknown} key
   * @param {"blocking" | "non-blocking"} mode
   * @param {(info: QueueInfo & { key: string, mode: "blocking" | "non-blocking" }) => T | Promise<T>} fn
   * @param {RunOptions} options
   * @returns {Promise<T>}
   */
  #enqueue(key, mode, fn, { label, waitMs, onBeforeRelease = null, onRelease = null, onCancel = null }) {
    const normalized = normalizeGateKey(key);
    const state = this.#stateFor(normalized);
    const requestedAt = Date.now();
    const maxWaitMs = Math.max(0, Number(waitMs) || 0);
    return new Promise((resolve, reject) => {
      const waiter = {
        key: normalized,
        mode,
        label,
        fn,
        requestedAt,
        depthAtEnqueue: state.queue.filter((entry) => !entry.cancelled).length,
        inFlightAtEnqueue: state.activeReaders + (state.activeWriter ? 1 : 0),
        resolve,
        reject,
        timer: null,
        cancelled: false,
        started: false,
        onBeforeRelease,
        onRelease,
        onCancel,
      };
      if (maxWaitMs > 0) {
        waiter.timer = setTimeout(() => {
          waiter.cancelled = true;
          state.queue = state.queue.filter((entry) => entry !== waiter);
          const err = new AsyncGateBusyError(
            `${this.#name} queue wait timed out after ${maxWaitMs}ms (${label})`,
            { key: normalized, label },
          );
          err.code = "ASYNC_GATE_TIMEOUT";
          reject(err);
          this.#notifyCancel(waiter, err, maxWaitMs);
        }, maxWaitMs);
        waiter.timer.unref?.();
      }
      this.#insertTask(state, waiter);
      this.#drain(normalized, state);
      if (maxWaitMs === 0 && !waiter.started) {
        waiter.cancelled = true;
        state.queue = state.queue.filter((entry) => entry !== waiter);
        const err = new AsyncGateBusyError(
          `${this.#name} queue wait timed out after 0ms (${label})`,
          { key: normalized, label },
        );
        err.code = "ASYNC_GATE_TIMEOUT";
        reject(err);
        this.#notifyCancel(waiter, err, 0);
      }
    });
  }

  /**
   * @param {string} key
   * @returns {{ activeReaders: number, activeWriter: boolean, queue: Array<any> }}
   */
  #stateFor(key) {
    let state = this.#states.get(key);
    if (!state) {
      state = { activeReaders: 0, activeWriter: false, queue: [] };
      this.#states.set(key, state);
    }
    return state;
  }

  /**
   * @param {{ activeWriter: boolean, queue: Array<any> }} state
   * @param {any} task
   */
  #insertTask(state, task) {
    if (this.#policy === "fifo" || task.mode !== "non-blocking" || !state.activeWriter) {
      state.queue.push(task);
      return;
    }
    let index = 0;
    while (index < state.queue.length && state.queue[index]?.mode === "non-blocking") {
      index += 1;
    }
    state.queue.splice(index, 0, task);
  }

  /**
   * @param {string} key
   * @param {{ activeReaders: number, activeWriter: boolean, queue: Array<any> }} state
   */
  #drain(key, state) {
    if (state.activeWriter) return;
    while (state.queue.length > 0) {
      const task = state.queue[0];
      if (!task || task.cancelled) {
        state.queue.shift();
        continue;
      }
      if (task.mode === "non-blocking") {
        state.queue.shift();
        this.#startReader(key, state, task);
        continue;
      }
      if (state.activeReaders > 0) return;
      state.queue.shift();
      this.#startWriter(key, state, task);
      return;
    }
    this.#cleanupState(key, state);
  }

  /**
   * @param {string} key
   * @param {{ activeReaders: number, activeWriter: boolean, queue: Array<any> }} state
   * @param {any} task
   */
  #startReader(key, state, task) {
    task.started = true;
    if (task.timer) clearTimeout(task.timer);
    state.activeReaders += 1;
    this.#runTask(key, state, task, () => {
      state.activeReaders = Math.max(0, state.activeReaders - 1);
    });
  }

  /**
   * @param {string} key
   * @param {{ activeReaders: number, activeWriter: boolean, queue: Array<any> }} state
   * @param {any} task
   */
  #startWriter(key, state, task) {
    task.started = true;
    if (task.timer) clearTimeout(task.timer);
    state.activeWriter = true;
    this.#runTask(key, state, task, () => {
      state.activeWriter = false;
    });
  }

  /**
   * @param {string} key
   * @param {{ activeReaders: number, activeWriter: boolean, queue: Array<any> }} state
   * @param {any} task
   * @param {() => void} release
   */
  #runTask(key, state, task, release) {
    const startedAt = Date.now();
    const queueInfo = {
      key,
      mode: task.mode,
      waitMs: Math.max(0, startedAt - task.requestedAt),
      depthAtEnqueue: task.depthAtEnqueue,
      inFlightAtEnqueue: task.inFlightAtEnqueue,
      label: task.label,
    };
    let status = /** @type {"fulfilled" | "rejected"} */ ("fulfilled");
    let error = undefined;
    Promise.resolve()
      .then(async () => {
        let value;
        try {
          value = await task.fn(queueInfo);
          status = "fulfilled";
        } catch (err) {
          status = "rejected";
          error = err;
        }
        ({ status, error } = await this.#runBeforeRelease(task, queueInfo, status, error));
        return { value };
      })
      .then(
        ({ value }) => {
          release();
          if (typeof task.onRelease === "function") {
            try {
              task.onRelease({ ...queueInfo, status, ...(error === undefined ? {} : { error }) });
            } catch {
              // Release hooks are observational; never break queue progress.
            }
          }
          this.#drain(key, state);
          if (status === "fulfilled") task.resolve(value);
          else task.reject(error);
        },
        (err) => {
          status = "rejected";
          error = err;
          release();
          if (typeof task.onRelease === "function") {
            try {
              task.onRelease({ ...queueInfo, status, error });
            } catch {
              // Release hooks are observational; never break queue progress.
            }
          }
          this.#drain(key, state);
          task.reject(err);
        },
      );
  }

  /**
   * Awaited cleanup that still owns the lock. Use it only for work that belongs
   * to the running operation, such as flushing or closing handles it opened.
   *
   * @param {any} task
   * @param {QueueInfo & { key: string, mode: "blocking" | "non-blocking" }} queueInfo
   * @param {"fulfilled" | "rejected"} status
   * @param {unknown} error
   * @returns {Promise<{ status: "fulfilled" | "rejected", error: unknown }>}
   */
  async #runBeforeRelease(task, queueInfo, status, error) {
    if (typeof task.onBeforeRelease !== "function") return { status, error };
    try {
      await task.onBeforeRelease({
        ...queueInfo,
        status,
        ...(error === undefined ? {} : { error }),
      });
      return { status, error };
    } catch (cleanupError) {
      if (status === "rejected" && error && typeof error === "object") {
        try {
          /** @type {any} */ (error).cleanupError = cleanupError;
        } catch {
          // Best-effort diagnostic only.
        }
        return { status, error };
      }
      return { status: "rejected", error: cleanupError };
    }
  }

  /**
   * @param {any} task
   * @param {unknown} error
   * @param {number} waitMs
   */
  #notifyCancel(task, error, waitMs) {
    if (typeof task?.onCancel !== "function") return;
    try {
      task.onCancel({
        key: task.key,
        mode: task.mode,
        waitMs,
        depthAtEnqueue: task.depthAtEnqueue,
        inFlightAtEnqueue: task.inFlightAtEnqueue,
        label: task.label,
        error,
      });
    } catch {
      // Cancellation hooks are observational; never break queue progress.
    }
  }

  /**
   * @param {string} key
   * @param {{ activeReaders: number, activeWriter: boolean, queue: Array<any> }} state
   */
  #cleanupState(key, state) {
    if (state.activeWriter || state.activeReaders > 0 || state.queue.length > 0) return;
    queueMicrotask(() => {
      const latest = this.#states.get(key);
      if (latest === state && !latest.activeWriter && latest.activeReaders === 0 && latest.queue.length === 0) {
        this.#states.delete(key);
      }
    });
  }
}

export class AsyncResourceGate {
  #gate;
  #barriers = new Map();

  /**
   * When `gate` is provided, its policy is used as-is and `policy` is
   * ignored. Otherwise a fresh `ProtectedAssetGate` is created with the
   * given policy (default "read-priority").
   *
   * @param {{ name?: string, gate?: ProtectedAssetGate, policy?: GatePolicy }} [options]
   */
  constructor({ name = "async resource", gate = null, policy = "read-priority" } = {}) {
    this.name = name;
    this.#gate = gate || new ProtectedAssetGate({ name, policy });
  }

  /**
   * Override in subclasses when a resource has a canonical key format
   * (absolute paths, repo ids, model ids, etc.).
   *
   * @param {unknown} key
   * @returns {string}
   */
  normalizeKey(key) {
    return normalizeGateKey(key);
  }

  /**
   * @param {unknown} barrierKey
   * @returns {string}
   */
  normalizeBarrierKey(barrierKey) {
    return normalizeGateKey(barrierKey);
  }

  /**
   * Default barrier name for blocking work against `key`.
   *
   * @param {unknown} key
   * @returns {string}
   */
  blockingReleaseKey(key) {
    return this.#defaultBlockingReleaseKey(this.normalizeKey(key));
  }

  /**
   * @template T
   * @param {unknown} key
   * @param {(info: QueueInfo & { key: string, mode: "non-blocking" }) => T | Promise<T>} fn
   * @param {RunOptions} [options]
   * @returns {Promise<T>}
   */
  read(key, fn, options = {}) {
    const normalized = this.normalizeKey(key);
    return this.#gate.runNonBlocking(normalized, fn, options);
  }

  /**
   * @template T
   * @param {unknown} key
   * @param {(info: QueueInfo & { key: string, mode: "blocking" }) => T | Promise<T>} fn
   * @param {RunOptions & { barrierKey?: string | string[] | null, barrierName?: string | null }} [options]
   * @returns {Promise<T>}
   */
  write(key, fn, options = {}) {
    const normalized = this.normalizeKey(key);
    const releases = this.#registerBlockingBarriers(normalized, options);
    try {
      return this.#gate.runBlocking(normalized, fn, {
        ...options,
        onRelease: (info) => {
          try { options.onRelease?.(info); } catch { /* caller hook is observational */ }
          this.#releaseBarriers(releases, info);
        },
        onCancel: (info) => {
          try { options.onCancel?.(info); } catch { /* caller hook is observational */ }
          this.#releaseBarriers(releases, { ...info, status: "rejected", error: info.error });
        },
      });
    } catch (err) {
      this.#releaseBarriers(releases, { key: normalized, status: "rejected", error: err });
      throw err;
    }
  }

  /**
   * @template T
   * @param {unknown} key
   * @param {(info: QueueInfo & { key: string, mode: "blocking" }) => T | Promise<T>} fn
   * @param {RunOptions & { barrierKey?: string | string[] | null, barrierName?: string | null, releaseWaitMs?: number }} [options]
   * @returns {{ barrier: { gate: string, name: string, resourceKey: string, barrierKey: string, released: Promise<any>, wait: (waitOptions?: { waitMs?: number }) => Promise<any> }, barrierKey: string, result: Promise<T>, released: Promise<any> }}
   */
  writeWithRelease(key, fn, options = {}) {
    const explicit = Array.isArray(options.barrierKey) ? options.barrierKey[0] : options.barrierKey;
    const barrierKey = this.normalizeBarrierKey(explicit || this.blockingReleaseKey(key));
    const writeBarrierKey = Array.isArray(options.barrierKey)
      ? [...options.barrierKey]
      : barrierKey;
    const result = this.write(key, fn, { ...options, barrierKey: writeBarrierKey });
    const released = this.waitForRelease(barrierKey, { waitMs: options.releaseWaitMs });
    const barrierName = String(options.barrierName || options.label || barrierKey);
    const barrier = {
      gate: this.name,
      name: barrierName,
      resourceKey: this.normalizeKey(key),
      barrierKey,
      released,
      wait: (waitOptions = {}) => this.awaitBarrier(barrier, waitOptions),
    };
    return { barrier, barrierKey, result, released };
  }

  /**
   * Preferred route-facing API: pass either a release handle received from a
   * writer, or a resource key owned by this gate. Callers should not need to
   * know the generated barrier key for common resource-idle waits.
   *
   * @param {unknown} barrierOrResourceKey
   * @param {{ waitMs?: number }} [options]
   */
  awaitBarrier(barrierOrResourceKey, options = {}) {
    if (
      barrierOrResourceKey
      && typeof barrierOrResourceKey === "object"
      && typeof /** @type {any} */ (barrierOrResourceKey).released?.then === "function"
    ) {
      return /** @type {any} */ (barrierOrResourceKey).released;
    }
    return this.waitForRelease(barrierOrResourceKey, options);
  }

  /**
   * Wait until currently registered blocking work for a barrier or resource
   * releases. Resolves immediately when nothing is blocking that key.
   *
   * @param {unknown} barrierKeyOrResourceKey
   * @param {{ waitMs?: number }} [options]
   * @returns {Promise<{ barrierKey: string, idle: boolean, releases: any[] }>}
   */
  waitForRelease(barrierKeyOrResourceKey, { waitMs = DEFAULT_WAIT_MS } = {}) {
    if (
      barrierKeyOrResourceKey
      && typeof barrierKeyOrResourceKey === "object"
      && typeof /** @type {any} */ (barrierKeyOrResourceKey).released?.then === "function"
    ) {
      return /** @type {any} */ (barrierKeyOrResourceKey).released;
    }
    const keys = this.#releaseLookupKeys(barrierKeyOrResourceKey);
    const promises = [];
    const waitingOn = [];
    let selected = keys[0] || "global";
    for (const key of keys) {
      const active = this.#barriers.get(key);
      if (!active || active.size === 0) continue;
      selected = key;
      for (const release of active) {
        promises.push(release.promise);
        waitingOn.push({
          gate: this.name,
          name: release.name,
          label: release.label,
          barrierKey: release.barrierKey,
          resourceKey: release.resourceKey,
        });
      }
    }
    if (promises.length === 0) {
      const idle = Promise.resolve({ barrierKey: selected, idle: true, releases: [], waitingOn: [] });
      return this.#withWaitMetadata(idle, { barrierKey: selected, idle: true, waitingOn: [] });
    }
    const joined = Promise.all(promises).then((releases) => ({
      barrierKey: selected,
      idle: false,
      releases,
      waitingOn,
    }));
    const maxWaitMs = Math.max(0, Number(waitMs) || 0);
    if (maxWaitMs <= 0) return this.#withWaitMetadata(joined, { barrierKey: selected, idle: false, waitingOn });
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new AsyncGateBusyError(
          `${this.name} release wait timed out after ${maxWaitMs}ms (${selected})`,
          { key: selected, label: "waitForRelease" },
        ));
      }, maxWaitMs);
      timer.unref?.();
    });
    const raced = Promise.race([joined, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return this.#withWaitMetadata(raced, { barrierKey: selected, idle: false, waitingOn });
  }

  snapshot() {
    return {
      ...this.#gate.snapshot(),
      name: this.name,
      barriers: Array.from(this.#barriers.entries()).map(([key, releases]) => ({
        key,
        pending: releases.size,
      })),
    };
  }

  /**
   * @param {string} normalizedKey
   * @param {{ barrierKey?: string | string[] | null }} options
   */
  #barrierKeys(normalizedKey, options = {}) {
    const keys = [this.#defaultBlockingReleaseKey(normalizedKey)];
    const explicit = options.barrierKey;
    if (Array.isArray(explicit)) {
      for (const key of explicit) keys.push(this.normalizeBarrierKey(key));
    } else if (explicit) {
      keys.push(this.normalizeBarrierKey(explicit));
    }
    return [...new Set(keys.filter(Boolean))];
  }

  /**
   * @param {unknown} key
   * @returns {string[]}
   */
  #releaseLookupKeys(key) {
    const exact = this.normalizeBarrierKey(key);
    const resource = this.#defaultBlockingReleaseKey(this.normalizeKey(key));
    return [...new Set([exact, resource].filter(Boolean))];
  }

  /**
   * @param {string} normalizedKey
   * @returns {string}
   */
  #defaultBlockingReleaseKey(normalizedKey) {
    return `${this.name}:blocking:${normalizedKey}`;
  }

  /**
   * @param {string} normalizedKey
   * @param {{ barrierKey?: string | string[] | null, label?: string, barrierName?: string | null }} options
   */
  #registerBlockingBarriers(normalizedKey, options) {
    return this.#barrierKeys(normalizedKey, options).map((barrierKey) => {
      /** @type {(value: any) => void} */
      let resolve = () => {};
      const promise = new Promise((res) => {
        resolve = res;
      });
      let active = this.#barriers.get(barrierKey);
      if (!active) {
        active = new Set();
        this.#barriers.set(barrierKey, active);
      }
      const release = {
        barrierKey,
        promise,
        resolve,
        label: options.label || "work",
        name: String(options.barrierName || options.label || barrierKey),
        resourceKey: normalizedKey,
      };
      active.add(release);
      return release;
    });
  }

  /**
   * @param {Array<{ barrierKey: string, promise: Promise<any>, resolve: (value: any) => void, label: string, name: string, resourceKey: string }>} releases
   * @param {any} info
   */
  #releaseBarriers(releases, info) {
    for (const release of releases) {
      const active = this.#barriers.get(release.barrierKey);
      if (active) {
        active.delete(release);
        if (active.size === 0) this.#barriers.delete(release.barrierKey);
      }
      release.resolve({
        barrierKey: release.barrierKey,
        name: release.name,
        resourceKey: release.resourceKey,
        key: info?.key,
        label: release.label,
        status: info?.status || "fulfilled",
        ...(info?.error === undefined ? {} : { error: info.error }),
      });
    }
  }

  /**
   * @template T
   * @param {Promise<T>} promise
   * @param {{ barrierKey: string, idle: boolean, waitingOn: any[] }} metadata
   * @returns {Promise<T> & { barrierKey?: string, idle?: boolean, waitingOn?: any[] }}
   */
  #withWaitMetadata(promise, metadata) {
    const tagged = /** @type {Promise<T> & { barrierKey?: string, idle?: boolean, waitingOn?: any[] }} */ (promise);
    tagged.barrierKey = metadata.barrierKey;
    tagged.idle = metadata.idle;
    tagged.waitingOn = metadata.waitingOn;
    return tagged;
  }
}

export function normalizeGateKey(value) {
  const text = String(value || "global").trim();
  return text || "global";
}
