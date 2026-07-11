// @ts-check
//
// ATLAS v2 Ledger — append-only file-level delta log + content-addressable
// blob store. Single SQLite file per repo. Implements the `Ledger`
// contract from lib/domains/atlas/functions/v2/contracts/api.js.
//
// Concurrency: better-sqlite3 is synchronous and serializes writes via
// SQLite's file lock. WAL mode lets readers run concurrently with the
// writer. Writers on different branch partitions do not contend
// semantically — they share the file lock but each append is a
// short transaction.

import path from "path";
import Database from "better-sqlite3";
import { isCanonicalRepoPath } from "../../functions/v2/paths.js";
import { isContentHash } from "../../functions/v2/hash.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import { openLedgerDb, openLedgerDbReadOnly } from "../../functions/v2/ledger/schema.js";
import {
  ensureLedgerNativeAsync,
  invalidateStorageCacheNativeAsync,
  writeLedgerNativeAsync,
} from "../../functions/v2/native/storage.js";
import { BlobStore } from "./ledger/BlobStore.js";
import { FeedbackStore } from "./ledger/FeedbackStore.js";
import { Interner } from "./ledger/Interner.js";
import { ScipIndexStore } from "./ledger/ScipIndexStore.js";
import { SourceStatsStore } from "./ledger/SourceStatsStore.js";

/** @typedef {import("../../functions/v2/contracts/schemas.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../../functions/v2/contracts/schemas.js").LedgerOp} LedgerOp */
/** @typedef {import("../../functions/v2/contracts/schemas.js").BranchRecord} BranchRecord */
/** @typedef {import("../../functions/v2/contracts/schemas.js").BranchStatus} BranchStatus */
/** @typedef {import("../../functions/v2/contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../functions/v2/contracts/schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("../../functions/v2/contracts/api.js").LedgerAppendInput} LedgerAppendInput */
/** @typedef {import("../../functions/v2/contracts/api.js").BlobIngest} BlobIngest */
/** @typedef {import("../../functions/v2/contracts/api.js").Ledger} LedgerContract */
/** @typedef {import("../../functions/v2/contracts/api.js").FeedbackRecordInput} FeedbackRecordInput */
/** @typedef {import("../../functions/v2/contracts/api.js").FeedbackQueryOptions} FeedbackQueryOptions */
/** @typedef {import("../../functions/v2/contracts/api.js").FeedbackAggregate} FeedbackAggregate */

const MAIN_BRANCH = "main";

/** @implements {LedgerContract} */
export class Ledger {
  /** @type {Database.Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {Record<string, Database.Statement>} */
  #stmt;
  /** @type {FeedbackStore} */
  #feedback;
  /** @type {Interner} */
  #interner;
  /** @type {ScipIndexStore} */
  #scipIndex;
  /** @type {SourceStatsStore} */
  #sourceStats;
  /** @type {BlobStore} */
  #blob;

  /**
   * Constructing directly requires an already-ensured (schema-current)
   * ledger file: use {@link Ledger.open}, which ensures through the
   * persistent native worker first. The constructor itself never spawns a
   * native process.
   *
   * @param {{ dbPath: string, mode?: "readwrite" | "readonly" }} args
   */
  constructor({ dbPath, mode = "readwrite" }) {
    if (!dbPath) throw new Error("Ledger: dbPath is required");
    this.#dbPath = path.resolve(dbPath);
    const readOnly = mode === "readonly";
    this.#db = readOnly ? openLedgerDbReadOnly(this.#dbPath) : openLedgerDb(this.#dbPath);
    // Any bootstrap throw after the open (schema-version mismatch, stale
    // read-only format, migration race) must close the connection: a leaked
    // handle blocks the very removeSqliteFile reset that would repair the
    // mismatch on Windows — a self-sustaining failure loop until restart.
    try {
      this.#bootstrap(readOnly);
    } catch (err) {
      try { this.#db.close(); } catch { /* preserve the bootstrap error */ }
      throw err;
    }
  }

  /**
   * @param {boolean} readOnly
   */
  #bootstrap(readOnly) {
    this.#stmt = this.#prepareAll();
    this.#interner = new Interner(this.#db);
    this.#scipIndex = new ScipIndexStore(this.#db, this.#interner);
    this.#sourceStats = new SourceStatsStore(this.#db, this.#dbPath, this.#interner);
    this.#blob = new BlobStore(this.#db, this.#dbPath, this.#interner);
    this.#feedback = new FeedbackStore(this.#db, this.#dbPath);
  }

