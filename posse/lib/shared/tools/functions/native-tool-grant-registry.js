// @ts-check
//
// Custody of Remote-issued native tool grants.
//
// A grant is an opaque Remote-signed token the native dispatch hosts verify.
// Node never interprets it as authority and never writes it into packets,
// telemetry, or persisted boot payloads: the token lives only in this WeakMap,
// keyed by the trusted surface object it was issued beside, and follows that
// surface through sanitization and narrowing so the agent gate can relay it.

import { PROVIDER_TOOL_GRANT_PROTOCOL } from "../../../catalog/binary.js";

const SURFACE_GRANTS = new WeakMap();

/**
 * @typedef {object} NativeToolGrant
 * @property {string} token
 * @property {string} grantId
 * @property {number|null} expiresAt
 * @property {string} protocol
 */

/**
 * Normalize a Remote `native_tool_grant` issuance object. Returns null when
 * the issuance is absent, malformed, or declares another protocol.
 * @param {unknown} value
 * @returns {Readonly<NativeToolGrant> | null}
 */
export function normalizeNativeToolGrant(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
  if (!source) return null;
  const token = typeof source.token === "string" ? source.token.trim() : "";
  const protocol = String(source.protocol || PROVIDER_TOOL_GRANT_PROTOCOL);
  if (!token || protocol !== PROVIDER_TOOL_GRANT_PROTOCOL) return null;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const expiresAt = Number(source.expires_at ?? source.expiresAt);
  return Object.freeze({
    token,
    grantId: String(source.grant_id || source.grantId || ""),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    protocol,
  });
}

/**
 * Attach a grant to a trusted surface object.
 * @param {object | null} surface
 * @param {unknown} grant
 * @returns {Readonly<NativeToolGrant> | null}
 */
export function registerNativeToolGrant(surface, grant) {
  const normalized = normalizeNativeToolGrant(grant);
  if (!surface || typeof surface !== "object" || !normalized) return null;
  SURFACE_GRANTS.set(surface, normalized);
  return normalized;
}

/** @param {unknown} surface */
export function nativeToolGrantForSurface(surface) {
  return surface && typeof surface === "object" ? SURFACE_GRANTS.get(surface) || null : null;
}

/**
 * Carry the grant of `from` to a derived surface object. Narrowing never mints
 * a new grant; the derived surface relays the ceiling it was narrowed from.
 * @param {unknown} from
 * @param {object | null} to
 */
export function inheritNativeToolGrant(from, to) {
  const grant = nativeToolGrantForSurface(from);
  if (grant && to && typeof to === "object" && !SURFACE_GRANTS.has(to)) SURFACE_GRANTS.set(to, grant);
  return grant;
}

/**
 * Read the signed tool ceiling from a grant token without verifying it. Used
 * only to fail fast with a clear local error; the native host is the verifier.
 * Returns null when the payload cannot be read.
 * @param {string} token
 * @returns {Set<string> | null}
 */
export function grantedToolIdsFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    const ids = [...(Array.isArray(payload?.tools) ? payload.tools : []), ...(Array.isArray(payload?.child_tools) ? payload.child_tools : [])];
    return new Set(ids.map((id) => String(id)));
  } catch {
    return null;
  }
}

/**
 * Strip the grant from a surface copy that will be persisted, logged, or
 * spread into a boot payload. The caller re-registers the grant on the
 * trusted object it keeps.
 * @template T
 * @param {T} surface
 * @returns {T}
 */
export function withoutNativeToolGrantField(surface) {
  if (!surface || typeof surface !== "object") return surface;
  const out = /** @type {Record<string, unknown>} */ ({ .../** @type {any} */ (surface) });
  delete out.native_tool_grant;
  delete out.nativeToolGrant;
  return /** @type {T} */ (out);
}
