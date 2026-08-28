import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { pulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";

export const PAIRING_AUTH_ROUTE = "pairing:session";
export const PAIRING_PROTOCOL = "posse.pairing.v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PAIRING_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/u;
const TOKEN_RE = /^pp[hm]_[0-9a-f]{32}$/u;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/u;
const SESSION_STATUSES = new Set(["active", "closed", "expired"]);

function invalidResponse(endpoint, detail, status = null) {
  const error = new Error(`Pairing relay returned an invalid ${endpoint} response: ${detail}`);
  error.code = "pairing_invalid_response";
  if (status != null) error.status = status;
  return error;
}

function recordPayload(endpoint, payload, status) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw invalidResponse(endpoint, "expected a JSON object", status);
  }
  return payload;
}

function requiredString(endpoint, payload, key, {
  maxLength = 2048,
  pattern = null,
  status = null,
} = {}) {
  const value = payload[key];
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
    || (pattern && !pattern.test(value))) {
    throw invalidResponse(endpoint, `${key} is invalid`, status);
  }
  return value;
}

function validateProtocol(endpoint, payload, status) {
  if (payload.protocol !== PAIRING_PROTOCOL) {
    throw invalidResponse(endpoint, `expected protocol ${PAIRING_PROTOCOL}`, status);
  }
}

function validateExpiry(endpoint, payload, status) {
  const value = requiredString(endpoint, payload, "expires_at", { maxLength: 64, status });
  if (!Number.isFinite(Date.parse(value))) {
    throw invalidResponse(endpoint, "expires_at is invalid", status);
  }
}

function validateRepository(endpoint, payload, status) {
  const repository = recordPayload(endpoint, payload.repository, status);
  requiredString(endpoint, repository, "url", { status });
  requiredString(endpoint, repository, "fingerprint", {
    maxLength: 64,
    pattern: FINGERPRINT_RE,
    status,
  });
  requiredString(endpoint, repository, "branch", { maxLength: 255, status });
}

export function validatePairingRemoteResponse(endpoint, payload, status = null) {
  const response = recordPayload(endpoint, payload, status);
  if (endpoint === "leave") {
    if (response.status !== "left") throw invalidResponse(endpoint, "status is invalid", status);
    return response;
  }

  validateProtocol(endpoint, response, status);
  requiredString(endpoint, response, "session_id", {
    maxLength: 36,
    pattern: SESSION_ID_RE,
    status,
  });
  validateExpiry(endpoint, response, status);
  validateRepository(endpoint, response, status);

  if (endpoint === "sessions") {
    requiredString(endpoint, response, "code", {
      maxLength: 11,
      pattern: PAIRING_CODE_RE,
      status,
    });
    requiredString(endpoint, response, "host_token", {
      maxLength: 36,
      pattern: TOKEN_RE,
      status,
    });
  } else if (endpoint === "join") {
    requiredString(endpoint, response, "member_token", {
      maxLength: 36,
      pattern: TOKEN_RE,
      status,
    });
  } else if (endpoint === "status" || endpoint === "heartbeat") {
    if (!SESSION_STATUSES.has(response.status)) {
      throw invalidResponse(endpoint, "status is invalid", status);
    }
    if (!["host", "member"].includes(response.role)) {
      throw invalidResponse(endpoint, "role is invalid", status);
    }
    if (!Number.isSafeInteger(response.active_members) || response.active_members < 0) {
      throw invalidResponse(endpoint, "active_members is invalid", status);
    }
  } else if (endpoint !== "resolve") {
    throw invalidResponse(endpoint, "unknown endpoint contract", status);
  }
  return response;
}

function responseError(body, status) {
  const message = String(body?.error?.message || body?.message || `HTTP ${status}`);
  const error = new Error(message);
  error.code = String(body?.error?.code || "pairing_remote_error");
  error.status = status;
  return error;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Pairing relay returned invalid JSON"), {
      code: "pairing_invalid_response",
      status: response.status,
    });
  }
}

export function createPairingRemoteClient({
  fetchImpl = globalThis.fetch,
  authManager = heartbeatAuthManager,
  pulseTokens = pulseTokenManager,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Pairing client requires fetch");
  const trustedPolicy = authManager.getTrustedAuthPolicy?.();
  const origin = String(trustedPolicy?.origin || "").trim();
  if (!origin) {
    const error = new Error("Trusted Posse Remote policy is unavailable");
    error.code = "pairing_remote_untrusted";
    throw error;
  }

  async function request(endpoint, { method = "POST", body = null, token = null } = {}) {
    const url = new URL(`v1/pairing/${endpoint}`, new URL("/", origin));
    pulseTokens.assertTrustedResourceUrl(url, `Posse pairing ${endpoint}`);
    const authorization = token || await pulseTokens.getPulseToken({
      requiredRoute: PAIRING_AUTH_ROUTE,
    });
    if (!authorization) {
      const error = new Error("Pairing authentication is unavailable");
      error.code = "pairing_auth_unavailable";
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${authorization}`,
            ...(body == null ? {} : { "content-type": "application/json" }),
          },
          ...(body == null ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (cause) {
        throw transportError(cause);
      }
      let payload;
      try {
        payload = await readJson(response);
      } catch (cause) {
        if (cause?.code === "pairing_invalid_response") throw cause;
        throw transportError(cause);
      }
      if (!response.ok) throw responseError(payload, response.status);
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  const validatedRequest = async (endpoint, options) => {
    const payload = await request(endpoint, options);
    return validatePairingRemoteResponse(endpoint, payload);
  };

  return Object.freeze({
    start: (metadata) => validatedRequest("sessions", { body: metadata }),
    resolve: (code) => validatedRequest("resolve", { body: { code } }),
    join: (code, instanceId) => validatedRequest("join", { body: { code, instance_id: instanceId } }),
    status: (token) => validatedRequest("status", { method: "GET", token }),
    heartbeat: (token) => validatedRequest("heartbeat", { token }),
    leave: (token) => validatedRequest("leave", { token }),
  });
}

function transportError(cause) {
  const error = new Error(
    cause?.name === "AbortError"
      ? "Pairing relay request timed out"
      : `Could not reach the pairing relay: ${cause?.message || cause}`,
    { cause },
  );
  error.code = cause?.name === "AbortError" ? "pairing_remote_timeout" : "pairing_remote_unavailable";
  return error;
}
