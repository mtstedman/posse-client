// @ts-check
// Native fetch/push envelope projections. Locks and publication stay in shared-trunk.
import { SHARED_TRUNK_PUSH_REFUSALS } from "../../../catalog/shared-trunk.js";

export function nativeResult(envelope) {
  return envelope && Object.prototype.hasOwnProperty.call(envelope, "result")
    ? envelope.result
    : envelope;
}

export function nativeUnavailable(envelope) {
  return !envelope || envelope.available !== true;
}

export function firstString(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export function fetchedClaims(result) {
  const claims = result?.fetchedClaims ?? result?.fetched_claims ?? result?.claims;
  return Array.isArray(claims) ? claims : [];
}

export function fetchedClaimsTruncated(result) {
  return result?.claimsTruncated === true || result?.claims_truncated === true;
}

export function fetchedClaimsPagination(result) {
  const camel = Object.prototype.hasOwnProperty.call(result || {}, "claimsNextCursor");
  const snake = Object.prototype.hasOwnProperty.call(result || {}, "claims_next_cursor");
  if (!camel && !snake) return { claimsPaginationSupported: false, claimsNextCursor: null };
  const raw = camel ? result.claimsNextCursor : result.claims_next_cursor;
  if (raw == null) return { claimsPaginationSupported: true, claimsNextCursor: null };
  const cursor = String(raw).trim();
  if (!/^[0-9a-f]{64}$/u.test(cursor)) {
    return { claimsPaginationSupported: false, claimsNextCursor: null };
  }
  return { claimsPaginationSupported: true, claimsNextCursor: cursor };
}

export function claimFetchMetadata(result) {
  return {
    claimsTruncated: result?.claimsTruncated === true,
    claimsPaginationSupported: result?.claimsPaginationSupported === true,
    claimsNextCursor: result?.claimsNextCursor || null,
  };
}

export function pushStatus(result) {
  return String(result?.status || result?.outcome || result?.result || "").trim().toLowerCase();
}

export function typedPushRejection(result) {
  const status = pushStatus(result);
  return result?.rejected === true
    || result?.nonFastForward === true
    || result?.non_fast_forward === true
    || ["rejected", "rejected_nonff", "non_fast_forward", "stale_expected_remote"].includes(status);
}

export function pushRejectionReason(result) {
  return String(result?.reason || result?.blockedReason || result?.blocked_reason || "").trim().toLowerCase();
}

/** The remote-refusal kind for a native push outcome, or null. An unknown
 * outcome is not a refusal: it falls through to publication_ambiguous. */
export function pushRefusal(pushed) {
  const status = pushStatus(pushed);
  return Object.hasOwn(SHARED_TRUNK_PUSH_REFUSALS, status) ? SHARED_TRUNK_PUSH_REFUSALS[status] : null;
}
