// Shared pure helpers for role execution, research budgets, and plan parsing.

export const CHECKPOINT_TOKEN_THRESHOLD = 15_000;

export function safeParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

export function getWorkItemMetadata(workItem) {
  return safeParseJson(workItem?.metadata_json) || {};
}

export const RESEARCH_BUDGETS = Object.freeze(["low", "normal", "high", "xhigh"]);
const RESEARCH_BUDGET_RANK = Object.freeze({ low: 0, normal: 1, high: 2, xhigh: 3 });

export function normalizeResearchBudget(value, fallback = "normal") {
  const normalizedFallback = RESEARCH_BUDGETS.includes(fallback) ? fallback : "normal";
  if (value === true) return "high";
  if (value === false || value == null) return normalizedFallback;
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return normalizedFallback;
  if (raw === "medium" || raw === "med" || raw === "default") return "normal";
  if (raw === "deep" || raw === "deepthink" || raw === "extra") return "high";
  if (raw === "max" || raw === "maximum" || raw === "ultra" || raw === "ultrathink") return "xhigh";
  return RESEARCH_BUDGETS.includes(raw) ? raw : normalizedFallback;
}

export function researchBudgetFromDeepthink(deepthink) {
  return deepthink ? "high" : "normal";
}

export function isResearchBudgetDeep(budget) {
  const normalized = normalizeResearchBudget(budget);
  return normalized === "high" || normalized === "xhigh";
}

export function maxResearchBudget(...budgets) {
  let best = "normal";
  for (const budget of budgets) {
    const normalized = normalizeResearchBudget(budget, "normal");
    if (RESEARCH_BUDGET_RANK[normalized] > RESEARCH_BUDGET_RANK[best]) best = normalized;
  }
  return best;
}

export function defaultResearchModelTier() {
  return "strong";
}

export function getResearchBudget(workItem, payload = null) {
  const metadata = getWorkItemMetadata(workItem);
  const explicit = payload?.deepthink_budget
    ?? payload?.research_budget
    ?? metadata.deepthink_budget
    ?? metadata.research_budget;
  if (explicit != null) return normalizeResearchBudget(explicit);
  if (payload && Object.prototype.hasOwnProperty.call(payload, "deepthink")) {
    return researchBudgetFromDeepthink(!!payload.deepthink);
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "deepthink")) {
    return researchBudgetFromDeepthink(!!metadata.deepthink);
  }
  return "normal";
}

export function researchBudgetToReasoningEffort(budget, fallback = "medium") {
  const normalized = normalizeResearchBudget(budget);
  if (normalized === "low") return "low";
  if (normalized === "high" || normalized === "xhigh") return "high";
  return fallback || "medium";
}

export function researchBudgetToMaxTurnsOverride(budget, role = "researcher", opts = {}) {
  const normalized = normalizeResearchBudget(budget);
  if (normalized !== "xhigh") return null;
  // xhigh is an explicit per-job budget override. These caps intentionally
  // bypass global max-turn settings so the requested budget is not silently
  // lowered by a runtime default.
  const roleMode = String(opts?.roleMode || opts?.role_mode || "").trim().toLowerCase();
  if (role === "researcher") return roleMode === "child" ? 24 : 46;
  if (role === "planner") return 18;
  return null;
}

export function maxTurnsOverrideFromPayload(payload = null) {
  const raw = payload?._max_turns_override ?? payload?.max_turns_override ?? null;
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.min(200, value));
}

export function researchBudgetPromptBlock(budget, role = "researcher") {
  const normalized = normalizeResearchBudget(budget);
  if (normalized === "low") {
    return "THINKING BUDGET: low. Keep investigation tightly scoped to the explicit request and avoid repo-wide exploration unless the task is impossible without it.";
  }
  if (normalized === "high") {
    return role === "planner"
      ? "THINKING BUDGET: high. Prefer a more thorough decomposition and allow for deeper repo review before finalizing the plan."
      : "THINKING BUDGET: high. Spend extra time on repo-wide review and synthesis before concluding.";
  }
  if (normalized === "xhigh") {
    return role === "planner"
      ? "THINKING BUDGET: xhigh. Treat this as a high-risk planning pass: inspect cross-module implications carefully, preserve alternatives, and surface uncertainty explicitly."
      : "THINKING BUDGET: xhigh. Treat this as a deep investigation: inspect cross-module implications carefully, verify citations, and synthesize before concluding.";
  }
  return null;
}

export function isDeepthinkTask(workItem, payload = null) {
  return isResearchBudgetDeep(getResearchBudget(workItem, payload));
}

export function shortJobTitle(job) {
  const title = String(job?.title || "");
  if (/^improvement\s*:/i.test(title)) {
    return title.replace(/^improvement\s*:\s*/i, "[I] ");
  }
  return title;
}

export function unwrapTaskArray(candidate) {
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === "object") {
    const wrapped = candidate.tasks || candidate.plan || candidate.jobs || candidate.steps;
    if (Array.isArray(wrapped)) return wrapped;
  }
  return candidate;
}

export function unwrapAssignmentArray(candidate) {
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === "object") {
    const wrapped = candidate.assignments || candidate.delegations || candidate.jobs || candidate.tasks;
    if (Array.isArray(wrapped)) return wrapped;
  }
  return candidate;
}

export function uniqueScopeFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

export function classifyPlannerOutput(output, parsed) {
  const text = String(output || "").trim();
  if (!text) return "empty";
  if (/MISSING_CONTEXT:/i.test(text)) return "missing_context";
  if (/```(?:json)?/i.test(text) || /[\[{]/.test(text)) {
    return parsed ? "wrapped_or_malformed_json" : "malformed_json";
  }
  return "prose_or_no_json";
}
