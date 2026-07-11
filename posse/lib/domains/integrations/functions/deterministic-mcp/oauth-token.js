// @ts-check
//
// Local OAuth-style capability tokens for the Posse MCP gateway.
//
// These tokens are intentionally small, local, and HMAC-signed. They let a
// stdio shim or persistent gateway derive job/session capabilities from a
// signed bearer instead of trusting model-controlled tool arguments.

import crypto from "crypto";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import {
  claimAccountSettingIfAbsent,
  getAccountSetting,
  setAccountSetting,
} from "../../../settings/functions/account-settings.js";
import {
  normalizeProjectDbCapability,
  normalizeSuiteToolAllowlist,
} from "../../../../shared/tools/functions/issued-tool-policy.js";

export const MCP_OAUTH_ISSUER = "posse";
export const MCP_OAUTH_AUDIENCE = "posse-mcp-gateway";
export const MCP_OAUTH_TOKEN_TYPE = "posse.mcp.oauth.v1";
export const DEFAULT_MCP_OAUTH_TTL_SECONDS = 8 * 60 * 60;

const TOKEN_PART_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {{
 *   getSettingFn?: (key: string) => unknown,
 * }} [opts]
 * @returns {string}
 */
export function getMcpOAuthSigningKey(opts = {}) {
  const getFn = opts.getSettingFn || getAccountSetting;
  return normalizeSigningKey(getFn(SETTING_KEYS.MCP_OAUTH_SIGNING_KEY));
}

/**
 * @param {{
 *   getSettingFn?: (key: string) => unknown,
 *   setSettingFn?: (key: string, value: string) => unknown,
 *   claimSettingFn?: (key: string, value: string) => boolean,
 * }} [opts]
 * @returns {string}
 */
export function ensureMcpOAuthSigningKey(opts = {}) {
  const getFn = opts.getSettingFn || getAccountSetting;
  const setFn = opts.setSettingFn || setAccountSetting;
  const claimFn = opts.claimSettingFn || claimAccountSettingIfAbsent;
  const existing = getMcpOAuthSigningKey({ getSettingFn: getFn });
  if (existing) return existing;
  const candidate = crypto.randomBytes(32).toString("base64url");
  try {
    if (claimFn(SETTING_KEYS.MCP_OAUTH_SIGNING_KEY, candidate)) return candidate;
    return getMcpOAuthSigningKey({ getSettingFn: getFn }) || candidate;
  } catch {
    try { setFn(SETTING_KEYS.MCP_OAUTH_SIGNING_KEY, candidate); } catch { /* best effort */ }
    return getMcpOAuthSigningKey({ getSettingFn: getFn }) || candidate;
  }
}

/**
 * @param {Record<string, unknown>} claims
 * @param {{ secret?: string, nowMs?: number, expiresInSeconds?: number, jti?: string, getSettingFn?: (key: string) => unknown, setSettingFn?: (key: string, value: string) => unknown, claimSettingFn?: (key: string, value: string) => boolean }} [opts]
 * @returns {string}
 */
export function mintMcpOAuthToken(claims, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const iat = Math.floor(nowMs / 1000);
  const ttl = Number.isFinite(Number(opts.expiresInSeconds)) && Number(opts.expiresInSeconds) > 0
    ? Math.floor(Number(opts.expiresInSeconds))
    : DEFAULT_MCP_OAUTH_TTL_SECONDS;
  const payload = {
    ...claims,
    typ: MCP_OAUTH_TOKEN_TYPE,
    iss: String(claims.iss || MCP_OAUTH_ISSUER),
    aud: String(claims.aud || MCP_OAUTH_AUDIENCE),
    iat: Number.isFinite(Number(claims.iat)) ? Number(claims.iat) : iat,
    exp: Number.isFinite(Number(claims.exp)) ? Number(claims.exp) : iat + ttl,
    jti: String(claims.jti || opts.jti || crypto.randomUUID()),
  };
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = signTokenInput(signingInput, resolveSigningSecret(opts.secret, {
    createIfMissing: true,
    getSettingFn: opts.getSettingFn,
    setSettingFn: opts.setSettingFn,
    claimSettingFn: opts.claimSettingFn,
  }));
  return `${signingInput}.${signature}`;
}

