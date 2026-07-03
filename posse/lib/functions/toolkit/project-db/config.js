// Per-repo "project database" config + credentials store.
//
// This backs the opt-in `project_db_query` agent tool: it remembers which of
// the developer's OWN application databases (sqlite/postgres/mysql) the agent is
// allowed to reach, with what granular permissions, and the credentials needed
// to connect.
//
// Storage choice: the row lives in the per-repo `.posse/db/orchestrator.db`
// (one row per repo), NOT the central account.db. Config is repo-anchored, so
// it follows the repo-scoped-state rule. The password is stored here too — a
// deliberate, operator-approved carve-out from the "credentials are env-only"
// rule for this specific feature. To honour the *spirit* of that rule the
// password never leaves this module except toward the driver: the sanitized
// shape (readProjectDbConfig) exposes only `hasPassword`, and the secret is
// scrubbed from observations/telemetry/logs elsewhere.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getRuntimeDbPath } from "../../../domains/runtime/functions/paths.js";

export const PROJECT_DB_TYPES = Object.freeze(["sqlite", "postgres", "mysql"]);

// Granular permissions the operator can grant, mapped to the leading SQL verb
// the tool will allow. READ also implies the read-only inspection verbs
// (PRAGMA/EXPLAIN/SHOW/DESCRIBE) — see permissions.js. CREATE/ALTER are the
// only grantable DDL; DROP/TRUNCATE and the rest are always blocked in permissions.js.
export const PROJECT_DB_PERMISSIONS = Object.freeze(["read", "write", "insert", "delete", "create", "alter"]);

export const PROJECT_DB_CONFIG_TABLE = "project_db_config";

