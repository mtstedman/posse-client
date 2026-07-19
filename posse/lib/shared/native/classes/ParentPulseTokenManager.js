// @ts-check

import http from "node:http";
import crypto from "node:crypto";

import { CAPABILITY_HANDSHAKE_PROTOCOL } from "../../permissions/classes/CapabilityHandshakeManager.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Pulse broker used by trusted child Node daemons. It never owns POSSE_KEY and
 * cannot contact the remote heartbeat; it asks the parent orchestrator over a
 * private local pipe for a route view of the parent's current signed pulse.
 */
export class ParentPulseTokenManager {
  /**
   * @param {{ pipePath: string, token: string, timeoutMs?: number }} capability
   */
  constructor(capability = /** @type {any} */ ({})) {
    this.pipePath = String(capability.pipePath || "").trim();
    this.token = String(capability.token || "").trim();
    this.timeoutMs = positiveNumber(capability.timeoutMs, DEFAULT_TIMEOUT_MS);
    if (!this.pipePath || !this.token) {
      throw new TypeError("ParentPulseTokenManager requires a private parent broker capability");
    }
    this._cache = new Map();
    this._grants = new Map();
    this._deniedRoutes = new Set();
    this._refreshes = new Map();
    this._generation = 0;
  }

  hasAuthentication() {
    return true;
  }

  async startHeartbeat() {
    return true;
  }

  stopHeartbeat() {}

