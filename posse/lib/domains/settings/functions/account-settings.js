// Stateful account settings now live under lib/domains/settings/classes/AccountSettings.js.
// This module remains as a strangler wrapper for existing call sites.

import { getDefaultAccountSettings } from "../classes/AccountSettings.js";

export function getAccountSetting(key) {
  return getDefaultAccountSettings().get(key);
}

export function getAccountRepoSetting(key, repoPath) {
  return getDefaultAccountSettings().getRepo(key, repoPath);
}

export function setAccountSetting(key, value) {
  getDefaultAccountSettings().set(key, value);
}

export function setAccountRepoSetting(key, value, repoPath) {
  getDefaultAccountSettings().setRepo(key, value, repoPath);
}

export function claimAccountSettingIfAbsent(key, value) {
  return getDefaultAccountSettings().claimAccountValueIfAbsent(key, value);
}

export function setAccountSettings(updates = {}) {
  getDefaultAccountSettings().setMany(updates);
}

export function listAccountSettings() {
  return getDefaultAccountSettings().getAll();
}

export function listAccountRepoSettings(repoPath) {
  return getDefaultAccountSettings().getAllRepo(repoPath);
}

export function getAccountSettingsPathForDisplay() {
  return getDefaultAccountSettings().getPathForDisplay();
}

export function getAccountSettingsDataVersion() {
  return getDefaultAccountSettings().getDataVersion();
}

export function setAccountSettingsPathForTests(dbPath = null) {
  setAccountSettingsDbPathForTests(dbPath);
}

export function setAccountSettingsDbPathForTests(dbPath = null) {
  getDefaultAccountSettings().setDbPathForTests(dbPath);
}

export function closeAccountSettingsDb() {
  getDefaultAccountSettings().close();
}
