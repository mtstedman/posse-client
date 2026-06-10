const EMPTY_POLICY = Object.freeze({
  succeeds: Object.freeze([]),
  fails: Object.freeze([]),
});

function freezePolicy({ succeeds = [], fails = [] } = {}) {
  return Object.freeze({
    succeeds: Object.freeze([...new Set((Array.isArray(succeeds) ? succeeds : []).filter(Boolean))]),
    fails: Object.freeze([...new Set((Array.isArray(fails) ? fails : []).filter(Boolean))]),
  });
}

export const ROLE_SPAWN_POLICIES = Object.freeze({
  researcher: freezePolicy({ fails: ["human_input"] }),
  planner: freezePolicy({ succeeds: ["delegate", "dev", "fix", "artificer", "promote", "human_input"], fails: ["human_input"] }),
  dev: freezePolicy({ succeeds: ["dev", "human_input"], fails: ["human_input"] }),
  fix: freezePolicy({ succeeds: ["dev", "human_input"], fails: ["human_input"] }),
  assessor: freezePolicy({ succeeds: ["promote"], fails: ["fix", "human_input", "artificer", "promote", "research", "plan"] }),
  artificer: freezePolicy({ fails: ["human_input"] }),
  preflight: EMPTY_POLICY,
  delegator: EMPTY_POLICY,
  summary: EMPTY_POLICY,
});

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
