// @ts-check
//
// Trusted auth policy for key-gated native helpers and Node pulse-token
// exchange. Production uses one compiled origin, audience, and verification
// pin set. Alternate trust roots are accepted only through an explicit policy
// object or the isolated node-test bootstrap.

import { getSetting } from "../../../domains/queue/functions/index.js";
import { POSSE_REMOTE_DEFAULT_URL } from "../../../domains/remote/functions/mode.js";

export const NATIVE_HEARTBEAT_SETTING_KEYS = Object.freeze({
  heartbeatUrl: "posse_native_heartbeat_url",
  publicKeyUrl: "posse_native_heartbeat_public_key_url",
  publicKey: "posse_native_heartbeat_jwt_public_key",
  publicKeySha256: "posse_native_heartbeat_jwt_public_key_sha256",
  audience: "posse_native_heartbeat_jwt_audience",
  timeoutSeconds: "posse_native_heartbeat_timeout_seconds",
});

export const NATIVE_HEARTBEAT_ENV_KEYS = Object.freeze({
  heartbeatUrl: "POSSE_NATIVE_HEARTBEAT_URL",
  publicKeyUrl: "POSSE_NATIVE_HEARTBEAT_PUBLIC_KEY_URL",
  publicKey: "POSSE_NATIVE_HEARTBEAT_JWT_PUBLIC_KEY",
  publicKeySha256: "POSSE_NATIVE_HEARTBEAT_JWT_PUBLIC_KEY_SHA256",
  audience: "POSSE_NATIVE_HEARTBEAT_JWT_AUDIENCE",
  timeoutSeconds: "POSSE_NATIVE_HEARTBEAT_TIMEOUT_SECONDS",
});

export const DEFAULT_HEARTBEAT_PUBLIC_KEY = "em4aF4mKM16kp7ZDqMNSppxudu/9JfKG1GUBMAP6Dcg=";
export const DEFAULT_HEARTBEAT_PUBLIC_KEY_SHA256 = "c569b984d5d21ae91620e1a43432283440ece6f9f19135a900aff3a831f8a135";
export const DEFAULT_HEARTBEAT_AUDIENCE = "posse-native-binaries";

const ENVELOPE_FIELDS = Object.freeze([
  "heartbeatUrl",
  "heartbeatPublicKeyUrl",
  "heartbeatJwtPublicKey",
  "heartbeatJwtPublicKeySha256",
  "heartbeatJwtAudience",
  "heartbeatTimeoutSeconds",
]);

/** @param {string} key @param {{ getSettingFn?: (key: string) => unknown }} [opts] */
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

/** @param {{ remoteUrl?: string, defaultRemoteUrl?: string }} [opts] */
export function deriveNativeHeartbeatUrl({
  remoteUrl = "",
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  const base = urlBase(remoteUrl) || urlBase(defaultRemoteUrl);
  return base ? `${base}/v1/native/heartbeat` : "";
}

/** @param {{ remoteUrl?: string, defaultRemoteUrl?: string }} [opts] */
export function deriveNativeHeartbeatPublicKeyUrl({
  remoteUrl = "",
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
} = {}) {
  const base = urlBase(remoteUrl) || urlBase(defaultRemoteUrl);
  return base ? `${base}/v1/native/public-key` : "";
}

/** @param {unknown} value */
export function normalizeNativeAuthEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const envelope = {};
  for (const field of ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    if (field === "heartbeatTimeoutSeconds") {
      const parsed = Number.parseInt(String(source[field] || ""), 10);
      if (Number.isFinite(parsed) && parsed > 0) envelope[field] = parsed;
      continue;
    }
    const text = String(source[field] || "").trim();
    if (text) envelope[field] = text;
  }
  return Object.keys(envelope).length > 0 ? envelope : null;
}

/**
 * @param {{ envelope?: Record<string, unknown> | null, developmentMode?: boolean } | Record<string, unknown> | null} [value]
 */
export function createNativeAuthTrustedPolicy(value = null) {
  const wrapper = value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
  const envelopeInput = Object.prototype.hasOwnProperty.call(wrapper, "envelope")
    ? wrapper.envelope
    : wrapper;
  const envelope = normalizeNativeAuthEnvelope(envelopeInput);
  if (!envelope?.heartbeatUrl) {
    throw nativeAuthPolicyError("POSSE_NATIVE_AUTH_POLICY_INVALID", "trusted heartbeat policy requires a heartbeat URL");
  }
  const heartbeatUrl = validateHeartbeatUrl(String(envelope.heartbeatUrl), wrapper.developmentMode === true);
  envelope.heartbeatUrl = heartbeatUrl.toString();
  if (envelope.heartbeatPublicKeyUrl) {
    const publicKeyUrl = validateAuthUrl(String(envelope.heartbeatPublicKeyUrl), wrapper.developmentMode === true, "heartbeat public-key URL");
    if (publicKeyUrl.origin !== heartbeatUrl.origin) {
      throw nativeAuthPolicyError("POSSE_NATIVE_AUTH_POLICY_INVALID", "heartbeat public-key origin does not match the trusted heartbeat origin");
    }
    envelope.heartbeatPublicKeyUrl = publicKeyUrl.toString();
  }
  return Object.freeze({
    developmentMode: wrapper.developmentMode === true,
    origin: heartbeatUrl.origin,
    envelope: freezeEnvelope(envelope),
  });
}

