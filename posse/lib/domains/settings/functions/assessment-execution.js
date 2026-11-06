import { JOB_MODEL_TIERS, JOB_REASONING_EFFORTS } from "../../../catalog/job.js";
import { getDefaultModelTierForRole, getDefaultReasoningEffortForRole } from "./repository-settings.js";

function atLeast(values, order, baseline) {
  return values.reduce((best, value) => order.indexOf(value) > order.indexOf(best) ? value : best, baseline);
}

// Operator role settings are the floor. Task policy and retries may raise it,
// but cannot downgrade it. Concrete models still resolve through the provider.
export function resolveAssessmentExecution({ payload = {}, modelTier = null, reasoningEffort = null,
  baseTier = getDefaultModelTierForRole("assessor"),
  baseEffort = getDefaultReasoningEffortForRole("assessor"),
} = {}) {
  const configuredTier = JOB_MODEL_TIERS.includes(baseTier) ? baseTier : getDefaultModelTierForRole("assessor");
  const configuredEffort = JOB_REASONING_EFFORTS.includes(baseEffort) ? baseEffort : getDefaultReasoningEffortForRole("assessor");
  const policy = payload._execution_policy?.assessor || {};
  const tier = atLeast([policy.model_tier, payload._assess_model_tier, modelTier], JOB_MODEL_TIERS, configuredTier);
  const effort = atLeast([policy.reasoning_effort, payload._assess_reasoning_effort, reasoningEffort], JOB_REASONING_EFFORTS, configuredEffort);
  return { modelTier: tier, reasoningEffort: effort, baseline: { model_tier: configuredTier, reasoning_effort: configuredEffort },
    reasons: [tier !== configuredTier ? "assessment policy or retry raised the configured model tier" : "configured review model tier",
      effort !== configuredEffort ? "assessment policy or retry raised the configured reasoning effort" : "configured review reasoning effort"] };
}

// Automatic retry escalation remains bounded at standard; a deliberately
// configured strong baseline is preserved, never normalized down to standard.
export function nextAssessmentTier(tier, { resolveModel = null } = {}) {
  if (tier !== "cheap") return JOB_MODEL_TIERS.includes(tier) ? tier : "standard";
  if (resolveModel) {
    const current = resolveModel("cheap");
    if (current && current === resolveModel("standard")) return tier;
  }
  return "standard";
}
