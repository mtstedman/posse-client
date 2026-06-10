import path from "path";
import { execFileSync } from "child_process";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { normalizeProjectDir } from "../../runtime/functions/paths.js";
import { getCatalogEntry } from "../../settings/functions/catalog.js";
import {
  getAccountRepoSetting,
  getAccountSetting,
  getAccountSettingsDataVersion,
  listAccountRepoSettings,
  listAccountSettings,
  setAccountRepoSetting,
  setAccountSetting,
} from "../../settings/functions/account-settings.js";

export const REPO_SCOPED_SETTING_KEYS = new Set([SETTING_KEYS.TARGET_BRANCH]);

function normalizeOptions(options = {}) {
  if (typeof options === "string") return { projectDir: options };
  return options && typeof options === "object" ? options : {};
}

function settingProjectDir(projectDir = null) {
  if (projectDir != null && String(projectDir).trim() !== "") return path.resolve(String(projectDir));
  if (process.env.POSSE_PROJECT_DIR && String(process.env.POSSE_PROJECT_DIR).trim() !== "") {
    return path.resolve(process.env.POSSE_PROJECT_DIR);
  }
  return normalizeProjectDir();
}

export function resolveRepoSettingPath(projectDir = null) {
  const cwd = settingProjectDir(projectDir);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    return path.resolve(root || cwd);
  } catch {
    return cwd;
  }
}

function catalogDefaultFor(key) {
  const entry = getCatalogEntry(key);
  return entry?.default == null ? "" : String(entry.default);
}

export function getSetting(key, options = {}) {
  const normalizedKey = String(key);
  const opts = normalizeOptions(options);
  if (REPO_SCOPED_SETTING_KEYS.has(normalizedKey)) {
    const repoValue = getAccountRepoSetting(normalizedKey, resolveRepoSettingPath(opts.projectDir));
    return repoValue != null ? repoValue : null;
  }
  const globalValue = getAccountSetting(normalizedKey);
  return globalValue != null ? globalValue : null;
}

// Read a setting and parse it as a base-10 integer, returning `fallback` if
// the setting is missing or unparseable. Consolidates the
// `parseInt(getSetting(key), 10) || N` pattern that appears in many call
// sites.
export function getIntSetting(key, fallback = null, options = {}) {
  const raw = getSetting(key, options);
  if (raw == null || String(raw).trim() === "") return fallback;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getProviderForRole(role) {
  try {
    const dbVal = getSetting(`provider_${role}`);
    if (dbVal) return dbVal;
  } catch { /* DB not ready */ }
  return "claude";
}

export function setSetting(key, value, options = {}) {
  const normalizedKey = String(key);
  const opts = normalizeOptions(options);
  if (REPO_SCOPED_SETTING_KEYS.has(normalizedKey)) {
    setAccountRepoSetting(normalizedKey, value, resolveRepoSettingPath(opts.projectDir));
    return;
  }
  // setAccountSetting notifies downstream caches (e.g. the ATLAS config cache)
  // so bulk/direct writers don't silently drift from this code path.
  setAccountSetting(normalizedKey, value);
}

export function listSettings(options = {}) {
  const opts = normalizeOptions(options);
  const repoPath = resolveRepoSettingPath(opts.projectDir);
  const repoRowsByKey = new Map(
    listAccountRepoSettings(repoPath)
      .filter((entry) => REPO_SCOPED_SETTING_KEYS.has(entry.setting_key))
      .map((entry) => [entry.setting_key, entry]),
  );
  const rows = listAccountSettings()
    .filter((entry) => !REPO_SCOPED_SETTING_KEYS.has(entry.setting_key))
    .map((entry) => ({
      ...entry,
      source: "global",
    }));

  for (const key of REPO_SCOPED_SETTING_KEYS) {
    const repoRow = repoRowsByKey.get(key);
    rows.push(repoRow
      ? { ...repoRow, source: "repo", repo_path: repoPath }
      : {
        repo_path: repoPath,
        setting_key: key,
        setting_value: catalogDefaultFor(key),
        updated_at: null,
        source: "repo",
      });
  }

  return rows.sort((a, b) => String(a.setting_key).localeCompare(String(b.setting_key)));
}

export function getSettingsDataVersion() {
  return getAccountSettingsDataVersion();
}
