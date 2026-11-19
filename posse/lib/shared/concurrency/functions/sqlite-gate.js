// @ts-check
//
// Shared SQLite gate for better-sqlite3 call sites. The driver is
// synchronous, so this does not make the transaction itself non-blocking once
// it is running; it prevents concurrent callers from piling into the same DB
// file and gives async workers an awaitable contention point.

import path from "path";
import { SqliteResourceGate } from "../classes/SqliteResourceGate.js";

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

// Built on first use: SqliteResourceGate imports sqliteGateKey from this
// module, so constructing it at load time fails when the class loads first.
let sqliteGate = null;
function gate() {
  sqliteGate ??= new SqliteResourceGate({ name: "SQLite protected asset" });
  return sqliteGate;
}

// IMPORTANT: this gate is per-thread (per JS realm), not cross-process or
// cross-worker. It serializes writers within this thread only; actual
// cross-thread/process arbitration is SQLite's WAL mode + busy_timeout. Do
// not rely on it for exclusivity against other workers or daemons.
export function runSqliteWrite(dbPath, fn, options = {}) {
  const { label = "sqlite.write", waitMs = 30000 } = options;
  return gate().write(dbPath, fn, { ...options, label, waitMs });
}

export function runSqliteReadNonBlocking(dbPath, fn, { label = "sqlite.read" } = {}) {
  return gate().read(dbPath, fn, { label });
}

export function sqliteGateReleaseKey(dbPath) {
  return gate().blockingReleaseKey(dbPath);
}

export function waitForSqliteRelease(dbPathOrBarrierKey, opts = {}) {
  return gate().awaitBarrier(dbPathOrBarrierKey, opts);
}

export function sqliteGateSnapshot() {
  return gate().snapshot();
}
