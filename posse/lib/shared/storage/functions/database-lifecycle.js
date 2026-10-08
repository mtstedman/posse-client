import fs from "node:fs";
import Database from "better-sqlite3";

export function isRecoverableDbError(err) {
  const msg = err?.message || String(err || "");
  return /disk I\/O error|database disk image is malformed|file is not a database|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg);
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

export function quarantineStaleIncompleteDb(dbPath, { force = false, ignoreAge = false } = {}) {
  if (!fs.existsSync(dbPath)) return;

  let stat;
  try { stat = fs.statSync(dbPath); } catch { return false; }
  if (!force && stat.size !== 0) return false;

  const siblings = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter((p) => fs.existsSync(p));
  if (siblings.length <= 1) return false;

  const newestSiblingMs = Math.max(...siblings.map((p) => {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
  }));
  if (!ignoreAge && Date.now() - newestSiblingMs < 5000) return false;

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  let quarantined = false;
  for (const filePath of siblings) {
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${stamp}`);
      quarantined = true;
    } catch {
      // Best effort: if another process owns it, let SQLite report the error.
    }
  }
  return quarantined;
}

export function ensureRuntimeDbDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows/best-effort */ }
}

export function openDatabaseHandle(dbPath) {
  let db = new Database(dbPath);
  try {
    try {
      applyDbPragmas(db, dbPath);
    } catch (err) {
      try { db.close(); } catch {}
      if (!quarantineStaleIncompleteDb(dbPath, { force: true, ignoreAge: true })) throw err;
      db = new Database(dbPath);
      applyDbPragmas(db, dbPath);
    }

    // A corrupt file may open and fail only on the first schema read.
    try {
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' LIMIT 1`).get();
    } catch (err) {
      try { db.close(); } catch {}
      if (!isRecoverableDbError(err)
        || !quarantineStaleIncompleteDb(dbPath, { force: true, ignoreAge: true })) throw err;
      db = new Database(dbPath);
      applyDbPragmas(db, dbPath);
    }
    return db;
  } catch (err) {
    try { db.close(); } catch {}
    throw err;
  }
}