  /**
   * THE readwrite entry point. Ensures the ledger schema through the
   * persistent native worker (creating or migrating the file when needed),
   * then opens the in-process read connection.
   *
   * @param {{ dbPath: string }} args
   * @returns {Promise<Ledger>}
   */
  static async open(args) {
    if (!args?.dbPath) throw new Error("Ledger.open: dbPath is required");
    await ensureLedgerNativeAsync(path.resolve(args.dbPath));
    return new Ledger(args);
  }

  /**
   * Open an existing ledger without running DDL or metadata bootstrapping.
   * Retrieval hot paths should use this so read-only ATLAS calls never take a
   * writer lock or checkpoint the WAL while the scheduler is waiting.
   *
   * @param {{ dbPath: string }} args
   * @returns {Ledger}
   */
  static openReadOnly(args) {
    return new Ledger({ ...args, mode: "readonly" });
  }

  #prepareAll() {
    const db = this.#db;
    return {
      // branches
      branchSelect: db.prepare("SELECT * FROM branches WHERE name = ?"),
      // ledger reads
      headSeqByBranch: db.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM symbol_deltas WHERE branch = ?",
      ),
      // hydrated via JOIN on interned_paths
      tail: db.prepare(
        `SELECT d.seq, d.branch, d.ts, d.op, p.path AS repo_rel_path,
                d.before_content_hash, d.after_content_hash, d.parent_seq
         FROM symbol_deltas d
         JOIN interned_paths p ON p.id = d.path_id
         WHERE d.branch = ? AND d.seq > ?
         ORDER BY d.seq ASC
         LIMIT ?`,
      ),
      tailBounded: db.prepare(
        `SELECT d.seq, d.branch, d.ts, d.op, p.path AS repo_rel_path,
                d.before_content_hash, d.after_content_hash, d.parent_seq
         FROM symbol_deltas d
         JOIN interned_paths p ON p.id = d.path_id
         WHERE d.branch = ? AND d.seq > ? AND d.seq <= ?
         ORDER BY d.seq ASC
         LIMIT ?`,
      ),

      lastDeltaPerPathBounded: db.prepare(
        `SELECT p.path AS repo_rel_path,
                d.op,
                d.before_content_hash,
                d.after_content_hash,
                d.seq
         FROM symbol_deltas d
         JOIN interned_paths p ON p.id = d.path_id
         WHERE d.branch = ? AND d.seq <= ?
           AND d.seq = (
             SELECT MAX(seq) FROM symbol_deltas
             WHERE branch = d.branch AND path_id = d.path_id AND seq <= ?
           )`,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * One ordered ledger write through the persistent native worker. The
   * per-thread SQLite gate keeps Node-side writers (source stats, feedback)
   * from racing this path within the thread; cross-process ordering is
   * SQLite's WAL + the worker's serial request loop. `idempotent: false` is
   * set at the storage boundary so a worker host lost mid-write reports
   * instead of retrying a possibly-committed write.
   *
   * @param {string} operation
   * @param {unknown} request
   * @param {string} label
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<any>}
   */
  #write(operation, request, label, opts = {}) {
    return runSqliteWrite(
      this.#dbPath,
      () => writeLedgerNativeAsync(this.#dbPath, operation, request),
      { label: opts.label || label, waitMs: opts.waitMs },
    );
  }