// Single-row table (id is pinned to 1): exactly one project DB per repo.
export const PROJECT_DB_CONFIG_DDL = `
  CREATE TABLE IF NOT EXISTS ${PROJECT_DB_CONFIG_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    db_type TEXT CHECK (db_type IS NULL OR db_type IN ('sqlite', 'postgres', 'mysql')),
    host TEXT,
    port INTEGER,
    database TEXT,
    username TEXT,
    password TEXT,
    permissions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;

// Mutating jobs run with a worktree under `<repo>/.posse-worktrees/` as cwd;
// the config row always lives with the repo that owns the worktree, so resolve
// through the worktree back to the repo root before locating orchestrator.db.
function resolveRepoRoot(projectDir) {
  if (!projectDir) return null;
  const resolved = path.resolve(String(projectDir));
  const segments = resolved.split(path.sep);
  const idx = segments.lastIndexOf(".posse-worktrees");
  return idx > 0 ? segments.slice(0, idx).join(path.sep) : resolved;
}

function resolveDbPath(projectDir = null) {
  return getRuntimeDbPath(resolveRepoRoot(projectDir));
}

function ensureTable(db) {
  db.exec(PROJECT_DB_CONFIG_DDL);
}

export function normalizePermissions(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const perm = String(entry || "").trim().toLowerCase();
    if (!perm || seen.has(perm)) continue;
    if (!PROJECT_DB_PERMISSIONS.includes(perm)) continue;
    seen.add(perm);
    out.push(perm);
  }
  // Stable, canonical ordering so the stored string is deterministic.
  return PROJECT_DB_PERMISSIONS.filter((perm) => seen.has(perm));
}

function rowToConnection(row) {
  if (!row) {
    return {
      enabled: false,
      dbType: null,
      host: null,
      port: null,
      database: null,
      username: null,
      password: null,
      permissions: [],
    };
  }
  return {
    enabled: !!row.enabled,
    dbType: row.db_type || null,
    host: row.host || null,
    port: row.port == null ? null : Number(row.port),
    database: row.database || null,
    username: row.username || null,
    password: row.password || null,
    permissions: normalizePermissions(row.permissions),
  };
}

/**
 * Full connection details INCLUDING the password. For driver use only — never
 * log, render, or return this to an agent. Callers that surface config to a UI
 * or the tool schema must use readProjectDbConfig() instead.
 */
export function readProjectDbConnection({ projectDir = null } = {}) {
  const dbPath = resolveDbPath(projectDir);
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT * FROM ${PROJECT_DB_CONFIG_TABLE} WHERE id = 1`).get();
    return rowToConnection(row);
  } catch {
    // Missing DB file or missing table => not configured / disabled.
    return rowToConnection(null);
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

/**
 * Sanitized config for display, tool advertisement, and admin surfaces. Carries
 * `hasPassword` rather than the secret itself.
 */
export function readProjectDbConfig({ projectDir = null } = {}) {
  const conn = readProjectDbConnection({ projectDir });
  return {
    enabled: conn.enabled,
    dbType: conn.dbType,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    hasPassword: !!conn.password,
    permissions: conn.permissions,
  };
}

/**
 * Cap a granted permission set to a job capability lane. Read-lane jobs
 * (researcher/planner, or any job running without write permission) only ever
 * keep the `read` grant; write-lane jobs keep the full operator grant.
 */
export function capProjectDbPermissions(permissions = [], capability = "write") {
  const perms = normalizePermissions(permissions);
  return capability === "read" ? perms.filter((perm) => perm === "read") : perms;
}

/**
 * The permissions a job with the given capability lane may actually use:
 * empty unless the repo's admin config is enabled AND has a configured engine,
 * then the operator grant capped to the lane. An empty result means the tool
 * must not be surfaced to that job.
 */
export function projectDbEffectivePermissions({ projectDir = null, capability = "write" } = {}) {
  const conn = readProjectDbConnection({ projectDir });
  if (!conn.enabled || !conn.dbType) return [];
  return capProjectDbPermissions(conn.permissions, capability);
}

/**
 * Upsert the single config row. Accepts a partial patch; unspecified fields are
 * left untouched. Pass enabled:false to disable without discarding stored
 * connection details, or use clearProjectDbConfig() to wipe the row entirely.
 */
export function writeProjectDbConfig(patch = {}, { projectDir = null } = {}) {
  const dbPath = resolveDbPath(projectDir);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 10000");
    ensureTable(db);
    const current = db.prepare(`SELECT * FROM ${PROJECT_DB_CONFIG_TABLE} WHERE id = 1`).get() || {};
    const next = {
      enabled: patch.enabled == null ? (current.enabled || 0) : (patch.enabled ? 1 : 0),
      db_type: patch.dbType === undefined ? (current.db_type ?? null) : (patch.dbType || null),
      host: patch.host === undefined ? (current.host ?? null) : (patch.host || null),
      port: patch.port === undefined ? (current.port ?? null) : (patch.port == null ? null : Number(patch.port)),
      database: patch.database === undefined ? (current.database ?? null) : (patch.database || null),
      username: patch.username === undefined ? (current.username ?? null) : (patch.username || null),
      password: patch.password === undefined ? (current.password ?? null) : (patch.password || null),
      permissions: patch.permissions === undefined
        ? (current.permissions ?? "")
        : normalizePermissions(patch.permissions).join(","),
    };
    if (next.db_type != null && !PROJECT_DB_TYPES.includes(next.db_type)) {
      throw new Error(`Unknown project DB type: ${next.db_type}`);
    }
    db.prepare(`
      INSERT INTO ${PROJECT_DB_CONFIG_TABLE}
        (id, enabled, db_type, host, port, database, username, password, permissions, updated_at)
      VALUES
        (1, @enabled, @db_type, @host, @port, @database, @username, @password, @permissions,
         strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        db_type = excluded.db_type,
        host = excluded.host,
        port = excluded.port,
        database = excluded.database,
        username = excluded.username,
        password = excluded.password,
        permissions = excluded.permissions,
        updated_at = excluded.updated_at
    `).run(next);
    return readProjectDbConfig({ projectDir });
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

export function clearProjectDbConfig({ projectDir = null } = {}) {
  const dbPath = resolveDbPath(projectDir);
  let db = null;
  try {
    db = new Database(dbPath);
    db.pragma("busy_timeout = 10000");
    ensureTable(db);
    db.prepare(`DELETE FROM ${PROJECT_DB_CONFIG_TABLE} WHERE id = 1`).run();
  } catch {
    // Nothing to clear if the DB/table never existed.
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}
