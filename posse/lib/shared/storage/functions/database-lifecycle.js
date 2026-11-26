import fs from "node:fs";
import Database from "better-sqlite3";

export function isRecoverableDbError(err) {
  // Contention and I/O failures do not establish corruption. In particular,
  // moving a live SQLite database on SQLITE_BUSY splits existing connections
  // from the replacement opened at its original path.
  const code = String(err?.code || "");
  if (code) return /^SQLITE_(?:CORRUPT(?:_|$)|NOTADB$)/.test(code);
  const msg = err?.message || String(err || "");
  return /database disk image is malformed|file is not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg);
}

export function applyDbPragmas(db, dbPath) {
  let walEnabled = false;
  try {
    db.pragma("journal_mode = WAL");
    walEnabled = true;
  } catch (err) {
    try {
      db.pragma("journal_mode = DELETE");
    } catch {
      throw err;
    }
    try {
      const stamp = new Date().toISOString();
      console.warn(`[posse][db] WAL unavailable for ${dbPath}; using DELETE journal mode (${stamp})`);
    } catch {
      // Best effort logging only.
    }
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  try { db.pragma("synchronous = NORMAL"); } catch { /* best effort */ }
  try { db.pragma("temp_store = MEMORY"); } catch { /* best effort */ }
  try { db.pragma("mmap_size = 268435456"); } catch { /* best effort */ }
  return { walEnabled };
}

export function ensureRuntimeDbDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows/best-effort */ }
}

export function openDatabaseHandle(dbPath) {
  let db;
  try {
    db = new Database(dbPath);
    applyDbPragmas(db, dbPath);
    // SQLite owns journal recovery. Corruption must never turn an existing
    // queue into a successfully opened empty database.
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`).get();
    return db;
  } catch (err) {
    try { db?.close(); } catch { /* retain the original failure */ }
    if (isRecoverableDbError(err)) {
      err.message = `Posse database recovery required at ${dbPath}: ${err.message}. `
        + "Startup stopped; no replacement database was created. Stop all Posse processes for this repository, "
        + "preserve the database and its SQLite sidecars, and restore a verified backup or recover a copy before retrying. "
        + "Do not delete the runtime directory to clear this error.";
    }
    throw err;
  }
}
