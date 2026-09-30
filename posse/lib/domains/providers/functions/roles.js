// Provider role identifiers and the job-type → role registry live in the
// catalogue; re-exported here so existing import paths keep working.
import {
  PROVIDER_ROLE_NAMES,
  DELEGATION_PROVIDER_ROLE_NAMES,
  JOB_TYPE_ROLE_REGISTRY,
  JOB_TYPE_TO_PROVIDER_ROLE,
} from "../../../catalog/provider.js";
import { JOB_MODEL_TIERS, JOB_REASONING_EFFORTS } from "../../../catalog/job.js";

export {
  PROVIDER_ROLE_NAMES,
  DELEGATION_PROVIDER_ROLE_NAMES,
  JOB_TYPE_ROLE_REGISTRY,
  JOB_TYPE_TO_PROVIDER_ROLE,
};

export function providerSettingKeyForRole(role) {
  return `provider_${role}`;
}

export function reasoningEffortSettingKeyForRole(role) {
  return `reasoning_effort_${role}`;
}

export function modelTierSettingKeyForRole(role) {
  return `model_tier_${role}`;
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
    description: `Comma-separated provider list for ${role} role (empty = claude)`,
  }))
);

// Each role's base reasoning effort and model tier. They fill in wherever a
// flow has no explicit value; research budgets (deepthink) step up or down
// from them, while explicit job values, risk policy, planner-dispatch
// settings, and harness pins still take precedence.
const ROLE_BASE_REASONING_EFFORTS = Object.freeze({
  dev: "medium",
  artificer: "medium",
  researcher: "high",
  planner: "medium",
  preflight: "low",
  assessor: "medium",
});

const ROLE_BASE_MODEL_TIERS = Object.freeze({
  dev: "standard",
  artificer: "standard",
  researcher: "standard",
  planner: "standard",
  preflight: "cheap",
  assessor: "cheap",
});

export const ROLE_REASONING_EFFORT_SETTING_DEFS = Object.freeze(
  PROVIDER_ROLE_NAMES.map((role) => Object.freeze({
    key: reasoningEffortSettingKeyForRole(role),
    default: ROLE_BASE_REASONING_EFFORTS[role] || "medium",
    options: JOB_REASONING_EFFORTS,
    description: `Base reasoning strength for ${role} calls; deepthink budgets step from it, and explicit job and workflow overrides take precedence`,
  }))
);

export const ROLE_MODEL_TIER_SETTING_DEFS = Object.freeze(
  PROVIDER_ROLE_NAMES.map((role) => Object.freeze({
    key: modelTierSettingKeyForRole(role),
    default: ROLE_BASE_MODEL_TIERS[role] || "standard",
    options: JOB_MODEL_TIERS,
    description: `Base model tier for ${role} calls; deepthink budgets step from it, and explicit job and workflow overrides take precedence`,
  }))
);

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
