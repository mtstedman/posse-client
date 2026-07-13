// @ts-check

import { createHash } from "node:crypto";

import { heartbeatAuthManager } from "./HeartbeatAuthManager.js";
import { isLoopbackHostname } from "../functions/auth.js";

const DEFAULT_REFRESH_SKEW_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PRODUCTION_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_DEVELOPMENT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_HEARTBEAT_RESPONSE_BYTES = 64 * 1024;
// Native pulse contract (posse_protocol native_auth): workers should request
// refresh no later than 15 seconds before expiry.
const NATIVE_PULSE_REFRESH_SKEW_SECONDS = 15;
const NATIVE_PULSE_MIN_REFRESH_DELAY_SECONDS = 5;

/**
 * @typedef {Object} NativePulseEnvelope
 * @property {string} token        Compact Ed25519 JWT minted by the heartbeat.
 * @property {string} kid          Signing-key id the native child verifies against.
 * @property {string} route        The route this envelope authorizes.
 * @property {number} expiresAt    Unix seconds.
 * @property {number} refreshAfter Unix seconds (== expiresAt - 15 unless the server says otherwise).
 * @property {Readonly<Record<string, string>>} nativeArtifacts Server-issued current native artifact versions.
 */

export class PulseTokenManager {
  /**
   * @param {{
   *   authManager?: import("./HeartbeatAuthManager.js").HeartbeatAuthManager,
   *   fetchImpl?: typeof fetch,
   *   now?: () => number,
   *   refreshSkewMs?: number,
   *   timeoutMs?: number,
   * }} [opts]
   */
  constructor({
    authManager = null,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (authManager !== null && typeof authManager?.getLaunchKey !== "function") {
      throw new TypeError("PulseTokenManager requires a HeartbeatAuthManager");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("PulseTokenManager requires fetch");
    // Kept lazy so constructing the module-level singleton inside the
    // HeartbeatAuthManager <-> NativeBinary import cycle never dereferences a
    // TDZ binding; the shared authority is resolved on first use instead.
    this._authManager = authManager;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.refreshSkewMs = positiveNumber(refreshSkewMs, DEFAULT_REFRESH_SKEW_MS);
    this.timeoutMs = positiveNumber(timeoutMs, DEFAULT_TIMEOUT_MS);
    /** @type {Map<string, { token: string, kid: string, expiresAt: number, refreshAt: number, refreshAfter: number, routes: string[], nativeArtifacts: Readonly<Record<string, string>>, envelope: Readonly<NativePulseEnvelope> | null }>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<{ token: string, envelope: Readonly<NativePulseEnvelope> | null }>>} */
    this._refreshes = new Map();
    this._generation = 0;
    this._heartbeatTimer = null;
    this._heartbeatRunning = false;
  }

  /**
   * The auth authority backing this broker. Falls back to the shared
   * HeartbeatAuthManager singleton on first use (never at construct time —
   * see the constructor note on the import cycle).
   */
  get authManager() {
    if (!this._authManager) this._authManager = heartbeatAuthManager;
    return this._authManager;
  }

  hasAuthentication() {
    return this.authManager.hasLaunchKey();
  }

  /**
   * Return only the derived pulse token. The raw key is obtained from the auth
   * manager inside the heartbeat exchange and is never returned or attached to
   * an error.
   *
   * @param {{ refresh?: boolean, requiredRoute?: string | null }} [opts]
   * @returns {Promise<string | null>}
   */
  async getPulseToken({ refresh = false, requiredRoute = null } = {}) {
    const rawKey = this.authManager.getLaunchKey({ refresh });
    if (!rawKey) return null;
    const policy = this.authManager.getTrustedAuthPolicy();
    if (!policy?.envelope?.heartbeatUrl) {
      throw pulseError("POSSE_PULSE_AUTH_POLICY_UNAVAILABLE", "trusted heartbeat policy is unavailable");
    }
    const cacheKey = pulseCacheKey(rawKey, policy);
    const now = this.now();
    const cached = this._cache.get(cacheKey);
    if (!refresh && cached && now < cached.refreshAt && now < cached.expiresAt) {
      assertRouteGranted(cached.routes, requiredRoute);
      this.#scheduleHeartbeat(cached);
      return cached.token;
    }
    const minted = await this.#mintPulse(cacheKey, rawKey, policy, null);
    const refreshed = this._cache.get(cacheKey);
    if (refreshed) {
      assertRouteGranted(refreshed.routes, requiredRoute);
      this.#scheduleHeartbeat(refreshed);
    }
    return minted.token;
  }

  /**
   * Establish the one process-wide remote heartbeat and keep it renewed until
   * {@link stopHeartbeat} is called. Native daemons receive route views of this
   * same signed token from their parent; this method never mints per-daemon or
   * per-request credentials.
   */
  async startHeartbeat() {
    this._heartbeatRunning = true;
    try {
      const token = await this.getPulseToken();
      if (token) return token;
      this._heartbeatRunning = false;
      throw pulseError("POSSE_PULSE_AUTH_UNAVAILABLE", "heartbeat authentication is unavailable");
    } catch (error) {
      this._heartbeatRunning = false;
      throw error;
    }
  }

  async getHeartbeatGrant({ refresh = false } = {}) {
    const token = await this.getPulseToken({ refresh });
    if (!token) return null;
    const rawKey = this.authManager.getLaunchKey();
    const policy = this.authManager.getTrustedAuthPolicy();
    if (!rawKey || !policy) return null;
    const entry = this._cache.get(pulseCacheKey(rawKey, policy));
    if (!entry || this.now() >= entry.expiresAt) return null;
    return Object.freeze({
      token: entry.token,
      kid: entry.kid,
      routes: Object.freeze([...entry.routes]),
      expiresAt: Math.floor(entry.expiresAt / 1000),
      refreshAfter: entry.refreshAfter,
      nativeArtifacts: entry.nativeArtifacts,
      pins: Object.freeze({
        heartbeatJwtPublicKeySha256: String(policy.envelope?.heartbeatJwtPublicKeySha256 || ""),
      }),
      keys: Object.freeze({
        heartbeatJwtPublicKey: String(policy.envelope?.heartbeatJwtPublicKey || ""),
      }),
    });
  }

  stopHeartbeat() {
    this._heartbeatRunning = false;
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  /**
   * Route view of the process-wide pulse for a native child. The remote token
   * is minted once with the orchestrator's full server-authorized route set;
   * the envelope names the route the child must verify. Agent permissions are
   * narrowed separately by signed MCP gateway capabilities.
   *
   * @param {{ refresh?: boolean, requiredRoute: string, nativePackage?: string | null, nativeVersion?: string | null }} opts
   * @returns {Promise<Readonly<NativePulseEnvelope> | null>} null when no launch key is available.
   */
  async getPulseEnvelope({ refresh = false, requiredRoute, nativePackage = null, nativeVersion = null } = /** @type {any} */ ({})) {
    const route = String(requiredRoute || "").trim();
    if (!route) throw pulseError("POSSE_PULSE_ROUTE_REQUIRED", "a native pulse envelope requires an explicit route");
    normalizedNativeIdentity(nativePackage, nativeVersion);
    const rawKey = this.authManager.getLaunchKey({ refresh });
    if (!rawKey) return null;
    const policy = this.authManager.getTrustedAuthPolicy();
    if (!policy?.envelope?.heartbeatUrl) {
      throw pulseError("POSSE_PULSE_AUTH_POLICY_UNAVAILABLE", "trusted heartbeat policy is unavailable");
    }
    const cacheKey = pulseCacheKey(rawKey, policy);
    const now = this.now();
    const cached = this._cache.get(cacheKey);
    if (!refresh && cached && now < cached.refreshAt && now < cached.expiresAt) {
      assertRouteGranted(cached.routes, route);
      this.#scheduleHeartbeat(cached);
      return nativeEnvelopeForRoute(cached, route);
    }
    await this.#mintPulse(cacheKey, rawKey, policy, null);
    const refreshed = this._cache.get(cacheKey);
    if (!refreshed) return null;
    assertRouteGranted(refreshed.routes, route);
    this.#scheduleHeartbeat(refreshed);
    return nativeEnvelopeForRoute(refreshed, route);
  }

  /**
   * Cache-only view of {@link getPulseEnvelope} for sync spawn boundaries that
   * cannot await the heartbeat exchange. Returns null (never fetches) when no
   * unexpired envelope for the route is cached.
   *
   * @param {{ requiredRoute: string, nativePackage?: string | null, nativeVersion?: string | null }} opts
   * @returns {Readonly<NativePulseEnvelope> | null}
   */
  getCachedPulseEnvelope({ requiredRoute, nativePackage = null, nativeVersion = null } = /** @type {any} */ ({})) {
    const route = String(requiredRoute || "").trim();
    if (!route) return null;
    normalizedNativeIdentity(nativePackage, nativeVersion);
    const rawKey = this.authManager.getLaunchKey();
    if (!rawKey) return null;
    const policy = this.authManager.getTrustedAuthPolicy();
    if (!policy?.envelope?.heartbeatUrl) return null;
    const cached = this._cache.get(pulseCacheKey(rawKey, policy));
    if (!cached || this.now() >= cached.expiresAt) return null;
    try {
      assertRouteGranted(cached.routes, route);
    } catch {
      return null;
    }
    return nativeEnvelopeForRoute(cached, route);
  }

  /**
   * Single-flight mint for one cache key: concurrent callers share one
   * heartbeat round-trip.
   *
   * @param {string} cacheKey
   * @param {string} rawKey
   * @param {{ envelope: Readonly<Record<string, unknown>>, developmentMode: boolean }} policy
   * @param {string | null} requiredRoute
   * @param {{ package: string, version: string } | null} nativeIdentity
   * @returns {Promise<{ token: string, envelope: Readonly<NativePulseEnvelope> | null }>}
   */
  #mintPulse(cacheKey, rawKey, policy, requiredRoute, nativeIdentity = null) {
    const inFlight = this._refreshes.get(cacheKey);
    if (inFlight) return inFlight;
    const generation = this._generation;
    const promise = this.#refreshPulse(rawKey, policy, requiredRoute, nativeIdentity).then((entry) => {
      if (this._generation === generation) this._cache.set(cacheKey, entry);
      return { token: entry.token, envelope: entry.envelope };
    }).finally(() => {
      if (this._refreshes.get(cacheKey) === promise) this._refreshes.delete(cacheKey);
    });
    this._refreshes.set(cacheKey, promise);
    return promise;
  }

