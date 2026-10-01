export const RESPONSE_TRANSFORM_OBSERVATION_TYPE = "system.response_transform";

// A frozen baseline that fails after passing for an earlier job of the same
// work item, attributed to the jobs whose commits landed in between.
export const BASELINE_SIBLING_REGRESSION_OBSERVATION_TYPE = "command.baseline_sibling_regression";

export const INTERNAL_BACKGROUND_OBSERVATION_TYPES = Object.freeze([
  RESPONSE_TRANSFORM_OBSERVATION_TYPE,
  "tool.response_transform",
]);

const INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET = new Set(INTERNAL_BACKGROUND_OBSERVATION_TYPES);

export function isInternalBackgroundObservationType(value) {
  return INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET.has(String(value || ""));
}
