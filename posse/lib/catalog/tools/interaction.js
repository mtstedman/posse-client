// Canonical structured-question and completion vocabulary for deterministic tools.
// This module is pure data so queue, worker, and handoff projections share identities.
export const WORK_ITEM_QUESTION_CHOICE_IDS = Object.freeze({
  plan_approval: Object.freeze(["approve", "reject"]),
  file_scope_approval: Object.freeze(["approve", "reject"]),
  assessment_review: Object.freeze(["pass", "fail", "skip", "replan"]),
  assessment_transport_recovery: Object.freeze(["retry", "pass", "fail", "skip", "replan"]),
  assessment_retry_limit: Object.freeze(["pass", "fail", "skip", "replan"]),
  blocked_recovery: Object.freeze(["retry", "skip", "replan", "explicit_waiver", "fail"]),
  partial_work_recovery: Object.freeze(["extend", "commit", "revert"]),
  dead_letter_recovery: Object.freeze([
    "retry", "retry:claude", "retry:openai", "retry:codex", "retry:grok", "skip", "fail",
  ]),
  pipeline_head_recovery: Object.freeze(["pass", "fail", "skip", "replan"]),
  one_shot_file_scope: Object.freeze(["plan", "cancel"]),
  push_offer: Object.freeze(["push", "decline"]),
  legacy_unstructured: Object.freeze([]),
});

export const DEV_COMPLETION_STATUSES = Object.freeze([
  "COMPLETE",
  "VERIFIED_NO_CHANGE",
  "PARTIAL",
  "BLOCKED",
]);

export const ARTIFICER_COMPLETION_STATUSES = Object.freeze([
  "COMPLETE",
  "PARTIAL",
  "BLOCKED",
]);
