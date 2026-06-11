import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import {
  getAccountRepoSetting,
  getAccountSetting,
  setAccountRepoSetting,
  setAccountSetting,
} from "../../settings/functions/account-settings.js";
import { getDefaultAccountSettings } from "../../settings/classes/AccountSettings.js";

const TOKEN_BYTES = 32;
const DEFAULT_RELAY_WS_URL = "wss://app.yourposseai.com/v1/instance";
// Port scan range when no repo port is persisted. Two repos serving
// concurrently land on consecutive ports; the winner is persisted so the
// port stays stable for LAN clients across restarts.
export const BRIDGE_PORT_SCAN_START = 7531;
export const BRIDGE_PORT_SCAN_END = 7551;

function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function randomInstanceId() {
  return `posse-${crypto.randomUUID()}`;
}

function readSetting(key) {
  try {
    return String(getAccountSetting(key) || "").trim();
  } catch {
    return "";
  }
}

function writeSetting(key, value) {
  setAccountSetting(key, String(value ?? ""));
}

function readRepoSetting(key, projectDir) {
  try {
    return String(getAccountRepoSetting(key, projectDir) || "").trim();
  } catch {
    return "";
  }
}

function writeRepoSetting(key, value, projectDir) {
  setAccountRepoSetting(key, String(value ?? ""), projectDir);
}

// Bridge identity moved from account scope to repo scope so one machine can
// expose N repos as N relay instances. Repo-scoped keys are invisible to
// getAccountSetting(), so the claim-once migration reads the legacy global
// rows directly from the account_settings table.
function readLegacyGlobalSetting(key) {
  try {
    return String(getDefaultAccountSettings().getRawAccountValue(key) || "").trim();
  } catch {
    return "";
  }
}

export function ensureBridgeLocalToken() {
  const existing = readSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN);
  if (existing) return existing;
  const token = randomToken();
  writeSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN, token);
  return token;
}

export function rotateBridgeLocalToken() {
  const token = randomToken();
  writeSetting(SETTING_KEYS.BRIDGE_LOCAL_TOKEN, token);
  return token;
}

/**
 * One-time migration: bridge identity used to live in account scope (one
 * identity per machine). The first repo that asks for its bridge config
 * after the upgrade claims the legacy global identity — so the machine's
 * existing relay pairing keeps working unchanged for that repo — and a
 * marker prevents any other repo from claiming it. Other repos mint fresh
 * identities and pair once each. Legacy global rows are left in place so
 * older binaries reading them keep working.
 */
function claimLegacyGlobalIdentityIfFirst(projectDir) {
  if (readRepoSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID, projectDir)) return;
  if (readSetting(SETTING_KEYS.BRIDGE_IDENTITY_MIGRATED_TO)) return;
  const legacyInstanceId = readLegacyGlobalSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID);
  if (!legacyInstanceId) return;
  writeRepoSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID, legacyInstanceId, projectDir);
  const legacyRelayToken = readLegacyGlobalSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN);
  if (legacyRelayToken) {
    writeRepoSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN, legacyRelayToken, projectDir);
  }
  const legacyLabel = readLegacyGlobalSetting(SETTING_KEYS.BRIDGE_LABEL);
  if (legacyLabel) {
    writeRepoSetting(SETTING_KEYS.BRIDGE_LABEL, legacyLabel, projectDir);
  }
  const legacyPort = readLegacyGlobalSetting(SETTING_KEYS.BRIDGE_PORT);
  if (legacyPort) {
    writeRepoSetting(SETTING_KEYS.BRIDGE_PORT, legacyPort, projectDir);
  }
  writeSetting(
    SETTING_KEYS.BRIDGE_IDENTITY_MIGRATED_TO,
    String(projectDir || process.cwd()),
  );
}

export function ensureBridgeInstanceId(projectDir = process.cwd()) {
  claimLegacyGlobalIdentityIfFirst(projectDir);
  const existing = readRepoSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID, projectDir);
  if (existing) return existing;
  const instanceId = randomInstanceId();
  writeRepoSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID, instanceId, projectDir);
  return instanceId;
}

export function getBridgeLabel(projectDir = process.cwd()) {
  const configured = readRepoSetting(SETTING_KEYS.BRIDGE_LABEL, projectDir);
  if (configured) return configured;
  const folder = path.basename(projectDir || process.cwd());
  return `${folder || "posse"} @ ${os.hostname() || "local"}`;
}

/**
 * Persisted repo port, or null when unset — the bridge then scans
 * BRIDGE_PORT_SCAN_START..END for a free port and persists the winner via
 * setBridgePort().
 */
export function getBridgePort(projectDir = process.cwd()) {
  const raw = readRepoSetting(SETTING_KEYS.BRIDGE_PORT, projectDir);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  return null;
}

export function setBridgePort(port, projectDir = process.cwd()) {
  writeRepoSetting(SETTING_KEYS.BRIDGE_PORT, String(port), projectDir);
}

export function getBridgeBindHost() {
  return readSetting(SETTING_KEYS.BRIDGE_BIND_HOST) || "127.0.0.1";
}

export function getBridgeRelayToken(projectDir = process.cwd()) {
  claimLegacyGlobalIdentityIfFirst(projectDir);
  return readRepoSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN, projectDir);
}

export function setBridgeRelayToken(token, projectDir = process.cwd()) {
  writeRepoSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN, token, projectDir);
}

export function getBridgeRelayUrl() {
  const relayUrl = readSetting(SETTING_KEYS.BRIDGE_RELAY_URL) || DEFAULT_RELAY_WS_URL;
  let parsed = null;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error("bridge_relay_url must be a valid wss: URL");
  }
  if (parsed.protocol !== "wss:") {
    throw new Error("bridge_relay_url must use wss: so relay bearer tokens are never sent over plaintext WebSockets");
  }
  return relayUrl;
}

export function bridgeAuthHeader(token) {
  return `Bearer ${token}`;
}

export function extractBearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(header || "").trim());
  return match ? match[1].trim() : "";
}

export function timingSafeTokenEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a || ""), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(b || ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

export function isAuthorizedRequest(req, token) {
  return timingSafeTokenEqual(extractBearerToken(req), token);
}

/**
 * Legacy authorization helper for callers that still authenticate a WebSocket
 * upgrade request before protocol frames are exchanged.
 *
 * Previous versions accepted `?token=<value>` in the upgrade URL — that
 * route was dropped because reverse proxies log full URLs (the protocol
 * doc explicitly says tokens belong in the hello body, not in URLs).
 *
 * `requestUrl` is kept in the signature for back-compat with callers that
 * pre-parsed the URL, but it is no longer consulted for token data.
 */
export function isAuthorizedWebSocketRequest(req, token, _requestUrl = null) {
  return isAuthorizedRequest(req, token);
}

export function getBridgeConfig(projectDir = process.cwd()) {
  // Repo-scoped identity: one relay instance per repo. Local LAN token and
  // relay URL stay machine-global. `port` may be null (auto-pick at bind).
  // Claim runs first so a legacy global identity (incl. port/label) is
  // visible to every getter below in the same call.
  claimLegacyGlobalIdentityIfFirst(projectDir);
  return {
    bindHost: getBridgeBindHost(),
    port: getBridgePort(projectDir),
    token: ensureBridgeLocalToken(),
    relayToken: getBridgeRelayToken(projectDir),
    relayUrl: getBridgeRelayUrl(),
    instanceId: ensureBridgeInstanceId(projectDir),
    label: getBridgeLabel(projectDir),
  };
}