  clearAuthentication() {
    this._generation += 1;
    this._cache.clear();
    this._refreshes.clear();
    this.authManager.clearAuthenticationState?.();
  }

  #scheduleHeartbeat(entry) {
    if (!this._heartbeatRunning) return;
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    const delay = Math.max(250, entry.refreshAt - this.now());
    this._heartbeatTimer = setTimeout(() => {
      this._heartbeatTimer = null;
      void this.#refreshHeartbeat();
    }, delay);
    this._heartbeatTimer.unref?.();
  }

  async #refreshHeartbeat() {
    if (!this._heartbeatRunning) return;
    try {
      await this.getPulseToken({ refresh: true });
    } catch {
      if (!this._heartbeatRunning) return;
      this._heartbeatTimer = setTimeout(() => {
        this._heartbeatTimer = null;
        void this.#refreshHeartbeat();
      }, 5_000);
      this._heartbeatTimer.unref?.();
    }
  }

  /** @param {string} value @param {string} [operation] */
  assertTrustedResourceUrl(value, operation = "remote resource request") {
    const policy = this.authManager.getTrustedAuthPolicy();
    if (!policy) throw pulseError("POSSE_PULSE_AUTH_POLICY_UNAVAILABLE", "trusted heartbeat policy is unavailable");
    let url;
    try {
      url = new URL(String(value || ""));
    } catch {
      throw pulseError("POSSE_REMOTE_INVALID_URL", `${operation} requires an absolute trusted URL`);
    }
    if (url.username || url.password) {
      throw pulseError("POSSE_REMOTE_INVALID_URL", `${operation} refuses URL credentials`);
    }
    const secure = url.protocol === "https:"
      || (policy.developmentMode === true && url.protocol === "http:" && isLoopbackHostname(url.hostname));
    if (!secure) {
      throw pulseError("POSSE_REMOTE_INSECURE_AUTH", `${operation} requires HTTPS; loopback HTTP requires explicit development mode`);
    }
    if (url.origin !== policy.origin) {
      throw pulseError("POSSE_REMOTE_UNTRUSTED_ORIGIN", `${operation} origin does not match trusted auth policy`);
    }
    return url;
  }

  /**
   * @param {string} rawKey
   * @param {{ envelope: Readonly<Record<string, unknown>>, developmentMode: boolean }} policy
   * @param {string | null} [requiredRoute] Route-scoped native mint: the heartbeat
   *   request names the route so each native grant is distinct. Omitted for
   *   Node's own outbound HTTPS bearer (unscoped legacy body).
   * @param {{ package: string, version: string } | null} [nativeIdentity]
   */
  async #refreshPulse(rawKey, policy, requiredRoute = null, nativeIdentity = null) {
    const heartbeatUrl = String(policy.envelope.heartbeatUrl || "");
    this.assertTrustedResourceUrl(heartbeatUrl, "heartbeat request");
    const ac = new AbortController();
    const configuredSeconds = Number(policy.envelope.heartbeatTimeoutSeconds);
    const timeoutMs = Number.isFinite(configuredSeconds) && configuredSeconds > 0
      ? configuredSeconds * 1000
      : this.timeoutMs;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let response;
    try {
      /** @type {Record<string, string>} */
      const heartbeatBody = { posse_key: rawKey };
      if (requiredRoute) heartbeatBody.route = requiredRoute;
      if (nativeIdentity) {
        heartbeatBody.nativePackage = nativeIdentity.package;
        heartbeatBody.nativeVersion = nativeIdentity.version;
      }
      response = await this.fetchImpl(heartbeatUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(heartbeatBody),
        redirect: "error",
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw pulseError("POSSE_PULSE_TIMEOUT", `heartbeat request timed out after ${timeoutMs}ms`);
      }
      // Do not retain the transport error as a cause: custom fetch layers may
      // attach request options (including the heartbeat body) to that object.
      throw pulseError("POSSE_PULSE_FETCH_FAILED", "heartbeat request failed");
    }
    let text;
    try {
      if (response.status === 401 || response.status === 403) this.clearAuthentication();
      if (!response.ok) {
        const err = pulseError("POSSE_PULSE_REJECTED", `heartbeat request was rejected with HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      // The request deadline covers the complete response, not only receipt of
      // headers. Otherwise a peer can send 200 headers and stall the body
      // forever while every caller waits on the shared in-flight mint.
      text = await abortable(boundedResponseText(response), ac.signal);
    } catch (err) {
      if (ac.signal.aborted || err?.name === "AbortError") {
        throw pulseError("POSSE_PULSE_TIMEOUT", `heartbeat request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw pulseError("POSSE_PULSE_INVALID_RESPONSE", "heartbeat response was not valid JSON");
    }
    const token = String(body?.token || body?.pulse_token || body?.pulseToken || "").trim();
    if (!token) throw pulseError("POSSE_PULSE_INVALID_RESPONSE", "heartbeat response did not contain a pulse token");
    const issuedAt = this.now();
    const maxTtlMs = policy.developmentMode === true
      ? MAX_DEVELOPMENT_TOKEN_TTL_MS
      : MAX_PRODUCTION_TOKEN_TTL_MS;
    const expiresAt = pulseExpiry(body, token, issuedAt, maxTtlMs);
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw pulseError("POSSE_PULSE_EXPIRED", "heartbeat response contained an expired pulse token");
    }
    const ttl = expiresAt - issuedAt;
    const skew = Math.min(this.refreshSkewMs, Math.max(1, Math.floor(ttl / 2)));
    let routes = exactPulseRoutes(body, token);
    let envelope = null;
    const kid = String(body?.kid || jwtHeader(token)?.kid || "").trim();
    const expiresAtSeconds = Math.floor(expiresAt / 1000);
    const issuedAtSeconds = Math.floor(issuedAt / 1000);
    const responseRefreshAfter = positiveNumber(body?.refresh_after ?? body?.refreshAfter, 0);
    const latestRefreshAfterSeconds = expiresAtSeconds - 1;
    const earliestRefreshAfterSeconds = Math.min(
      issuedAtSeconds + NATIVE_PULSE_MIN_REFRESH_DELAY_SECONDS,
      latestRefreshAfterSeconds,
    );
    const refreshAfterSeconds = Math.max(
      earliestRefreshAfterSeconds,
      Math.min(
        responseRefreshAfter > 0 ? responseRefreshAfter : expiresAtSeconds - NATIVE_PULSE_REFRESH_SKEW_SECONDS,
        latestRefreshAfterSeconds,
      ),
    );
    const nativeArtifacts = exactNativeArtifactVersions(body, token);
    if (requiredRoute) {
      // Native mint: fail loud right here when the grant is wrong, and build
      // the wire envelope { token, kid, route, expiresAt, refreshAfter } the
      // native child consumes (unix seconds, offline-verified by kid).
      routes = exactNativePulseRoutes(body, token, requiredRoute);
      if (!kid) {
        throw pulseError("POSSE_PULSE_INVALID_RESPONSE", "heartbeat response did not name a signing kid for the native pulse");
      }
      envelope = Object.freeze({
        token,
        kid,
        route: requiredRoute,
        expiresAt: expiresAtSeconds,
        refreshAfter: refreshAfterSeconds,
        nativeArtifacts,
      });
    }
    return {
      token,
      kid,
      expiresAt,
      refreshAt: expiresAt - skew,
      refreshAfter: refreshAfterSeconds,
      routes,
      nativeArtifacts,
      envelope,
    };
  }
}

