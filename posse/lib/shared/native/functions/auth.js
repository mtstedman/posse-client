// @ts-check
//
// Shared auth envelope builder for key-gated native Posse binaries. The Rust
// binaries receive runtime tuning as JSON, so this helper is the one place that
// translates account settings into the heartbeat config object.

import { getSetting } from "../../../domains/queue/functions/index.js";
import { POSSE_REMOTE_DEFAULT_URL } from "../../../domains/remote/functions/mode.js";

export const NATIVE_HEARTBEAT_SETTING_KEYS = Object.freeze({
  heartbeatUrl: "posse_native_heartbeat_url",
  publicKeyUrl: "posse_native_heartbeat_public_key_url",
  publicKey: "posse_native_heartbeat_jwt_public_key",
  publicKeySha256: "posse_native_heartbeat_jwt_public_key_sha256",
  audience: "posse_native_heartbeat_jwt_audience",
  timeoutSeconds: "posse_native_heartbeat_timeout_seconds",
  remoteUrl: "posse_remote_url",
});

// Environment fallbacks for the heartbeat config, used when the account db has
// no stored value. This lets a process supply native auth without a configured
// account db (e.g. the test runner, or short-lived CLI invocations).
export const NATIVE_HEARTBEAT_ENV_KEYS = Object.freeze({
  heartbeatUrl: "POSSE_NATIVE_HEARTBEAT_URL",
  publicKeyUrl: "POSSE_NATIVE_HEARTBEAT_PUBLIC_KEY_URL",
  publicKey: "POSSE_NATIVE_HEARTBEAT_JWT_PUBLIC_KEY",
  publicKeySha256: "POSSE_NATIVE_HEARTBEAT_JWT_PUBLIC_KEY_SHA256",
  audience: "POSSE_NATIVE_HEARTBEAT_JWT_AUDIENCE",
  timeoutSeconds: "POSSE_NATIVE_HEARTBEAT_TIMEOUT_SECONDS",
  remoteUrl: "POSSE_REMOTE_URL",
});

function settingOrEnv(field, getSettingFn) {
  const fromSetting = getSettingText(NATIVE_HEARTBEAT_SETTING_KEYS[field], { getSettingFn });
  if (fromSetting) return fromSetting;
  return String(process.env[NATIVE_HEARTBEAT_ENV_KEYS[field]] || "").trim();
}

/**
 * @param {string} key
 * @param {{ getSettingFn?: (key: string) => unknown }} [opts]
 * @returns {string}
 */
export function getSettingText(key, { getSettingFn = getSetting } = {}) {
  try {
    return String(getSettingFn(key) || "").trim();
  } catch {
    return "";
  }
}

function urlBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// Compiled trust root for the DEFAULT remote's heartbeat signer: the PUBLIC
// verification key + its sha256 + the JWT audience served by
// POSSE_REMOTE_DEFAULT_URL/v1/native/public-key. These are public (verification
// only — never the signing key, which never leaves the remote), pinned here so
// the key-gated binaries authenticate out of the box with zero configuration.
// Overridable via settings/env (custom remote, or a rotated pin before a release
// ships the new value). Only applied when pointed at the default remote.
const DEFAULT_HEARTBEAT_PUBLIC_KEY = "k2snf5sbudyEzeSfggF5ahnjqOZwN+GRlB/UIYh8sjA=";
const DEFAULT_HEARTBEAT_PUBLIC_KEY_SHA256 = "f8d47974dfb948147da25b58c88d9b7f7c8c26d010bbd717e1bd05a69b2d45e2";
const DEFAULT_HEARTBEAT_AUDIENCE = "posse-native-binaries";

/**
 * @param {{ remoteUrl?: string, defaultRemoteUrl?: string }} [opts]
 * @returns {string}
 */
export function deriveNativeHeartbeatUrl({
  remoteUrl = "",
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  const base = urlBase(remoteUrl) || urlBase(defaultRemoteUrl);
  return base ? `${base}/v1/native/heartbeat` : "";
}

/**
 * @param {{ remoteUrl?: string, defaultRemoteUrl?: string }} [opts]
 * @returns {string}
 */
export function deriveNativeHeartbeatPublicKeyUrl({
  remoteUrl = "",
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  const base = urlBase(remoteUrl) || urlBase(defaultRemoteUrl);
  return base ? `${base}/v1/native/public-key` : "";
}

/**
 * @param {{ getSettingFn?: (key: string) => unknown, defaultRemoteUrl?: string }} [opts]
 * @returns {Record<string, unknown> | null}
 */
export function nativeHeartbeatAuthFromSettings({
  getSettingFn = getSetting,
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  const current = {
    heartbeatUrl: settingOrEnv("heartbeatUrl", getSettingFn),
    publicKeyUrl: settingOrEnv("publicKeyUrl", getSettingFn),
    publicKey: settingOrEnv("publicKey", getSettingFn),
    publicKeySha256: settingOrEnv("publicKeySha256", getSettingFn),
    audience: settingOrEnv("audience", getSettingFn),
    timeoutSeconds: settingOrEnv("timeoutSeconds", getSettingFn),
  };
  // The remote is always-on AND singular: heartbeat auth is mandatory for the
  // key-gated native binaries (git is hard-on), and there is exactly ONE
  // authoritative remote — the compiled default. It is NOT a configurable knob
  // (the old `posse_remote_url` override was an early-testing artifact that could
  // strand auth on a stale localhost endpoint). A fresh install with no config
  // authenticates out of the box: both URLs + the pinned trust root come from
  // the compiled default. The remaining env/setting overrides exist only to pin
  // or pre-fetch a key for offline test runs.
  /** @type {Record<string, unknown>} */
  const auth = {};
  auth.heartbeatUrl = current.heartbeatUrl || deriveNativeHeartbeatUrl({ defaultRemoteUrl });
  auth.heartbeatPublicKeyUrl = current.publicKeyUrl || deriveNativeHeartbeatPublicKeyUrl({ defaultRemoteUrl });
  const publicKey = current.publicKey || DEFAULT_HEARTBEAT_PUBLIC_KEY;
  const publicKeySha256 = current.publicKeySha256 || DEFAULT_HEARTBEAT_PUBLIC_KEY_SHA256;
  const audience = current.audience || DEFAULT_HEARTBEAT_AUDIENCE;
  if (publicKey) auth.heartbeatJwtPublicKey = publicKey;
  if (publicKeySha256) auth.heartbeatJwtPublicKeySha256 = publicKeySha256;
  if (audience) auth.heartbeatJwtAudience = audience;
  if (current.timeoutSeconds) {
    const parsed = Number.parseInt(current.timeoutSeconds, 10);
    if (Number.isFinite(parsed) && parsed > 0) auth.heartbeatTimeoutSeconds = parsed;
  }
  return auth.heartbeatUrl ? auth : null;
}
