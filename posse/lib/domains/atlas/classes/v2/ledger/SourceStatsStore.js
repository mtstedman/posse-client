// @ts-check
//
// ATLAS v2 Ledger — source-file stats store. Owns `path_source_stats`: the
// last-observed size/mtime/content-hash per (branch, path), used as a
// boot-time prefilter so the warmer can skip hashing files whose stats are
// unchanged. Extracted from the Ledger monolith; the wireframe constructs one
// (sharing the connection + Interner) and delegates. Error messages keep the
// `Ledger.` prefix so the public contract is unchanged.

import { runSqliteWrite } from "../../../../../shared/concurrency/functions/sqlite-gate.js";
import { tableExists } from "../../../functions/v2/ledger/schema.js";
import { isCanonicalRepoPath } from "../../../functions/v2/paths.js";
import { isContentHash } from "../../../functions/v2/hash.js";

export class SourceStatsStore {
  /** @type {import("better-sqlite3").Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {import("./Interner.js").Interner} */
  #interner;
  /** @type {Record<string, import("better-sqlite3").Statement | null>} */
  #stmt;

  /**
   * @param {import("better-sqlite3").Database} db
   * @param {string} dbPath
   * @param {import("./Interner.js").Interner} interner
   */
  constructor(db, dbPath, interner) {
    this.#db = db;
    this.#dbPath = dbPath;
    this.#interner = interner;
    // path_source_stats predates some ledgers; guard so older DBs that haven't
    // been migrated yet degrade to "no prefilter" rather than throwing.
    const hasPathSourceStats = tableExists(db, "path_source_stats");
    this.#stmt = {
      sourceStatsByBranch: hasPathSourceStats
        ? db.prepare(
            `SELECT s.branch, p.path AS repo_rel_path, s.content_hash,
                    s.size_bytes, s.mtime_epoch_ms, s.indexed_at_epoch_ms
             FROM path_source_stats s
             JOIN interned_paths p ON p.id = s.path_id
             WHERE s.branch = ?
             ORDER BY p.path ASC`,
          )
        : null,
      sourceStatsUpsert: hasPathSourceStats
        ? db.prepare(
            `INSERT INTO path_source_stats
               (branch, path_id, content_hash, size_bytes, mtime_epoch_ms, indexed_at_epoch_ms)
             VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(branch, path_id) DO UPDATE SET
               content_hash = excluded.content_hash,
               size_bytes = excluded.size_bytes,
               mtime_epoch_ms = excluded.mtime_epoch_ms,
               indexed_at_epoch_ms = excluded.indexed_at_epoch_ms`,
          )
        : null,
      sourceStatsDelete: hasPathSourceStats
        ? db.prepare("DELETE FROM path_source_stats WHERE branch = ? AND path_id = ?")
        : null,
    };
  }

  /**
   * Source file stats observed when a branch/path was last proven to match a
   * content hash. Used as a boot-time prefilter before hashing source files.
   *
   * @param {string} branch
   * @returns {Map<string, { content_hash: string, size_bytes: number, mtime_epoch_ms: number, indexed_at_epoch_ms: number }>}
   */
  sourceStatsForBranch(branch) {
    /** @type {Map<string, { content_hash: string, size_bytes: number, mtime_epoch_ms: number, indexed_at_epoch_ms: number }>} */
    const out = new Map();
    const stmt = this.#stmt.sourceStatsByBranch;
    if (!stmt || !branch) return out;
    const rows = /** @type {Array<Record<string, any>>} */ (stmt.all(branch));
    for (const row of rows) {
      const repoRelPath = String(row.repo_rel_path || "");
      if (!repoRelPath) continue;
      out.set(repoRelPath, {
        content_hash: String(row.content_hash || ""),
        size_bytes: Number(row.size_bytes || 0),
        mtime_epoch_ms: Number(row.mtime_epoch_ms || 0),
        indexed_at_epoch_ms: Number(row.indexed_at_epoch_ms || 0),
      });
    }
    return out;
  }

  /**
   * @param {{ branch: string, repo_rel_path: string, content_hash: string, size_bytes: number, mtime_epoch_ms: number, indexed_at_epoch_ms?: number }} input
   */
  recordSourceStat(input) {
    const stmt = this.#stmt.sourceStatsUpsert;
    if (!stmt) return;
    const branch = String(input?.branch || "").trim();
    const repoRelPath = String(input?.repo_rel_path || "").trim();
    const contentHash = String(input?.content_hash || "").trim();
    const sizeBytes = Number(input?.size_bytes);
    const mtimeEpochMs = Number(input?.mtime_epoch_ms);
    const indexedAtEpochMs = Number(input?.indexed_at_epoch_ms ?? Date.now());
    if (!branch) throw new TypeError("Ledger.recordSourceStat: branch is required");
    if (!isCanonicalRepoPath(repoRelPath)) {
      throw new RangeError(`Ledger.recordSourceStat: repo_rel_path must be canonical; got '${repoRelPath}'`);
    }
    if (!isContentHash(contentHash)) {
      throw new RangeError("Ledger.recordSourceStat: content_hash must be SHA-256 hex");
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
      throw new RangeError("Ledger.recordSourceStat: size_bytes must be a non-negative integer");
    }
    if (!Number.isInteger(mtimeEpochMs) || mtimeEpochMs < 0) {
      throw new RangeError("Ledger.recordSourceStat: mtime_epoch_ms must be a non-negative integer");
    }
    const pathId = this.#interner.internPath(repoRelPath);
    stmt.run(branch, pathId, contentHash, sizeBytes, mtimeEpochMs, indexedAtEpochMs);
  }

  /**
   * @param {Array<Parameters<SourceStatsStore["recordSourceStat"]>[0]>} rows
   */
  recordSourceStats(rows) {
    if (!Array.isArray(rows) || rows.length === 0 || !this.#stmt.sourceStatsUpsert) return;
    const txn = this.#db.transaction((items) => {
      for (const item of items) this.recordSourceStat(item);
    });
    txn(rows);
  }

  /**
   * @param {Parameters<SourceStatsStore["recordSourceStat"]>[0]} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  async recordSourceStatAsync(input, opts = {}) {
    await runSqliteWrite(this.#dbPath, () => this.recordSourceStat(input), {
      label: opts.label || "Ledger.recordSourceStat",
      waitMs: opts.waitMs,
    });
  }

  /**
   * @param {Parameters<SourceStatsStore["recordSourceStats"]>[0]} rows
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  async recordSourceStatsAsync(rows, opts = {}) {
    await runSqliteWrite(this.#dbPath, () => this.recordSourceStats(rows), {
      label: opts.label || "Ledger.recordSourceStats",
      waitMs: opts.waitMs,
    });
  }

  /**
   * @param {{ branch: string, repo_rel_path: string }} input
   */
  deleteSourceStat(input) {
    const stmt = this.#stmt.sourceStatsDelete;
    if (!stmt) return;
    const branch = String(input?.branch || "").trim();
    const repoRelPath = String(input?.repo_rel_path || "").trim();
    if (!branch || !isCanonicalRepoPath(repoRelPath)) return;
    const pathId = this.#interner.pathId(repoRelPath);
    if (pathId == null) return;
    stmt.run(branch, pathId);
  }

  /**
   * @param {Parameters<SourceStatsStore["deleteSourceStat"]>[0]} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  async deleteSourceStatAsync(input, opts = {}) {
    await runSqliteWrite(this.#dbPath, () => this.deleteSourceStat(input), {
      label: opts.label || "Ledger.deleteSourceStat",
      waitMs: opts.waitMs,
    });
  }
}