  /**
   * @param {LedgerAppendInput} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<LedgerEntry>}
   */
  async append(input, opts = {}) {
    if (!input || typeof input !== "object") {
      throw new TypeError("Ledger.append: input is required");
    }
    const { branch, op, repo_rel_path, before_content_hash, after_content_hash } = input;
    if (!branch || typeof branch !== "string") {
      throw new TypeError("Ledger.append: branch is required");
    }
    if (op !== "add" && op !== "remove" && op !== "modify") {
      throw new RangeError(`Ledger.append: invalid op '${op}'`);
    }
    if (!isCanonicalRepoPath(repo_rel_path)) {
      throw new RangeError(
        `Ledger.append: repo_rel_path must be canonical; got '${repo_rel_path}'`,
      );
    }

    const beforeOk = before_content_hash === null || isContentHash(before_content_hash);
    const afterOk = after_content_hash === null || isContentHash(after_content_hash);
    if (!beforeOk || !afterOk) {
      throw new RangeError("Ledger.append: content hashes must be null or SHA-256 hex");
    }

    if (op === "add" && (before_content_hash !== null || after_content_hash === null)) {
      throw new RangeError("Ledger.append: op='add' requires before=null and after non-null");
    }
    if (op === "remove" && (before_content_hash === null || after_content_hash !== null)) {
      throw new RangeError("Ledger.append: op='remove' requires before non-null and after=null");
    }
    if (op === "modify" && (before_content_hash === null || after_content_hash === null)) {
      throw new RangeError("Ledger.append: op='modify' requires both hashes non-null");
    }

    const result = await this.#write("append", input, "Ledger.append", opts);
    return /** @type {LedgerEntry} */ (result?.value);
  }

  /**
   * Write one parse layer for a content blob. This is the new A/B storage
   * surface: source='treesitter' and source='scip' identities can coexist for
   * the same content_hash without overwriting each other.
   *
   * @param {BlobIngest & {
   *   source?: "treesitter" | "scip",
   *   tool_version?: string,
   *   parser_spec_version?: string,
   *   config_hash?: string,
   *   deps_hash?: string,
   *   fileset_hash?: string,
   *   indexed_at?: string,
   *   status?: "indexed" | "failed" | "stale",
   * }} layer
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ layer_id: number, source: "treesitter" | "scip", symbols: number, edges: number }>}
   */
  async ingestBlobLayer(layer, opts = {}) {
    const result = await this.#write("ingest_blob_layer", layer, "Ledger.ingestBlobLayer", opts);
    return result?.value;
  }

  /**
   * Idempotent. If the blob already exists, returns without re-inserting.
   *
   * @param {BlobIngest} blob
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  async ingestBlob(blob, opts = {}) {
    await this.#write("ingest_blob", blob, "Ledger.ingestBlob", opts);
  }

  /**
   * Merge parser rows into an already-known blob without discarding rows from
   * another backend. This is intentionally narrower than `ingestBlob`: it keeps
   * SCIP compiler edges while adding tree-sitter declarations that a SCIP
   * indexer may omit, such as procedural PHP functions.
   *
   * @param {BlobIngest} blob
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ inserted_symbols: number, mapped_symbols: number, inserted_edges: number, skipped_edges: number }>}
   */
  async mergeBlobParseRows(blob, opts = {}) {
    const result = await this.#write("merge_blob_parse_rows", blob, "Ledger.mergeBlobParseRows", opts);
    return result?.value;
  }

  /**
   * @param {string} content_hash
   * @returns {ReturnType<BlobStore["listBlobLayers"]>}
   */
  listBlobLayers(content_hash) {
    return this.#blob.listBlobLayers(content_hash);
  }

  /**
   * @param {number} layerId
   * @returns {{ symbols: any[], edges: any[] }}
   */
  blobLayerRows(layerId) {
    return this.#blob.blobLayerRows(layerId);
  }

  /**
   * @param {string} content_hash
   * @returns {boolean}
   */
  hasBlob(content_hash) {
    return this.#blob.hasBlob(content_hash);
  }

  /**
   * @param {string} content_hash
   * @returns {boolean}
   */
  hasCurrentParsedBlob(content_hash) {
    return this.#blob.hasCurrentParsedBlob(content_hash);
  }

  /**
   * @param {string} content_hash
   * @returns {boolean}
   */
  hasCurrentTreeSitterLayer(content_hash) {
    return this.#blob.hasCurrentTreeSitterLayer(content_hash);
  }

