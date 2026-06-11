import { getSetting, setSetting } from "../lib/domains/queue/functions/settings.js";
import { nativeBinaryIsKeyGated } from "../lib/catalog/binary.js";
import { POSSE_REMOTE_DEFAULT_URL } from "../lib/domains/remote/functions/mode.js";

export const NATIVE_HEARTBEAT_PUBLIC_KEY_TIMEOUT_MS = 15_000;

const SETTING_KEYS = Object.freeze({
  heartbeatUrl: "posse_native_heartbeat_url",
  publicKeyUrl: "posse_native_heartbeat_public_key_url",
  publicKey: "posse_native_heartbeat_jwt_public_key",
  publicKeySha256: "posse_native_heartbeat_jwt_public_key_sha256",
  audience: "posse_native_heartbeat_jwt_audience",
  remoteUrl: "posse_remote_url",
});

function settingText(value) {
  return String(value || "").trim();
}

function urlBase(value) {
  const text = settingText(value).replace(/\/+$/, "");
  return text || "";
}

function selectedIncludesKeyGatedNative(selectedBinaries) {
  return !Array.isArray(selectedBinaries) || selectedBinaries.some((name) => nativeBinaryIsKeyGated(name));
}

export function deriveNativeHeartbeatPublicKeyUrl(heartbeatUrl) {
  const parsed = new URL(settingText(heartbeatUrl));
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[parts.length - 1] === "heartbeat") parts.pop();
  parts.push("public-key");
  parsed.pathname = `/${parts.join("/")}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function nativeHeartbeatUrlsFromSettings({
  publicKeyUrl = "",
  heartbeatUrl = "",
  remoteUrl = "",
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  const configuredPublicKeyUrl = settingText(publicKeyUrl);
  const configuredHeartbeatUrl = settingText(heartbeatUrl);
  if (configuredPublicKeyUrl) {
    return {
      heartbeatUrl: configuredHeartbeatUrl,
      publicKeyUrl: configuredPublicKeyUrl,
      heartbeatUrlDerived: false,
    };
  }

  if (configuredHeartbeatUrl) {
    return {
      heartbeatUrl: configuredHeartbeatUrl,
      publicKeyUrl: deriveNativeHeartbeatPublicKeyUrl(configuredHeartbeatUrl),
      heartbeatUrlDerived: false,
    };
  }

  const remoteBase = urlBase(remoteUrl) || urlBase(defaultRemoteUrl);
  return {
    heartbeatUrl: `${remoteBase}/v1/native/heartbeat`,
    publicKeyUrl: `${remoteBase}/v1/native/public-key`,
    heartbeatUrlDerived: true,
  };
}

export function parseNativeHeartbeatPublicKeyResponse(body) {
  const text = settingText(body);
  if (!text) throw new Error("native heartbeat public-key response was empty");

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { publicKey: text, publicKeySha256: "", audience: "" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("native heartbeat public-key response must be an object or public-key string");
  }
  const alg = settingText(parsed.alg);
  if (alg && alg !== "EdDSA" && alg !== "Ed25519") {
    throw new Error(`native heartbeat public-key response used unsupported alg: ${alg}`);
  }
  const publicKey = settingText(parsed.public_key || parsed.publicKey);
  if (!publicKey) throw new Error("native heartbeat public-key response omitted public_key");
  return {
    publicKey,
    publicKeySha256: settingText(parsed.public_key_sha256 || parsed.publicKeySha256),
    audience: settingText(parsed.audience),
  };
}

async function fetchPublicKey(url, { fetchFn = globalThis.fetch, timeoutMs = NATIVE_HEARTBEAT_PUBLIC_KEY_TIMEOUT_MS } = {}) {
  if (typeof fetchFn !== "function") throw new Error("global fetch is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}: ${body.trim()}`);
    }
    return parseNativeHeartbeatPublicKeyResponse(body);
  } finally {
    clearTimeout(timer);
  }
}

function writeIfMissing({ key, value, current, dryRun, setSettingFn, logFn }) {
  if (!value || settingText(current)) return false;
  if (dryRun) {
    logFn(`[native-heartbeat-public-key] would set ${key}`);
    return true;
  }
  setSettingFn(key, value);
  logFn(`[native-heartbeat-public-key] set ${key}`);
  return true;
}

export async function ensureNativeHeartbeatPublicKey({
  selectedBinaries = null,
  skip = false,
  dryRun = false,
  publicKeyUrl = "",
  timeoutMs = NATIVE_HEARTBEAT_PUBLIC_KEY_TIMEOUT_MS,
  getSettingFn = getSetting,
  setSettingFn = setSetting,
  fetchFn = globalThis.fetch,
  logFn = console.log,
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  if (skip || !selectedIncludesKeyGatedNative(selectedBinaries)) {
    return { skipped: true, reason: skip ? "disabled" : "no key-gated native binaries selected" };
  }

  const currentPublicKey = settingText(getSettingFn(SETTING_KEYS.publicKey));
  if (currentPublicKey) {
    logFn("[native-heartbeat-public-key] public key already configured");
    return { skipped: true, reason: "public key already configured" };
  }

  const current = {
    heartbeatUrl: getSettingFn(SETTING_KEYS.heartbeatUrl),
    publicKeyUrl: getSettingFn(SETTING_KEYS.publicKeyUrl),
    publicKey: currentPublicKey,
    publicKeySha256: getSettingFn(SETTING_KEYS.publicKeySha256),
    audience: getSettingFn(SETTING_KEYS.audience),
  };
  const urls = nativeHeartbeatUrlsFromSettings({
    publicKeyUrl: publicKeyUrl || current.publicKeyUrl,
    heartbeatUrl: current.heartbeatUrl,
    remoteUrl: getSettingFn(SETTING_KEYS.remoteUrl),
    defaultRemoteUrl,
  });

  if (dryRun) {
    logFn(`[native-heartbeat-public-key] would fetch ${urls.publicKeyUrl}`);
    writeIfMissing({
      key: SETTING_KEYS.heartbeatUrl,
      value: urls.heartbeatUrl,
      current: current.heartbeatUrl,
      dryRun,
      setSettingFn,
      logFn,
    });
    return { skipped: true, reason: "dry run", publicKeyUrl: urls.publicKeyUrl };
  }

  const fetched = await fetchPublicKey(urls.publicKeyUrl, { fetchFn, timeoutMs });
  const wrote = [];
  if (writeIfMissing({
    key: SETTING_KEYS.heartbeatUrl,
    value: urls.heartbeatUrl,
    current: current.heartbeatUrl,
    dryRun,
    setSettingFn,
    logFn,
  })) wrote.push(SETTING_KEYS.heartbeatUrl);
  if (writeIfMissing({
    key: SETTING_KEYS.publicKey,
    value: fetched.publicKey,
    current: current.publicKey,
    dryRun,
    setSettingFn,
    logFn,
  })) wrote.push(SETTING_KEYS.publicKey);
  if (writeIfMissing({
    key: SETTING_KEYS.publicKeySha256,
    value: fetched.publicKeySha256,
    current: current.publicKeySha256,
    dryRun,
    setSettingFn,
    logFn,
  })) wrote.push(SETTING_KEYS.publicKeySha256);
  if (writeIfMissing({
    key: SETTING_KEYS.audience,
    value: fetched.audience,
    current: current.audience,
    dryRun,
    setSettingFn,
    logFn,
  })) wrote.push(SETTING_KEYS.audience);

  return {
    skipped: false,
    publicKeyUrl: urls.publicKeyUrl,
    heartbeatUrl: urls.heartbeatUrl,
    wrote,
  };
}
