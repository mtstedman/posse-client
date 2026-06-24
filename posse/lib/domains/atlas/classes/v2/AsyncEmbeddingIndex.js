// @ts-check

/**
 * Async facade for the usearch embedding index.
 *
 * usearch's native API is synchronous. Wrapping it behind an async facade keeps
 * runtime retrieval code uniform and lets the AsyncResourceGate serialize
 * concurrent reads/writes against the in-process index file.
 */

import { AsyncResourceGate } from "../../../../shared/concurrency/classes/AsyncGate.js";
import { errorForTelemetry, recordEmbeddingForensics } from "../../functions/v2/embeddings/forensics.js";

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIngest} EmbeddingIngest */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingHit} EmbeddingHit */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSearchOptions} EmbeddingSearchOptions */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIndex} EmbeddingIndexContract */

class EmbeddingIndexResourceGate extends AsyncResourceGate {
  normalizeKey(key) {
    return `embedding:${String(key || "default").trim() || "default"}`;
  }
}

const EMBEDDING_INDEX_GATE = new EmbeddingIndexResourceGate({ name: "ATLAS embedding index" });

/** @implements {EmbeddingIndexContract} */
export class AsyncEmbeddingIndex {
  /** @type {EmbeddingIndexContract} */
  #inner;
  /** @type {string} */
  #gateKey;
  /** @type {number} */
  #waitMs;

  /**
   * @param {EmbeddingIndexContract} inner
   * @param {{ gateKey?: string, waitMs?: number }} [options]
   */
  constructor(inner, { gateKey = null, waitMs = 30000 } = {}) {
    if (!inner) throw new TypeError("AsyncEmbeddingIndex: inner index is required");
    this.#inner = inner;
    this.model = inner.model;
    this.model_version = inner.model_version;
    this.dim = inner.dim;
    this.backend = /** @type {any} */ (inner).backend || "sync";
    this.#gateKey = String(gateKey || /** @type {any} */ (inner).gateKey || `${this.backend}:${this.model}:${this.model_version}:${this.dim}`);
    this.gateKey = this.#gateKey;
    this.#waitMs = Math.max(0, Number(waitMs) || 0) || 30000;
    this.asyncIndex = true;
    this.protectedAsyncIndex = true;
  }

  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;
  /** @type {string} */
  backend;
  /** @type {true} */
  asyncIndex;
  /** @type {true} */
  protectedAsyncIndex;
  /** @type {string} */
  gateKey;

  /**
   * @param {EmbeddingIngest[]} rows
   * @returns {Promise<void>}
   */
  async add(rows) {
    return await this.#write("add", () => this.#inner.add(rows), { rows: Array.isArray(rows) ? rows.length : 0 });
  }