  /**
   * @param {string} branch
   * @param {number} fromSeq
   * @param {{ limit?: number, upToSeq?: number } | number} [options]
   *   Either a numeric limit (legacy form) or an options object.
   * @returns {LedgerEntry[]}
   */
  tail(branch, fromSeq, options) {
    const opts = typeof options === "number" ? { limit: options } : options || {};
    const limit =
      typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : Number.MAX_SAFE_INTEGER;
    const upToSeq = typeof opts.upToSeq === "number" ? opts.upToSeq : null;
    /** @type {any[]} */
    let rows;
    if (upToSeq !== null) {
      rows = this.#stmt.tailBounded.all(branch, fromSeq, upToSeq, limit);
    } else {
      rows = this.#stmt.tail.all(branch, fromSeq, limit);
    }
    return rows.map(this.#hydrateLedgerEntry);
  }

  /**
   * @param {string} branch
   * @returns {number}
   */
  headSeq(branch) {
    const row = /** @type {{ s: number }} */ (this.#stmt.headSeqByBranch.get(branch));
    return row?.s || 0;
  }

  /**
   * @param {string} name
   * @param {string} parentBranch
   * @param {number} atSeq
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<BranchRecord>}
   */
  async forkBranch(name, parentBranch, atSeq, opts = {}) {
    if (!name || typeof name !== "string") {
      throw new TypeError("Ledger.forkBranch: name is required");
    }
    if (name === MAIN_BRANCH) {
      throw new Error("Ledger.forkBranch: cannot fork onto 'main' (it is the root)");
    }
    if (!parentBranch || typeof parentBranch !== "string") {
      throw new TypeError("Ledger.forkBranch: parentBranch is required");
    }
    if (!Number.isInteger(atSeq) || atSeq < 0) {
      throw new RangeError("Ledger.forkBranch: atSeq must be a non-negative integer");
    }
    if (this.getBranch(name)) {
      throw new Error(`Ledger.forkBranch: branch '${name}' already exists`);
    }
    const parent = this.getBranch(parentBranch);
    if (!parent) throw new Error(`Ledger.forkBranch: unknown parent '${parentBranch}'`);
    const parentHead = this.headSeq(parentBranch);
    if (atSeq > parentHead) {
      throw new RangeError(
        `Ledger.forkBranch: atSeq ${atSeq} exceeds parent head ${parentHead}`,
      );
    }
    const result = await this.#write("fork_branch", {
      name,
      parent_branch: parentBranch,
      at_seq: atSeq,
    }, "Ledger.forkBranch", opts);
    return /** @type {BranchRecord} */ (result?.value);
  }

