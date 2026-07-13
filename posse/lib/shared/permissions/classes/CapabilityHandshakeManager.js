// @ts-check

export const CAPABILITY_HANDSHAKE_PROTOCOL = "posse.capability-handshake.v1";
const MAX_SCOPES = 128;
const MAX_GRANT_BYTES = 256 * 1024;
const SCOPE_RE = /^[A-Za-z0-9._:/-]{1,160}$/;

/**
 * Universal parent-to-child permission handoff. Capability-specific issuers
 * supply the actual permissions/tokens/pins/keys; this class enforces the
 * invariant shared by every hierarchy edge: a child grant is a time-bounded
 * subset of the authority its parent already holds.
 */
export class CapabilityHandshakeManager {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this._issuers = new Map();
  }

  /**
   * @param {string} capability
   * @param {(request: Readonly<Record<string, unknown>>, context: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>} issuer
   */
  register(capability, issuer) {
    const kind = normalizeCapability(capability);
    if (typeof issuer !== "function") throw new TypeError("capability issuer must be a function");
    this._issuers.set(kind, issuer);
    return this;
  }

  unregister(capability) {
    return this._issuers.delete(normalizeCapability(capability));
  }

  issue(request = {}, context = null) {
    const normalized = normalizeRequest(request);
    const issuer = this._issuers.get(normalized.capability);
    if (!issuer) throw handshakeError("POSSE_CAPABILITY_UNSUPPORTED", `unsupported capability ${normalized.capability}`);
    const issued = issuer(normalized, context);
    return issued && typeof issued.then === "function"
      ? issued.then((grant) => this.#finalize(normalized, grant))
      : this.#finalize(normalized, issued);
  }

  issueSync(request = {}, context = null) {
    const issued = this.issue(request, context);
    if (issued && typeof issued.then === "function") {
      throw handshakeError("POSSE_CAPABILITY_ASYNC_ISSUER", "capability issuer requires an async handshake");
    }
    return issued;
  }

  #finalize(request, rawGrant) {
    const grant = plainObject(rawGrant);
    const parentScopes = normalizeScopes(grant.parentScopes, "parent grant");
    const parentSet = new Set(parentScopes);
    for (const scope of request.scopes) {
      if (!parentSet.has(scope)) {
        throw handshakeError("POSSE_CAPABILITY_SCOPE_DENIED", `parent capability does not authorize scope ${scope}`);
      }
    }
    const grantedScopes = normalizeScopes(grant.scopes ?? request.scopes, "child grant");
    const requestedSet = new Set(request.scopes);
    for (const scope of grantedScopes) {
      if (!requestedSet.has(scope) || !parentSet.has(scope)) {
        throw handshakeError("POSSE_CAPABILITY_SCOPE_WIDENED", `child capability widened scope ${scope}`);
      }
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    const parentExpiresAt = positiveInteger(grant.parentExpiresAt, "parentExpiresAt");
    const expiresAt = positiveInteger(grant.expiresAt ?? parentExpiresAt, "expiresAt");
    if (expiresAt <= nowSeconds || parentExpiresAt <= nowSeconds || expiresAt > parentExpiresAt) {
      throw handshakeError("POSSE_CAPABILITY_EXPIRY_INVALID", "child capability expiry must be live and no later than its parent grant");
    }
    const artifacts = freezeJson({
      permissions: plainObjectOrEmpty(grant.permissions),
      tokens: plainObjectOrEmpty(grant.tokens),
      pins: plainObjectOrEmpty(grant.pins),
      keys: plainObjectOrEmpty(grant.keys),
    });
    const response = {
      control: "capabilityGrant",
      protocol: CAPABILITY_HANDSHAKE_PROTOCOL,
      requestId: request.requestId,
      capability: request.capability,
      scopes: grantedScopes,
      expiresAt,
      artifacts,
    };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_GRANT_BYTES) {
      throw handshakeError("POSSE_CAPABILITY_GRANT_TOO_LARGE", "capability grant exceeded the allowed size");
    }
    return freezeJson(response);
  }
}

export function capabilityRequest({ requestId, capability, scopes = [], reason = "missing" } = {}) {
  return normalizeRequest({
    control: "capabilityRequest",
    protocol: CAPABILITY_HANDSHAKE_PROTOCOL,
    requestId,
    capability,
    scopes,
    reason,
  });
}

function normalizeRequest(value) {
  const request = plainObject(value);
  const protocol = String(request.protocol || CAPABILITY_HANDSHAKE_PROTOCOL).trim();
  if (protocol !== CAPABILITY_HANDSHAKE_PROTOCOL) {
    throw handshakeError("POSSE_CAPABILITY_PROTOCOL_INVALID", "capability handshake protocol is unsupported");
  }
  const requestId = String(request.requestId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "capability handshake requires a bounded requestId");
  }
  const capability = normalizeCapability(request.capability);
  const scopes = normalizeScopes(request.scopes, "capability request");
  if (scopes.length === 0) {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "capability handshake requires at least one scope");
  }
  const reason = String(request.reason || "missing").trim().slice(0, 80) || "missing";
  return Object.freeze({
    control: "capabilityRequest",
    protocol,
    requestId,
    capability,
    scopes: Object.freeze(scopes),
    reason,
  });
}

function normalizeCapability(value) {
  const capability = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(capability)) {
    throw handshakeError("POSSE_CAPABILITY_REQUEST_INVALID", "capability name is invalid");
  }
  return capability;
}

function normalizeScopes(value, label) {
  const scopes = [...new Set(
    (Array.isArray(value) ? value : [])
      .map((scope) => String(scope || "").trim())
      .filter(Boolean),
  )];
  if (scopes.length > MAX_SCOPES || scopes.some((scope) => !SCOPE_RE.test(scope))) {
    throw handshakeError("POSSE_CAPABILITY_SCOPE_INVALID", `${label} contains invalid scopes`);
  }
  return scopes;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw handshakeError("POSSE_CAPABILITY_EXPIRY_INVALID", `${label} must be a positive unix timestamp`);
  }
  return parsed;
}

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw handshakeError("POSSE_CAPABILITY_GRANT_INVALID", "capability handshake object is invalid");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

function plainObjectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function freezeJson(value) {
  const cloned = JSON.parse(JSON.stringify(value));
  return deepFreeze(cloned);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function handshakeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
