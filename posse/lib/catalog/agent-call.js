// Canonical identities for provider-call parentage. Keep this set limited to
// child execution paths that actually exist; proposed protocols must not
// become persisted identities before their runtime and accounting contracts
// are implemented.

export const AGENT_CALL_CHILD_KINDS = Object.freeze({
  CITATION: "citation",
  RESEARCH: "research",
  WEB_RESEARCH: "web_research",
  RESEARCH_CLAIM_REVIEW: "research_claim_review",
  // The read-only reviewer a dev/fix agent's final_review call runs.
  FINAL_REVIEW: "final_review",
});

export const AGENT_CALL_CHILD_KIND_VALUES = Object.freeze(
  Object.values(AGENT_CALL_CHILD_KINDS),
);

export const AGENT_CALL_CHILD_KIND_LIST_SQL = AGENT_CALL_CHILD_KIND_VALUES
  .map((value) => `'${value}'`)
  .join(",");

const AGENT_CALL_CHILD_KIND_SET = new Set(AGENT_CALL_CHILD_KIND_VALUES);

export function isAgentCallChildKind(value) {
  return AGENT_CALL_CHILD_KIND_SET.has(String(value || ""));
}

// Persisted agent-call role labels that name a child variant of a runtime
// role. The child still attaches and executes as the runtime role; the label
// only distinguishes it in accounting and display.
export const AGENT_CALL_ROLE_LABELS = Object.freeze({
  WEB_RESEARCHER: "web_researcher",
  // An assessor run for a dev's final_review: it neither spends the
  // assessment's call budget nor counts as the independent assessment.
  FINAL_REVIEWER: "final_reviewer",
});

export const AGENT_CALL_ROLE_LABEL_RUNTIME_ROLES = Object.freeze({
  [AGENT_CALL_ROLE_LABELS.WEB_RESEARCHER]: "researcher",
  [AGENT_CALL_ROLE_LABELS.FINAL_REVIEWER]: "assessor",
});

export function runtimeRoleForAgentCallRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return AGENT_CALL_ROLE_LABEL_RUNTIME_ROLES[role] || role;
}
