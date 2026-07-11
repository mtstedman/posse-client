// @ts-check
//
// Single authority for the raw Posse credential and the non-secret native
// heartbeat trust envelope. Production trust is compiled; child capabilities
// may carry an envelope, but cannot replace the local origin, audience, or
// verification pins.

import {
  createNativeAuthTrustedPolicy,
  freezeEnvelope,
  nativeHeartbeatAuthFromSettings,
  normalizeNativeAuthEnvelope,
} from "../functions/auth.js";
import { resolvePosseKey } from "../functions/key.js";

export class HeartbeatAuthManager {
  /**
   * @param {{
   *   env?: NodeJS.ProcessEnv | null,
   *   envelope?: Record<string, unknown> | null,
   *   envelopeResolver?: (() => (Record<string, unknown> | null)) | null,
   *   getSettingFn?: (key: string) => unknown,
   *   posseKey?: string | null,
   *   trustedPolicy?: { envelope?: Record<string, unknown> | null, developmentMode?: boolean } | Record<string, unknown> | null,
   *   developmentMode?: boolean,
   * }} [opts]
   */
  constructor({
    env = null,
    envelope = undefined,
    envelopeResolver = null,
    getSettingFn = undefined,
    posseKey = undefined,
    trustedPolicy = null,
    developmentMode = false,
  } = {}) {
    this._env = env || null;
    this._getSettingFn = getSettingFn || null;
    this._developmentMode = developmentMode === true || isIsolatedTestContext();
    this._fixedLaunchKey = posseKey !== undefined ? (String(posseKey || "").trim() || null) : undefined;
    /** @type {string | null | undefined} */
    this._cachedLaunchKey = undefined;

    this._trustedPolicy = trustedPolicy
      ? createNativeAuthTrustedPolicy(trustedPolicy)
      : null;
    this._envelopeResolver = envelopeResolver || (() => nativeHeartbeatAuthFromSettings({
      ...(this._getSettingFn ? { getSettingFn: this._getSettingFn } : {}),
      allowDevelopmentOverrides: this._developmentMode,
    }));

    if (envelope !== undefined) {
      if (envelope && !this._trustedPolicy) {
        this._trustedPolicy = createNativeAuthTrustedPolicy({ envelope, developmentMode: this._developmentMode });
      }
      this._fixedEnvelope = envelope
        ? this.#trustedEnvelopeFor(envelope)
        : null;
    } else {
      this._fixedEnvelope = undefined;
    }
    /** @type {Readonly<Record<string, unknown>> | null | undefined} */
    this._cachedEnvelope = undefined;
  }

  /** @param {{ refresh?: boolean }} [opts] */
  getNativeAuthEnvelope({ refresh = false } = {}) {
    if (this._fixedEnvelope !== undefined) return this._fixedEnvelope;
    if (refresh || this._cachedEnvelope === undefined) {
      const resolved = normalizeNativeAuthEnvelope(this._envelopeResolver?.());
      this._cachedEnvelope = resolved ? this.#trustedEnvelopeFor(resolved) : null;
    }
    return this._cachedEnvelope;
  }

  /** @param {{ refresh?: boolean }} [opts] */
  getLaunchKey({ refresh = false } = {}) {
    if (this._fixedLaunchKey !== undefined) return this._fixedLaunchKey;
    if (refresh || this._cachedLaunchKey === undefined) {
      this._cachedLaunchKey = resolvePosseKey(this._env || process.env) || null;
    }
    return this._cachedLaunchKey;
  }

  /** @param {{ refresh?: boolean }} [opts] */
  hasLaunchKey(opts) {
    return !!this.getLaunchKey(opts);
  }

  /**
   * Authentication rejection invalidates environment-backed key resolution so
   * a rotated credential can be observed on the next pulse exchange.
   */
  clearAuthenticationState() {
    if (this._fixedLaunchKey === undefined) this._cachedLaunchKey = undefined;
  }

  getTrustedAuthPolicy() {
    if (!this._trustedPolicy) {
      const envelope = this.getNativeAuthEnvelope();
      if (!envelope) return null;
      this._trustedPolicy = createNativeAuthTrustedPolicy({
        envelope,
        developmentMode: this._developmentMode,
      });
    }
    return this._trustedPolicy;
  }

