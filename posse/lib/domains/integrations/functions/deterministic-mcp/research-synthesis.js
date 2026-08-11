export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
// Leave enough room for broad source-read tasks to close late-discovered gaps;
// the curtain call reserves the final five calls for targeted closure.
const DEFAULT_RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS = 30;
const configuredExplorationCeiling = Number(
  process.env.POSSE_RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS,
);
export const RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS =
  Number.isSafeInteger(configuredExplorationCeiling)
    && configuredExplorationCeiling
      >= RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS
        + RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS
  ? configuredExplorationCeiling
  : DEFAULT_RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS;
export const RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS = 5;
export const RESEARCH_EARLY_FETCH_SYNTHESIS_AUDIT_BATCHES = 2;
// Exploration-time traversal remains available for omitted or bounded stored
// payloads. The gate only becomes terminal after closeout has admitted one
// final batched fetch_ref request.
export const RESEARCH_CITATION_FETCH_GATE_ENABLED = true;
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
      "FINAL FETCH BATCH ALREADY USED: the one synthesis-phase atlas.fetch_ref batch has completed.",
      "Do not call another tool. Submit the best-supported terminal report using the evidence already gathered.",
    ].join("\n");
  }
  return [
    "FETCH_REF NOT ELIGIBLE: early stored-ref traversal is limited to omitted, bounded, cursor, survey, or otherwise unseen payloads.",
    "Do not fetch content already delivered in full. A ref marked ref_role=citation is already usable as evidence in the current context; only ref_role=continuation or an explicit cursor/continuation field advertises unseen content.",
    "During exploration, wait to accumulate at least two eligible refs before fetching. Use a singleton only when one required cursor or omitted region blocks the next traversal step.",
  ].join("\n");
}

export function buildResearchEarlyFetchBatchingText() {
  return [
    "FETCH BATCHING CHECKPOINT: this exploration fetch contained one ref.",
    "Do not fetch another singleton merely because a citation ref is visible. Accumulate at least two eligible continuation refs; use a singleton only when one required cursor or omitted region blocks the next traversal step.",
  ].join("\n");
}

export function buildResearchEarlyFetchSynthesisAuditText({ fetchBatches = 0 } = {}) {
  return [
    `SYNTHESIS AUDIT: ${Math.max(0, Number(fetchBatches) || 0)} exploration fetch batches have been used.`,
    "Compare the gathered evidence with every requested flow, branch, and boundary. If each material item has direct support, synthesize now instead of gathering corroboration.",
    "If a material gap remains, make only the highest-value targeted lookup and accumulate any further continuation refs into one batch.",
  ].join("\n");
}

export function buildResearchFinalFetchBatchText() {
  return [
    "FINAL FETCH BATCH COMPLETE.",
    "No further discovery or stored-ref calls are available. Synthesize the terminal report now from the gathered evidence.",
  ].join("\n");
}

export function buildResearchMidpointAuditText() {
  return [
    `SYNTHESIS CHECKPOINT: ${RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS} exploration calls have been used.`,
    "Compare the gathered evidence with every requested flow, branch, and boundary. If each material item has direct support, synthesize now; do not browse for extra corroboration.",
    "If a material gap remains, use only targeted calls for that gap and batch any eligible continuation refs.",
  ].join("\n");
}

export function buildResearchCurtainCallText({
  explorationSteps = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS,
} = {}) {
  const remainingCalls = Math.max(
    0,
    RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS - Number(explorationSteps || 0),
  );
  return [
    `RESEARCH BUDGET: ${remainingCalls} exploration call${remainingCalls === 1 ? "" : "s"} ${remainingCalls === 1 ? "remains" : "remain"} before required closeout.`,
    "Use the remaining calls only when needed, then close out from the gathered evidence.",
  ].join("\n");
}

export function buildResearchSynthesisRequiredText({
  explorationSteps = 0,
  staleSteps = 0,
  absoluteCeilingReached = true,
} = {}) {
  const stopReason = absoluteCeilingReached
    ? "deterministic_research_tool_ceiling"
    : "deterministic_synthesize_now_no_novel_evidence";
  return [
    "RESEARCH CLOSEOUT REQUIRED.",
    absoluteCeilingReached
      ? `Exploration budget used: ${explorationSteps}/${RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS}.`
      : `No new relevant evidence in the last ${staleSteps} exploration calls.`,
    `No further discovery calls are available. If essential unseen stored evidence remains, put every eligible ref into one final batched atlas.fetch_ref call; after that response, make no further tool calls. Otherwise submit the best-supported terminal report now with stop_reason=${stopReason}.`,
  ].join("\n");
}
