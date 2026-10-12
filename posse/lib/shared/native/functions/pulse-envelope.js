// @ts-check

/**
 * Validate the structural, route, and expiry contract at a trusted parent
 * boundary. Signature verification remains the native receiver's responsibility.
 * @param {Record<string, unknown> | null | undefined} value
 * @param {string} route
 * @param {number} [nowSeconds]
 */
export function validPulseEnvelope(value, route, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (String(value.route || "") !== route) return false;
  if (!String(value.token || "").trim() || !String(value.kid || "").trim()) return false;
  const expiresAt = Number(value.expiresAt);
  const refreshAfter = Number(value.refreshAfter);
  return Number.isSafeInteger(expiresAt)
    && Number.isSafeInteger(refreshAfter)
    && refreshAfter > 0
    && refreshAfter < expiresAt
    && expiresAt > nowSeconds;
}