/** @param {string} rawKey @param {{ origin: string, developmentMode: boolean, envelope: Readonly<Record<string, unknown>> }} policy */
function pulseCacheKey(rawKey, policy) {
  const keyIdentity = createHash("sha256").update(rawKey, "utf8").digest("hex");
  const policyIdentity = createHash("sha256")
    .update(stableJson({
      origin: policy.origin,
      developmentMode: policy.developmentMode,
      envelope: policy.envelope,
    }), "utf8")
    .digest("hex");
  return `${keyIdentity}:${policyIdentity}`;
}

function pulseExpiry(body, token, issuedAt, maxTtlMs) {
  const candidates = [];
  const expiresInSeconds = positiveNumber(
    body?.expires_in_seconds ?? body?.expiresInSeconds ?? body?.expires_in ?? body?.expiresIn,
    0,
  );
  if (expiresInSeconds > 0) candidates.push(issuedAt + expiresInSeconds * 1000);
  const responseExpirySeconds = positiveNumber(
    body?.expires_at_unix_seconds ?? body?.expiresAtUnixSeconds ?? body?.expires_at ?? body?.expiresAt,
    0,
  );
  if (responseExpirySeconds > 0) candidates.push(responseExpirySeconds * 1000);
  const jwtExpiry = jwtExpiryMs(token);
  if (jwtExpiry) candidates.push(jwtExpiry);
  if (candidates.length === 0) return NaN;
  return Math.min(...candidates, issuedAt + maxTtlMs);
}

