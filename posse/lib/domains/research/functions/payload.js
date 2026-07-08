import {
  isResearchBudgetDeep,
  normalizeResearchBudget,
} from "../../../shared/policies/functions/role-utils.js";

export function researchBudgetMetadata(metadata, budget) {
  const deepthinkBudget = normalizeResearchBudget(budget);
  const explicit = metadata?.research_budget_explicit
    ?? metadata?.deepthink_budget_explicit
    ?? metadata?.budget_explicit
    ?? null;
  return {
    ...metadata,
    deepthink_budget: deepthinkBudget,
    deepthink: isResearchBudgetDeep(deepthinkBudget),
    ...(explicit != null ? { research_budget_explicit: !!explicit } : {}),
  };
}

export function researchPayload(extra = {}, budget = "normal") {
  const deepthinkBudget = normalizeResearchBudget(budget);
  return {
    ...extra,
    deepthink_budget: deepthinkBudget,
    deepthink: isResearchBudgetDeep(deepthinkBudget),
  };
}