  getCapability() {
    const envelope = this.getNativeAuthEnvelope();
    return Object.freeze({ envelope: envelope ? freezeEnvelope(envelope) : null });
  }

  /**
   * @param {{ envelope?: Record<string, unknown> | null } | null | undefined} capability
   * @param {{ trustedPolicy?: { envelope?: Record<string, unknown> | null, developmentMode?: boolean } | Record<string, unknown> | null }} [opts]
   */
  static fromCapability(capability, { trustedPolicy = null } = {}) {
    const localPolicy = trustedPolicy
      ? createNativeAuthTrustedPolicy(trustedPolicy)
      : defaultRuntimeTrustedPolicy();
    const supplied = capability && typeof capability === "object" && !Array.isArray(capability)
      ? normalizeNativeAuthEnvelope(capability.envelope)
      : null;
    const envelope = supplied
      ? validateCapabilityEnvelope(supplied, localPolicy)
      : localPolicy.envelope;
    return new HeartbeatAuthManager({
      envelope,
      trustedPolicy: localPolicy,
    });
  }

  /** @param {Record<string, unknown>} envelope */
  #trustedEnvelopeFor(envelope) {
    if (!this._trustedPolicy) {
      this._trustedPolicy = createNativeAuthTrustedPolicy({
        envelope,
        developmentMode: this._developmentMode,
      });
    }
    return validateCapabilityEnvelope(envelope, this._trustedPolicy);
  }
}

function defaultRuntimeTrustedPolicy() {
  const developmentMode = isIsolatedTestContext();
  return createNativeAuthTrustedPolicy({
    envelope: nativeHeartbeatAuthFromSettings({ allowDevelopmentOverrides: developmentMode }),
    developmentMode,
  });
}

/**
 * Validate every caller-supplied trust-bearing field, then return the local
 * trusted envelope rather than the caller's object.
 *
 * @param {Record<string, unknown>} supplied
 * @param {{ envelope: Readonly<Record<string, unknown>>, origin: string }} policy
 */
function validateCapabilityEnvelope(supplied, policy) {
  const candidate = normalizeNativeAuthEnvelope(supplied);
  if (!candidate?.heartbeatUrl) {
    throw capabilityError("child native-auth capability is missing its heartbeat origin");
  }
  let candidateUrl;
  let trustedUrl;
  try {
    candidateUrl = new URL(String(candidate.heartbeatUrl));
    trustedUrl = new URL(String(policy.envelope.heartbeatUrl));
  } catch {
    throw capabilityError("child native-auth capability contains an invalid heartbeat origin");
  }
  if (candidateUrl.origin !== policy.origin || normalizeUrl(candidateUrl) !== normalizeUrl(trustedUrl)) {
    throw capabilityError("child native-auth capability heartbeat origin does not match trusted policy");
  }
  assertTrustedField(candidate, policy.envelope, "heartbeatJwtAudience", "audience");
  assertTrustedField(candidate, policy.envelope, "heartbeatJwtPublicKey", "public key pin");
  assertTrustedField(candidate, policy.envelope, "heartbeatJwtPublicKeySha256", "public key fingerprint");
  assertTrustedField(candidate, policy.envelope, "heartbeatPublicKeyUrl", "public-key endpoint");
  return freezeEnvelope(policy.envelope);
}

function assertTrustedField(candidate, trusted, field, label) {
  if (!Object.prototype.hasOwnProperty.call(candidate, field)) return;
  if (String(candidate[field] || "") !== String(trusted[field] || "")) {
    throw capabilityError(`child native-auth capability ${label} does not match trusted policy`);
  }
}

function normalizeUrl(url) {
  return url.toString().replace(/\/$/, "");
}

function capabilityError(message) {
  const err = new Error(message);
  err.code = "POSSE_NATIVE_AUTH_CAPABILITY_REJECTED";
  return err;
}

function isIsolatedTestContext() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN);
}

export const heartbeatAuthManager = new HeartbeatAuthManager();
