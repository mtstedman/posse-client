// @ts-check

/**
 * Whether one parent scope authorizes one requested child scope. This is the
 * canonical implication rule used by both pulse validation and capability
 * handoff, so the two gates cannot disagree about wildcard or Git read access.
 *
 * @param {string} parentScope
 * @param {string} requestedScope
 */
export function scopeGrants(parentScope, requestedScope) {
  const parent = String(parentScope || "").trim();
  const requested = String(requestedScope || "").trim();
  if (!parent || !requested) return false;
  return parent === "*"
    || parent === requested
    || (parent === "git:mutate" && requested === "git:read");
}

/** @param {readonly string[]} parentScopes @param {string} requestedScope */
export function scopeGrantedBy(parentScopes, requestedScope) {
  return Array.isArray(parentScopes)
    && parentScopes.some((parentScope) => scopeGrants(parentScope, requestedScope));
}
