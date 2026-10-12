// @ts-check
// Required local prompt projections; readiness intentionally excludes artificer.
export const REQUIRED_PROMPT_ROLES = Object.freeze(["researcher", "planner", "dev", "assessor", "preflight"]);
export const REQUIRED_PROMPT_CONTRACTS = Object.freeze(["rule-priority", "file-scope", "task-modes", "researcher-output"]);
