// Recovery actions precede terminal dispositions; waiver is last so it is
// always an explicit choice. Shared by persisted questions and review gates.
export const GATE_ACTION_ORDER = Object.freeze([
  "send_back", "retry_assessment", "retry", "retry_with_changes", "recheck",
  "replan", "pass", "fail", "explicit_waiver",
]);

export function orderedGateActions(actions) {
  const requested = new Set(actions);
  if (requested.size !== actions.length || [...requested].some((action) => !GATE_ACTION_ORDER.includes(action))) {
    throw new Error("Gate actions must be distinct members of the canonical order");
  }
  return Object.freeze(GATE_ACTION_ORDER.filter((action) => requested.has(action)));
}

// Persisted gates from older owners retain their original choice IDs/order.
export const LEGACY_REVIEW_CHOICE_IDS = Object.freeze({
  assessment_review: Object.freeze(["pass", "fail", "skip", "replan"]),
  assessment_transport_recovery: Object.freeze(["retry", "pass", "fail", "skip", "replan"]),
  assessment_retry_limit: Object.freeze(["pass", "fail", "skip", "replan"]),
  unexecuted_replan_recovery: Object.freeze(["replan", "fail", "explicit_waiver"]),
  blocked_recovery: Object.freeze(["retry", "skip", "replan", "explicit_waiver", "fail"]),
  pipeline_head_recovery: Object.freeze(["pass", "fail", "skip", "replan"]),
});

export function validReviewChoiceIDs(kind, ids, canonical) {
  const legacy = LEGACY_REVIEW_CHOICE_IDS[kind];
  if (!legacy || ids.length === 0) return false;
  if (ids.length === legacy.length && ids.every((id, index) => id === legacy[index])) return true;
  // One older blocked-recovery owner used pass as its waiver spelling.
  if (kind === "blocked_recovery" &&
    ids.join(",") === "retry,skip,replan,pass,fail") return true;
  let previous = -1;
  return ids.every((id) => {
    const index = canonical.indexOf(id);
    if (index <= previous) return false;
    previous = index;
    return true;
  });
}
