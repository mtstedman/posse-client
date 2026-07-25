export const RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS = 12;
export const RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS = 4;
// Leave enough room for broad source-read tasks to close late-discovered gaps;
// the curtain call still reserves the final two calls for targeted closure.
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
export const RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS = 2;

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
    "atlas.fetch_ref is not a research-budget workaround. After RESEARCH CLOSEOUT REQUIRED, the runtime may admit one exact retrieval of a ref surfaced before the curtain call, only when its stored payload is essential to a final claim. It does not reopen discovery or permit another producer-tool call.",
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
    `RESEARCH CURTAIN CALL: ${remainingCalls} targeted exploration call${remainingCalls === 1 ? "" : "s"} ${remainingCalls === 1 ? "remains" : "remain"} before mandatory closeout.`,
    "Use them only to close an exact, answer-critical evidence gap that is already named. Do not start a new research branch, repeat an earlier search/read, or use atlas.fetch_ref as a discovery workaround.",
    "Then stop tool use and synthesize the final report with the information already gathered.",
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
    "RESEARCH CLOSEOUT REQUIRED: deterministic exploration limit reached.",
    absoluteCeilingReached
      ? `Exploration calls: ${explorationSteps}; absolute ceiling: ${RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS}.`
      : `Exploration calls: ${explorationSteps}; no new relevant file in the last ${staleSteps} exploration calls.`,
    "No further discovery calls are available. Use the remaining model turns to synthesize the best-supported final research report from the information already gathered and complete the terminal handoff.",
    "Before answering, audit every requested deliverable: state the supported finding with evidence, or name the specific unresolved gap under Limitations. Do not emit empty sections, placeholder bullets, or unsupported completion claims.",
    "Do not use atlas.fetch_ref or another full tool call to extend research. The only runtime exception is one exact retrieval of a ref surfaced before the curtain call when its stored payload is already known to be essential to a final claim; it does not reopen discovery.",
    `Include files/symbols consulted, why each mattered, unknowns, and stop_reason=${stopReason}.`,
  ].join("\n");
}
