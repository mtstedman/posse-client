// @ts-check
//
// Shared SQLite gate for better-sqlite3 call sites. The driver is
// synchronous, so this does not make the transaction itself non-blocking once
// it is running; it prevents concurrent callers from piling into the same DB
// file and gives async workers an awaitable contention point.

import path from "path";
import { AsyncResourceGate } from "./async-gate.js";

function normalizeSqlitePath(dbPath) {
  const raw = String(dbPath || "default").trim() || "default";
  let resolved = raw;
  try {
    resolved = path.resolve(raw);
  } catch {
    resolved = raw;
  }
  const normalized = resolved.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function sqliteGateKey(dbPath, scope = "sqlite") {
  return `${scope}:${normalizeSqlitePath(dbPath)}`;
}

class SqliteResourceGate extends AsyncResourceGate {
  normalizeKey(dbPath) {
    return sqliteGateKey(dbPath);
  }
}

const SQLITE_GATE = new SqliteResourceGate({
  name: "SQLite protected asset",
});

// IMPORTANT: this gate is per-thread (per JS realm), not cross-process or
// cross-worker. It serializes writers within this thread only; actual
// cross-thread/process arbitration is SQLite's WAL mode + busy_timeout. Do
// not rely on it for exclusivity against other workers or daemons.
export function runSqliteWrite(dbPath, fn, { label = "sqlite.write", waitMs = 30000 } = {}) {
  return SQLITE_GATE.write(dbPath, fn, { label, waitMs });
}

export function runSqliteReadNonBlocking(dbPath, fn, { label = "sqlite.read" } = {}) {
  return SQLITE_GATE.read(dbPath, fn, { label });
}

export function sqliteGateReleaseKey(dbPath) {
  return SQLITE_GATE.blockingReleaseKey(dbPath);
}

export function waitForSqliteRelease(dbPathOrBarrierKey, opts = {}) {
  return SQLITE_GATE.awaitBarrier(dbPathOrBarrierKey, opts);
}

export function sqliteGateSnapshot() {
  return SQLITE_GATE.snapshot();
}