function jwtPart(token, index) {
  const part = String(token || "").split(".")[index];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtHeader(token) {
  return jwtPart(token, 0);
}

function jwtClaims(token) {
  return jwtPart(token, 1);
}

function jwtExpiryMs(token) {
  const exp = Number(jwtClaims(token)?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

function exactPulseRoutes(body, token) {
  const responseRoutes = normalizedRoutes(body?.routes ?? body?.capabilities);
  const signedRoutes = normalizedRoutes(jwtClaims(token)?.routes ?? jwtClaims(token)?.capabilities);
  if (responseRoutes.length === 0 || stableJson(responseRoutes) !== stableJson(signedRoutes)) {
    throw pulseError(
      "POSSE_PULSE_ROUTE_DENIED",
      "heartbeat response routes do not match the signed pulse routes",
    );
  }
  return signedRoutes;
}

function nativeEnvelopeForRoute(entry, route) {
  if (!entry.kid) {
    throw pulseError("POSSE_PULSE_INVALID_RESPONSE", "heartbeat response did not name a signing kid for the native pulse");
  }
  return Object.freeze({
    token: entry.token,
    kid: entry.kid,
    route,
    expiresAt: Math.floor(entry.expiresAt / 1000),
    refreshAfter: entry.refreshAfter,
    nativeArtifacts: entry.nativeArtifacts,
  });
}

function exactNativePulseRoutes(body, token, requiredRoute) {
  const required = String(requiredRoute || "").trim();
  const responseRoute = String(body?.route || "").trim();
  const responseRoutes = normalizedRoutes(body?.routes);
  const signedRoutes = normalizedRoutes(jwtClaims(token)?.routes);
  if (responseRoute !== required
    || !isExactRouteSet(responseRoutes, required)
    || !isExactRouteSet(signedRoutes, required)) {
    throw pulseError(
      "POSSE_PULSE_ROUTE_DENIED",
      "heartbeat response and signed pulse routes do not match the requested route",
    );
  }
  return signedRoutes;
}

function exactNativeArtifactVersions(body, token) {
  const responseVersions = normalizedNativeArtifactVersions(body?.nativeArtifacts ?? body?.native_artifacts);
  const signedVersions = normalizedNativeArtifactVersions(
    jwtClaims(token)?.native_artifacts ?? jwtClaims(token)?.nativeArtifacts,
  );
  if (stableJson(responseVersions) !== stableJson(signedVersions)) {
    throw pulseError(
      "POSSE_PULSE_INVALID_RESPONSE",
      "heartbeat response and signed native artifact versions do not match",
    );
  }
  return Object.freeze(signedVersions);
}

function normalizedNativeArtifactVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const versions = {};
  for (const [name, rawVersion] of Object.entries(value)) {
    const packageName = String(name || "").trim();
    const version = String(rawVersion || "").trim();
    if (!/^posse-[a-z0-9-]+$/.test(packageName)) continue;
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(version) || version.includes("..")) continue;
    versions[packageName] = version;
  }
  return versions;
}

function normalizedNativeIdentity(nativePackage, nativeVersion) {
  const packageName = String(nativePackage || "").trim();
  const version = String(nativeVersion || "").trim();
  if (!packageName && !version) return null;
  if (!packageName || !version) {
    throw pulseError(
      "POSSE_PULSE_NATIVE_VERSION_INCOMPLETE",
      "nativePackage and nativeVersion must be provided together",
    );
  }
  if (!/^posse-[a-z0-9-]+$/.test(packageName)
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(version)
    || version.includes("..")) {
    throw pulseError(
      "POSSE_PULSE_NATIVE_VERSION_INVALID",
      "native heartbeat package or version is invalid",
    );
  }
  return Object.freeze({ package: packageName, version });
}

function normalizedRoutes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((route) => String(route || "").trim()).filter(Boolean))];
}

