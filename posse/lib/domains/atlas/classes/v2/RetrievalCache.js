// @ts-check
//
// Small process-local retrieval cache for hot ATLAS reads. Keys include the
// version id, so normal view advancement naturally misses; pipeline events
// also clear the cache to avoid stale same-version handles during warm races.

import { sha256Hex } from "../../functions/v2/hash.js";

class TtlLru {
  /**
   * @param {{ capacity: number, ttlMs: number }} opts
   */
  constructor({ capacity, ttlMs }) {
    this.capacity = Math.max(1, capacity);
    this.ttlMs = Math.max(1, ttlMs);
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.map = new Map();
  }

  /**
   * @param {string} key
   * @returns {any | null}
   */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return cloneJson(entry.value);
  }

  /**
   * @param {string} key
   * @returns {any | null}
   */
  peek(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return cloneJson(entry.value);
  }

  /**
   * @param {string} key
   * @param {any} value
   */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {
      value: cloneJson(value),
      expiresAt: Date.now() + this.ttlMs,
    });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest == null) break;
      this.map.delete(String(oldest));
    }
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

export class RetrievalCache {
  /**
   * @param {{
   *   cardCapacity?: number,
   *   cardTtlMs?: number,
   *   sliceCapacity?: number,
   *   sliceTtlMs?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.cards = new TtlLru({
      capacity: opts.cardCapacity ?? 1000,
      ttlMs: opts.cardTtlMs ?? 5 * 60 * 1000,
    });
    this.slices = new TtlLru({
      capacity: opts.sliceCapacity ?? 50,
      ttlMs: opts.sliceTtlMs ?? 2 * 60 * 1000,
    });
    this.metrics = emptyMetrics();
  }

  /**
   * @param {{ versionId: string, repoId?: string | null, symbolId: string, detail: string, minCallConfidence: number, includeResolutionMetadata: boolean }} args
   */
  cardKey(args) {
    const repoId = normalizeRepoId(args.repoId);
    return `${repoId}:${args.versionId}:card:${stableDigest({ ...args, repoId })}`;
  }

  /**
   * @param {string} key
   */
  getCard(key) {
    const value = this.cards.get(key);
    recordCacheAccess(this.metrics.cards, value != null);
    return value;
  }

  /**
   * Read a card without counting a consumer cache access.
   *
   * @param {string} key
   */
  peekCard(key) {
    return this.cards.peek(key);
  }

  /**
   * @param {string} key
   * @param {any} card
   */
  setCard(key, card) {
    this.cards.set(key, card);
    this.metrics.cards.sets += 1;
  }

  /**
   * @param {{ versionId: string, params: Record<string, unknown>, repoId?: string | null }} args
   */
  sliceKey(args) {
    const repoId = normalizeRepoId(args.repoId);
    return `${repoId}:${args.versionId}:slice:${stableDigest({ ...args, repoId })}`;
  }

  /**
   * @param {string} key
   */
  getSlice(key) {
    const value = this.slices.get(key);
    recordCacheAccess(this.metrics.slices, value != null);
    return value;
  }

  /**
   * Read a slice without counting a consumer cache access.
   *
   * @param {string} key
   */
  peekSlice(key) {
    return this.slices.peek(key);
  }

  /**
   * @param {string} key
   * @param {any} slice
   */
  setSlice(key, slice) {
    this.slices.set(key, slice);
    this.metrics.slices.sets += 1;
  }

  invalidateAll() {
    this.cards.clear();
    this.slices.clear();
    this.metrics = emptyMetrics();
  }

  stats() {
    return {
      cards: this.cards.size,
      slices: this.slices.size,
    };
  }

  telemetry() {
    return {
      cards: {
        entries: this.cards.size,
        ...metricSnapshot(this.metrics.cards),
      },
      slices: {
        entries: this.slices.size,
        ...metricSnapshot(this.metrics.slices),
      },
    };
  }
}

const DEFAULT_RETRIEVAL_CACHE = new RetrievalCache();

export function getRetrievalCache() {
  return DEFAULT_RETRIEVAL_CACHE;
}

export function __resetRetrievalCacheForTests() {
  DEFAULT_RETRIEVAL_CACHE.invalidateAll();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableDigest(value) {
  return sha256Hex(stableStringify(value)).slice(0, 24);
}

/**
 * @param {string | null | undefined} repoId
 * @returns {string}
 */
function normalizeRepoId(repoId) {
  const text = String(repoId || "default").trim();
  return text || "default";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * @param {any} value
 */
function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function emptyMetrics() {
  return {
    cards: { hits: 0, misses: 0, sets: 0 },
    slices: { hits: 0, misses: 0, sets: 0 },
  };
}

/**
 * @param {{ hits: number, misses: number }} bucket
 * @param {boolean} hit
 */
function recordCacheAccess(bucket, hit) {
  if (hit) bucket.hits += 1;
  else bucket.misses += 1;
}

/**
 * @param {{ hits: number, misses: number, sets: number }} bucket
 */
function metricSnapshot(bucket) {
  const total = bucket.hits + bucket.misses;
  return {
    hits: bucket.hits,
    misses: bucket.misses,
    sets: bucket.sets,
    hitRate: total > 0 ? bucket.hits / total : null,
  };
}
