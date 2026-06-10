import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";
import {
  getAccountSetting,
  setAccountSetting,
} from "../../settings/functions/account-settings.js";

const TOKEN_BYTES = 32;
const DEFAULT_RELAY_WS_URL = "wss://app.yourposseai.com/v1/instance";

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

export function ensureBridgeInstanceId() {
  const existing = readSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID);
  if (existing) return existing;
  const instanceId = randomInstanceId();
  writeSetting(SETTING_KEYS.BRIDGE_INSTANCE_ID, instanceId);
  return instanceId;
}

export function getBridgeLabel(projectDir = process.cwd()) {
  const configured = readSetting(SETTING_KEYS.BRIDGE_LABEL);
  if (configured) return configured;
  const folder = path.basename(projectDir || process.cwd());
  return `${folder || "posse"} @ ${os.hostname() || "local"}`;
}

export function getBridgePort() {
  const raw = readSetting(SETTING_KEYS.BRIDGE_PORT);
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  return getCatalogRuntimeFallbackInt(SETTING_KEYS.BRIDGE_PORT, 7531);
}

export function getBridgeBindHost() {
  return readSetting(SETTING_KEYS.BRIDGE_BIND_HOST) || "127.0.0.1";
}

export function getBridgeRelayToken() {
  return readSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN);
}

export function setBridgeRelayToken(token) {
  writeSetting(SETTING_KEYS.BRIDGE_RELAY_TOKEN, token);
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
  return {
    bindHost: getBridgeBindHost(),
    port: getBridgePort(),
    token: ensureBridgeLocalToken(),
    relayToken: getBridgeRelayToken(),
    relayUrl: getBridgeRelayUrl(),
    instanceId: ensureBridgeInstanceId(),
    label: getBridgeLabel(projectDir),
  };
}