function isExactRouteSet(routes, requiredRoute) {
  return routes.length === 1 && routes[0] === requiredRoute;
}

function assertExactRoute(routes, requiredRoute) {
  if (!isExactRouteSet(routes, String(requiredRoute || "").trim())) {
    throw pulseError("POSSE_PULSE_ROUTE_DENIED", "pulse token does not authorize only the requested route");
  }
}

function assertRouteGranted(routes, requiredRoute) {
  const required = String(requiredRoute || "").trim();
  if (!required) return;
  const granted = routes.some((route) => route === "*"
    || route === required
    || (required === "git:read" && route === "git:mutate"));
  if (!granted) {
    throw pulseError("POSSE_PULSE_ROUTE_DENIED", "pulse token does not authorize the requested route");
  }
}

async function boundedResponseText(response) {
  const text = await response.text();
  if (Buffer.byteLength(String(text || ""), "utf8") > MAX_HEARTBEAT_RESPONSE_BYTES) {
    throw pulseError("POSSE_PULSE_INVALID_RESPONSE", "heartbeat response exceeded the allowed size");
  }
  return text;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortError() {
  const err = new Error("operation aborted");
  err.name = "AbortError";
  return err;
}

function stableJson(value) {
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pulseError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export const pulseTokenManager = new PulseTokenManager();
