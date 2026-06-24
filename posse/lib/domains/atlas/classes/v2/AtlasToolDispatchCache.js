// @ts-check
//
// Gateway-owned ATLAS dispatch-result cache. This is intentionally a class so
// the long-lived MCP owner can hold the cache, while short-lived shim processes
// and direct executor instances stay cache-free unless a caller opts in.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

export class AtlasToolDispatchCache {
  #actions;
  #ttlMs;
  #maxEntries;
  #now;
  /** @type {Map<string, { state: "ready", value: any, expiresAt: number } | { state: "pending", promise: Promise<any>, startedAt: number, waiters: number }>} */
  #entries = new Map();
  /** @type {Map<string, number>} */
  #repoEpochs = new Map();

  /**
   * @param {{
   *   actions?: Iterable<string>,
   *   ttlMs?: number,
   *   maxEntries?: number,
   *   now?: () => number,
   * }} [opts]
   */
  constructor({
    actions = [],
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = Date.now,
  } = {}) {
    this.#actions = new Set([...actions].map((action) => String(action || "").toLowerCase()).filter(Boolean));
    this.#ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.#maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    this.#now = now;
  }

  /**
   * @param {{ repoKey: string, action: string, args?: Record<string, any>, selectorKeys?: string[], keyParts?: Record<string, any> }} request
   */
  keyFor({ repoKey, action, args = {}, selectorKeys = [], keyParts = {} }) {
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (!normalizedAction || !this.#actions.has(normalizedAction)) return null;
    return `${String(repoKey || "global")}|${normalizedAction}:${stableStringify({
      args: cacheArgs(args, selectorKeys),
      key: keyParts,
    })}`;
  }

  /**
   * @param {string | null} key
   */
  get(key) {
    if (!key) return null;
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (entry.state === "pending") return null;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return null;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return cloneJson(entry.value);
  }

  /**
   * @param {string | null} key
   * @param {any} value
   * @param {{ ttlMs?: number | null }} [opts]
   */
  set(key, value, opts = {}) {
    const ttlMs = opts.ttlMs == null ? this.#ttlMs : Math.max(0, Number(opts.ttlMs) || 0);
    if (!key || ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, {
      state: "ready",
      value: cloneJson(value),
      expiresAt: this.#now() + ttlMs,
    });
    this.#prune();
  }

  /**
   * Return a ready value, wait on a pending producer, or install a new pending
   * producer. The pending entry hydrates every waiter into the same settled
   * value, then promotes that value to the ready cache.
   *
   * @param {string | null} key
   * @param {() => Promise<any> | any} producer
   * @param {{ ttlMs?: number | null, cacheReady?: boolean, repoKey?: string | null }} [opts]
   * @returns {Promise<{ state: "miss" | "hit" | "waiting", value: any }>}
   */
  async getOrRun(key, producer, opts = {}) {
    if (!key) return { state: "miss", value: await producer() };
    const cacheReady = opts.cacheReady !== false;
    const repoKey = opts.repoKey == null ? repoKeyFromCacheKey(key) : String(opts.repoKey || "global");
    if (cacheReady) {
      const ready = this.get(key);
      if (ready != null) return { state: "hit", value: ready };
    }

    const existing = this.#entries.get(key);
    if (existing?.state === "pending") {
      existing.waiters += 1;
      const value = await existing.promise;
      return { state: "waiting", value: cloneJson(value) };
    }

    const promise = Promise.resolve().then(producer);
    const startedEpoch = this.epochForRepo(repoKey);
    this.#entries.delete(key);
    this.#entries.set(key, {
      state: "pending",
      promise,
      startedAt: this.#now(),
      waiters: 0,
    });
    this.#prune();
    try {
      const value = await promise;
      const entry = this.#entries.get(key);
      const stillCurrent = entry?.state === "pending" && entry.promise === promise;
      const epochUnchanged = this.epochForRepo(repoKey) === startedEpoch;
      if (cacheReady && stillCurrent && epochUnchanged) {
        this.set(key, value, opts);
      } else if (stillCurrent) {
        this.#entries.delete(key);
      }
      return { state: "miss", value };
    } catch (err) {
      const entry = this.#entries.get(key);
      if (entry?.state === "pending" && entry.promise === promise) this.#entries.delete(key);
      throw err;
    }
  }

  /**
   * @param {string} repoKey
   */
  clearRepo(repoKey) {
    this.bumpRepo(repoKey);
  }

  /**
   * @param {string} repoKey
   */
  bumpRepo(repoKey) {
    const normalized = String(repoKey || "global");
    this.#repoEpochs.set(normalized, this.epochForRepo(normalized) + 1);
    const prefix = `${String(repoKey || "global")}|`;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
  }

  /**
   * @param {string | null | undefined} repoKey
   */
  epochForRepo(repoKey) {
    return this.#repoEpochs.get(String(repoKey || "global")) || 0;
  }

  clear() {
    this.#entries.clear();
  }

  snapshot() {
    let ready = 0;
    let pending = 0;
    let waiters = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === "pending") {
        pending += 1;
        waiters += entry.waiters;
      } else {
        ready += 1;
      }
    }
    return {
      entries: this.#entries.size,
      ready,
      pending,
      waiters,
      ttlMs: this.#ttlMs,
      maxEntries: this.#maxEntries,
      actions: this.#actions.size,
      repoEpochs: this.#repoEpochs.size,
    };
  }

  #prune() {
    while (this.#entries.size > this.#maxEntries) {
      let oldest = null;
      for (const [key, entry] of this.#entries.entries()) {
        if (entry.state === "ready") {
          oldest = key;
          break;
        }
      }
      if (oldest == null) break;
      this.#entries.delete(oldest);
    }
  }
}

function cacheArgs(args = {}, selectorKeys = []) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out = { ...args };
  // Gateway wrappers carry the target action in one of these fields. The
  // effective dispatch action is already part of the cache key, so leaving the
  // selector in args would prevent atlas.code -> code.skeleton from sharing
  // with atlas.code.skeleton.
  for (const key of selectorKeys) delete out[key];
  return out;
}

function repoKeyFromCacheKey(key) {
  const text = String(key || "");
  const index = text.indexOf("|");
  return index >= 0 ? text.slice(0, index) : "global";
}

/**
 * @param {unknown} value
 */
function stableStringify(value) {
  if (value === undefined || value == null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * @param {any} value
 */
function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}
