// @ts-check
// Provider role setting identities and defaults; role routing remains provider-owned.
import { PROVIDER_ROLE_NAMES } from "./provider.js";
import { JOB_MODEL_TIERS, JOB_REASONING_EFFORTS } from "./job.js";

export function providerSettingKeyForRole(role) {
  return `provider_${role}`;
}

export function reasoningEffortSettingKeyForRole(role) {
  return `reasoning_effort_${role}`;
}

export function modelTierSettingKeyForRole(role) {
  return `model_tier_${role}`;
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
export const ROLE_BASE_REASONING_EFFORTS = Object.freeze({
  dev: "medium",
  artificer: "medium",
  researcher: "high",
  planner: "medium",
  preflight: "low",
  assessor: "medium",
});

export const ROLE_BASE_MODEL_TIERS = Object.freeze({
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
