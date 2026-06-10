// @ts-check
//
// ATLAS v2 EmbeddingIndex — usearch-backed ANN over symbol embeddings.
//
// Embeddings are content-addressed by (content_hash, local_id), the same
// identity SymbolRow uses. usearch keys are uint64, so we maintain a
// SQLite sidecar that maps (content_hash, local_id) ↔ uint64 stably.
// The sidecar IS the source of truth for what's in the index — the
// .usearch file is the ANN structure rebuilt from the sidecar on load.
//
// One index file per (model, model_version) tuple lives under
//   <repo>/.posse/atlas/embeddings/<encoded-model>--<encoded-version>/
// alongside `keys.db` (sidecar). View files do not store vectors — they
// store no embedding state at all. Views are rebuildable; the embedding
// store is the *only* persisted embedding state.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { createHash } from "crypto";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { appendPersistentTelemetry } from "../../../../shared/telemetry/functions/persistent-log.js";
import {
  errorForTelemetry,
  recordEmbeddingForensics,
  summarizeRows,
} from "../../functions/v2/embeddings/forensics.js";

// usearch is an OPTIONAL native dependency. Phase 3.1 installs degrade
// to FTS-only `symbol.search` when usearch isn't on disk — e.g. on
// Windows boxes without a C++ toolchain (no Windows prebuild ships with
// the package). The require here happens synchronously so callers get a
// clean predicate (`isUsearchAvailable`) rather than an unhandled
// rejection from a top-level dynamic import.
const localRequire = createRequire(import.meta.url);
/** @type {any} */
let usearch = null;
/** @type {string | null} */
let usearchLoadError = null;
let annSaveFailureLogged = false;
try {
  const mod = localRequire("usearch");
  usearch = /** @type {any} */ (mod?.default ?? mod);
} catch (err) {
  usearchLoadError = /** @type {any} */ (err)?.message || String(err);
}

/**
 * True when the usearch native module loaded successfully and
 * EmbeddingIndex.open() can be called. False on platforms where the
 * native dep isn't installed; callers should fall back to FTS-only
 * search and skip embedding ingest.
 *
 * @returns {boolean}
 */
export function isUsearchAvailable() {
  return usearch !== null;
}

/**
 * Human-readable reason the optional dep didn't load. Useful for
 * surface-level error messages and operator diagnostics. Returns null
 * when usearch loaded fine.
 *
 * @returns {string | null}
 */
export function usearchUnavailableReason() {
  return usearchLoadError;
}

/**
 * @param {string} context
 * @param {unknown} err
 */
function logAnnSaveFailure(context, err) {
  if (annSaveFailureLogged) return;
  annSaveFailureLogged = true;
  const message = /** @type {any} */ (err)?.message || String(err);
  console.warn(`[atlas-v2 embeddings] failed to save ANN index during ${context}; will retry on close: ${message}`);
  recordAnnRecoveryEvent("ann.save_failed", { context, error: message });
}

/**
 * @param {string} event
 * @param {Record<string, any>} data
 */
function recordAnnRecoveryEvent(event, data = {}) {
  appendPersistentTelemetry(ANN_RECOVERY_LOG_STREAM, {
    event,
    component: "atlas.embedding.index",
    ...data,
  });
}

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIngest} EmbeddingIngest */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingHit} EmbeddingHit */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSearchOptions} EmbeddingSearchOptions */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIndex} EmbeddingIndexContract */

