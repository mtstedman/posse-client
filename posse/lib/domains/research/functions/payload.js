import {
  isResearchBudgetDeep,
  normalizeResearchBudget,
} from "../../../shared/policies/functions/role-utils.js";

export function researchBudgetMetadata(metadata, budget) {
  const deepthinkBudget = normalizeResearchBudget(budget);
  return {
    ...metadata,
    deepthink_budget: deepthinkBudget,
    deepthink: isResearchBudgetDeep(deepthinkBudget),
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
