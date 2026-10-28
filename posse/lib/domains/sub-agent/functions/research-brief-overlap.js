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
        onOverlap({ request_ids: [...previous.mergedRequestIds || [previous.id], ...combined.mergedRequestIds], anchors: overlap });
        combined = { ...previous,
          timeoutMs: Math.max(previous.timeoutMs || 0, combined.timeoutMs || 0) || undefined,
          maxTurns: Math.max(previous.maxTurns || 0, combined.maxTurns || 0) || undefined,
          mergedRequestIds: [...previous.mergedRequestIds || [previous.id], ...combined.mergedRequestIds],
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