const SIDECAR_SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  uid INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  UNIQUE(content_hash, local_id)
);
CREATE INDEX IF NOT EXISTS idx_keys_content_hash ON keys(content_hash);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS vectors (
  uid INTEGER PRIMARY KEY,
  vector BLOB NOT NULL
);
`;

const ANN_MANIFEST_VERSION = 1;
const ANN_INDEX_FILE = "index.usearch";
const ANN_MANIFEST_FILE = "index.usearch.json";
const ANN_RECOVERY_LOG_STREAM = "atlas-embedding-recovery";
const DEFAULT_ANN_SAVE_EVERY_BATCHES = 16;
const DEFAULT_ANN_SAVE_EVERY_MS = 30_000;
// Quarantined ANN files (`index.usearch.{reason}-{stamp}-{pid}`) are kept for
// post-mortem forensics, then GC'd. Matches the 7-day grace used for obsolete
// model dirs in cleanupStaleEmbeddingDirs.
const ANN_QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} modelDir
 * @returns {{ usearchPath: string, manifestPath: string, sidecarPath: string }}
 */
function pathsFor(modelDir) {
  return {
    usearchPath: path.join(modelDir, ANN_INDEX_FILE),
    manifestPath: path.join(modelDir, ANN_MANIFEST_FILE),
    sidecarPath: path.join(modelDir, "keys.db"),
  };
}

/**
 * @param {number} dim
 */
function newNativeIndex(dim) {
  return new usearch.Index({ metric: "cos", dimensions: dim });
}

/**
 * @param {any} index
 * @returns {{ size: number | null, capacity: number | null, dimensions: number | null, connectivity: number | null }}
 */
function nativeIndexStats(index) {
  const call = (name) => {
    try {
      const value = typeof index?.[name] === "function" ? index[name]() : null;
      return Number.isFinite(Number(value)) ? Number(value) : null;
    } catch {
      return null;
    }
  };
  return {
    size: call("size"),
    capacity: call("capacity"),
    dimensions: call("dimensions"),
    connectivity: call("connectivity"),
  };
}

/** @implements {EmbeddingIndexContract} */
export class EmbeddingIndex {
  /** @type {string} */
  model;
  /** @type {string} */
  model_version;
  /** @type {number} */
  dim;
  /** @type {string} */
  backend = "usearch";
  /** @type {string} */
  gateKey;

  /** @type {any} */
  #usearch;
  /** @type {Database.Database} */
  #db;
  /** @type {Database.Statement} */
  #lookupByUid;
  /** @type {string} */
  #usearchPath;
  /** @type {string} */
  #manifestPath;
  /** @type {string} */
  #inflightPath;
  /** @type {boolean} */
  #dirty = false;
  /** @type {Record<string, any> | null} */
  #lastAddTiming = null;
  /** @type {number} */
  #annSaveEveryBatches = DEFAULT_ANN_SAVE_EVERY_BATCHES;
  /** @type {number} */
  #annSaveEveryMs = DEFAULT_ANN_SAVE_EVERY_MS;
  /** @type {number} */
  #annDirtyBatches = 0;
  /** @type {number} */
  #lastAnnSaveAt = Date.now();

  /**
   * @param {{
   *   model: string,
   *   model_version: string,
   *   dim: number,
   *   modelDir: string,
   *   annSaveEveryBatches?: number,
   *   annSaveEveryMs?: number,
   * }} args
   */
  constructor({ model, model_version, dim, modelDir, annSaveEveryBatches, annSaveEveryMs }) {
    if (usearch === null) {
      throw new Error(
        `EmbeddingIndex: usearch native dependency is not installed (${usearchLoadError ?? "missing"}). ` +
        `Embeddings are an optional feature; install usearch to enable, or skip semantic search.`,
      );
    }
    if (!model) throw new TypeError("EmbeddingIndex: model is required");
    if (!model_version) throw new TypeError("EmbeddingIndex: model_version is required");
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new RangeError("EmbeddingIndex: dim must be a positive integer");
    }
    if (!modelDir) throw new TypeError("EmbeddingIndex: modelDir is required");

    this.model = model;
    this.model_version = model_version;
    this.dim = dim;
    this.#annSaveEveryBatches = normalizePositiveInt(annSaveEveryBatches, DEFAULT_ANN_SAVE_EVERY_BATCHES);
    this.#annSaveEveryMs = normalizePositiveInt(annSaveEveryMs, DEFAULT_ANN_SAVE_EVERY_MS);

    ensureDir(modelDir);
    cleanupStaleAnnTempFiles(modelDir);
    const { usearchPath, manifestPath, sidecarPath } = pathsFor(modelDir);
    this.#usearchPath = usearchPath;
    this.#manifestPath = manifestPath;
    this.#inflightPath = path.join(modelDir, "inflight.json");
    this.gateKey = `usearch:${usearchPath}`;
    recordEmbeddingForensics("embedding_index.open.start", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      model_dir: modelDir,
      sidecar_path: sidecarPath,
      usearch_path: this.#usearchPath,
      manifest_path: this.#manifestPath,
      ann_save_every_batches: this.#annSaveEveryBatches,
      ann_save_every_ms: this.#annSaveEveryMs,
    });

    this.#db = new Database(sidecarPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db["exec"](SIDECAR_SCHEMA);
    this.#assertMeta();
    this.#lookupByUid = this.#db.prepare(
      "SELECT content_hash, local_id FROM keys WHERE uid = ?",
    );

    this.#usearch = newNativeIndex(this.dim);
    this.#loadTrustedAnnFile();
    recordEmbeddingForensics("embedding_index.open.done", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      model_dir: modelDir,
      vector_count: this.#vectorCount(),
      native_stats: nativeIndexStats(this.#usearch),
    });
  }

  /**
   * @param {{
   *   model: string,
   *   model_version: string,
   *   dim: number,
   *   embeddingsRoot: string,
   *   annSaveEveryBatches?: number,
   *   annSaveEveryMs?: number,
   * }} args
   * @returns {EmbeddingIndex}
   */
  static open({ model, model_version, dim, embeddingsRoot, annSaveEveryBatches, annSaveEveryMs }) {
    const modelDir = path.join(embeddingsRoot, modelDirName({ model, model_version }));
    return new EmbeddingIndex({
      model,
      model_version,
      dim,
      modelDir,
      annSaveEveryBatches,
      annSaveEveryMs,
    });
  }

  #assertMeta() {
    const get = this.#db.prepare("SELECT value FROM meta WHERE key = ?");
    const put = this.#db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const existingModel = /** @type {{ value: string } | undefined} */ (get.get("model"));
    const existingVersion = /** @type {{ value: string } | undefined} */ (get.get("model_version"));
    const existingDim = /** @type {{ value: string } | undefined} */ (get.get("dim"));
    if (existingModel && existingModel.value !== this.model) {
      throw new Error(
        `EmbeddingIndex: sidecar model '${existingModel.value}' != requested '${this.model}'`,
      );
    }
    if (existingVersion && existingVersion.value !== this.model_version) {
      throw new Error(
        `EmbeddingIndex: sidecar model_version '${existingVersion.value}' != requested '${this.model_version}'`,
      );
    }
    if (existingDim && Number(existingDim.value) !== this.dim) {
      throw new Error(
        `EmbeddingIndex: sidecar dim ${existingDim.value} != requested ${this.dim}`,
      );
    }
    put.run("model", this.model);
    put.run("model_version", this.model_version);
    put.run("dim", String(this.dim));
  }

  #loadTrustedAnnFile() {
    const trust = trustedAnnFile({
      usearchPath: this.#usearchPath,
      manifestPath: this.#manifestPath,
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
    });
    recordEmbeddingForensics("embedding_index.ann.trust", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      usearch_path: this.#usearchPath,
      manifest_path: this.#manifestPath,
      trust,
    });
    if (!trust.load) {
      if (trust.quarantine) {
        quarantinePath(this.#usearchPath, trust.reason);
        quarantinePath(this.#manifestPath, trust.reason);
      }
      this.#rebuildAnnFromSidecar(trust.reason);
      return;
    }
    try {
      recordEmbeddingForensics("embedding_index.ann.load.start", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
      });
      this.#usearch.load(this.#usearchPath);
      recordEmbeddingForensics("embedding_index.ann.load.done", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
        native_stats: nativeIndexStats(this.#usearch),
      });
      if (Number.isInteger(trust.vectorCount) && this.#vectorCount() !== /** @type {number} */ (trust.vectorCount)) {
        this.#usearch = newNativeIndex(this.dim);
        this.#rebuildAnnFromSidecar("sidecar_mismatch");
      }
    } catch (err) {
      // A trusted manifest should keep torn writes away from native load().
      // If usearch still rejects the file with a JS exception, quarantine it
      // and let the next ingest rebuild from the sidecar identities.
      recordEmbeddingForensics("embedding_index.ann.load.error", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
        error: errorForTelemetry(err),
      });
      quarantinePath(this.#usearchPath, "load_failed");
      quarantinePath(this.#manifestPath, "load_failed");
      this.#usearch = newNativeIndex(this.dim);
      this.#rebuildAnnFromSidecar("load_failed");
    }
  }

  /**
   * @param {string} _reason
   * @param {{ reset?: boolean, forceSave?: boolean }} [opts]
   */
  #rebuildAnnFromSidecar(_reason, { reset = false, forceSave = false } = {}) {
    if (reset) this.#usearch = newNativeIndex(this.dim);
    const rows = this.#db.prepare(
      "SELECT k.uid AS uid, v.vector AS vector FROM keys k JOIN vectors v ON v.uid = k.uid ORDER BY k.uid",
    ).iterate();
    let rebuilt = 0;
    for (const row of /** @type {Iterable<{ uid: number, vector: Buffer }>} */ (rows)) {
      const vector = vectorFromBlob(row.vector, this.dim);
      if (!vector || !isFiniteVector(vector)) continue;
      try {
        this.#usearch.add(BigInt(row.uid), vector);
        rebuilt++;
      } catch {
        // Keep rebuilding best-effort; a later ingest can repair any bad row.
      }
    }
    if (rebuilt > 0 || forceSave) {
      this.#dirty = true;
      this.#saveBestEffort("sidecar rebuild");
    }
    if (reset || rebuilt > 0 || forceSave) {
      recordAnnRecoveryEvent("ann.rebuilt_from_sidecar", {
        reason: _reason,
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        rebuilt,
        force_save: !!forceSave,
        usearch_path: this.#usearchPath,
      });
    }
  }

  /** @returns {number} */
  #vectorCount() {
    const row = /** @type {{ c: number }} */ (
      this.#db.prepare("SELECT COUNT(*) AS c FROM vectors").get()
    );
    return row.c;
  }

  /** @returns {number | null} */
  #safeVectorCount() {
    try {
      return this.#vectorCount();
    } catch {
      return null;
    }
  }

  /**
   * @param {EmbeddingIngest[]} rows
   * @returns {void}
   */
  add(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const startedAt = performance.now();
    recordEmbeddingForensics("embedding_index.add.start", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      rows: summarizeRows(rows),
      vector_count_before: this.#vectorCount(),
      native_stats_before: nativeIndexStats(this.#usearch),
    });
    const timing = {
      rows: rows.length,
      sqliteMs: 0,
      annAddMs: 0,
      annSaveMs: 0,
      annHashMs: 0,
      annManifestMs: 0,
      totalMs: 0,
      annDeferred: false,
      annDirtyBatches: 0,
    };
    const insertKey = this.#db.prepare(
      "INSERT OR IGNORE INTO keys(content_hash, local_id) VALUES(?, ?) RETURNING uid",
    );
    const findKey = this.#db.prepare(
      "SELECT uid FROM keys WHERE content_hash = ? AND local_id = ?",
    );
    const upsertVector = this.#db.prepare(
      "INSERT INTO vectors(uid, vector) VALUES(?, ?) ON CONFLICT(uid) DO UPDATE SET vector = excluded.vector",
    );
    /** @type {{ uid: bigint, vector: Float32Array }[]} */
    const pendingAnnRows = [];
    /** @type {Set<bigint>} */
    const pendingUids = new Set();
    const txn = this.#db.transaction(() => {
      for (const r of rows) {
        if (!r || typeof r.content_hash !== "string" || !Number.isInteger(r.local_id)) {
          throw new TypeError("EmbeddingIndex.add: each row needs content_hash and integer local_id");
        }
        if (!(r.vector instanceof Float32Array) || r.vector.length !== this.dim) {
          throw new RangeError(
            `EmbeddingIndex.add: vector must be Float32Array of length ${this.dim}; got length ${r.vector?.length}`,
          );
        }
        assertFiniteVector(r.vector, "EmbeddingIndex.add");
        let uid;
        const inserted = /** @type {{ uid: number } | undefined} */ (
          insertKey.get(r.content_hash, r.local_id)
        );
        if (inserted) {
          uid = inserted.uid;
        } else {
          const existing = /** @type {{ uid: number } | undefined} */ (
            findKey.get(r.content_hash, r.local_id)
          );
          if (!existing) {
            throw new Error("EmbeddingIndex.add: failed to obtain uid for row");
          }
          uid = existing.uid;
        }
        const annUid = BigInt(uid);
        upsertVector.run(uid, vectorToBlob(r.vector));
        if (pendingUids.has(annUid) || this.#usearch.contains(annUid)) {
          // Already in the ANN or queued by an earlier duplicate row in this batch.
          continue;
        }
        pendingAnnRows.push({ uid: annUid, vector: r.vector });
        pendingUids.add(annUid);
      }
    });
    const sqliteStartedAt = performance.now();
    try {
      txn();
    } catch (err) {
      recordEmbeddingForensics("embedding_index.add.sqlite_error", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        rows: summarizeRows(rows),
        elapsed_ms: roundMs(elapsedSince(sqliteStartedAt)),
        error: errorForTelemetry(err),
      });
      throw err;
    }
    timing.sqliteMs = elapsedSince(sqliteStartedAt);
    recordEmbeddingForensics("embedding_index.add.sqlite_done", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      rows: rows.length,
      pending_ann_rows: pendingAnnRows.length,
      sqlite_ms: roundMs(timing.sqliteMs),
      vector_count_after_sqlite: this.#vectorCount(),
    });
    // The sidecar is the source of truth and commits before the in-memory ANN
    // is mutated. Saving the native ANN is expensive on large indexes because
    // it writes and hashes the whole file, so add() checkpoints the ANN only
    // periodically. If a run is cut off between checkpoints, the next open
    // sees a stale/missing manifest and rebuilds the ANN from sidecar vectors.
    this.#flushAnnAdds(pendingAnnRows, timing);
    timing.totalMs = elapsedSince(startedAt);
    this.#lastAddTiming = roundTiming(timing);
    recordEmbeddingForensics("embedding_index.add.done", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      rows: summarizeRows(rows),
      timing: this.#lastAddTiming,
      vector_count_after: this.#vectorCount(),
      native_stats_after: nativeIndexStats(this.#usearch),
    });
  }

  /**
   * @returns {Record<string, any> | null}
   */
  getLastAddTiming() {
    return this.#lastAddTiming ? { ...this.#lastAddTiming } : null;
  }

  /**
   * @param {string[]} content_hashes
   * @returns {number}
   */
  removeByContentHash(content_hashes) {
    if (!Array.isArray(content_hashes) || content_hashes.length === 0) return 0;
    const select = this.#db.prepare(
      "SELECT uid FROM keys WHERE content_hash = ?",
    );
    const del = this.#db.prepare("DELETE FROM keys WHERE content_hash = ?");
    const delVector = this.#db.prepare("DELETE FROM vectors WHERE uid = ?");
    let removed = 0;
    /** @type {bigint[]} */
    const pendingAnnRemovals = [];
    const txn = this.#db.transaction(() => {
      for (const ch of content_hashes) {
        if (typeof ch !== "string" || ch.length === 0) continue;
        const rows = /** @type {{ uid: number }[]} */ (select.all(ch));
        for (const row of rows) {
          pendingAnnRemovals.push(BigInt(row.uid));
          delVector.run(row.uid);
          removed++;
        }
        del.run(ch);
      }
    });
    txn();
    // Native usearch 2.25.1 on Windows can save an unreadable ANN after
    // remove()+save(). The SQLite sidecar is authoritative, so rebuild the ANN
    // graph from sidecar vectors instead of mutating/removing in place.
    if (pendingAnnRemovals.length > 0) {
      this.#rebuildAnnFromSidecar("remove_by_content_hash", { reset: true, forceSave: true });
    }
    return removed;
  }

  /**
   * Remove rows that no longer belong to the current view. This is a bounded
   * self-healing sweep for interrupted warms or view rebuilds where old
   * content hashes may not appear in the latest delta set.
   *
   * @param {{ content_hash: string, local_id: number }[]} keys
   * @returns {number}
   */
  pruneToKeys(keys) {
    if (!Array.isArray(keys)) return 0;
    const keep = new Set();
    for (const key of keys) {
      if (!key || typeof key.content_hash !== "string" || !Number.isInteger(key.local_id)) continue;
      keep.add(`${key.content_hash}\0${key.local_id}`);
    }
    const rows = /** @type {Array<{ uid: number, content_hash: string, local_id: number }>} */ (
      this.#db.prepare("SELECT uid, content_hash, local_id FROM keys").all()
    );
    const del = this.#db.prepare("DELETE FROM keys WHERE uid = ?");
    const delVector = this.#db.prepare("DELETE FROM vectors WHERE uid = ?");
    let removed = 0;
    /** @type {bigint[]} */
    const pendingAnnRemovals = [];
    const txn = this.#db.transaction(() => {
      for (const row of rows) {
        if (keep.has(`${row.content_hash}\0${row.local_id}`)) continue;
        pendingAnnRemovals.push(BigInt(row.uid));
        delVector.run(row.uid);
        del.run(row.uid);
        removed++;
      }
    });
    txn();
    if (pendingAnnRemovals.length > 0) {
      this.#rebuildAnnFromSidecar("prune_to_keys", { reset: true, forceSave: true });
    }
    return removed;
  }

  /**
   * @param {{ uid: bigint, vector: Float32Array }[]} rows
   */
  #flushAnnAdds(rows, timing = null) {
    if (rows.length === 0) return;
    let added = 0;
    try {
      const annStartedAt = performance.now();
      recordEmbeddingForensics("embedding_index.ann.add.start", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        rows: rows.length,
        first_uid: rows[0]?.uid?.toString?.() || null,
        last_uid: rows[rows.length - 1]?.uid?.toString?.() || null,
        native_stats_before: nativeIndexStats(this.#usearch),
      });
      for (const row of rows) {
        this.#usearch.add(row.uid, row.vector);
        added++;
        this.#dirty = true;
      }
      if (timing) timing.annAddMs += elapsedSince(annStartedAt);
    } catch (err) {
      recordEmbeddingForensics("embedding_index.ann.add.error", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        rows: rows.length,
        added_before_error: added,
        error: errorForTelemetry(err),
      });
      if (added > 0) this.#saveBestEffort("partial add", timing);
      throw err;
    }
    recordEmbeddingForensics("embedding_index.ann.add.done", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      rows: rows.length,
      added,
      native_stats_after: nativeIndexStats(this.#usearch),
    });
    if (added > 0) this.#annDirtyBatches++;
    this.#checkpointAnnIfNeeded("add checkpoint", timing);
  }

  /**
   * @param {string} context
   * @returns {boolean}
   */
  #saveBestEffort(context, timing = null) {
    try {
      this.save(timing);
      return true;
    } catch (err) {
      logAnnSaveFailure(context, err);
      return false;
    }
  }

  // --- Durable in-flight breadcrumb -----------------------------------------
  // A crash-surviving record of the batch currently being ENCODED (before its
  // atomic keys.db commit). `index.usearch` rebuilds from keys.db, and keys.db
  // writes are per-batch atomic — so the one thing a crash can lose without a
  // trace is the *in-flight* batch. This marker turns that silent gap into a
  // known one: reconciliation reads it to learn an encode was interrupted, and
  // it doubles as the progress signal we lost when the daemon went strict
  // request/response. All ops are best-effort: the breadcrumb is a safety net,
  // never load-bearing, and must never break ingest.

  /**
   * Record the batch entering the encoder. Overwrites the previous marker —
   * batches encode sequentially, so only one is ever in flight per index.
   * @param {Array<{ content_hash: string, local_id: number }>} keys
   * @param {{ branch?: string|null, batch?: number, total?: number }} [meta]
   */
  markEncoding(keys, meta = {}) {
    try {
      const payload = {
        started_at: new Date().toISOString(),
        model: this.model,
        model_version: this.model_version,
        branch: meta.branch ?? null,
        batch: meta.batch ?? null,
        total: meta.total ?? null,
        keys: (Array.isArray(keys) ? keys : [])
          .filter((k) => k && typeof k.content_hash === "string" && Number.isInteger(k.local_id))
          .map((k) => ({ content_hash: k.content_hash, local_id: k.local_id })),
      };
      fs.writeFileSync(this.#inflightPath, JSON.stringify(payload));
    } catch { /* best effort — never block ingest on the breadcrumb */ }
  }

  /** Clear the in-flight marker once the batch has durably committed. */
  clearEncoding() {
    try { fs.rmSync(this.#inflightPath, { force: true }); } catch { /* best effort */ }
  }

  /**
   * Read the in-flight marker, if any. A non-null result means a prior encode
   * was interrupted (process died between markEncoding and clearEncoding) — the
   * listed keys may or may not have committed to keys.db, so reconciliation
   * should re-check them against the store.
   * @returns {{ started_at: string, branch: string|null, batch: number|null, total: number|null, keys: Array<{content_hash:string, local_id:number}> } | null}
   */
  readInflight() {
    try {
      const raw = fs.readFileSync(this.#inflightPath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed && Array.isArray(parsed.keys) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} content_hash
   * @param {number} local_id
   * @returns {boolean}
   */
  contains(content_hash, local_id) {
    if (typeof content_hash !== "string" || content_hash.length === 0 || !Number.isInteger(local_id)) {
      return false;
    }
    const row = /** @type {{ uid: number } | undefined} */ (
      this.#db.prepare("SELECT uid FROM keys WHERE content_hash = ? AND local_id = ?").get(content_hash, local_id)
    );
    if (!row) return false;
    try {
      return this.#usearch.contains(BigInt(row.uid));
    } catch {
      return false;
    }
  }

  /**
   * @param {{ content_hash: string, local_id: number }[]} keys
   * @returns {Set<string>}
   */
  containsMany(keys) {
    const out = new Set();
    if (!Array.isArray(keys) || keys.length === 0) return out;
    const findKey = this.#db.prepare(
      "SELECT uid FROM keys WHERE content_hash = ? AND local_id = ?",
    );
    for (const key of keys) {
      if (!key || typeof key.content_hash !== "string" || key.content_hash.length === 0 || !Number.isInteger(key.local_id)) {
        continue;
      }
      const row = /** @type {{ uid: number } | undefined} */ (
        findKey.get(key.content_hash, key.local_id)
      );
      if (!row) continue;
      try {
        if (this.#usearch.contains(BigInt(row.uid))) {
          out.add(embeddingKey(key));
        }
      } catch {
        // Keep membership observational; a later rebuild can repair the ANN.
      }
    }
    return out;
  }

  /**
   * @param {Float32Array} vector
   * @param {EmbeddingSearchOptions} [opts]
   * @returns {EmbeddingHit[]}
   */
  nearest(vector, opts = {}) {
    if (!(vector instanceof Float32Array) || vector.length !== this.dim) {
      throw new RangeError(
        `EmbeddingIndex.nearest: vector must be Float32Array of length ${this.dim}; got ${vector?.length}`,
      );
    }
    assertFiniteVector(vector, "EmbeddingIndex.nearest");
    const k = Math.max(1, Math.min(Number.isInteger(opts.k) ? /** @type {number} */ (opts.k) : 20, 1000));
    const minScore = typeof opts.minScore === "number"
      ? Math.max(0, Math.min(1, opts.minScore))
      : 0;
    const restrict = opts.restrictToContentHashes;
    // Over-request when filtering so we can drop misses without falling
    // below the requested k.
    const requestK = restrict && restrict.size > 0 ? k * 4 : k;
    const matches = this.#usearch.search(vector, requestK);
    const keys = /** @type {BigUint64Array} */ (matches.keys);
    const distances = /** @type {Float32Array} */ (matches.distances);

    /** @type {EmbeddingHit[]} */
    const out = [];
    for (let i = 0; i < keys.length && out.length < k; i++) {
      const uid = Number(keys[i]);
      const row = /** @type {{ content_hash: string, local_id: number } | undefined} */ (
        this.#lookupByUid.get(uid)
      );
      if (!row) continue;
      if (restrict && restrict.size > 0 && !restrict.has(row.content_hash)) continue;
      const distance = distances[i];
      const score = 1 - distance / 2; // cos distance ∈ [0, 2] maps to score ∈ [1, 0]
      if (!Number.isFinite(score) || score < minScore) continue;
      out.push({
        content_hash: row.content_hash,
        local_id: row.local_id,
        score,
        distance,
      });
    }
    return out;
  }

  /** @returns {number} */
  count() {
    const row = /** @type {{ c: number }} */ (
      this.#db.prepare("SELECT COUNT(*) AS c FROM keys").get()
    );
    return row.c;
  }

  /**
   * Persist the ANN to disk. add() calls this only at checkpoint thresholds;
   * close() also saves if dirty so normal exits keep a warm ANN file.
   *
   * @returns {void}
   */
  save(timing = null) {
    if (!this.#dirty && fs.existsSync(this.#usearchPath)) return;
    ensureDir(path.dirname(this.#usearchPath));
    const tmpPath = uniqueTempPath(this.#usearchPath);
    try {
      const saveStartedAt = performance.now();
      recordEmbeddingForensics("embedding_index.save.start", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
        tmp_path: tmpPath,
        manifest_path: this.#manifestPath,
        vector_count: this.#vectorCount(),
        native_stats: nativeIndexStats(this.#usearch),
      });
      this.#usearch.save(tmpPath);
      if (timing) timing.annSaveMs += elapsedSince(saveStartedAt);
      const stat = fs.statSync(tmpPath);
      const hashStartedAt = performance.now();
      const sha256 = sha256File(tmpPath);
      if (timing) timing.annHashMs += elapsedSince(hashStartedAt);
      const nativeStats = nativeIndexStats(this.#usearch);
      const manifest = {
        version: ANN_MANIFEST_VERSION,
        backend: "usearch",
        index_file: ANN_INDEX_FILE,
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        vector_count: this.#vectorCount(),
        native_size: nativeStats.size,
        native_capacity: nativeStats.capacity,
        native_dimensions: nativeStats.dimensions,
        native_connectivity: nativeStats.connectivity,
        size: stat.size,
        sha256,
        saved_at: new Date().toISOString(),
      };
      recordEmbeddingForensics("embedding_index.save.rename.start", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        tmp_path: tmpPath,
        usearch_path: this.#usearchPath,
        size: stat.size,
        sha256,
      });
      fs.renameSync(tmpPath, this.#usearchPath);
      recordEmbeddingForensics("embedding_index.save.rename.done", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
      });
      const manifestStartedAt = performance.now();
      recordEmbeddingForensics("embedding_index.save.manifest.start", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        manifest_path: this.#manifestPath,
        vector_count: manifest.vector_count,
      });
      writeJsonAtomic(this.#manifestPath, manifest);
      if (timing) timing.annManifestMs += elapsedSince(manifestStartedAt);
      recordEmbeddingForensics("embedding_index.save.done", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
        manifest_path: this.#manifestPath,
        vector_count: manifest.vector_count,
        save_ms: timing ? roundMs(timing.annSaveMs) : null,
        hash_ms: timing ? roundMs(timing.annHashMs) : null,
        manifest_ms: timing ? roundMs(timing.annManifestMs) : null,
      });
      if (timing) {
        timing.annDeferred = false;
        timing.annDirtyBatches = 0;
      }
    } catch (err) {
      recordEmbeddingForensics("embedding_index.save.error", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        usearch_path: this.#usearchPath,
        manifest_path: this.#manifestPath,
        tmp_path: tmpPath,
        error: errorForTelemetry(err),
      });
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      throw err;
    }
    this.#dirty = false;
    this.#annDirtyBatches = 0;
    this.#lastAnnSaveAt = Date.now();
  }

  /** @returns {void} */
  close() {
    recordEmbeddingForensics("embedding_index.close.start", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
      dirty: this.#dirty,
      vector_count: this.#safeVectorCount(),
    });
    try { if (this.#dirty) this.save(); } catch (err) {
      recordEmbeddingForensics("embedding_index.close.save_error", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        error: errorForTelemetry(err),
      });
    }
    try { this.#db.close(); } catch (err) {
      recordEmbeddingForensics("embedding_index.close.db_error", {
        model: this.model,
        model_version: this.model_version,
        dim: this.dim,
        error: errorForTelemetry(err),
      });
    }
    recordEmbeddingForensics("embedding_index.close.done", {
      model: this.model,
      model_version: this.model_version,
      dim: this.dim,
    });
  }

  /**
   * @param {string} context
   * @param {Record<string, any> | null} timing
   * @returns {boolean}
   */
  #checkpointAnnIfNeeded(context, timing = null) {
    if (!this.#dirty) return false;
    const dueByBatch = this.#annDirtyBatches >= this.#annSaveEveryBatches;
    const dueByTime = Date.now() - this.#lastAnnSaveAt >= this.#annSaveEveryMs;
    if (!dueByBatch && !dueByTime) {
      if (timing) {
        timing.annDeferred = true;
        timing.annDirtyBatches = this.#annDirtyBatches;
      }
      return false;
    }
    const saved = this.#saveBestEffort(context, timing);
    if (!saved && timing) {
      timing.annDeferred = true;
      timing.annDirtyBatches = this.#annDirtyBatches;
    }
    return saved;
  }
}

/**
 * Encode arbitrary model IDs into a portable single path component.
 * Remote providers often use names such as `openai:text-embedding-3-small`;
 * colons are not valid in Windows filenames, so keep the original values in
 * sidecar metadata and only encode the directory name.
 *
 * @param {{ model: string, model_version: string }} args
 * @returns {string}
 */
export function modelDirName({ model, model_version }) {
  const encode = (value) => encodeURIComponent(String(value)).replace(/%/g, "~");
  return `${encode(model)}--${encode(model_version)}`;
}

function elapsedSince(startedAt) {
  return Math.max(0, performance.now() - Number(startedAt || performance.now()));
}

function normalizePositiveInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.floor(Number(value));
  return n > 0 ? n : fallback;
}

function embeddingKey(key) {
  return `${key.content_hash}\0${key.local_id}`;
}

function roundTiming(timing = {}) {
  const out = {};
  for (const [key, value] of Object.entries(timing)) {
    out[key] = typeof value === "number" && Number.isFinite(value)
      ? Math.round(value * 10) / 10
      : value;
  }
  return out;
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

/**
 * @param {Float32Array} vector
 * @returns {boolean}
 */
function isFiniteVector(vector) {
  return firstNonFiniteIndex(vector) < 0;
}

/**
 * @param {Float32Array} vector
 * @param {string} context
 * @returns {void}
 */
function assertFiniteVector(vector, context) {
  const index = firstNonFiniteIndex(vector);
  if (index >= 0) {
    throw new RangeError(`${context}: vector contains non-finite value at index ${index}`);
  }
}

/**
 * @param {Float32Array} vector
 * @returns {number}
 */
function firstNonFiniteIndex(vector) {
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) return i;
  }
  return -1;
}

/**
 * @param {Float32Array} vector
 * @returns {Buffer}
 */
function vectorToBlob(vector) {
  const out = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    out.writeFloatLE(vector[i], i * 4);
  }
  return out;
}

/**
 * @param {Buffer | Uint8Array} blob
 * @param {number} dim
 * @returns {Float32Array | null}
 */
function vectorFromBlob(blob, dim) {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (bytes.byteLength !== dim * 4) return null;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = bytes.readFloatLE(i * 4);
  }
  return out;
}

/**
 * @param {{
 *   usearchPath: string,
 *   manifestPath: string,
 *   model: string,
 *   model_version: string,
 *   dim: number,
 * }} args
 * @returns {{ load: boolean, quarantine: boolean, reason: string, vectorCount?: number | null }}
 */
function trustedAnnFile({ usearchPath, manifestPath, model, model_version, dim }) {
  if (!fs.existsSync(usearchPath)) {
    return { load: false, quarantine: fs.existsSync(manifestPath), reason: "missing_ann_file" };
  }
  if (!fs.existsSync(manifestPath)) {
    return { load: false, quarantine: true, reason: "missing_ann_manifest" };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { load: false, quarantine: true, reason: "invalid_ann_manifest" };
  }
  if (manifest?.version !== ANN_MANIFEST_VERSION) {
    return { load: false, quarantine: true, reason: "ann_manifest_version_mismatch" };
  }
  if (manifest?.backend !== "usearch" || manifest?.index_file !== ANN_INDEX_FILE) {
    return { load: false, quarantine: true, reason: "ann_manifest_backend_mismatch" };
  }
  if (manifest?.model !== model || manifest?.model_version !== model_version || Number(manifest?.dim) !== dim) {
    return { load: false, quarantine: true, reason: "ann_manifest_model_mismatch" };
  }
  let stat;
  try {
    stat = fs.statSync(usearchPath);
  } catch {
    return { load: false, quarantine: true, reason: "ann_stat_failed" };
  }
  if (Number(manifest?.size) !== stat.size) {
    return { load: false, quarantine: true, reason: "ann_size_mismatch" };
  }
  if (String(manifest?.sha256 || "") !== sha256File(usearchPath)) {
    return { load: false, quarantine: true, reason: "ann_hash_mismatch" };
  }
  return {
    load: true,
    quarantine: false,
    reason: "trusted",
    vectorCount: Number.isInteger(manifest?.vector_count) ? Number(manifest.vector_count) : null,
  };
}

/**
 * @param {string} filePath
 * @param {string} reason
 */
function quarantinePath(filePath, reason) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const safeReason = String(reason || "untrusted").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "untrusted";
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, "");
  const target = `${filePath}.${safeReason}-${stamp}-${process.pid}`;
  try {
    fs.renameSync(filePath, target);
    recordAnnRecoveryEvent("ann.quarantined", {
      reason: safeReason,
      file_path: filePath,
      quarantine_path: target,
    });
  } catch (err) {
    recordAnnRecoveryEvent("ann.quarantine_failed", {
      reason: safeReason,
      file_path: filePath,
      error: /** @type {any} */ (err)?.message || String(err),
    });
  }
}

/**
 * Sweep ANN byproducts in a model dir on open: interrupted-save `.tmp` files
 * are removed immediately, and quarantine-renamed ANN/manifest files
 * (`index.usearch.{reason}-{stamp}-{pid}`) are GC'd once older than
 * ANN_QUARANTINE_RETENTION_MS so they can't accumulate unboundedly.
 *
 * @param {string} modelDir
 */
function cleanupStaleAnnTempFiles(modelDir) {
  if (!fs.existsSync(modelDir)) return;
  let entries;
  try { entries = fs.readdirSync(modelDir, { withFileTypes: true }); }
  catch { return; }
  const nowMs = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Never touch the live ANN file or its manifest; only their byproducts
    // (`index.usearch.<suffix>` / `index.usearch.json.<suffix>`).
    if (entry.name === ANN_INDEX_FILE || entry.name === ANN_MANIFEST_FILE) continue;
    if (!entry.name.startsWith(`${ANN_INDEX_FILE}.`) && !entry.name.startsWith(`${ANN_MANIFEST_FILE}.`)) continue;
    const filePath = path.join(modelDir, entry.name);
    if (entry.name.endsWith(".tmp")) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
      continue;
    }
    let stat;
    try { stat = fs.statSync(filePath); }
    catch { continue; }
    if (nowMs - Number(stat.mtimeMs) < ANN_QUARANTINE_RETENTION_MS) continue;
    try {
      fs.rmSync(filePath, { force: true });
      recordAnnRecoveryEvent("ann.quarantine_swept", { file_path: filePath });
    } catch { /* ignore */ }
  }
}

/**
 * @param {string} targetPath
 */
function uniqueTempPath(targetPath) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return path.join(dir, `${base}.${nonce}.tmp`);
}

/**
 * @param {string} filePath
 */
function sha256File(filePath) {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * @param {string} targetPath
 * @param {unknown} value
 */
function writeJsonAtomic(targetPath, value) {
  ensureDir(path.dirname(targetPath));
  const tmpPath = uniqueTempPath(targetPath);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}
