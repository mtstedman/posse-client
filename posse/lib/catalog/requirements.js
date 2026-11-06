export const REQUIREMENT_CONTRACT_VERSION = 1;
export const REQUIREMENT_SOURCE_FIELDS = Object.freeze(["task_spec", "instructions", "success_criteria", "must_modify"]);
export const REQUIREMENT_STATES = Object.freeze({ OPEN: "unresolved", CONSTRAINED: "policy_constrained", SATISFIED: "satisfied", WAIVED: "waived" });
