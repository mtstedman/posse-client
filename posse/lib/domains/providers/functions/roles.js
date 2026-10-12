import { reasoningEffortSettingKeyForRole, modelTierSettingKeyForRole, ROLE_REASONING_EFFORT_SETTING_DEFS, ROLE_MODEL_TIER_SETTING_DEFS } from "../../../catalog/provider-role-settings.js";
export { providerSettingKeyForRole, reasoningEffortSettingKeyForRole, modelTierSettingKeyForRole, PROVIDER_ROLE_SETTING_DEFS, ROLE_REASONING_EFFORT_SETTING_DEFS, ROLE_MODEL_TIER_SETTING_DEFS } from "../../../catalog/provider-role-settings.js";
// Provider role identifiers and the job-type → role registry live in the
// catalogue; re-exported here so existing import paths keep working.
import { PROVIDER_ROLE_NAMES, DELEGATION_PROVIDER_ROLE_NAMES, JOB_TYPE_ROLE_REGISTRY, JOB_TYPE_TO_PROVIDER_ROLE } from "../../../catalog/provider.js";

export {
  PROVIDER_ROLE_NAMES,
  DELEGATION_PROVIDER_ROLE_NAMES,
  JOB_TYPE_ROLE_REGISTRY,
  JOB_TYPE_TO_PROVIDER_ROLE,
};




export function providerRoleForJobType(jobTypeOrRole = "dev") {
  const normalized = String(jobTypeOrRole || "dev").trim().toLowerCase();
  return JOB_TYPE_ROLE_REGISTRY[normalized]?.provider || normalized || "dev";
}

export function delegationRoleForJobType(jobTypeOrRole = "dev", { fallback = "dev" } = {}) {
  const normalized = String(jobTypeOrRole || "").trim().toLowerCase();
  const role = JOB_TYPE_ROLE_REGISTRY[normalized]?.delegation;
  return role || fallback;
}

export function workerRoleForJobType(jobTypeOrRole = "dev", { fallback = "dev" } = {}) {
  const normalized = String(jobTypeOrRole || "").trim().toLowerCase();
  return JOB_TYPE_ROLE_REGISTRY[normalized]?.worker || fallback;
}

export function spawnPolicyRoleForJobType(jobTypeOrRole = "dev") {
  const normalized = String(jobTypeOrRole || "").trim().toLowerCase();
  return JOB_TYPE_ROLE_REGISTRY[normalized]?.spawn || null;
}

export function displayRoleForJobType(jobTypeOrRole = "dev") {
  const role = providerRoleForJobType(jobTypeOrRole);
  if (PROVIDER_ROLE_NAMES.includes(role) || role === "human" || role === "promote") return role;
  return "system";
}






export function defaultReasoningEffortForRole(role) {
  const normalized = providerRoleForJobType(role);
  return ROLE_REASONING_EFFORT_SETTING_DEFS.find((entry) => (
    entry.key === reasoningEffortSettingKeyForRole(normalized)
  ))?.default || "medium";
}

export function defaultModelTierForRole(role) {
  const normalized = providerRoleForJobType(role);
  return ROLE_MODEL_TIER_SETTING_DEFS.find((entry) => (
    entry.key === modelTierSettingKeyForRole(normalized)
  ))?.default || "standard";
}
