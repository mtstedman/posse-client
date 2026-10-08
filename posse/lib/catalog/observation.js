// Physical Atlas requests, distinct from expanded tool.atlas execution rows.
export const ATLAS_REQUEST_OBSERVATION_TYPE = "system.atlas_request";

export const RESPONSE_TRANSFORM_OBSERVATION_TYPE = "system.response_transform";
export const PROVIDER_TOOL_REFERENCE_UNRESOLVED_OBSERVATION_TYPE = "provider.tool_reference_unresolved";
export const RESEARCH_CHILD_ENVELOPE_NORMALIZED_OBSERVATION_TYPE = "handoff.research_child_envelope_normalized";

// A frozen baseline that fails after passing for an earlier job of the same
// work item, attributed to the jobs whose commits landed in between.
export const BASELINE_SIBLING_REGRESSION_OBSERVATION_TYPE = "command.baseline_sibling_regression";

export const INTERNAL_BACKGROUND_OBSERVATION_TYPES = Object.freeze([
  RESPONSE_TRANSFORM_OBSERVATION_TYPE,
  ATLAS_REQUEST_OBSERVATION_TYPE,
  "tool.response_transform",
]);

const INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET = new Set(INTERNAL_BACKGROUND_OBSERVATION_TYPES);

export function isInternalBackgroundObservationType(value) {
  return INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET.has(String(value || ""));
}
