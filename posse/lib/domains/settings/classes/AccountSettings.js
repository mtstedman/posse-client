import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { SETTINGS_CATALOG, getCatalogEntry, validateCatalogSettingValue } from "../functions/catalog.js";

const ACCOUNT_DB_BUSY_TIMEOUT_MS = 2000;

const REPO_SCOPED_SETTING_KEYS = new Set(
  SETTINGS_CATALOG.filter((entry) => entry.scope === "repo").map((entry) => entry.key),
);
const ACCOUNT_SCOPED_SETTINGS_CATALOG = SETTINGS_CATALOG.filter((entry) => !REPO_SCOPED_SETTING_KEYS.has(entry.key));

function normalizeDbPath(dbPath) {
  if (dbPath == null || String(dbPath).trim() === "") return null;
  return path.resolve(String(dbPath));
}

function normalizeRepoPath(repoPath) {
  if (repoPath == null || String(repoPath).trim() === "") return null;
  const resolved = path.resolve(String(repoPath)).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Tests must never touch the operator's real ~/.posse/account.db. Before this
// guard, any test that called setSetting() without an explicit
// POSSE_ACCOUNT_DB_PATH wrote the LIVE global settings — e.g. the scip CLI
// suite flipped atlas_scip_mode off and reset atlas_scip_restage_policy on
// every run. Under node --test (NODE_TEST_CONTEXT), an unset account DB path
// now resolves to a per-process temp DB instead, pinned into the env so
// subprocesses the test spawns share the same isolated DB. Tests that point
// POSSE_ACCOUNT_DB_PATH somewhere explicit keep full control.
let _testRedirectPath = null;
function resolveTestRedirectPath() {
  if (_testRedirectPath) return _testRedirectPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-test-account-"));
  _testRedirectPath = path.join(dir, "account.db");
  process.env.POSSE_ACCOUNT_DB_PATH = _testRedirectPath;
  return _testRedirectPath;
}

// A process is "under test" when it is the test runner itself
// (NODE_TEST_CONTEXT, set by `node --test`) OR any descendant of `npm test`
// (POSSE_TEST_RUN, set by scripts/run-tests.mjs and inherited by every spawned
// child/grandchild). Either way it must never touch the operator's real
// ~/.posse/account.db — child processes that lack NODE_TEST_CONTEXT used to
// fall through to it and clobber live settings.
function isUnderTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN);
}

function realDefaultAccountDbPath() {
  return path.join(os.homedir(), ".posse", "account.db");
}

function resolveDefaultPath() {
  const envPath = normalizeDbPath(process.env.POSSE_ACCOUNT_DB_PATH);
  if (envPath) return envPath;
  if (isUnderTest()) return resolveTestRedirectPath();
  return realDefaultAccountDbPath();
}

// Eager isolation: pin the per-process redirect into the env at module load (in
// any test process) so that a child process spawned BEFORE the first in-process
// settings access still inherits a sandboxed account DB instead of resolving
// the real ~/.posse/account.db.
if (isUnderTest() && !normalizeDbPath(process.env.POSSE_ACCOUNT_DB_PATH)) {
  resolveTestRedirectPath();
}

// ATLAS (and any future module that caches DB-backed config) registers an
// invalidator on globalThis at import time. Invoking it here guarantees that
// every settings write clears downstream caches, regardless of which key
// changed.
function notifySettingsChanged() {
  try {
    if (typeof globalThis.__POSSE_INVALIDATE_ATLAS_CONFIG_CACHE === "function") {
      globalThis.__POSSE_INVALIDATE_ATLAS_CONFIG_CACHE();
    }
  } catch {
    // best-effort
  }
}

export class AccountSettings {
  constructor({ dbPath = null } = {}) {
    this._db = null;
    this._openPath = null;
    this._dbPathOverride = normalizeDbPath(dbPath);
    this._cache = new Map();
    this._dataVersion = null;
  }

  static forTests({ dbPath } = {}) {
    return new AccountSettings({ dbPath });
  }

  resolvePath() {
    return this._dbPathOverride || resolveDefaultPath();
  }

