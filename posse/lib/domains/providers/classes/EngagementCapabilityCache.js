// lib/domains/providers/classes/EngagementCapabilityCache.js
//
// Per-process memory of whether posse-remote can answer engagement launch
// plans. A missing, old, or mismatched binary costs one capabilities probe
// (then one per backoff window) instead of a failed spawn and a warning on
// every provider launch. Also remembers which warnings were already logged so
// each reason is reported once per process.

const INITIAL_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * @typedef {{ ok: true } | { ok: false, reason: string, message: string }} EngagementCapabilityStatus
 * @typedef {{
 *   status: "ok" | "failed" | "probing",
 *   failures: number,
 *   retryAt: number,
 *   reason: string,
 *   message: string,
 *   inflight: Promise<EngagementCapabilityStatus> | null,
 * }} EngagementCapabilityEntry
 */

/** @param {unknown} error */
function failureOf(error) {
  const err = /** @type {{ reason?: unknown, message?: unknown } | null} */ (error && typeof error === "object" ? error : null);
  return {
    reason: typeof err?.reason === "string" && err.reason ? err.reason : "call-failed",
    message: String(err?.message ?? error ?? "engagement call failed"),
  };
}

export class EngagementCapabilityCache {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    /** @type {WeakMap<object, Map<string, EngagementCapabilityEntry>>} */
    this._entries = new WeakMap();
    /** @type {Set<string>} */
    this._warned = new Set();
  }

  /** @param {object} owner */
  #entriesFor(owner) {
    let entries = this._entries.get(owner);
    if (!entries) {
      entries = new Map();
      this._entries.set(owner, entries);
    }
    return entries;
  }

  /** @param {number} failures */
  #backoffMs(failures) {
    return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
  }

  /**
   * Whether the binary identified by `binaryKey` (owned by `owner`, usually a
   * BinaryManager) can serve engagement plans. Runs `probe` at most once per
   * binary while it keeps succeeding, and once per backoff window after a
   * failure. `probe` throws an error carrying a short `reason` code.
   *
   * @param {object} owner
   * @param {string} binaryKey
   * @param {() => Promise<unknown>} probe
   * @returns {Promise<EngagementCapabilityStatus>}
   */
  check(owner, binaryKey, probe) {
    const entries = this.#entriesFor(owner);
    const entry = entries.get(binaryKey);
    if (entry?.inflight) return entry.inflight;
    if (entry?.status === "ok") return Promise.resolve({ ok: true });
    if (entry?.status === "failed" && this._now() < entry.retryAt) {
      return Promise.resolve({ ok: false, reason: entry.reason, message: entry.message });
    }
    const failures = entry?.failures || 0;
    const inflight = (async () => {
      try {
        await probe();
        entries.set(binaryKey, { status: "ok", failures: 0, retryAt: 0, reason: "", message: "", inflight: null });
        return /** @type {EngagementCapabilityStatus} */ ({ ok: true });
      } catch (error) {
        const { reason, message } = failureOf(error);
        this.#recordFailure(entries, binaryKey, failures, reason, message);
        return /** @type {EngagementCapabilityStatus} */ ({ ok: false, reason, message });
      }
    })();
    entries.set(binaryKey, { status: "probing", failures, retryAt: 0, reason: "", message: "", inflight });
    return inflight;
  }

  /**
   * A launch-plan call failed after a successful probe: back off before the
   * next attempt so a flaky binary does not cost every launch.
   *
   * @param {object} owner
   * @param {string} binaryKey
   * @param {unknown} error
   */
  markFailed(owner, binaryKey, error) {
    const entries = this.#entriesFor(owner);
    const { reason, message } = failureOf(error);
    this.#recordFailure(entries, binaryKey, entries.get(binaryKey)?.failures || 0, reason, message);
  }

  /**
   * @param {Map<string, EngagementCapabilityEntry>} entries
   * @param {string} binaryKey
   * @param {number} previousFailures
   * @param {string} reason
   * @param {string} message
   */
  #recordFailure(entries, binaryKey, previousFailures, reason, message) {
    const failures = previousFailures + 1;
    entries.set(binaryKey, {
      status: "failed",
      failures,
      retryAt: this._now() + this.#backoffMs(failures),
      reason,
      message,
      inflight: null,
    });
  }

  /**
   * True the first time `key` is seen in this process.
   *
   * @param {string} key
   * @returns {boolean}
   */
  firstTime(key) {
    if (this._warned.has(key)) return false;
    this._warned.add(key);
    return true;
  }

  reset() {
    this._entries = new WeakMap();
    this._warned.clear();
  }
}

export const engagementCapabilityCache = new EngagementCapabilityCache();
