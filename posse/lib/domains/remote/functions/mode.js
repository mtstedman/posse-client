import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../queue/functions/index.js";

export const POSSE_REMOTE_DEFAULT_URL = "https://api.yourposseai.com";
export const POSSE_REMOTE_DEFAULT_TIMEOUT_MS = 60_000;
export const POSSE_REMOTE_MODE = "required";
const AGENT_FLOW_REMOTE_FLAG = "POSSE_AGENT_FLOW_HARNESS";
const AGENT_FLOW_REMOTE_URL = "POSSE_AGENT_FLOW_REMOTE_URL";

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

export function getAgentFlowRemoteUrl(env = process.env) {
  if (String(env?.[AGENT_FLOW_REMOTE_FLAG] || "").trim() !== "1") return "";
  const raw = String(env?.[AGENT_FLOW_REMOTE_URL] || "").trim();
  if (!raw) {
    throw new Error(`${AGENT_FLOW_REMOTE_URL} is required when ${AGENT_FLOW_REMOTE_FLAG}=1`);
  }
  try {
    const parsed = new URL(raw);
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "http:" || !loopback || parsed.username || parsed.password) {
      throw new Error(`${AGENT_FLOW_REMOTE_URL} must be an unauthenticated http:// loopback URL`);
    }
    return parsed.href.replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${AGENT_FLOW_REMOTE_URL} `)) throw error;
    throw new Error(`${AGENT_FLOW_REMOTE_URL} is invalid`, { cause: error });
  }
}

export function getPosseRemoteUrl({ env = process.env } = {}) {
  const experimentUrl = getAgentFlowRemoteUrl(env);
  if (experimentUrl) return experimentUrl;
  // Singular authoritative remote — the compiled default. No longer a settable
  // knob: `posse_remote_url` was an early-testing override that could strand the
  // client (and native heartbeat auth) on a dead localhost endpoint. The only
  // override is a loopback-only, double-gated full-funnel experiment endpoint;
  // native heartbeat auth remains pinned to the compiled production identity.
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
