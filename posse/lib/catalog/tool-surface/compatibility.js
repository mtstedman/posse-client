// Execution names accepted during rolling client/compiler upgrades. Remote
// issuance still chooses the actual name; these never expand advertised tools.
export const TOOL_EXECUTION_ALIASES = Object.freeze({
  agent_claim: Object.freeze(["report_claims"]),
});

export function withToolExecutionAliases(names = []) {
  return [...new Set(names.flatMap((name) => [name, ...(TOOL_EXECUTION_ALIASES[name] || [])]))];
}
