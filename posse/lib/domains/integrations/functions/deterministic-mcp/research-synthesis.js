export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
export const RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS = 12;

const NON_EXPLORATION_ATLAS_ACTIONS = new Set([
  "buffer.push",
  "create.ref",
  "fetch.ref",
  "file.write",
  "index.refresh",
  "policy.set",
  "runtime.execute",
  "scip.ingest",
]);

export function normalizeResearchAtlasAction(action) {
  return String(action || "")
    .replace(/^tools\./, "")
    .replace(/^atlas\./, "")
    .replace(/^atlas_/, "")
    .replace(/_/g, ".");
}

export function isResearchAtlasCitationFetchAction(action) {
  return normalizeResearchAtlasAction(action) === "fetch.ref";
}

export function isResearchAtlasExplorationAction(action) {
  const normalized = normalizeResearchAtlasAction(action);
  return !!normalized
    && !normalized.startsWith("memory.")
    && !NON_EXPLORATION_ATLAS_ACTIONS.has(normalized);
}

export function buildResearchCitationFetchGateText({ reason = "before_synthesis" } = {}) {
  if (reason === "budget_exhausted") {
    return [
      "CITATION FETCH BUDGET EXHAUSTED: the one synthesis-phase atlas.fetch_ref call has already been used.",
      "Do not fetch another ref or reopen discovery. Return the answer using the evidence already gathered.",
    ].join("\n");
  }
  return [
    "CITATION FETCH DEFERRED: atlas.fetch_ref is reserved for the synthesis phase.",
    "Continue bounded discovery without fetching a ref. After RESEARCH SYNTHESIS REQUIRED, fetch at most one surfaced load-bearing ref with a focused search, then answer.",
  ].join("\n");
}

export function buildResearchSynthesisRequiredText({
  explorationSteps = 0,
  staleSteps = 0,
  absoluteCeilingReached = true,
  toolName = null,
} = {}) {
  return [
    `RESEARCH SYNTHESIS REQUIRED: deterministic cap reached before ${toolName || "another tool call"}.`,
    absoluteCeilingReached
      ? `Exploration calls: ${explorationSteps}; absolute ceiling: ${RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS}.`
      : `Exploration calls: ${explorationSteps}; no new relevant file in the last ${staleSteps} exploration calls.`,
    "Stop discovery and return a partial planner-ready brief now.",
    "Citation-only exception: if a surfaced hash ref is load-bearing and its exact stored payload is still needed, fetch that ref once with atlas.fetch_ref before answering. This opens existing evidence; it does not reopen exploration.",
    "Include files/symbols consulted, why each mattered, unknowns, and stop_reason=deterministic_synthesize_now_no_novel_evidence.",
  ].join("\n");
}