  open() {
    const targetPath = this.resolvePath();
    // Tripwire: never let a test (or a child/grandchild it spawned) open the
    // operator's real account DB. The redirect in resolveDefaultPath makes this
    // unreachable unless a test explicitly pointed POSSE_ACCOUNT_DB_PATH at the
    // real path — in which case fail loudly instead of corrupting live settings.
    if (isUnderTest() && normalizeDbPath(targetPath) === normalizeDbPath(realDefaultAccountDbPath())) {
      throw new Error(
        `Refusing to open the real account DB during tests: ${targetPath}. ` +
        "Sandbox it via POSSE_ACCOUNT_DB_PATH or setAccountSettingsPathForTests().",
      );
    }
    if (this._db && this._openPath === targetPath) return this._db;

    if (this._db) {
      try { this._db.close(); } catch { /* ignore */ }
      this._db = null;
      this._openPath = null;
    }

    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* Windows/best-effort */ }
    this._db = new Database(targetPath);
    try { fs.chmodSync(targetPath, 0o600); } catch { /* Windows/best-effort */ }
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("synchronous = NORMAL");
    this._db.pragma(`busy_timeout = ${ACCOUNT_DB_BUSY_TIMEOUT_MS}`);
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS account_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS repo_settings (
        repo_path TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (repo_path, setting_key)
      );

