// Recovery actions precede terminal dispositions; waiver is last so it is
// always an explicit choice. Shared by persisted questions and review gates.
export const GATE_ACTION_ORDER = Object.freeze([
  "send_back", "retry_assessment", "retry", "recheck",
  "replan", "pass", "fail", "explicit_waiver",
]);

export function orderedGateActions(actions) {
  const requested = new Set(actions);
  if (requested.size !== actions.length || [...requested].some((action) => !GATE_ACTION_ORDER.includes(action))) {
    throw new Error("Gate actions must be distinct members of the canonical order");
  }
  return Object.freeze(GATE_ACTION_ORDER.filter((action) => requested.has(action)));
}
