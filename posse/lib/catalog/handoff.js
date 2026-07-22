// Canonical terminal-handoff vocabulary shared by schemas and runtime policy.

export const AGENT_HANDOFF_RECEIPT_NOTIFICATION = "notifications/posse/agent_handoff_receipt";

export const AGENT_HANDOFF_PLANNER_CONTRACT_VERSION = 1;
export const AGENT_HANDOFF_PLANNER_CONTRACT_KEYS = Object.freeze([
  "version",
  "exact_executable_handoffs",
  "dependency_edges",
]);
export const AGENT_HANDOFF_PLANNER_DEPENDENCY_EDGE_POLICIES = Object.freeze([
  "unconstrained",
  "at_least_one",
  "none",
]);
export const AGENT_HANDOFF_WORK_ITEM_CONTRACT_ERROR = "AGENT_HANDOFF_WORK_ITEM_CONTRACT_INVALID";
