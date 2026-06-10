// Provider role identifiers and the job-type → role registry live in the
// catalogue; re-exported here so existing import paths keep working.
import {
  PROVIDER_ROLE_NAMES,
  DELEGATION_PROVIDER_ROLE_NAMES,
  JOB_TYPE_ROLE_REGISTRY,
  JOB_TYPE_TO_PROVIDER_ROLE,
} from "../../../catalog/provider.js";

export {
  PROVIDER_ROLE_NAMES,
  DELEGATION_PROVIDER_ROLE_NAMES,
  JOB_TYPE_ROLE_REGISTRY,
  JOB_TYPE_TO_PROVIDER_ROLE,
};

export function providerSettingKeyForRole(role) {
  return `provider_${role}`;
}

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

export const PROVIDER_ROLE_SETTING_DEFS = Object.freeze(
  PROVIDER_ROLE_NAMES.map((role) => Object.freeze({
    key: providerSettingKeyForRole(role),
    default: "",
    description: role === "delegator"
      ? "Provider for the delegator itself (empty = claude)"
      : `Comma-separated provider list for ${role} role (empty = claude)`,
  }))
);
