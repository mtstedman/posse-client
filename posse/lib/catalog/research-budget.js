// Factual admission state is available even when optional research advice is off.
export const RESEARCH_WORK_BUDGET_NOTICE = "research_work_budget";

// Ordered operator budget levels and their displacement from a role's base
// model tier or reasoning effort. The policy is shared by planning and CLI.
export const RESEARCH_BUDGETS = Object.freeze(["low", "normal", "high", "xhigh"]);
export const RESEARCH_BUDGET_STEP = Object.freeze({ low: -1, normal: 0, high: 1, xhigh: 2 });
