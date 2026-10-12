import { ROLE_SPAWN_POLICIES, EMPTY_POLICY } from "../../../catalog/spawn-policy.js";
export { ROLE_SPAWN_POLICIES } from "../../../catalog/spawn-policy.js";





export function normalizeSpawnRoleName(roleName) {
  return String(roleName || "")
    .trim()
    .toLowerCase()
    .replace(/role$/, "")
    .replace(/^.*\./, "");
}

export function spawnPolicyForRoleName(roleName) {
  const normalized = normalizeSpawnRoleName(roleName);
  return ROLE_SPAWN_POLICIES[normalized] || EMPTY_POLICY;
}

export function spawnSuccessForRole(roleName) {
  return spawnPolicyForRoleName(roleName).succeeds;
}

export function spawnFailureForRole(roleName) {
  return spawnPolicyForRoleName(roleName).fails;
}
