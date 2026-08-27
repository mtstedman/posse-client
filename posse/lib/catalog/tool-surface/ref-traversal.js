// Role policy for stored-reference traversal. Keep the rollout sets here so
// advertisement and execution enforce the same compatibility boundary.
export const BOUNDED_REF_TRAVERSAL_ROLES = Object.freeze([
  "researcher",
  "planner",
  "dev",
]);

export const CANONICAL_REF_TRAVERSAL_ROLES = Object.freeze([
  "researcher",
  "planner",
]);

export function roleUsesBoundedRefTraversal(role) {
  return BOUNDED_REF_TRAVERSAL_ROLES.includes(String(role || "").trim().toLowerCase());
}

export function roleUsesCanonicalRefTraversal(role) {
  return CANONICAL_REF_TRAVERSAL_ROLES.includes(String(role || "").trim().toLowerCase());
}
