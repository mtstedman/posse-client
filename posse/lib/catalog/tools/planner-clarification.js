import { ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS, ENVIRONMENT_SETUP_LIVE_MAX_MS } from "./environment-setup.js";
export const PLANNER_CLARIFICATION_TOOL = "request_clarification";
export const PLANNER_CLARIFICATION_REVIEW_TYPE = "planner_clarification";
export const PLANNER_CLARIFICATION_TIMEOUT_MS = ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS;
export const PLANNER_CLARIFICATION_LIVE_MAX_MS = ENVIRONMENT_SETUP_LIVE_MAX_MS;
export const TOOL_REQUEST_CLARIFICATION = Object.freeze({
  type: "function", name: PLANNER_CLARIFICATION_TOOL,
  description: "Ask the user to resolve a planning ambiguity and wait for their answer in this session. The compute slot is released while waiting. Continue planning from the returned answer; this does not finish or replace the plan. Use only for requirements that repository evidence cannot resolve.",
  parameters: { type: "object", additionalProperties: false,
    properties: {
      questions: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 1000 } },
      context: { type: "string", minLength: 1, maxLength: 2000 },
    }, required: ["questions", "context"] },
});
