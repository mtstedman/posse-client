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
    this._refreshes = new Map();
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
    const cached = this.getCachedPulseEnvelope({ requiredRoute: route });
    if (!refresh && cached && Date.now() < Number(cached.refreshAfter) * 1000) return cached;
    const inFlight = this._refreshes.get(route);
    if (inFlight) return inFlight;
    const request = this.#requestRoute(route).finally(() => {
      if (this._refreshes.get(route) === request) this._refreshes.delete(route);
    });
    this._refreshes.set(route, request);
    return request;
  }

  getCachedPulseEnvelope({ requiredRoute } = /** @type {any} */ ({})) {
    const route = String(requiredRoute || "").trim();
    const envelope = this._cache.get(route) || null;
    if (!validEnvelope(envelope, route)) {
      if (envelope) this._cache.delete(route);
      return null;
    }
    return envelope;
  }

  async getPulseToken({ refresh = false, requiredRoute } = {}) {
    if (!requiredRoute) {
      throw brokerError("POSSE_PULSE_ROUTE_REQUIRED", "a child broker cannot request an unscoped pulse token");
    }
    const envelope = await this.getPulseEnvelope({ refresh, requiredRoute });
    return envelope?.token || null;
  }

  clearAuthentication() {
    this._cache.clear();
    this._refreshes.clear();
  }

  #requestRoute(route) {
    const body = JSON.stringify({
      control: "capabilityRequest",
      protocol: CAPABILITY_HANDSHAKE_PROTOCOL,
      requestId: crypto.randomUUID(),
      capability: "native.pulse",
      scopes: [route],
      reason: "missing-or-refresh-due",
    });
    return new Promise((resolve, reject) => {
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
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response exceeded the allowed size"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(brokerError("POSSE_PARENT_PULSE_REJECTED", `parent pulse broker rejected the request with HTTP ${res.statusCode || 0}`));
            return;
          }
          let parsed;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
            reject(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response was not valid JSON"));
            return;
          }
          const envelope = parsed?.grant?.artifacts?.tokens?.pulses?.[route] || null;
          if (!validEnvelope(envelope, route)) {
            reject(brokerError("POSSE_PARENT_PULSE_INVALID_RESPONSE", "parent pulse response did not contain the requested route grant"));
            return;
          }
          const frozen = Object.freeze({ ...envelope });
          this._cache.set(route, frozen);
          resolve(frozen);
        });
      });
      const timer = setTimeout(() => {
        req.destroy(brokerError("POSSE_PARENT_PULSE_TIMEOUT", `parent pulse request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      req.on("close", () => clearTimeout(timer));
      req.on("error", () => reject(brokerError("POSSE_PARENT_PULSE_UNAVAILABLE", "parent pulse broker is unavailable")));
      req.end(body);
    });
  }
}

function validEnvelope(value, route) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (String(value.route || "") !== route) return false;
  if (!String(value.token || "").trim() || !String(value.kid || "").trim()) return false;
  return Number(value.expiresAt) > Math.floor(Date.now() / 1000);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function brokerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