      CREATE INDEX IF NOT EXISTS idx_repo_settings_key ON repo_settings(setting_key);
    `);
    this._openPath = targetPath;
    this._seedDefaults();
    this.invalidate();
    this._dataVersion = this._readDataVersion(this._db);
    return this._db;
  }

  close() {
    if (!this._db) return;
    try { this._db.close(); } catch { /* ignore */ }
    this._db = null;
    this._openPath = null;
    this._dataVersion = null;
    this.invalidate();
  }

  invalidate() {
    this._cache.clear();
  }

  _readDataVersion(db = this._db) {
    if (!db) return null;
    try {
      const value = db.pragma("data_version", { simple: true });
      const version = Number(value);
      return Number.isFinite(version) ? version : null;
    } catch {
      return null;
    }
  }

  _openForReadOrWrite() {
    const db = this.open();
    const version = this._readDataVersion(db);
    if (version != null && this._dataVersion != null && version !== this._dataVersion) {
      this.invalidate();
    }
    if (version != null) this._dataVersion = version;
    return db;
  }

  getPathForDisplay() {
    return this.resolvePath();
  }

  getDataVersion() {
    this._openForReadOrWrite();
    return this._dataVersion;
  }

  setDbPathForTests(dbPath = null) {
    this.close();
    this._dbPathOverride = normalizeDbPath(dbPath);
  }

  /**
   * Read an account_settings row regardless of the key's catalog scope.
   * Exists for one-time migrations that must see legacy account-level rows
   * after a key has been reclassified as repo-scoped (normal get() hides
   * repo-scoped keys). Bypasses the cache; do not use on hot paths.
   */
  getRawAccountValue(key) {
    const db = this._openForReadOrWrite();
    const row = db
      .prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`)
      .get(String(key));
    const value = row?.setting_value;
    return value == null || value === "" ? null : String(value);
  }

  get(key) {
    const cacheKey = String(key);
    if (REPO_SCOPED_SETTING_KEYS.has(cacheKey)) return null;
    const db = this._openForReadOrWrite();
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const row = db
      .prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`)
      .get(cacheKey);
    if (!row) {
      this._cache.set(cacheKey, null);
      return null;
    }
    const value = row.setting_value;
    if (value == null || value === "") {
      this._cache.set(cacheKey, null);
      return null;
    }
    const normalized = String(value);
    this._cache.set(cacheKey, normalized);
    return normalized;
  }

  set(key, value) {
    const db = this._openForReadOrWrite();
    const normalizedKey = String(key);
    if (REPO_SCOPED_SETTING_KEYS.has(normalizedKey)) {
      db.prepare(`DELETE FROM account_settings WHERE setting_key = ?`).run(normalizedKey);
      this._cache.set(normalizedKey, null);
      this._dataVersion = this._readDataVersion(db);
      notifySettingsChanged();
      return;
    }
    const validated = validateCatalogSettingValue(normalizedKey, value);
    if (!validated.ok) throw new Error(validated.error);
    const normalizedValue = validated.value;
    const isEmpty = normalizedValue == null || String(normalizedValue).trim() === "";

    if (isEmpty) {
      const catalog = getCatalogEntry(normalizedKey);
      if (catalog) {
        const catalogValue = catalog.default == null ? "" : String(catalog.default);
        db.prepare(
          `INSERT INTO account_settings (setting_key, setting_value, updated_at)
           VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(setting_key) DO UPDATE
             SET setting_value = excluded.setting_value,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run(normalizedKey, catalogValue);
        this._cache.set(normalizedKey, catalogValue === "" ? null : catalogValue);
      } else {
        db.prepare(`DELETE FROM account_settings WHERE setting_key = ?`).run(normalizedKey);
        this._cache.set(normalizedKey, null);
      }
    } else {
      db.prepare(
        `INSERT INTO account_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(setting_key) DO UPDATE
           SET setting_value = excluded.setting_value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(normalizedKey, normalizedValue);
      this._cache.set(normalizedKey, normalizedValue);
    }
    this._dataVersion = this._readDataVersion(db);
    notifySettingsChanged();
  }

  /**
   * Atomically write `key` only when it has no value yet (no row, or the
   * empty default row that _seedDefaults materializes); returns true when
   * this process won the claim. Exists for one-time migrations that must
   * elect exactly one winner across concurrently booting processes — a
   * read-then-set sequence lets every racer pass the read.
   */
  claimAccountValueIfAbsent(key, value) {
    const normalizedKey = String(key);
    if (REPO_SCOPED_SETTING_KEYS.has(normalizedKey)) {
      throw new Error(`claimAccountValueIfAbsent: "${normalizedKey}" is repo-scoped`);
    }
    const validated = validateCatalogSettingValue(normalizedKey, value);
    if (!validated.ok) throw new Error(validated.error);
    const db = this._openForReadOrWrite();
    const info = db.prepare(
      `INSERT INTO account_settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(setting_key) DO UPDATE
         SET setting_value = excluded.setting_value,
             updated_at = excluded.updated_at
         WHERE account_settings.setting_value IS NULL
            OR account_settings.setting_value = ''`,
    ).run(normalizedKey, String(validated.value ?? ""));
    this._cache.delete(normalizedKey);
    this._dataVersion = this._readDataVersion(db);
    notifySettingsChanged();
    return info.changes > 0;
  }

  getRepo(key, repoPath) {
    const normalizedKey = String(key);
    const normalizedRepoPath = normalizeRepoPath(repoPath);
    if (!normalizedRepoPath) return null;
    const cacheKey = `repo:${normalizedRepoPath}\0${normalizedKey}`;
    const db = this._openForReadOrWrite();
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const row = db
      .prepare(`SELECT setting_value FROM repo_settings WHERE repo_path = ? AND setting_key = ?`)
      .get(normalizedRepoPath, normalizedKey);
    if (!row) {
      this._cache.set(cacheKey, null);
      return null;
    }
    const value = row.setting_value;
    if (value == null || value === "") {
      this._cache.set(cacheKey, null);
      return null;
    }
    const normalized = String(value);
    this._cache.set(cacheKey, normalized);
    return normalized;
  }

  setRepo(key, value, repoPath) {
    const normalizedKey = String(key);
    const normalizedRepoPath = normalizeRepoPath(repoPath);
    if (!normalizedRepoPath) return;
    const db = this._openForReadOrWrite();
    const cacheKey = `repo:${normalizedRepoPath}\0${normalizedKey}`;
    const validated = validateCatalogSettingValue(normalizedKey, value);
    if (!validated.ok) throw new Error(validated.error);
    const normalizedValue = validated.value;
    const isEmpty = normalizedValue == null || String(normalizedValue).trim() === "";

    if (isEmpty) {
      db.prepare(`DELETE FROM repo_settings WHERE repo_path = ? AND setting_key = ?`).run(normalizedRepoPath, normalizedKey);
      this._cache.set(cacheKey, null);
    } else {
      db.prepare(
        `INSERT INTO repo_settings (repo_path, setting_key, setting_value, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(repo_path, setting_key) DO UPDATE
           SET setting_value = excluded.setting_value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(normalizedRepoPath, normalizedKey, normalizedValue);
      this._cache.set(cacheKey, normalizedValue);
    }
    this._dataVersion = this._readDataVersion(db);
    notifySettingsChanged();
  }

  setMany(updates = {}) {
    const db = this._openForReadOrWrite();
    const upsert = db.prepare(
      `INSERT INTO account_settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(setting_key) DO UPDATE
         SET setting_value = excluded.setting_value,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    );
    const del = db.prepare(`DELETE FROM account_settings WHERE setting_key = ?`);

    const tx = db.transaction((entries) => {
      for (const [key, value] of entries) {
        const normalizedKey = String(key);
        if (REPO_SCOPED_SETTING_KEYS.has(normalizedKey)) {
          del.run(normalizedKey);
          this._cache.set(normalizedKey, null);
          continue;
        }
        const validated = validateCatalogSettingValue(normalizedKey, value);
        if (!validated.ok) throw new Error(validated.error);
        const normalizedValue = validated.value;
        const isEmpty = normalizedValue == null || String(normalizedValue).trim() === "";
        if (isEmpty) {
          const catalog = getCatalogEntry(normalizedKey);
          if (catalog) {
            const catalogValue = catalog.default == null ? "" : String(catalog.default);
            upsert.run(normalizedKey, catalogValue);
            this._cache.set(normalizedKey, catalogValue === "" ? null : catalogValue);
          } else {
            del.run(normalizedKey);
            this._cache.set(normalizedKey, null);
          }
        } else {
          upsert.run(normalizedKey, normalizedValue);
          this._cache.set(normalizedKey, normalizedValue);
        }
      }
    });
    tx(Object.entries(updates || {}));
    this._dataVersion = this._readDataVersion(db);
    notifySettingsChanged();
  }

  getAll() {
    const rows = this._openForReadOrWrite()
      .prepare(`SELECT setting_key, setting_value, updated_at FROM account_settings ORDER BY setting_key`)
      .all();
    return rows
      .filter((row) => !REPO_SCOPED_SETTING_KEYS.has(row.setting_key))
      .map((row) => ({
        setting_key: row.setting_key,
        setting_value: String(row.setting_value ?? ""),
        updated_at: row.updated_at || null,
        source: "account",
      }));
  }

  getAllRepo(repoPath) {
    const normalizedRepoPath = normalizeRepoPath(repoPath);
    if (!normalizedRepoPath) return [];
    const rows = this._openForReadOrWrite()
      .prepare(`SELECT setting_key, setting_value, updated_at FROM repo_settings WHERE repo_path = ? ORDER BY setting_key`)
      .all(normalizedRepoPath);
    return rows.map((row) => ({
      repo_path: normalizedRepoPath,
      setting_key: row.setting_key,
      setting_value: String(row.setting_value ?? ""),
      updated_at: row.updated_at || null,
      source: "repo",
    }));
  }

  _seedDefaults() {
    this._migrateAtlasToolGateDefault();
    this._migrateAtlasPrefetchEntrypointRankDefault();
    const stmt = this._db.prepare(
      `INSERT OR IGNORE INTO account_settings (setting_key, setting_value) VALUES (?, ?)`,
    );
    const tx = this._db.transaction((entries) => {
      for (const entry of entries) stmt.run(entry.key, entry.default);
    });
    tx(ACCOUNT_SCOPED_SETTINGS_CATALOG);
    // These were briefly account settings, but they target a specific checked-out
    // repo and can poison every run when stored globally. Repo target now resolves
    // from cwd or explicit in-memory config objects only.
    this._db.prepare(`DELETE FROM account_settings WHERE setting_key IN ('atlas_repo_id', 'atlas_repo_path', 'target_branch')`).run();
  }

  _migrateAtlasPrefetchEntrypointRankDefault() {
    const markerKey = "atlas_prefetch_entrypoint_rank_default_migrated_at";
    const marker = this._db
      .prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`)
      .get(markerKey);
    if (marker) return;

    this._db
      .prepare(
        `UPDATE account_settings
           SET setting_value = 'on',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE setting_key = 'atlas_prefetch_entrypoint_rank'
           AND lower(trim(setting_value)) = 'off'`,
      )
      .run();
    this._db
      .prepare(`INSERT OR IGNORE INTO account_settings (setting_key, setting_value) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(markerKey);
  }

  _migrateAtlasToolGateDefault() {
    const markerKey = "atlas_tool_gate_default_migrated_at";
    const marker = this._db
      .prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`)
      .get(markerKey);
    if (marker) return;

    const gateRow = this._db
      .prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`)
      .get("atlas_tool_gate_enabled");
    const gateValue = String(gateRow?.setting_value ?? "").trim().toLowerCase();
    if (gateRow && gateValue === "") {
      this._db
        .prepare(
          `UPDATE account_settings
             SET setting_value = 'true',
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE setting_key = 'atlas_tool_gate_enabled'`,
        )
        .run();
    }
    this._db
      .prepare(`INSERT OR IGNORE INTO account_settings (setting_key, setting_value) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .run(markerKey);
  }
}

let _defaultAccountSettings = null;

export function getDefaultAccountSettings() {
  if (!_defaultAccountSettings) _defaultAccountSettings = new AccountSettings();
  return _defaultAccountSettings;
}
