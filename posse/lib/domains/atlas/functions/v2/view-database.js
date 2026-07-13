// @ts-check
//
// Write-side connection lifecycle for the rebuildable ATLAS view cache.
// Retrieval reads do not use this module; they cross the Rust view-read
// boundary in native/view-read.js.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

import { VIEW_DDL, VIEW_SCHEMA_VERSION } from "./contracts/index.js";
import { ensureGraphDerivedTables } from "./graph-derived.js";

const VIEW_INDEXES = Object.freeze([
  {
    name: "idx_symbols_path",
    sql: "CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(repo_rel_path, range_start, global_id)",
  },
  {
    name: "idx_symbols_lang",
    sql: "CREATE INDEX IF NOT EXISTS idx_symbols_lang ON symbols(lang)",
  },
  {
    name: "idx_edges_from",
    sql: "CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_global_id, range_start, to_global_id)",
  },
  {
    name: "idx_edges_to",
    sql: `CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_global_id, from_global_id, range_start)
      WHERE to_global_id IS NOT NULL`,
  },
  {
    name: "idx_edges_source",
    sql: "CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)",
  },
]);

/** @param {string} dbPath */
export function openViewDbReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

/** @param {string} dbPath */
export function openViewDbReadWrite(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let fresh = !fs.existsSync(dbPath);
  let db;
  try {
    db = new Database(dbPath);
  } catch {
    removeSqliteFile(dbPath);
    db = new Database(dbPath);
    fresh = true;
  }
  if (!fresh) {
    let reset = false;
    try {
      reset = viewNeedsFormatReset(db);
    } catch {
      reset = true;
    }
    if (reset) {
      try { db.close(); } catch { /* ignore close failures while resetting */ }
      removeSqliteFile(dbPath);
      db = new Database(dbPath);
      fresh = true;
    }
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  if (fresh) {
    db.exec(VIEW_DDL);
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(VIEW_SCHEMA_VERSION));
  }
  ensureColumn(db, "symbols", "range_start_line", "INTEGER");
  ensureColumn(db, "symbols", "range_end_line", "INTEGER");
  ensureColumn(db, "edges", "range_start_line", "INTEGER");
  ensureColumn(db, "edges", "range_end_line", "INTEGER");
  ensureColumn(db, "symbols", "signature_text", "TEXT");
  ensureColumn(db, "symbols", "body_identifiers", "TEXT");
  ensureColumn(db, "symbols", "merged_fingerprint", "TEXT");
  ensureColumn(db, "edges", "to_external_id", "INTEGER");
  ensureColumn(db, "edges", "external_descriptor", "TEXT");
  ensureColumn(db, "edges", "source", "TEXT NOT NULL DEFAULT 'treesitter'");
  ensureViewIndexes(db);
  ensureGraphDerivedTables(db);
  return db;
}

function removeSqliteFile(dbPath) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* disposable cache cleanup is best effort */ }
  }
}

function viewNeedsFormatReset(db) {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all();
  const tables = new Set(rows.map((row) => row.name));
  if (tables.size === 0) return true;
  for (const table of ["meta", "path_to_blob", "symbols", "edges"]) {
    if (!tables.has(table)) return true;
  }
  const existing = db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
  return !existing || Number(existing.value) !== VIEW_SCHEMA_VERSION;
}

function ensureColumn(db, table, column, sqlType) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

function ensureViewIndexes(db) {
  for (const index of VIEW_INDEXES) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index.name);
    if (row && normalizeIndexSql(row.sql) !== normalizeIndexSql(index.sql)) {
      db.exec(`DROP INDEX IF EXISTS ${index.name}`);
    }
    db.exec(index.sql);
  }
}

function normalizeIndexSql(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .trim()
    .toLowerCase();
}