  async getPulseEnvelope({ refresh = false, requiredRoute } = /** @type {any} */ ({})) {
    const route = String(requiredRoute || "").trim();
    if (!route) throw brokerError("POSSE_PULSE_ROUTE_REQUIRED", "a parent pulse request requires an explicit route");
    if (this._deniedRoutes.has(route)) {
      throw brokerError("POSSE_PARENT_PULSE_DENIED", `parent pulse broker does not authorize route ${route}`);
    }
    const cached = this.getCachedPulseEnvelope({ requiredRoute: route });
    if (!refresh && cached && Date.now() < Number(cached.refreshAfter) * 1000) return cached;
    const inFlight = this._refreshes.get(route);
    if (inFlight) return inFlight;
    const generation = this._generation;
    const request = this.#requestRoute(route, generation).finally(() => {
      if (this._refreshes.get(route) === request) this._refreshes.delete(route);
    });
    this._refreshes.set(route, request);
    return request;
  }

  getCachedPulseEnvelope({ requiredRoute } = /** @type {any} */ ({})) {
    const route = String(requiredRoute || "").trim();
    const envelope = this._cache.get(route) || null;
    const grant = this._grants.get(route) || null;
    if (!validEnvelope(envelope, route) || !validRouteGrant(grant, envelope)) {
      if (envelope) this._cache.delete(route);
      if (grant) this._grants.delete(route);
      return null;
    }
    return envelope;
  }

  /** @param {{ refresh?: boolean, requiredRoute?: string }} [options] */
  async getPulseToken({ refresh = false, requiredRoute } = {}) {
    if (!requiredRoute) {
      throw brokerError("POSSE_PULSE_ROUTE_REQUIRED", "a child broker cannot request an unscoped pulse token");
    }
    const envelope = await this.getPulseEnvelope({ refresh, requiredRoute });
    return envelope?.token || null;
  }

  getHeartbeatGrant() {
    const live = [...this._grants.entries()]
      .filter(([route, grant]) => validEnvelope(this._cache.get(route), route)
        && Number(grant?.expiresAt) > Math.floor(Date.now() / 1000));
    if (live.length === 0) return null;
    const expiresAt = Math.min(...live.map(([, grant]) => Number(grant.expiresAt)));
    const pins = live[0][1]?.pins || {};
    const keys = live[0][1]?.keys || {};
    return Object.freeze({
      routes: Object.freeze(live.map(([route]) => route)),
      expiresAt,
      pins: Object.freeze({ ...pins }),
      keys: Object.freeze({ ...keys }),
    });
  }

  clearAuthentication() {
    this._generation += 1;
    this._cache.clear();
    this._grants.clear();
    this._deniedRoutes.clear();
    this._refreshes.clear();
  }

  #requestRoute(route, generation) {
    const body = JSON.stringify({
      control: "capabilityRequest",
      protocol: CAPABILITY_HANDSHAKE_PROTOCOL,
      requestId: crypto.randomUUID(),
      capability: "native.pulse",
      scopes: [route],
      reason: "missing-or-refresh-due",
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      const fail = (error) => settle(reject, error);
      const req = http.request({
        socketPath: this.pipePath,
        path: "/v1/capabilities/handshake",
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            const error = brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response exceeded the allowed size");
            fail(error);
            res.destroy(error);
            req.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("aborted", () => fail(brokerError(
          "POSSE_PARENT_PULSE_INVALID_RESPONSE",
          "parent pulse response was aborted before completion",
        )));
        res.on("end", () => {
          if (settled) return;
          if (this._generation !== generation) {
            fail(brokerError(
              "POSSE_PARENT_PULSE_AUTH_CHANGED",
              "parent pulse authentication changed while the route grant was being requested",
            ));
            return;
          }
          if (res.statusCode !== 200) {
            const status = Number(res.statusCode) || 0;
            if (status === 401 || status === 403) {
              this._cache.delete(route);
              this._grants.delete(route);
              this._deniedRoutes.add(route);
              fail(brokerError("POSSE_PARENT_PULSE_DENIED", `parent pulse broker denied route ${route}`));
              return;
            }
            fail(brokerError("POSSE_PARENT_PULSE_REJECTED", `parent pulse broker rejected the request with HTTP ${status}`));
            return;
          }
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
            fail(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response was not valid JSON"));
            return;
          }
          const grant = parsed?.grant;
          const envelope = grant?.artifacts?.tokens?.pulses?.[route] || null;
          if (grant?.protocol !== CAPABILITY_HANDSHAKE_PROTOCOL
            || grant?.capability !== "native.pulse"
            || !Array.isArray(grant?.scopes)
            || !grant.scopes.includes(route)) {
            fail(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response contained an invalid capability grant"));
            return;
          }
          if (!validEnvelope(envelope, route)) {
            fail(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response did not contain the requested route grant"));
            return;
          }
          if (!validRouteGrant(grant, envelope)) {
            fail(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response contained an invalid grant expiry"));
            return;
          }
          const frozen = Object.freeze({
            ...envelope,
            nativeArtifacts: Object.freeze({ ...(envelope.nativeArtifacts || {}) }),
          });
          this._cache.set(route, frozen);
          this._grants.set(route, Object.freeze({
            expiresAt: Number(grant.expiresAt),
            pins: Object.freeze({ ...(grant.artifacts?.pins || {}) }),
            keys: Object.freeze({ ...(grant.artifacts?.keys || {}) }),
          }));
          settle(resolve, frozen);
        });
      });
      timer = setTimeout(() => {
        const error = brokerError("POSSE_PARENT_PULSE_TIMEOUT", `parent pulse request timed out after ${this.timeoutMs}ms`);
        fail(error);
        req.destroy(error);
      }, this.timeoutMs);
      timer.unref?.();
      req.on("error", (error) => fail(/** @type {any} */ (error)?.code
        ? error
        : brokerError("POSSE_PARENT_PULSE_UNAVAILABLE", "parent pulse broker is unavailable")));
      req.end(body);
    });
  }
}

function validEnvelope(value, route) {
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

function validRouteGrant(grant, envelope) {
  const expiresAt = Number(grant?.expiresAt);
  return Number.isSafeInteger(expiresAt)
    && expiresAt > Math.floor(Date.now() / 1000)
    && expiresAt <= Number(envelope?.expiresAt);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function brokerError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}
