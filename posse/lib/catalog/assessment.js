// Closed local-assessment policy vocabulary. Runtime evidence evaluation stays
// in the assessment domain; this catalog only names accepted tool outcomes.
export const PIXEL_VISUAL_EVIDENCE_TOOL_NAMES = Object.freeze([
  "view_image",
  "inspect_image",
  "analyze_image",
  "image_preview",
]);

export const UNSUCCESSFUL_VISUAL_TOOL_STATUSES = Object.freeze([
  "blocked",
  "cancelled",
  "canceled",
  "denied",
  "error",
  "failed",
  "rejected",
]);
