// @ts-check
//
// Durable slice-handle registry. Slice contents remain rebuildable, but a
// handle should survive a worker process restart long enough for an agent to
// refresh or fetch spillover.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { slicesDbPath } from "../runtime-paths.js";

const SLICE_STORE_DDL = `
CREATE TABLE IF NOT EXISTS slice_handles (
  handle TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slice_handles_expires_at ON slice_handles(expires_at);
`;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {Object} StoredSlice
 * @property {string} handle
 * @property {string} version_id
 * @property {number} expires_at
 * @property {any} entry
 */

/**
 * @param {string | undefined} repoRoot
 * @returns {Database.Database | null}
 */
function openStore(repoRoot) {
  if (!repoRoot) return null;
  const dbPath = slicesDbPath(repoRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.exec(SLICE_STORE_DDL);
  return db;
}

/**
 * @param {{ repoRoot?: string, handle: string, entry: any, ttlMs?: number }} args
 * @returns {void}
 */
export function saveSliceEntry({ repoRoot, handle, entry, ttlMs = DEFAULT_TTL_MS }) {
  const db = openStore(repoRoot);
  if (!db) return;
  try {
    const expiresAt = Date.now() + Math.max(60_000, ttlMs);
    db.prepare("DELETE FROM slice_handles WHERE expires_at < ?").run(Date.now());
    db.prepare(`
      INSERT INTO slice_handles(handle, version_id, expires_at, entry_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET
        version_id = excluded.version_id,
        expires_at = excluded.expires_at,
        entry_json = excluded.entry_json
    `).run(handle, String(entry.versionId || ""), expiresAt, JSON.stringify({ ...entry, expiresAt }));
  } finally {
    db.close();
  }
}

/**
 * @param {{ repoRoot?: string, handle: string }} args
 * @returns {StoredSlice | null}
 */
export function loadSliceEntry({ repoRoot, handle }) {
  const db = openStore(repoRoot);
  if (!db) return null;
  try {
    // Expired rows are filtered here and purged on the save path; loads stay
    // read-only so concurrent readers never contend for the write lock.
    const row = /** @type {{ handle: string, version_id: string, expires_at: number, entry_json: string } | undefined} */ (
      db.prepare("SELECT handle, version_id, expires_at, entry_json FROM slice_handles WHERE handle = ? AND expires_at >= ?").get(handle, Date.now())
    );
    if (!row) return null;
    return {
      handle: row.handle,
      version_id: row.version_id,
      expires_at: row.expires_at,
      entry: JSON.parse(row.entry_json),
    };
  } finally {
    db.close();
  }
}
