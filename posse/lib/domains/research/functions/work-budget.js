import { RESEARCH_WORK_BUDGET_NOTICE } from "../../../catalog/research-budget.js";

export function researchWorkBudget(admission) {
  if (!admission?.tracked) return null;
  const limit = Number(admission.maxPhysicalCalls);
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  const assigned = Number(admission.assignedPhysicalCallStep) || 0;
  const reserved = admission.reservedPhysicalCalls?.();
  // The live reservation count includes concurrent work and refunds. Assigned
  // steps are only a fallback: a refunded last call no longer consumes its slot.
  const count = Number.isSafeInteger(reserved) && reserved >= 0
    ? reserved
    : Math.max(Number(admission.callSteps) || 0, admission.blocked ? assigned - 1 : assigned);
  const used = Math.min(limit, Math.max(0, count));
  return { limit, used_or_reserved: used, remaining: limit - used, handoff_available: true };
}

export function appendResearchWorkBudget(result, admission) {
  const budget = researchWorkBudget(admission);
  if (!budget || !Array.isArray(result?.content)) return result;
  // Append a distinct control block: source block indices and JSON headers
  // remain untouched, including in native multi-symbol responses.
  return {
    ...result,
    content: [...result.content, {
      type: "text",
      text: `[${RESEARCH_WORK_BUDGET_NOTICE}] ${JSON.stringify(budget)}`,
    }],
    _meta: { ...result._meta, researchWorkBudget: budget },
  };
}

export function isResearchWorkBudgetBlock(block, result) {
  return result?._meta?.researchWorkBudget != null && block?.type === "text"
    && block.text === `[${RESEARCH_WORK_BUDGET_NOTICE}] ${JSON.stringify(result._meta.researchWorkBudget)}`;
}
