import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../queue/functions/index.js";

export const POSSE_REMOTE_DEFAULT_URL = "https://api.yourposseai.com";
export const POSSE_REMOTE_DEFAULT_TIMEOUT_MS = 60_000;
export const POSSE_REMOTE_MODE = "required";

export function normalizePosseRemoteMode(value) {
  return POSSE_REMOTE_MODE;
}

export function getPosseRemoteMode() {
  return POSSE_REMOTE_MODE;
}

function settingValue(key) {
  try {
    const value = getSetting(key);
    return value == null ? "" : String(value).trim();
  } catch {
    return "";
  }
}

export function getPosseRemoteUrl() {
  // The frozen task A/B harness may target an isolated loopback compiler so
  // prompt-policy candidates can be exercised before deployment. Production
  // continues to use the singular compiled origin.
  if (process.env.POSSE_TEST_RUN) {
    const testUrl = String(process.env.POSSE_REMOTE_URL || "").trim();
    if (testUrl) return testUrl;
  }
  // Singular authoritative remote — the compiled default. No longer a settable
  // knob: `posse_remote_url` was an early-testing override that could strand the
  // client (and native heartbeat auth) on a dead localhost endpoint. Always
  // return the compiled URL.
  return POSSE_REMOTE_DEFAULT_URL;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getPosseRemoteTimeoutMs() {
  return positiveInteger(settingValue(SETTING_KEYS.POSSE_REMOTE_TIMEOUT_MS))
    || POSSE_REMOTE_DEFAULT_TIMEOUT_MS;
}

export function getPosseRemoteResponseSigningSecret() {
  return settingValue(SETTING_KEYS.POSSE_REMOTE_RESPONSE_SIGNING_SECRET);
}