/**
 * @param {Record<string, unknown>} bootConfig
 * @param {{ secret?: string, nowMs?: number, expiresInSeconds?: number, jti?: string, getSettingFn?: (key: string) => unknown, setSettingFn?: (key: string, value: string) => unknown, claimSettingFn?: (key: string, value: string) => boolean }} [opts]
 * @returns {string}
 */
export function mintMcpOAuthTokenForBootConfig(bootConfig = {}, opts = {}) {
  return mintMcpOAuthToken(buildMcpOAuthClaimsFromBootConfig(bootConfig), opts);
}

/**
 * @param {Record<string, unknown>} bootConfig
 * @returns {Record<string, unknown>}
 */
export function buildMcpOAuthClaimsFromBootConfig(bootConfig = {}) {
  const jobId = numberOrNull(bootConfig.jobId);
  const workItemId = numberOrNull(bootConfig.workItemId);
  const attemptId = numberOrNull(bootConfig.attemptId);
  const agentCallId = numberOrNull(bootConfig.agentCallId);
  const promptChars = numberOrNull(bootConfig.promptChars);
  const role = stringOrNull(bootConfig.role);
  const providerName = stringOrNull(bootConfig.providerName);
  return {
    sub: jobId != null ? `job:${jobId}` : `mcp:${crypto.randomUUID()}`,
    job_id: jobId,
    work_item_id: workItemId,
    role,
    provider: providerName,
    capabilities: {
      cwd: stringOrNull(bootConfig.cwd),
      dbPath: stringOrNull(bootConfig.dbPath),
      role,
      providerName,
      jobId,
      workItemId,
      attemptId,
      agentCallId,
      promptChars,
      disableSystemTools: bootConfig.disableSystemTools === true,
      scopedFiles: stringArray(bootConfig.scopedFiles),
      createFiles: stringArray(bootConfig.createFiles),
      deleteFiles: stringArray(bootConfig.deleteFiles),
      createRoots: stringArray(bootConfig.createRoots),
      readRoots: stringArray(bootConfig.readRoots),
      allowWrite: bootConfig.allowWrite === true,
      allowShell: bootConfig.allowShell === true,
      allowTests: bootConfig.allowTests === true,
      projectDbWrite: bootConfig.projectDbWrite === true,
      projectDbCapability: normalizeProjectDbCapability(
        bootConfig.projectDbCapability || (bootConfig.projectDbWrite === true ? "write" : "none"),
      ),
      allowImageHelpers: bootConfig.allowImageHelpers === true,
      allowImageGeneration: bootConfig.allowImageGeneration === true,
      atlasAvailable: bootConfig.atlasAvailable === true,
      atlasGateEnabled: bootConfig.atlasGateEnabled === true,
      atlasPrefetchStatus: stringOrNull(bootConfig.atlasPrefetchStatus) || "",
      atlas: plainObjectOrNull(bootConfig.atlas) || {},
      remoteCatalog: plainObjectOrNull(bootConfig.remoteCatalog) || {},
      toolAllowlist: normalizeSuiteToolAllowlist(bootConfig.toolAllowlist),
      toolPolicy: plainObjectOrNull(bootConfig.issuedToolPolicy) || {},
      webAccess: plainObjectOrNull(bootConfig.issuedWebAccess) || {},
      nativeAuth: plainObjectOrNull(bootConfig.nativeAuth) || null,
    },
  };
}

/**
 * @param {string} token
 * @param {{ secret?: string, nowMs?: number, audience?: string, issuer?: string, clockSkewSeconds?: number, getSettingFn?: (key: string) => unknown }} [opts]
 * @returns {Record<string, unknown>}
 */
