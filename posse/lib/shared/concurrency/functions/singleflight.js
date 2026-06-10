// @ts-check
//
// Single-flight (in-flight coalescing) primitive. When multiple callers ask for
// the same keyed work while it is already running, they share one execution and
// one result instead of each doing the work independently. The map self-cleans:
// once the shared promise settles, the key is removed so the next caller starts
// fresh.
//
// This is a pure concurrency helper with no domain knowledge — callers decide
// what makes a key "the same work" (e.g. repo + version + action + args hash).

/**
 * @template T
 * @typedef {() => T | Promise<T>} Factory
 */

export function createSingleflight() {
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  return {
    /**
     * Run `factory` under `key`, coalescing concurrent identical calls. When
     * `key` is null/undefined the call is never coalesced (always runs).
     *
     * @template T
     * @param {string | null | undefined} key
     * @param {Factory<T>} factory
     * @returns {Promise<T>}
     */
    run(key, factory) {
      if (key == null) {
        try { return Promise.resolve(factory()); }
        catch (err) { return Promise.reject(err); }
      }
      const existing = inflight.get(key);
      if (existing) return existing;
      // Run the factory synchronously so the "exactly one execution per key"
      // guarantee holds for callers that enqueue in the same tick (the common
      // case: a burst of identical concurrent requests). A synchronous throw
      // never registers a key — there is no async work to coalesce — so it just
      // rejects this caller.
      let started;
      try {
        started = Promise.resolve(factory());
      } catch (err) {
        return Promise.reject(err);
      }
      const tracked = started.finally(() => {
        if (inflight.get(key) === tracked) inflight.delete(key);
      });
      inflight.set(key, tracked);
      return tracked;
    },

    /** @returns {number} number of distinct in-flight keys */
    size() {
      return inflight.size;
    },

    /**
     * @param {string} key
     * @returns {boolean} whether work for `key` is currently in flight
     */
    has(key) {
      return inflight.has(key);
    },
  };
}