  /**
   * @param {string[]} content_hashes
   * @returns {Promise<number>}
   */
  async removeByContentHash(content_hashes) {
    return await this.#write("remove", () => this.#inner.removeByContentHash(content_hashes), {
      content_hashes: Array.isArray(content_hashes) ? content_hashes.length : 0,
    });
  }

  /**
   * @param {{ content_hash: string, local_id: number }[]} keys
   * @returns {Promise<number>}
   */
  async pruneToKeys(keys) {
    const fn = /** @type {any} */ (this.#inner).pruneToKeys;
    if (typeof fn !== "function") return 0;
    return await this.#write("prune", () => fn.call(this.#inner, keys), {
      keys: Array.isArray(keys) ? keys.length : 0,
    });
  }

  /**
   * @param {string} content_hash
   * @param {number} local_id
   * @returns {Promise<boolean>}
   */
  async contains(content_hash, local_id) {
    const fn = /** @type {any} */ (this.#inner).contains;
    if (typeof fn !== "function") return false;
    return await EMBEDDING_INDEX_GATE.read(
      this.#gateKey,
      () => !!fn.call(this.#inner, content_hash, local_id),
      { label: `embedding.${this.backend}.contains`, waitMs: this.#waitMs },
    );
  }

  /**
   * @param {{ content_hash: string, local_id: number }[]} keys
   * @returns {Promise<Set<string>>}
   */
  async containsMany(keys) {
    const batch = Array.isArray(keys) ? keys : [];
    const fn = /** @type {any} */ (this.#inner).containsMany;
    const contains = /** @type {any} */ (this.#inner).contains;
    if (typeof fn !== "function" && typeof contains !== "function") return new Set();
    return await EMBEDDING_INDEX_GATE.read(
      this.#gateKey,
      async () => {
        if (typeof fn === "function") {
          return normalizeContainsManyResult(await fn.call(this.#inner, batch));
        }
        const out = new Set();
        for (const key of batch) {
          if (!key || typeof key.content_hash !== "string" || !Number.isInteger(key.local_id)) continue;
          if (await contains.call(this.#inner, key.content_hash, key.local_id)) {
            out.add(embeddingKey(key));
          }
        }
        return out;
      },
      { label: `embedding.${this.backend}.containsMany`, waitMs: this.#waitMs },
    );
  }

  /**
   * @returns {Record<string, any> | null}
   */
  getLastAddTiming() {
    const fn = /** @type {any} */ (this.#inner).getLastAddTiming;
    if (typeof fn !== "function") return null;
    return fn.call(this.#inner);
  }

  /**
   * @param {string} key
   * @returns {Promise<Record<string, any> | null>}
   */
  async getEmbeddingWatermark(key) {
    const fn = /** @type {any} */ (this.#inner).getEmbeddingWatermark;
    if (typeof fn !== "function") return null;
    return await EMBEDDING_INDEX_GATE.read(
      this.#gateKey,
      () => fn.call(this.#inner, key) || null,
      { label: `embedding.${this.backend}.getEmbeddingWatermark`, waitMs: this.#waitMs },
    );
  }

  /**
   * @param {string} key
   * @param {Record<string, any>} watermark
   * @returns {Promise<void>}
   */
  async setEmbeddingWatermark(key, watermark) {
    const fn = /** @type {any} */ (this.#inner).setEmbeddingWatermark;
    if (typeof fn !== "function") return;
    await this.#write("setEmbeddingWatermark", () => fn.call(this.#inner, key, watermark), {
      key,
      ledger_seq: Number.isInteger(watermark?.ledger_seq) ? watermark.ledger_seq : null,
    });
  }

  /**
   * @param {Float32Array} vector
   * @param {EmbeddingSearchOptions} [opts]
   * @returns {Promise<EmbeddingHit[]>}
   */
  async nearest(vector, opts = {}) {
    return await EMBEDDING_INDEX_GATE.read(
      this.#gateKey,
      () => this.#inner.nearest(vector, opts),
      { label: `embedding.${this.backend}.nearest`, waitMs: this.#waitMs },
    );
  }

  /** @returns {Promise<number>} */
  async count() {
    return await EMBEDDING_INDEX_GATE.read(
      this.#gateKey,
      () => this.#inner.count(),
      { label: `embedding.${this.backend}.count`, waitMs: this.#waitMs },
    );
  }

  /** @returns {Promise<void>} */
  async close() {
    await this.#write("close", () => this.#inner.close());
  }

  async #write(op, fn, detail = {}) {
    const label = `embedding.${this.backend}.${op}`;
    recordEmbeddingForensics("embedding_index_gate.write.wait", {
      op,
      label,
      gate_key: this.#gateKey,
      wait_ms: this.#waitMs,
      backend: this.backend,
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      detail,
    });
    const startedAt = Date.now();
    try {
      return await EMBEDDING_INDEX_GATE.write(
        this.#gateKey,
        (info) => {
          recordEmbeddingForensics("embedding_index_gate.write.enter", {
            op,
            label,
            gate_key: this.#gateKey,
            wait_ms: info?.waitMs ?? null,
            depth_at_enqueue: info?.depthAtEnqueue ?? null,
            in_flight_at_enqueue: info?.inFlightAtEnqueue ?? null,
            backend: this.backend,
            model: this.model,
            model_version: this.model_version,
            dim: this.dim,
            detail,
          });
          return fn();
        },
        { label, waitMs: this.#waitMs },
      );
    } catch (err) {
      recordEmbeddingForensics("embedding_index_gate.write.error", {
        op,
        label,
        gate_key: this.#gateKey,
        elapsed_ms: Date.now() - startedAt,
        error: errorForTelemetry(err),
      });
      throw err;
    } finally {
      recordEmbeddingForensics("embedding_index_gate.write.release", {
        op,
        label,
        gate_key: this.#gateKey,
        elapsed_ms: Date.now() - startedAt,
      });
    }
  }
}

/**
 * @param {EmbeddingIndexContract} index
 * @returns {EmbeddingIndexContract}
 */
export function toAsyncEmbeddingIndex(index) {
  if (!index) return index;
  if (/** @type {any} */ (index).protectedAsyncIndex === true) return index;
  return /** @type {EmbeddingIndexContract} */ (new AsyncEmbeddingIndex(index));
}

export function embeddingIndexGateSnapshot() {
  return EMBEDDING_INDEX_GATE.snapshot();
}

export function embeddingIndexGateReleaseKey(key) {
  return EMBEDDING_INDEX_GATE.blockingReleaseKey(key);
}

export function waitForEmbeddingIndexRelease(keyOrBarrierKey, opts = {}) {
  return EMBEDDING_INDEX_GATE.awaitBarrier(keyOrBarrierKey, opts);
}

function normalizeContainsManyResult(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set();
}

function embeddingKey(key) {
  return `${key.content_hash}\0${key.local_id}`;
}
