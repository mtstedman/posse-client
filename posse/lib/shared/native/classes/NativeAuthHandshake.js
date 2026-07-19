// @ts-check

import { CAPABILITY_HANDSHAKE_PROTOCOL } from "../../permissions/classes/CapabilityHandshakeManager.js";

const MAX_SCOPES = 32;
const MAX_GRANT_BYTES = 256 * 1024;
const SCOPE_RE = /^[A-Za-z0-9._:/-]{1,160}$/;

/**
 * Owns native service-door keys and their in-flight mint promises.
 *
 * This is authentication, not downhill permission delegation: the caller has
 * already decided that the service is available. The daemon receives a key,
 * verifies it, and opens the door. It never becomes a permission parent and
 * never narrows WI/job/agent authority.
 */
export class NativeAuthHandshake {
  /**
   * @param {{
   *   pulseManager: { getPulseEnvelope: (options: Record<string, unknown>) => Promise<Record<string, unknown> | null> },
   *   pulseOptionsForRoute?: (route: string) => Record<string, unknown>,
   * }} options
   */
  constructor({ pulseManager, pulseOptionsForRoute = (requiredRoute) => ({ requiredRoute }) } = /** @type {any} */ ({})) {
    if (!pulseManager || typeof pulseManager.getPulseEnvelope !== "function") {
      throw new TypeError("NativeAuthHandshake requires a pulse manager");
    }
    if (typeof pulseOptionsForRoute !== "function") {
      throw new TypeError("NativeAuthHandshake requires a pulse-options function");
    }
    this.pulseManager = pulseManager;
    this.pulseOptionsForRoute = pulseOptionsForRoute;
    /** @type {Map<string, Promise<Record<string, Record<string, unknown>>>>} */
    this._keyMints = new Map();
  }

  /**
   * Issue a wire-compatible service-key handshake. Requests for the same set
   * of door keys share one mint promise while it is pending.
   */
  issue(request = {}) {
    const normalized = normalizeRequest(request);
    const key = normalized.scopes.slice().sort().join("\u0000");
    let mint = this._keyMints.get(key);
    if (!mint) {
      mint = this.#mintKeys(normalized.scopes).finally(() => {
        if (this._keyMints.get(key) === mint) this._keyMints.delete(key);
      });
      this._keyMints.set(key, mint);
    }
    return mint.then((pulses) => buildGrant(normalized, pulses));
  }

  async #mintKeys(scopes) {
    const entries = await Promise.all(scopes.map(async (route) => [
      route,
      await this.pulseManager.getPulseEnvelope(this.pulseOptionsForRoute(route)),
    ]));
    const pulses = {};
    for (const [route, value] of entries) {
      if (!validPulse(value, route)) {
        throw handshakeError(
          "POSSE_NATIVE_HEARTBEAT_UNAVAILABLE",
          `native service key is unavailable for route ${route}`,
        );
      }
      pulses[route] = Object.freeze({ ...value });
    }
    return Object.freeze(pulses);
  }
}

function normalizeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "native auth handshake request is invalid");
  }
  const protocol = String(value.protocol || CAPABILITY_HANDSHAKE_PROTOCOL).trim();
  if (protocol !== CAPABILITY_HANDSHAKE_PROTOCOL) {
    throw handshakeError("POSSE_CAPABILITY_PROTOCOL_INVALID", "native auth handshake protocol is unsupported");
  }
  const requestId = String(value.requestId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "native auth handshake requires a bounded requestId");
  }
  if (String(value.capability || "") !== "native.pulse") {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "native auth handshake capability is unsupported");
  }
  const scopes = [...new Set(
    (Array.isArray(value.scopes) ? value.scopes : [])
      .map((scope) => String(scope || "").trim())
      .filter(Boolean),
  )];
  if (scopes.length === 0 || scopes.length > MAX_SCOPES || scopes.some((scope) => !SCOPE_RE.test(scope))) {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "native auth handshake requires valid service routes");
  }
  return Object.freeze({ protocol, requestId, capability: "native.pulse", scopes: Object.freeze(scopes) });
}

function buildGrant(request, pulses) {
  const expiresAt = Math.min(...request.scopes.map((route) => Number(pulses[route]?.expiresAt)));
  const grant = {
    control: "capabilityGrant",
    protocol: request.protocol,
    requestId: request.requestId,
    capability: request.capability,
    scopes: request.scopes,
    expiresAt,
    artifacts: {
      // Service selection happened before this handshake. The daemon only
      // authenticates these keys; it receives no child permission policy.
      permissions: {},
      tokens: { pulses },
      pins: {},
      keys: {},
    },
  };
  if (Buffer.byteLength(JSON.stringify(grant), "utf8") > MAX_GRANT_BYTES) {
    throw handshakeError("POSSE_CAPABILITY_GRANT_TOO_LARGE", "native auth handshake exceeded the allowed size");
  }
  return deepFreeze(grant);
}

function validPulse(value, route) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (String(value.route || "") !== route) return false;
  if (!String(value.token || "").trim() || !String(value.kid || "").trim()) return false;
  const expiresAt = Number(value.expiresAt);
  const refreshAfter = Number(value.refreshAfter);
  return Number.isSafeInteger(expiresAt)
    && Number.isSafeInteger(refreshAfter)
    && refreshAfter > 0
    && refreshAfter < expiresAt
    && expiresAt > Math.floor(Date.now() / 1000);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function handshakeError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}
