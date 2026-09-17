import { createHash, createPublicKey, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { TEAM_FAILURE_REASONS } from "../../../catalog/team.js";

const PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64URL_RE = /^[A-Za-z0-9_-]+$/u;
const JTI_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function normalizedPermissions(value) {
  if (!value || typeof value !== "object" || !value.write) return null;
  return {
    write: {
      files: value.write.files ?? [],
      roots: value.write.roots ?? [],
      unknown: value.write.unknown ?? false,
    },
    tools: value.tools ?? [],
    database: value.database ?? [],
    budget: value.budget ?? null,
  };
}

function decodePart(part) {
  if (!B64URL_RE.test(part) || part.length > 8192) throw new Error("Invalid grant encoding");
  return Buffer.from(part, "base64url");
}

/** Verify a host-signed WI grant before applying it to any local Git action.
 * Remote binds the public key to the authenticated host session at issue time;
 * this check also pins the token to the local executor/repository/branch. */
export function verifyTeamGrantToken(grant, {
  sessionId,
  instanceId,
  repositoryFingerprint,
  branch,
  workItemId,
  signingPublicKey,
  kid,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  try {
    const compact = String(grant?.signed_grant || "");
    const parts = compact.split(".");
    if (parts.length !== 3 || compact.length > 16_384) throw new Error("Grant token is missing");
    const publicBytes = decodePart(String(signingPublicKey || ""));
    if (publicBytes.length !== 32) throw new Error("Grant signing key is invalid");
    const computedKid = createHash("sha256").update(publicBytes).digest("hex");
    if (kid !== computedKid) throw new Error("Grant key identity does not match");
    const header = JSON.parse(decodePart(parts[0]).toString("utf8"));
    const claims = JSON.parse(decodePart(parts[1]).toString("utf8"));
    if (header?.alg !== "EdDSA" || header?.typ !== "posse-wi-grant+jwt" || header?.kid !== computedKid) {
      throw new Error("Grant header is invalid");
    }
    const publicKey = createPublicKey({
      key: Buffer.concat([PUBLIC_KEY_PREFIX, publicBytes]), format: "der", type: "spki",
    });
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, decodePart(parts[2]))) {
      throw new Error("Grant signature is invalid");
    }
    if (claims.iss !== `posse-session-host:${sessionId}`
      || claims.sub !== workItemId
      || claims.aud !== instanceId
      || claims.session_id !== sessionId
      || claims.repository_fingerprint !== repositoryFingerprint
      || claims.branch !== branch
      || !JTI_RE.test(String(claims.jti || ""))) {
      throw new Error("Grant audience or scope identity does not match");
    }
    // A token that simply aged out is an ordinary, self-healing condition: the
    // host reissues and the next attempt succeeds. Keep it distinct from a
    // token whose signature, key or claims do not verify, which never heals.
    if (!Number.isSafeInteger(claims.nbf) || !Number.isSafeInteger(claims.exp)
      || claims.exp - claims.nbf > 900) {
      throw new Error("Grant is outside its permitted lifetime");
    }
    if (claims.nbf > nowSec || claims.exp <= nowSec) {
      throw Object.assign(new Error("Grant has expired"), { expired: true });
    }
    if (grant?.grant_jti != null && grant.grant_jti !== claims.jti) {
      throw new Error("Grant token identity does not match the current grant");
    }
    if (grant?.expires_at != null && Date.parse(grant.expires_at) !== claims.exp * 1000) {
      throw new Error("Grant expiry does not match the current grant");
    }
    for (const [claimKey, recordKey] of [
      ["grant_revision", "revision"],
      ["claim_generation", "claim_generation"],
      ["policy_revision", "policy_revision"],
    ]) {
      if (!Number.isSafeInteger(claims[claimKey]) || claims[claimKey] !== grant?.[recordKey]) {
        throw new Error(`${claimKey} does not match the current grant`);
      }
    }
    if (!isDeepStrictEqual(normalizedPermissions(claims.effective_permissions),
      normalizedPermissions(grant?.effective_permissions))) {
      throw new Error("Grant permissions do not match the signed token");
    }
    return { ok: true, claims };
  } catch (error) {
    return {
      ok: false,
      reason: error?.expired === true
        ? TEAM_FAILURE_REASONS.SIGNED_GRANT_EXPIRED
        : TEAM_FAILURE_REASONS.SIGNED_GRANT_INVALID,
      message: String(error?.message || error).slice(0, 200),
    };
  }
}
