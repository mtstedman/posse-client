// lib/domains/providers/functions/codex/auth.js

import fs from "fs";
import os from "os";
import path from "path";
import { readModelSetting } from "./settings.js";

function getAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

function hasCodexLoginAuth() {
  return fs.existsSync(getAuthPath());
}

function hasCodexApiAuth() {
  return !!process.env.CODEX_API_KEY || !!process.env.OPENAI_API_KEY;
}

export function normalizeConfiguredAuthMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "oauth";
  if (raw === "oauth" || raw === "login") return "oauth";
  if (raw === "api" || raw === "api_key" || raw === "apikey") return "api";
  if (raw === "auto") return "auto";
  return "oauth";
}

export function getConfiguredCodexAuthMode() {
  return normalizeConfiguredAuthMode(
    readModelSetting("codex_auth_mode")
      || "oauth"
  );
}

export function resolveCodexAuthModeInternal({
  configuredMode = "auto",
  loginAvailable = hasCodexLoginAuth(),
  apiAvailable = hasCodexApiAuth(),
} = {}) {
  const mode = normalizeConfiguredAuthMode(configuredMode);
  if (mode === "oauth") {
    if (!loginAvailable) {
      return {
        ok: false,
        configuredMode: mode,
        mode: "oauth",
        reason: "Codex auth mode is oauth but ~/.codex/auth.json was not found. Run `codex login`. API-key auth is disabled unless codex_auth_mode is explicitly api.",
      };
    }
    return { ok: true, configuredMode: mode, mode: "oauth", reason: null };
  }
  if (mode === "api") {
    if (!apiAvailable) {
      return {
        ok: false,
        configuredMode: mode,
        mode: "api",
        reason: "Codex auth mode is api but CODEX_API_KEY/OPENAI_API_KEY is not set.",
      };
    }
    return { ok: true, configuredMode: mode, mode: "api", reason: null };
  }

  if (loginAvailable) return { ok: true, configuredMode: mode, mode: "oauth", reason: null };
  return {
    ok: false,
    configuredMode: mode,
    mode: "oauth",
    reason: "Codex auth mode is auto but ~/.codex/auth.json was not found. Run `codex login`. API keys are only used when codex_auth_mode is explicitly api.",
  };
}

export function getPreferredCodexAuthMode() {
  return resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() }).mode;
}

export function hasCredentials() {
  return resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() }).ok;
}

export function __testResolveCodexAuthMode(configuredMode, loginAvailable, apiAvailable) {
  return resolveCodexAuthModeInternal({ configuredMode, loginAvailable, apiAvailable });
}
