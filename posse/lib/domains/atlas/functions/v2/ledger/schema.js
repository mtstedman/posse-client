// @ts-check
//
// Stateless SQLite schema / migration helpers for the ATLAS v2 Ledger.
// Extracted from Ledger.js so the class can stay a thin wireframe over the
// connection + domain helpers. Everything here takes a better-sqlite3 handle
// explicitly and holds no state.

import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { LEDGER_SCHEMA_VERSION } from "../contracts/index.js";

/**
 * Runs DDL (multi-statement SQL) against a better-sqlite3 database.
 * Centralized so the call site is small and consistent.
 *
 * @param {Database.Database} db
 * @param {string} sql
 */
export function runDdl(db, sql) {
  db["exec"](sql);
}

/**
 * Add `column` to `table` if it does not already exist. Idempotent —
 * lets us evolve schemas by additive columns without bumping
 * schema_version (the project's stated policy for nullable additions).
 *
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} column
 * @param {string} sqlType  e.g. "INTEGER" or "TEXT"
 */
export function ensureColumn(db, table, column, sqlType) {
  const cols = /** @type {Array<{ name: string }>} */ (
    db.prepare(`PRAGMA table_info(${table})`).all()
  );
  if (cols.some((c) => c.name === column)) return;
  runDdl(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

/**
 * @param {Database.Database} db
 * @param {string} table
 * @returns {boolean}
 */
export function tableExists(db, table) {
  const row = /** @type {{ name: string } | undefined} */ (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
  return !!row;
}

/**
 * @param {string} dbPath
 */
export function removeSqliteFile(dbPath) {
  for (const sfx of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + sfx); }
    catch { /* stale cache cleanup is best effort */ }
  }
}

/**
 * @param {Database.Database} db
 * @returns {Set<string>}
 */
export function applicationTableNames(db) {
  const rows = /** @type {Array<{ name: string }>} */ (
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all()
  );
  return new Set(rows.map((r) => r.name));
}

/**
 * @param {Database.Database} db
 * @param {string} table
 * @returns {Set<string>}
 */
export function tableColumnSet(db, table) {
  const cols = /** @type {Array<{ name: string }>} */ (
    db.prepare(`PRAGMA table_info(${table})`).all()
  );
  return new Set(cols.map((c) => c.name));
}

export const REQUIRED_LEDGER_COLUMNS = Object.freeze({
  blob_symbols: [
    "range_start_line",
    "range_end_line",
    "signature_text",
    "source",
  ],
  blob_edges: [
    "to_external_id",
    "to_module_id",
    "range_start_line",
    "range_end_line",
    "source",
  ],
  scip_indexes: [
    "documents_failed",
    "status",
  ],
});

/**
 * Ledger files are durable enough to speed warm/replay paths, but their
 * parsed symbol tables are rebuildable. If the format is stale or malformed,
 * rebuild the DB instead of trying to run current SCIP-aware statements
 * against old tables.
 *
 * @param {Database.Database} db
 * @returns {boolean}
 */
export function ledgerNeedsFormatReset(db) {
  const tables = applicationTableNames(db);
  if (tables.size === 0) return false;
  if (!tables.has("meta")) return true;

  const existing = /** @type {{ value: string } | undefined} */ (
    db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version")
  );
  if (!existing || Number(existing.value) !== LEDGER_SCHEMA_VERSION) return true;

  for (const [table, required] of Object.entries(REQUIRED_LEDGER_COLUMNS)) {
    if (!tables.has(table)) return true;
    const columns = tableColumnSet(db, table);
    for (const column of required) {
      if (!columns.has(column)) return true;
    }
  }
  return false;
}

/**
 * @param {string} dbPath
 * @returns {Database.Database}
 */
export function openLedgerDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db;
  try {
    db = new Database(dbPath);
  } catch {
    removeSqliteFile(dbPath);
    db = new Database(dbPath);
    db.pragma("busy_timeout = 5000");
    return db;
  }
  db.pragma("busy_timeout = 5000");

  try {
    if (!ledgerNeedsFormatReset(db)) return db;
  } catch {
    // Corrupt or non-SQLite files are disposable cache at this layer.
  }

  try { db.close(); } catch { /* ignore close failures while resetting */ }
  removeSqliteFile(dbPath);
  return new Database(dbPath);
}

/**
 * @param {string} dbPath
 * @returns {Database.Database}
 */
export function openLedgerDbReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * New partial indexes in LEDGER_DDL reference additive SCIP columns. Existing
 * DBs need those columns before the full DDL runs, otherwise SQLite rejects
 * the CREATE INDEX statements with "no such column".
 *
 * @param {Database.Database} db
 */
export function ensureLegacyScipColumnsBeforeDdl(db) {
  if (tableExists(db, "blob_edges")) {
    ensureColumn(db, "blob_edges", "to_external_id", "INTEGER");
    ensureColumn(db, "blob_edges", "to_module_id", "INTEGER");
    ensureColumn(db, "blob_edges", "source", "TEXT NOT NULL DEFAULT 'treesitter'");
  }
  if (tableExists(db, "blob_symbols")) {
    ensureColumn(db, "blob_symbols", "source", "TEXT NOT NULL DEFAULT 'treesitter'");
  }
}

/**
 * Existing ledgers may predate the external-content FTS tables. Rebuild only
 * when the visible row counts diverge so normal opens stay cheap.
 *
 * @param {Database.Database} db
 */
export function ensureLedgerFtsBackfill(db) {
  rebuildExternalFtsIfCountDiffers(db, "memories", "memories_fts");
  rebuildExternalFtsIfCountDiffers(db, "feedback_signals", "feedback_fts");
}

/**
 * @param {Database.Database} db
 * @param {string} contentTable
 * @param {string} ftsTable
 */
export function rebuildExternalFtsIfCountDiffers(db, contentTable, ftsTable) {
  if (!tableExists(db, contentTable) || !tableExists(db, ftsTable)) return;
  try {
    const contentRow = /** @type {{ c: number } | undefined} */ (
      db.prepare(`SELECT COUNT(*) AS c FROM ${contentTable}`).get()
    );
    const ftsRow = /** @type {{ c: number } | undefined} */ (
      db.prepare(`SELECT COUNT(*) AS c FROM ${ftsTable}`).get()
    );
    const contentCount = Number(contentRow?.c || 0);
    const ftsCount = Number(ftsRow?.c || 0);
    if (contentCount !== ftsCount) {
      db.prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`).run();
    }
  } catch {
    // FTS is an acceleration path. If rebuild fails, lexical fallback still works.
  }
}
