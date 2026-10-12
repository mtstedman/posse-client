import { readonlySet } from "./readonly-collections.js";
// Physical Atlas requests, distinct from expanded tool.atlas execution rows.
export const ATLAS_REQUEST_OBSERVATION_TYPE = "system.atlas_request";

export const RESPONSE_TRANSFORM_OBSERVATION_TYPE = "system.response_transform";
export const PROVIDER_TOOL_REFERENCE_UNRESOLVED_OBSERVATION_TYPE = "provider.tool_reference_unresolved";
export const RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE = "handoff.research_child_envelope_normalized";
export const ASSESSMENT_VERDICT_OBSERVATION_TYPE = "assessment.verdict";
export const HANDOFF_TRAVERSAL_COMPLETION_CHECK_OBSERVATION_TYPE = "handoff.traversal_completion_check";
export const TOOL_SURFACE_ISSUED_OBSERVATION_TYPE = "tool.surface.issued";
export const RESEARCH_EVIDENCE_REUSE_OBSERVATIONS = Object.freeze({
  context: "research.evidence_reuse.context",
  coverage: "research.evidence_reuse.coverage",
  prefetch: "research.evidence_reuse.prefetch",
});
export const AGENT_HANDOFF_OBSERVATION_TYPES = Object.freeze({
  SHAPE_NORMALIZED: "agent_handoff.shape_normalized",
  TARGET_DERIVED: "agent_handoff.target_derived",
  EVIDENCE_CLEANUP: "agent_handoff.evidence_cleanup",
  TRAVERSAL_COMPLETION_GATE: "agent_handoff.traversal_completion_gate",
});

// A frozen baseline that fails after passing for an earlier job of the same
// work item, attributed to the jobs whose commits landed in between.
export const BASELINE_SIBLING_REGRESSION_OBSERVATION_TYPE = "command.baseline_sibling_regression";

export const INTERNAL_BACKGROUND_OBSERVATION_TYPES = Object.freeze([
  RESPONSE_TRANSFORM_OBSERVATION_TYPE,
  ATLAS_REQUEST_OBSERVATION_TYPE,
  "tool.response_transform",
]);

const INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET = readonlySet(INTERNAL_BACKGROUND_OBSERVATION_TYPES);

export function isInternalBackgroundObservationType(value) {
  return INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET.has(String(value || ""));
}
