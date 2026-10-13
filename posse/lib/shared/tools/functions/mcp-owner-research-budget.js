import { RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS, researchSynthesisExplorationCeiling } from "../../../domains/integrations/functions/deterministic-mcp/research-synthesis.js";

// A provider emits one turn's parallel tool calls together; the model cannot
// read the exhaustion notice carried by the call that reached the ceiling
// until every sibling returns. Siblings that arrive while that emission is
// still in flight, or within this gap after its last call returned, execute
// past the ceiling instead of returning blocked (atlas592: 7 blocked calls,
// all issued in the same turn as the exhausting call). The next model turn
// takes far longer than this gap, so a call issued after reading the notice
// is still blocked.
const RESEARCH_CEILING_EMISSION_GRACE_MS = 1000;

// Per-session record of the parallel emission that reached the physical
// ceiling. `opened` is set when the ceiling step is assigned; `active` counts
// in-flight research physical calls; `lastReleasedAt` is when the latest one
// returned.
export function researchCeilingEmissionFor(session) {
  if (!session || typeof session !== "object") return null;
  session._researchCeilingEmission ||= { opened: false, active: 0, lastReleasedAt: null };
  return session._researchCeilingEmission;
}

export function researchCeilingGraceDecision(emission, { now = Date.now(), graceMs = RESEARCH_CEILING_EMISSION_GRACE_MS } = {}) {
  if (!emission?.opened) return { grace: false, reason: "ceiling_not_reached_in_flight" };
  if (Number(emission.active) > 0) return { grace: true, reason: "emission_in_flight" };
  const releasedAt = Number(emission.lastReleasedAt);
  if (Number.isFinite(releasedAt) && now - releasedAt <= graceMs) {
    return { grace: true, reason: "emission_idle_gap" };
  }
  return { grace: false, reason: "emission_closed" };
}

export function isTerminalResearchExplorationAdmission(admission) {
  if (
    !admission?.tracked
    || admission.blocked
    || admission.citationFetch
    || !Number.isSafeInteger(admission.assignedExplorationStep)
  ) {
    return false;
  }
  return admission.assignedExplorationStep >= researchSynthesisExplorationCeiling({
    staleSteps: admission.staleSteps,
  }) || admission.assignedPhysicalCallStep >= admissionMaxPhysicalCalls(admission);
}

// Every consumer reads the physical ceiling from the admission it was handed.
// A missing value (older callers, tests building partial admissions) falls
// back to the process-level constant rather than a fresh resolution, so an
// attempt can never observe two different rails.
export function admissionMaxPhysicalCalls(admission) {
  const value = Number(admission?.maxPhysicalCalls);
  return Number.isSafeInteger(value) && value > 0 ? value : RESEARCH_SYNTHESIS_MAX_PHYSICAL_CALLS;
}
