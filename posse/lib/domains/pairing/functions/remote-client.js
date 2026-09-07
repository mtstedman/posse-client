import { heartbeatAuthManager } from "../../../shared/native/classes/HeartbeatAuthManager.js";
import { pulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";
import { readResponseTextWithLimit } from "../../remote/functions/client.js";

export const PAIRING_AUTH_ROUTE = "pairing:session";
export const PAIRING_PROTOCOL = "posse.pairing.v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PAIRING_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/u;
const TOKEN_RE = /^pp[hm]_[0-9a-f]{32}$/u;
const COUNTERSIGN_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/u;
const SESSION_STATUSES = new Set(["active", "draining", "closed", "expired"]);
const PEER_ROLES = new Set(["host", "member"]);
const MAX_PEERS = 100;
const MAX_WORK_ITEMS = 50;
const MAX_JOBS = 100;
const MAX_PAIRING_RESPONSE_BYTES = 8 * 1024 * 1024;

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

function validatePolicies(endpoint, payload, status) {
  if (payload.policies == null) return;
  const policies = recordPayload(endpoint, payload.policies, status);
  if (!["each-member", "capability-routing", "host-only"].includes(policies.compute)) {
    throw invalidResponse(endpoint, "policies.compute is invalid", status);
  }
  if (!["none", "side-trunk"].includes(policies.integration)) {
    throw invalidResponse(endpoint, "policies.integration is invalid", status);
  }
}

function validateScopeSet(endpoint, scopeSet, status) {
  if (scopeSet == null) return;
  const scope = recordPayload(endpoint, scopeSet, status);
  const write = recordPayload(endpoint, scope.write || {}, status);
  for (const field of ["files", "roots"]) {
    if (!Array.isArray(write[field]) || write[field].length > 256
      || write[field].some((value) => typeof value !== "string" || !value || value.length > 1024)) {
      throw invalidResponse(endpoint, `scope_set.write.${field} is invalid`, status);
    }
  }
  if (typeof write.unknown !== "boolean") {
    throw invalidResponse(endpoint, "scope_set.write.unknown is invalid", status);
  }
}

function optionalPeerWorkItems(endpoint, peer, status) {
  if (!Array.isArray(peer.work_items) || peer.work_items.length > MAX_WORK_ITEMS) {
    throw invalidResponse(endpoint, "peer work_items is invalid", status);
  }
  for (const item of peer.work_items) {
    const record = recordPayload(endpoint, item, status);
    if (!Number.isSafeInteger(record.id) || record.id <= 0) {
      throw invalidResponse(endpoint, "peer work item id is invalid", status);
    }
    requiredString(endpoint, record, "title", { maxLength: 240, status });
    requiredString(endpoint, record, "status", { maxLength: 40, status });
    requiredString(endpoint, record, "priority", { maxLength: 20, status });
  }
}

function validatePeers(endpoint, response, status) {
  if (response.peers == null) {
    response.peers = [];
    return;
  }
  if (!Array.isArray(response.peers) || response.peers.length > MAX_PEERS) {
    throw invalidResponse(endpoint, "peers is invalid", status);
  }
  for (const value of response.peers) {
    const peer = recordPayload(endpoint, value, status);
    requiredString(endpoint, peer, "instance_id", { maxLength: 128, status });
    requiredString(endpoint, peer, "label", { maxLength: 160, status });
    if (peer.git_identities == null) peer.git_identities = [];
    if (!Array.isArray(peer.git_identities) || peer.git_identities.length > 16
      || peer.git_identities.some((value) => typeof value !== "string" || !value || value.length > 320)) {
      throw invalidResponse(endpoint, "peer git_identities is invalid", status);
    }
    if (peer.capabilities == null) peer.capabilities = {};
    const capabilities = recordPayload(endpoint, peer.capabilities, status);
    if (Object.keys(capabilities).length > 0) {
      for (const field of ["job_types", "providers", "headroom"]) {
        if (!Array.isArray(capabilities[field]) || capabilities[field].length > 32) {
          throw invalidResponse(endpoint, `peer capabilities.${field} is invalid`, status);
        }
      }
      if (capabilities.job_types.some((value) => typeof value !== "string" || !value || value.length > 80)
        || capabilities.providers.some((value) => typeof value !== "string" || !value || value.length > 80)
        || typeof capabilities.tier !== "string" || !capabilities.tier || capabilities.tier.length > 40) {
        throw invalidResponse(endpoint, "peer capabilities names are invalid", status);
      }
      for (const entry of capabilities.headroom) {
        const headroom = recordPayload(endpoint, entry, status);
        if (typeof headroom.provider !== "string" || !headroom.provider || headroom.provider.length > 80
          || typeof headroom.available !== "boolean"
          || !Number.isSafeInteger(headroom.retry_after_sec)
          || headroom.retry_after_sec < 0 || headroom.retry_after_sec > 86_400) {
          throw invalidResponse(endpoint, "peer capabilities headroom is invalid", status);
        }
      }
    }
    if (!PEER_ROLES.has(peer.role)) {
      throw invalidResponse(endpoint, "peer role is invalid", status);
    }
    const updatedAt = requiredString(endpoint, peer, "updated_at", { maxLength: 64, status });
    if (!Number.isFinite(Date.parse(updatedAt))) {
      throw invalidResponse(endpoint, "peer updated_at is invalid", status);
    }
    optionalPeerWorkItems(endpoint, peer, status);
    if (peer.jobs == null) peer.jobs = [];
    if (!Array.isArray(peer.jobs) || peer.jobs.length > MAX_JOBS) {
      throw invalidResponse(endpoint, "peer jobs is invalid", status);
    }
    for (const value of peer.jobs) {
      const job = recordPayload(endpoint, value, status);
      if (!Number.isSafeInteger(job.id) || job.id <= 0) {
        throw invalidResponse(endpoint, "peer job id is invalid", status);
      }
      if (job.work_item_id != null && (!Number.isSafeInteger(job.work_item_id) || job.work_item_id <= 0)) {
        throw invalidResponse(endpoint, "peer job work_item_id is invalid", status);
      }
      requiredString(endpoint, job, "title", { maxLength: 240, status });
      requiredString(endpoint, job, "status", { maxLength: 40, status });
      requiredString(endpoint, job, "job_type", { maxLength: 40, status });
    }
  }
}

function validateMembers(endpoint, response, status) {
  if (!Array.isArray(response.members) || response.members.length > MAX_PEERS) {
    throw invalidResponse(endpoint, "members is invalid", status);
  }
  for (const value of response.members) {
    const member = recordPayload(endpoint, value, status);
    requiredString(endpoint, member, "id", { maxLength: 128, status });
    requiredString(endpoint, member, "instance_id", { maxLength: 128, status });
    requiredString(endpoint, member, "state", { maxLength: 16, status });
    requiredString(endpoint, member, "role", { maxLength: 16, status });
    if (member.ssh_public_key != null) {
      requiredString(endpoint, member, "ssh_public_key", { maxLength: 16_640, status });
    }
    if (!member.scope_set || typeof member.scope_set !== "object" || Array.isArray(member.scope_set)) {
      throw invalidResponse(endpoint, "member scope_set is invalid", status);
    }
    const joinedAt = requiredString(endpoint, member, "joined_at", { maxLength: 64, status });
    if (!Number.isFinite(Date.parse(joinedAt))) {
      throw invalidResponse(endpoint, "member joined_at is invalid", status);
    }
  }
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
  validatePolicies(endpoint, response, status);
  validateScopeSet(endpoint, response.scope_set, status);
  if (response.admitted_member != null) {
    validateMembers(endpoint, { members: [response.admitted_member] }, status);
  }

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
    const joinStatus = response.status || "admitted";
    if (joinStatus === "pending") {
      requiredString(endpoint, response, "pending_token", {
        maxLength: 36,
        pattern: TOKEN_RE,
        status,
      });
      requiredString(endpoint, response, "countersign", {
        maxLength: 4,
        pattern: COUNTERSIGN_RE,
        status,
      });
    } else if (joinStatus === "admitted") {
      requiredString(endpoint, response, "member_token", {
        maxLength: 36,
        pattern: TOKEN_RE,
        status,
      });
    } else {
      throw invalidResponse(endpoint, "status is invalid", status);
    }
  } else if (endpoint === "pending") {
    if (!["pending", "admitted", "left", "kicked", "closed", "expired"].includes(response.status)) {
      throw invalidResponse(endpoint, "status is invalid", status);
    }
    requiredString(endpoint, response, "member_role", { maxLength: 32, status });
  } else if (endpoint === "members") {
    validateMembers(endpoint, response, status);
  } else if (endpoint === "status" || endpoint === "heartbeat" || endpoint === "close" || endpoint === "admit") {
    if (!SESSION_STATUSES.has(response.status)) {
      throw invalidResponse(endpoint, "status is invalid", status);
    }
    if (!["host", "member"].includes(response.role)) {
      throw invalidResponse(endpoint, "role is invalid", status);
    }
    if (!Number.isSafeInteger(response.active_members) || response.active_members < 0) {
      throw invalidResponse(endpoint, "active_members is invalid", status);
    }
    if (response.enrollment_open != null && typeof response.enrollment_open !== "boolean") {
      throw invalidResponse(endpoint, "enrollment_open is invalid", status);
    }
    if (response.compute_policy != null
      && !["each-member", "capability-routing", "host-only"].includes(response.compute_policy)) {
      throw invalidResponse(endpoint, "compute_policy is invalid", status);
    }
    if (response.integration_policy != null
      && !["none", "side-trunk"].includes(response.integration_policy)) {
      throw invalidResponse(endpoint, "integration_policy is invalid", status);
    }
    validatePeers(endpoint, response, status);
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

async function readJson(response, endpoint) {
  let text;
  try {
    text = await readResponseTextWithLimit(response, {
      maxBytes: MAX_PAIRING_RESPONSE_BYTES,
      operation: "pairing relay request",
      url: "trusted pairing relay",
    });
  } catch (error) {
    if (error?.code === "POSSE_REMOTE_RESPONSE_TOO_LARGE") {
      throw invalidResponse(endpoint, `response exceeds ${MAX_PAIRING_RESPONSE_BYTES} bytes`, response.status);
    }
    throw error;
  }
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

  async function request(endpoint, { method = "POST", body = null, token = null, path = endpoint } = {}) {
    const url = new URL(`v1/pairing/${path}`, new URL("/", origin));
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
        payload = await readJson(response, endpoint);
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
    start: (metadata) => validatedRequest("sessions", {
      body: { ...metadata, shutdown_protocol: 2 },
    }),
    resolve: (code) => validatedRequest("resolve", { body: { code } }),
    join: (code, instanceId) => validatedRequest("join", {
      body: { code, instance_id: instanceId, shutdown_protocol: 2 },
    }),
    requestJoin: async (code, instanceId, { sshPublicKey = null } = {}) => {
      const response = await validatedRequest("join", {
        body: {
          code,
          instance_id: instanceId,
          shutdown_protocol: 2,
          admission_protocol: 2,
          ...(sshPublicKey ? { ssh_public_key: sshPublicKey } : {}),
        },
      });
      if (response.status == null) {
        throw invalidResponse("join", "relay does not support host admission");
      }
      return response;
    },
    pendingStatus: (token) => validatedRequest("pending", { method: "GET", token }),
    admit: (token, countersign) => validatedRequest("admit", {
      token,
      body: { countersign },
      path: "members/admit",
    }),
    members: (token, { pendingOnly = false } = {}) => validatedRequest("members", {
      method: "GET",
      token,
      path: pendingOnly ? "members/pending" : "members",
    }),
    kick: (token, memberId) => validatedRequest("status", {
      token,
      body: { member_id: memberId },
      path: "members/kick",
    }),
    setInviteOpen: (token, open) => validatedRequest("status", {
      token,
      path: `invite/${open ? "open" : "close"}`,
    }),
    setScope: (token, memberId, scopeSet, role = "operator") => validatedRequest("status", {
      token,
      body: { member_id: memberId, role, scope_set: scopeSet },
      path: "members/scope",
    }),
    setPolicy: (token, compute) => validatedRequest("status", {
      token,
      body: { compute, scheduler_routing_protocol: 1 },
      path: "policy",
    }),
    status: (token) => validatedRequest("status", { method: "GET", token }),
    heartbeat: (token, presence = null) => validatedRequest("heartbeat", { token, body: presence }),
    close: (token, mode = "graceful") => validatedRequest("close", { token, body: { mode } }),
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
