// Native heartbeat auth for tests.
//
// The key-gated Posse binaries (posse-git, posse-atlas, ...) require a real
// POSSE_KEY validated against the central heartbeat server on every call —
// there is no offline/keyless path by design. Tests that drive a cut-over
// native method (directly, in-process, or through a spawned orchestrator)
// therefore need two things in place:
//
//   1. A real POSSE_KEY in the environment (the binaries read it at call time).
//   2. The `posse_native_heartbeat_*` account settings pointing at the central
//      remote, so Node hands the binary a heartbeat config to authenticate with.
//
// This helper fetches the central public key once (when a key is present) and
// seeds those settings into whichever account.db a test uses. When no key is
// available, or the public key cannot be fetched, callers skip — we never fake
// the heartbeat or unlock the binaries.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { POSSE_REMOTE_DEFAULT_URL } from "../../../lib/domains/remote/functions/mode.js";
import {
  closeAccountSettingsDb,
  setAccountSettingsPathForTests,
} from "../../../lib/domains/settings/functions/account-settings.js";

const SETTING_KEYS = Object.freeze({
  url: "posse_native_heartbeat_url",
  publicKey: "posse_native_heartbeat_jwt_public_key",
  publicKeySha256: "posse_native_heartbeat_jwt_public_key_sha256",
  audience: "posse_native_heartbeat_jwt_audience",
});

function posseKey() {
  return String(process.env.POSSE_KEY || "").trim();
}

function remoteBase() {
  return String(POSSE_REMOTE_DEFAULT_URL || "").trim().replace(/\/+$/, "");
}

async function fetchHeartbeatSettings() {
  const base = remoteBase();
  if (!base) throw new Error("no default remote URL configured");
  const response = await fetch(`${base}/v1/native/public-key`);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${base}/v1/native/public-key failed with ${response.status}: ${body.trim()}`);
  }
  const parsed = JSON.parse(body);
  const publicKey = String(parsed.public_key || parsed.publicKey || "").trim();
  if (!publicKey) throw new Error("native heartbeat public-key response omitted public_key");
  return {
    [SETTING_KEYS.url]: `${base}/v1/native/heartbeat`,
    [SETTING_KEYS.publicKey]: publicKey,
    [SETTING_KEYS.publicKeySha256]: String(parsed.public_key_sha256 || parsed.publicKeySha256 || "").trim(),
    [SETTING_KEYS.audience]: String(parsed.audience || "").trim(),
  };
}

// Resolve the central heartbeat settings once at import time. Only reaches out
// when a POSSE_KEY is present; on any failure we degrade to "not ready" so
// callers skip rather than fake auth.
let _settings = null;
let _unavailableReason = null;
if (posseKey()) {
  try {
    _settings = await fetchHeartbeatSettings();
  } catch (err) {
    _unavailableReason = `native heartbeat public key unavailable: ${err?.message || err}`;
  }
} else {
  _unavailableReason = "POSSE_KEY is not set";
}

/** @returns {boolean} whether a real key + heartbeat settings are available. */
export function nativeHeartbeatReady() {
  return !!_settings;
}

/**
 * @returns {string | null} skip reason when the native heartbeat is unavailable,
 * suitable for `it(name, { skip: nativeHeartbeatSkipReason() ?? false }, ...)`.
 */
export function nativeHeartbeatSkipReason() {
  return _settings ? null : (_unavailableReason || "native heartbeat unavailable");
}

function writeAccountSetting(db, key, value) {
  db.prepare(`
    INSERT INTO account_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at
  `).run(key, value);
}

/**
 * Seed the central heartbeat settings into the account.db at `dbPath` so a
 * process reading that db (e.g. a spawned orchestrator) can authenticate the
 * key-gated binaries. No-op returning false when the heartbeat is unavailable.
 *
 * @param {string} dbPath
 * @returns {boolean}
 */
export function seedNativeHeartbeat(dbPath) {
  if (!_settings) return false;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    for (const [key, value] of Object.entries(_settings)) {
      if (value) writeAccountSetting(db, key, value);
    }
  } finally {
    db.close();
  }
  return true;
}

/**
 * Point the in-process account settings singleton at a freshly seeded heartbeat
 * db for the duration of a test. Returns a restore function that re-opens the
 * default account settings path.
 *
 * @param {string} dbPath account.db location to seed and read from
 * @returns {() => void} restore callback (always safe to call)
 */
export function installNativeHeartbeatForProcess(dbPath) {
  if (!seedNativeHeartbeat(dbPath)) return () => {};
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(dbPath);
  return () => {
    closeAccountSettingsDb();
    setAccountSettingsPathForTests(null);
  };
}