  /**
   * @param {string} name
   * @returns {BranchRecord | null}
   */
  getBranch(name) {
    const row = /** @type {any} */ (this.#stmt.branchSelect.get(name));
    if (!row) return null;
    return {
      name: row.name,
      parent_branch: row.parent_branch ?? null,
      parent_seq: row.parent_seq ?? null,
      created_at: row.created_at,
      status: /** @type {BranchStatus} */ (row.status),
    };
  }

  /**
   * Ensure a root branch exists. Intended for projects whose configured git
   * target branch is not literally named "main" (for example "master").
   *
   * @param {string} name
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<BranchRecord>}
   */
  async ensureRootBranch(name, opts = {}) {
    const branch = String(name || "").trim();
    if (!branch) throw new TypeError("Ledger.ensureRootBranch: name is required");
    const result = await this.#write("ensure_root_branch", { name: branch }, "Ledger.ensureRootBranch", opts);
    return /** @type {BranchRecord} */ (result?.value);
  }

  /**
   * @param {string} name
   * @param {"merged" | "abandoned"} status
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  async setBranchStatus(name, status, opts = {}) {
    if (status !== "merged" && status !== "abandoned") {
      throw new RangeError(`Ledger.setBranchStatus: invalid status '${status}'`);
    }
    await this.#write("set_branch_status", { name, status }, "Ledger.setBranchStatus", opts);
  }

  /**
   * Replay source branch's deltas after fromSeq onto the destination
   * branch. Each replayed delta gets a fresh seq on the destination.
   * Used at merge-to-main time.
   *
   * Conflict detection: each entry's `before_content_hash` is checked
   * against the destination branch's CURRENT head-of-path. If they
   * diverge (another branch modified the same path on dest first), the
   * whole replay aborts inside the transaction with a clear error.
   * Otherwise merge-to-main can silently produce a fake history.
   *
   * @param {string} branch
   * @param {string} ontoBranch
   * @param {number} fromSeq
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<LedgerEntry[]>}
   */
  async replayPartition(branch, ontoBranch, fromSeq, opts = {}) {
    const result = await this.#write("replay_partition", {
      branch,
      onto_branch: ontoBranch,
      from_seq: fromSeq,
    }, "Ledger.replayPartition", opts);
    return /** @type {LedgerEntry[]} */ (result?.value || []);
  }

  /**
   * Return all symbols belonging to a blob. Rows are hydrated to the
   * SymbolRow shape (matching the in-memory parser output). Empty when
   * the blob is unknown.
   *
   * @param {string} content_hash
   * @returns {SymbolRow[]}
   */
  getBlobSymbols(content_hash) {
    return this.#blob.getBlobSymbols(content_hash);
  }

  /**
   * Build a path → content_hash snapshot for `branch` at or before
   * `atSeq`, walking branch lineage so a forked branch inherits its
   * parent's tree minus paths it has since overridden.
   *
   * Paths removed by the latest seen delta are NOT included in the map.
   *
   * @param {string} branch
   * @param {number} atSeq
   * @returns {Map<string, string>}
   */
  pathSnapshotAt(branch, atSeq) {
    /** @type {Map<string, string>} */
    const map = new Map();
    /** @type {{ name: string, atSeq: number }[]} */
    const chain = [];
    let cur = this.getBranch(branch);
    let cap = atSeq;
    while (cur) {
      chain.push({ name: cur.name, atSeq: cap });
      if (!cur.parent_branch) break;
      const next = this.getBranch(cur.parent_branch);
      if (!next) break;
      cap = cur.parent_seq != null ? cur.parent_seq : 0;
      cur = next;
    }
    // Walk root-most first so child branches override parent entries.
    for (let i = chain.length - 1; i >= 0; i--) {
      const { name, atSeq: bound } = chain[i];
      const rows = /** @type {any[]} */ (
        this.#stmt.lastDeltaPerPathBounded.all(name, bound, bound)
      );
      for (const r of rows) {
        if (r.op === "remove" || r.after_content_hash == null) {
          map.delete(r.repo_rel_path);
        } else {
          map.set(r.repo_rel_path, r.after_content_hash);
        }
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Source-file stats (delegated to SourceStatsStore)
  // ---------------------------------------------------------------------------

  /**
   * @param {string} branch
   * @returns {ReturnType<SourceStatsStore["sourceStatsForBranch"]>}
   */
  sourceStatsForBranch(branch) {
    return this.#sourceStats.sourceStatsForBranch(branch);
  }

  /** @param {Parameters<SourceStatsStore["recordSourceStat"]>[0]} input */
  recordSourceStat(input) {
    return this.#sourceStats.recordSourceStat(input);
  }

  /** @param {Parameters<SourceStatsStore["recordSourceStats"]>[0]} rows */
  recordSourceStats(rows) {
    return this.#sourceStats.recordSourceStats(rows);
  }

  /**
   * @param {Parameters<SourceStatsStore["recordSourceStat"]>[0]} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  recordSourceStatAsync(input, opts = {}) {
    return this.#sourceStats.recordSourceStatAsync(input, opts);
  }

  /**
   * @param {Parameters<SourceStatsStore["recordSourceStats"]>[0]} rows
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  recordSourceStatsAsync(rows, opts = {}) {
    return this.#sourceStats.recordSourceStatsAsync(rows, opts);
  }

  /** @param {Parameters<SourceStatsStore["deleteSourceStat"]>[0]} input */
  deleteSourceStat(input) {
    return this.#sourceStats.deleteSourceStat(input);
  }

  /**
   * @param {Parameters<SourceStatsStore["deleteSourceStat"]>[0]} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  deleteSourceStatAsync(input, opts = {}) {
    return this.#sourceStats.deleteSourceStatAsync(input, opts);
  }

  // ---------------------------------------------------------------------------
  // Feedback signals (delegated to FeedbackStore)
  // ---------------------------------------------------------------------------

  /**
   * @param {FeedbackRecordInput} input
   * @returns {number}
   */
  recordFeedback(input) {
    return this.#feedback.recordFeedback(input);
  }

  /**
   * @param {FeedbackRecordInput} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<number>}
   */
  recordFeedbackAsync(input, opts = {}) {
    return this.#feedback.recordFeedbackAsync(input, opts);
  }

  /**
   * @param {FeedbackQueryOptions} [opts]
   * @returns {FeedbackAggregate[]}
   */
  recentFeedback(opts) {
    return this.#feedback.recentFeedback(opts);
  }

  // ---------------------------------------------------------------------------
  // External symbols + SCIP index bookkeeping (delegated to ScipIndexStore)
  // ---------------------------------------------------------------------------

  /**
   * @param {Parameters<ScipIndexStore["upsertExternalSymbol"]>[0]} input
   * @returns {number}
   */
  upsertExternalSymbol(input) {
    return this.#scipIndex.upsertExternalSymbol(input);
  }

  /**
   * @param {Parameters<ScipIndexStore["recordScipIndex"]>[0]} input
   * @returns {number | null}
   */
  recordScipIndex(input) {
    return this.#scipIndex.recordScipIndex(input);
  }

  /**
   * @param {Parameters<ScipIndexStore["findScipIndexId"]>[0]} input
   * @returns {number | null}
   */
  findScipIndexId(input) {
    return this.#scipIndex.findScipIndexId(input);
  }

  /**
   * @param {Parameters<ScipIndexStore["findScipIndexByBytesHash"]>[0]} input
   * @returns {ReturnType<ScipIndexStore["findScipIndexByBytesHash"]>}
   */
  findScipIndexByBytesHash(input) {
    return this.#scipIndex.findScipIndexByBytesHash(input);
  }

  /**
   * @param {Parameters<ScipIndexStore["updateScipIndexBytesHash"]>[0]} id
   * @param {Parameters<ScipIndexStore["updateScipIndexBytesHash"]>[1]} [fields]
   */
  updateScipIndexBytesHash(id, fields) {
    this.#scipIndex.updateScipIndexBytesHash(id, fields);
  }

  /**
   * @returns {ReturnType<ScipIndexStore["listScipIndexes"]>}
   */
  listScipIndexes() {
    return this.#scipIndex.listScipIndexes();
  }

  // ---------------------------------------------------------------------------
  // Blob reingest (opt-in backend swap)
  // ---------------------------------------------------------------------------

  /**
   * Discard every parsed-symbol / edge row tied to `content_hash`, inside a
   * single transaction. The blob row remains because symbol_deltas points at
   * blobs(content_hash); `ingestBlob` can refill parse rows for a blob whose
   * parsed rows were cleared.
   *
   * Opt-in only — used by `posse atlas-v2 scip reparse` so operators can
   * migrate an existing tree-sitter-only ledger to SCIP, and by the
   * main-merge warmer when staged SCIP must refresh blobs that just landed on
   * the default branch.
   *
   * @param {{ content_hash: string }} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ removed_symbols: number, removed_edges: number, removed_blob: number }>}
   */
  async reingestBlobWithBackend(input, opts = {}) {
    const result = await this.#write("reingest_blob", input, "Ledger.reingestBlob", opts);
    return result?.value;
  }

  /** @returns {void} */
  close() {
    this.#db.close();
  }

  /** Close the local reader and the resident Rust writer handle. */
  async closeNative() {
    this.close();
    await invalidateStorageCacheNativeAsync(this.#dbPath);
  }

  // ---------------------------------------------------------------------------
  // Internals — exposed for in-process ViewBuilder
  // ---------------------------------------------------------------------------

  /**
   * Direct DB handle for in-package consumers (notably ViewBuilder, which
   * needs read-only joins across blob_symbols / blob_edges that the
   * public API doesn't surface). External callers must use the public API.
   *
   * @returns {Database.Database}
   */
  _unsafeDb() {
    return this.#db;
  }

  /** @returns {string} */
  _dbPath() {
    return this.#dbPath;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** @param {any} row */
  #hydrateLedgerEntry = (row) => {
    return /** @type {LedgerEntry} */ ({
      seq: row.seq,
      branch: row.branch,
      ts: row.ts,
      op: row.op,
      repo_rel_path: row.repo_rel_path,
      before_content_hash: row.before_content_hash ?? null,
      after_content_hash: row.after_content_hash ?? null,
      parent_seq: row.parent_seq ?? null,
    });
  };
}