export function verifyMcpOAuthToken(token, opts = {}) {
  const text = String(token || "").trim();
  const parts = text.split(".");
  if (parts.length !== 3 || parts.some((part) => !part || !TOKEN_PART_RE.test(part))) {
    throw tokenError("invalid_token", "MCP OAuth token must be a signed JWT-like bearer token");
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = signTokenInput(signingInput, resolveSigningSecret(opts.secret, {
    createIfMissing: false,
    getSettingFn: opts.getSettingFn,
  }));
  if (!timingSafeTokenEqual(signature, expected)) {
    throw tokenError("invalid_signature", "MCP OAuth token signature is invalid");
  }
  const header = parseBase64UrlJson(encodedHeader, "header");
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw tokenError("invalid_header", "MCP OAuth token header is unsupported");
  }
  const claims = parseBase64UrlJson(encodedPayload, "payload");
  const audience = String(opts.audience || MCP_OAUTH_AUDIENCE);
  const issuer = String(opts.issuer || MCP_OAUTH_ISSUER);
  if (claims.typ !== MCP_OAUTH_TOKEN_TYPE) throw tokenError("invalid_type", "MCP OAuth token type is unsupported");
  if (claims.aud !== audience) throw tokenError("invalid_audience", "MCP OAuth token audience is invalid");
  if (claims.iss !== issuer) throw tokenError("invalid_issuer", "MCP OAuth token issuer is invalid");
  const now = Math.floor((Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now()) / 1000);
  const skew = Number.isFinite(Number(opts.clockSkewSeconds)) ? Math.max(0, Number(opts.clockSkewSeconds)) : 30;
  const exp = Number(claims.exp);
  const iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp + skew < now) throw tokenError("token_expired", "MCP OAuth token is expired");
  if (Number.isFinite(iat) && iat - skew > now) throw tokenError("token_not_yet_valid", "MCP OAuth token is not valid yet");
  return claims;
}

/**
 * @param {Record<string, unknown>} claims
 * @returns {Record<string, unknown>}
 */
export function bootConfigFromMcpOAuthClaims(claims = {}) {
  const capabilities = plainObjectOrNull(claims.capabilities) || {};
  return {
    cwd: stringOrNull(capabilities.cwd) || "",
    dbPath: stringOrNull(capabilities.dbPath) || "",
    role: stringOrNull(capabilities.role) || "",
    providerName: stringOrNull(capabilities.providerName) || "",
    jobId: numberOrNull(capabilities.jobId),
    workItemId: numberOrNull(capabilities.workItemId),
    attemptId: numberOrNull(capabilities.attemptId),
    agentCallId: numberOrNull(capabilities.agentCallId),
    promptChars: numberOrNull(capabilities.promptChars) || 0,
    disableSystemTools: capabilities.disableSystemTools === true,
    scopedFiles: stringArray(capabilities.scopedFiles),
    createFiles: stringArray(capabilities.createFiles),
    deleteFiles: stringArray(capabilities.deleteFiles),
    createRoots: stringArray(capabilities.createRoots),
    readRoots: stringArray(capabilities.readRoots),
    allowWrite: capabilities.allowWrite === true,
    allowShell: capabilities.allowShell === true,
    allowTests: capabilities.allowTests === true,
    projectDbWrite: capabilities.projectDbWrite === true,
    projectDbCapability: normalizeProjectDbCapability(
      capabilities.projectDbCapability || (capabilities.projectDbWrite === true ? "write" : "none"),
    ),
    allowImageHelpers: capabilities.allowImageHelpers === true,
    allowImageGeneration: capabilities.allowImageGeneration === true,
    atlasAvailable: capabilities.atlasAvailable === true,
    atlasGateEnabled: capabilities.atlasGateEnabled === true,
    atlasPrefetchStatus: stringOrNull(capabilities.atlasPrefetchStatus) || "",
    atlas: plainObjectOrNull(capabilities.atlas) || {},
    remoteCatalog: plainObjectOrNull(capabilities.remoteCatalog) || {},
    toolAllowlist: normalizeSuiteToolAllowlist(capabilities.toolAllowlist || capabilities.tool_allowlist),
    issuedToolPolicy: plainObjectOrNull(capabilities.toolPolicy || capabilities.tool_policy) || {},
    issuedWebAccess: plainObjectOrNull(capabilities.webAccess || capabilities.web_access) || {},
    nativeAuth: plainObjectOrNull(capabilities.nativeAuth) || null,
  };
}

function resolveSigningSecret(secret, opts = {}) {
  const text = normalizeSigningKey(secret);
  if (text) return text;
  if (opts.createIfMissing === false) {
    const existing = getMcpOAuthSigningKey({ getSettingFn: opts.getSettingFn });
    if (existing) return existing;
    throw tokenError("missing_signing_key", "MCP OAuth signing key is not initialized");
  }
  return ensureMcpOAuthSigningKey(opts);
}

function normalizeSigningKey(value) {
  const text = String(value || "").trim();
  return text.length >= 32 ? text : "";
}

function signTokenInput(signingInput, secret) {
  return crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseBase64UrlJson(value, part) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw tokenError("invalid_token", `MCP OAuth token ${part} is invalid`);
  }
}

function timingSafeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function tokenError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function plainObjectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}
