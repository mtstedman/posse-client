// Canonical identities for provider-call parentage. Keep this set limited to
// child execution paths that actually exist; proposed protocols must not
// become persisted identities before their runtime and accounting contracts
// are implemented.

export const AGENT_CALL_CHILD_KINDS = Object.freeze({
  CITATION: "citation",
  WEB_RESEARCH: "web_research",
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
