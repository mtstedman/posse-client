// @ts-check

import Database from "better-sqlite3";
import { USAGE_DDL, USAGE_SCHEMA_VERSION } from "../../functions/v2/contracts/ddl/index.js";
import { usageDbPathFor } from "../../functions/v2/runtime-paths.js";

const DEFAULT_MAX_HANDLES = 8;

/** Sole-writer owner for the dedicated Atlas usage stores in this process. */
export class UsageStoreWriter {
  /** @type {Map<string, { db: any, insert: any }>} */
  #handles = new Map();
  #maxHandles;
  #inserted = 0;
  #malformed = 0;
  #failed = 0;
  #batches = 0;
  #lastError = null;

  constructor({ maxHandles = DEFAULT_MAX_HANDLES } = {}) {
    this.#maxHandles = Math.max(1, Number(maxHandles) || DEFAULT_MAX_HANDLES);
  }

  /**
   * @param {unknown[]} entries
   * @returns {{ inserted: number, malformed: number, failed: number, stores: number, lastError: string | null }}
   */
  record(entries) {
    const groups = new Map();
    let malformed = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const normalized = normalizeEntry(entry);
      if (!normalized) {
        malformed++;
        continue;
      }
      const dbPath = usageDbPathFor(normalized.ledgerPath);
      if (!dbPath) {
        malformed++;
        continue;
      }
      const rows = groups.get(dbPath) || [];
      rows.push(normalized.row);
      groups.set(dbPath, rows);
    }

    let inserted = 0;
    let failed = 0;
    for (const [dbPath, rows] of groups) {
      try {
        const handle = this.#handle(dbPath);
        const transaction = handle.db.transaction((batch) => {
          for (const row of batch) {
            handle.insert.run(
              row.ts,
              row.repoId,
              row.action,
              row.ok,
              row.durationMs,
              row.resultBytes,
              row.versionId,
              row.taskType,
              row.errorCode,
            );
          }
        });
        transaction(rows);
        inserted += rows.length;
      } catch (err) {
        failed += rows.length;
        this.#lastError = `${dbPath}: ${String(/** @type {any} */ (err)?.message || err)}`;
      }
    }

    this.#batches++;
    this.#inserted += inserted;
    this.#malformed += malformed;
    this.#failed += failed;
    return { inserted, malformed, failed, stores: groups.size, lastError: this.#lastError };
  }

  info() {
    return {
      openStores: [...this.#handles.keys()],
      batches: this.#batches,
      inserted: this.#inserted,
      malformed: this.#malformed,
      failed: this.#failed,
      lastError: this.#lastError,
    };
  }

  close() {
    for (const { db } of this.#handles.values()) {
      try { db.close(); } catch { /* best effort */ }
    }
    this.#handles.clear();
  }

  #handle(dbPath) {
    let handle = this.#handles.get(dbPath);
    if (handle) {
      this.#handles.delete(dbPath);
      this.#handles.set(dbPath, handle);
      return handle;
    }

    const db = new Database(dbPath);
    try {
      db.pragma("busy_timeout = 5000");
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(USAGE_DDL);
      const schemaVersion = Number(db.prepare(
        "SELECT value FROM usage_meta WHERE key = 'schema_version'",
      ).pluck().get());
      if (schemaVersion !== USAGE_SCHEMA_VERSION) {
        throw new Error(`unsupported Atlas usage schema version ${schemaVersion}`);
      }
      handle = {
        db,
        insert: db.prepare(
          `INSERT INTO usage_events
             (ts, repo_id, action, ok, duration_ms, result_bytes, version_id, task_type, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
      };
    } catch (err) {
      try { db.close(); } catch { /* best effort */ }
      throw err;
    }

    this.#handles.set(dbPath, handle);
    while (this.#handles.size > this.#maxHandles) {
      const oldestPath = this.#handles.keys().next().value;
      const oldest = this.#handles.get(oldestPath);
      this.#handles.delete(oldestPath);
      try { oldest?.db?.close(); } catch { /* best effort */ }
    }
    return handle;
  }
}

function normalizeEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = /** @type {any} */ (value);
  const ledgerPath = String(entry.ledgerPath || "").trim();
  const row = entry.row;
  if (!ledgerPath || !row || typeof row !== "object" || Array.isArray(row)) return null;
  const ts = String(row.ts || "").trim();
  const repoId = String(row.repoId || "").trim();
  const action = String(row.action || "").trim();
  const ok = Number(row.ok);
  const durationMs = Number(row.durationMs);
  const resultBytes = Number(row.resultBytes);
  if (
    !ts || Number.isNaN(Date.parse(ts))
    || !repoId || repoId.length > 1024
    || !action || action.length > 256
    || (ok !== 0 && ok !== 1)
    || !Number.isSafeInteger(durationMs) || durationMs < 0
    || !Number.isSafeInteger(resultBytes) || resultBytes < 0
  ) return null;
  return {
    ledgerPath,
    row: {
      ts,
      repoId,
      action,
      ok,
      durationMs,
      resultBytes,
      versionId: optionalText(row.versionId, 1024),
      taskType: optionalText(row.taskType, 256),
      errorCode: optionalText(row.errorCode, 256),
    },
  };
}

function optionalText(value, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}