/**
 * Production policy is compiled and singular. Test/development overrides are
 * enabled only by an explicit argument or the test runner's isolated context.
 *
 * @param {{
 *   getSettingFn?: (key: string) => unknown,
 *   defaultRemoteUrl?: string,
 *   allowDevelopmentOverrides?: boolean,
 * }} [opts]
 */
export function nativeHeartbeatAuthFromSettings({
  getSettingFn = getSetting,
  defaultRemoteUrl = POSSE_REMOTE_DEFAULT_URL,
  allowDevelopmentOverrides = isIsolatedTestContext(),
} = {}) {
  const compiledBase = allowDevelopmentOverrides ? defaultRemoteUrl : POSSE_REMOTE_DEFAULT_URL;
  /** @type {Record<string, unknown>} */
  const auth = {
    heartbeatUrl: deriveNativeHeartbeatUrl({ defaultRemoteUrl: compiledBase }),
    heartbeatPublicKeyUrl: deriveNativeHeartbeatPublicKeyUrl({ defaultRemoteUrl: compiledBase }),
    heartbeatJwtPublicKey: DEFAULT_HEARTBEAT_PUBLIC_KEY,
    heartbeatJwtPublicKeySha256: DEFAULT_HEARTBEAT_PUBLIC_KEY_SHA256,
    heartbeatJwtAudience: DEFAULT_HEARTBEAT_AUDIENCE,
  };

  if (allowDevelopmentOverrides) {
    const heartbeatUrl = settingOrEnv("heartbeatUrl", getSettingFn);
    const publicKeyUrl = settingOrEnv("publicKeyUrl", getSettingFn);
    const publicKey = settingOrEnv("publicKey", getSettingFn);
    const publicKeySha256 = settingOrEnv("publicKeySha256", getSettingFn);
    const audience = settingOrEnv("audience", getSettingFn);
    if (heartbeatUrl) {
      auth.heartbeatUrl = heartbeatUrl;
      if (!publicKeyUrl) {
        try {
          auth.heartbeatPublicKeyUrl = `${new URL(heartbeatUrl).origin}/v1/native/public-key`;
        } catch { /* validated by the trusted-policy boundary */ }
      }
    }
    if (publicKeyUrl) auth.heartbeatPublicKeyUrl = publicKeyUrl;
    if (publicKey) auth.heartbeatJwtPublicKey = publicKey;
    if (publicKeySha256) auth.heartbeatJwtPublicKeySha256 = publicKeySha256;
    if (audience) auth.heartbeatJwtAudience = audience;
  }

  const timeoutSeconds = allowDevelopmentOverrides
    ? settingOrEnv("timeoutSeconds", getSettingFn)
    : getSettingText(NATIVE_HEARTBEAT_SETTING_KEYS.timeoutSeconds, { getSettingFn });
  const parsedTimeout = Number.parseInt(timeoutSeconds, 10);
  if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) auth.heartbeatTimeoutSeconds = parsedTimeout;
  return freezeEnvelope(auth);
}

export function productionNativeAuthTrustedPolicy() {
  return createNativeAuthTrustedPolicy({
    envelope: nativeHeartbeatAuthFromSettings({ allowDevelopmentOverrides: false }),
    developmentMode: false,
  });
}

/** @param {string} field @param {(key: string) => unknown} getSettingFn */
function settingOrEnv(field, getSettingFn) {
  const fromSetting = getSettingText(NATIVE_HEARTBEAT_SETTING_KEYS[field], { getSettingFn });
  if (fromSetting) return fromSetting;
  return String(process.env[NATIVE_HEARTBEAT_ENV_KEYS[field]] || "").trim();
}

function isIsolatedTestContext() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN);
}

/** @param {string} value @param {boolean} developmentMode */
function validateHeartbeatUrl(value, developmentMode) {
  const url = validateAuthUrl(value, developmentMode, "heartbeat URL");
  if (url.pathname.replace(/\/+$/, "") !== "/v1/native/heartbeat" || url.search || url.hash) {
    throw nativeAuthPolicyError("POSSE_NATIVE_AUTH_POLICY_INVALID", "trusted heartbeat URL must use the fixed /v1/native/heartbeat endpoint");
  }
  return url;
}

/** @param {string} value @param {boolean} developmentMode @param {string} label */
function validateAuthUrl(value, developmentMode, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw nativeAuthPolicyError("POSSE_NATIVE_AUTH_POLICY_INVALID", `${label} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw nativeAuthPolicyError("POSSE_NATIVE_AUTH_POLICY_INVALID", `${label} must not contain URL credentials`);
  }
  if (url.protocol === "https:") return url;
  if (developmentMode && url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw nativeAuthPolicyError("POSSE_NATIVE_AUTH_POLICY_INVALID", `${label} must use HTTPS; loopback HTTP requires explicit development mode`);
}

/** @param {string} hostname */
export function isLoopbackHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

/** @param {Record<string, unknown>} envelope */
export function freezeEnvelope(envelope) {
  return Object.freeze({ ...envelope });
}

function nativeAuthPolicyError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}
