import { MODEL_TIERS } from "../../../catalog/model.js";
import { PLANNER_RESEARCH_EFFORT_VALUES } from "../../../catalog/planner-dispatch.js";

// The merged child answers every question, so it runs at the strongest tier
// and effort any of them asked for. Taking the first brief's values ran a
// strong request on standard (or a cheap one on strong) without a note.
function maxOrdered(order, ...values) {
  const known = values.filter((value) => order.includes(value));
  if (!known.length) return values.find((value) => value != null);
  return order[Math.max(...known.map((value) => order.indexOf(value)))];
}

function mergedBudget(previous, combined) {
  const modelTier = maxOrdered(MODEL_TIERS, previous.modelTier, combined.modelTier);
  const reasoningEffort = maxOrdered(PLANNER_RESEARCH_EFFORT_VALUES, previous.reasoningEffort, combined.reasoningEffort);
  const raised = [previous, combined]
    .filter((brief) => (brief.modelTier ?? null) !== (modelTier ?? null) || (brief.reasoningEffort ?? null) !== (reasoningEffort ?? null))
    .map((brief) => ({ request_id: brief.id, from: { model_tier: brief.modelTier ?? null, reasoning_effort: brief.reasoningEffort ?? null } }));
  return {
    modelTier,
    reasoningEffort,
    repair: raised.length
      ? { action: "raised", reason: "merged_brief_takes_strongest_budget", to: { model_tier: modelTier ?? null, reasoning_effort: reasoningEffort ?? null }, raised }
      : null,
  };
}

// Merge connected sets of explicit code anchors, retaining every question and
// every unique anchor. Web and citation-only children keep their own contracts.
export function mergeOverlappingResearchBriefs(requests, onOverlap = () => {}) {
  const merged = [];
  const keys = request => new Set((request.anchors || []).map(anchor => anchor.path || anchor.ref).filter(Boolean));
  for (const request of requests) {
    if (request.agentType !== "code" || request.validationError || !keys(request).size) { merged.push(request); continue; }
    let combined = { ...request, mergedRequestIds: [request.id], anchors: [...request.anchors] };
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < merged.length; i++) {
        const previous = merged[i];
        if (previous.agentType !== "code" || previous.validationError) continue;
        const overlap = [...keys(previous)].filter(key => keys(combined).has(key));
        if (!overlap.length) continue;
        const budget = mergedBudget(previous, combined);
        const mergedRequestIds = [...previous.mergedRequestIds || [previous.id], ...combined.mergedRequestIds];
        onOverlap({ request_ids: mergedRequestIds, anchors: overlap, ...(budget.repair ? { budget: budget.repair } : {}) });
        combined = { ...previous,
          timeoutMs: Math.max(previous.timeoutMs || 0, combined.timeoutMs || 0) || undefined,
          maxTurns: Math.max(previous.maxTurns || 0, combined.maxTurns || 0) || undefined,
          ...(budget.modelTier === undefined ? {} : { modelTier: budget.modelTier }),
          ...(budget.reasoningEffort === undefined ? {} : { reasoningEffort: budget.reasoningEffort }),
          mergedRequestIds,
          intent: `${previous.intent}\n\nAdditional question (${combined.id}): ${combined.intent}`,
          anchors: [...new Map([...previous.anchors, ...combined.anchors].map(anchor => [JSON.stringify(anchor), anchor])).values()],
        };
        merged.splice(i, 1); changed = true; break;
      }
    }
    merged.push(combined);
  }
  return merged;
}
