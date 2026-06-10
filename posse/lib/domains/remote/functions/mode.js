import { SETTING_KEYS, POSSE_REMOTE_MODE_VALUES } from "../../../catalog/settings.js";
import { getSetting } from "../../queue/functions/index.js";

const VALID_MODES = new Set(POSSE_REMOTE_MODE_VALUES);
export const POSSE_REMOTE_DEFAULT_URL = "https://api.yourposseai.com";
export const POSSE_REMOTE_DEFAULT_TIMEOUT_MS = 60_000;

export function normalizePosseRemoteMode(value) {
  const mode = String(value || "required").trim().toLowerCase();
  return VALID_MODES.has(mode) ? mode : "required";
}

export function getPosseRemoteMode() {
  return normalizePosseRemoteMode(getSetting(SETTING_KEYS.POSSE_REMOTE_MODE));
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
