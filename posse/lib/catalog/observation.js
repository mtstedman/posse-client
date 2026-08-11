export const RESPONSE_TRANSFORM_OBSERVATION_TYPE = "system.response_transform";

export const INTERNAL_BACKGROUND_OBSERVATION_TYPES = Object.freeze([
  RESPONSE_TRANSFORM_OBSERVATION_TYPE,
  "tool.response_transform",
]);

const INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET = new Set(INTERNAL_BACKGROUND_OBSERVATION_TYPES);

export function isInternalBackgroundObservationType(value) {
  return INTERNAL_BACKGROUND_OBSERVATION_TYPE_SET.has(String(value || ""));
}
