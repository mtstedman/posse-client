// Canonical structured-question and completion vocabulary for deterministic tools.
// This module is pure data so queue, worker, and handoff projections share identities.
// @catalog-sync id=posse.work_item.question_vocabulary role=authority relation=strict compare=values extract=js-question-vocabulary symbol=WORK_ITEM_QUESTION_CHOICE_IDS projection_source=posse
// @linked_repos posse:posse/test/fixtures/work-item-overview/protocol/question-vocabulary-v1.json#kinds posse-bossy:catalog/work_item_overview.go#QUESTION_VOCABULARY posse-bossy:catalog/testdata/repository_work_item_overview/question-vocabulary-v1.json#kinds
export const WORK_ITEM_QUESTION_CHOICE_IDS = Object.freeze({
  plan_approval: Object.freeze(["approve", "reject"]),
  file_scope_approval: Object.freeze(["approve", "reject"]),
  assessment_review: Object.freeze(["pass", "fail", "skip", "replan"]),
  assessment_transport_recovery: Object.freeze(["retry", "pass", "fail", "skip", "replan"]),
  assessment_retry_limit: Object.freeze(["pass", "fail", "skip", "replan"]),
  unexecuted_replan_recovery: Object.freeze(["replan", "fail", "explicit_waiver"]),
  blocked_recovery: Object.freeze(["retry", "skip", "replan", "explicit_waiver", "fail"]),
  partial_work_recovery: Object.freeze(["extend", "commit", "revert"]),
  dead_letter_recovery: Object.freeze([
    "retry", "retry:claude", "retry:openai", "retry:codex", "retry:grok", "skip", "fail",
  ]),
  pipeline_head_recovery: Object.freeze(["pass", "fail", "skip", "replan"]),
  artifact_routing_admin: Object.freeze(["acknowledge"]),
  one_shot_file_scope: Object.freeze(["plan", "cancel"]),
  push_offer: Object.freeze(["push", "decline"]),
  shared_trunk_provenance: Object.freeze(["accept", "reject"]),
  // @linked +posse:posse/lib/domains/bridge/functions/work-item-feed.js#validStoredChoiceEntries +posse:posse/lib/domains/queue/functions/interaction-contract.js#validChoiceEntries (ordered subsets)
  work_item_failure_disposition: Object.freeze(["retry", "accept", "abandon"]),
  // @linked +posse:posse/lib/domains/bridge/functions/work-item-feed.js#validStoredChoiceEntries +posse:posse/lib/domains/queue/functions/interaction-contract.js#validChoiceEntries (ordered subsets)
  cross_wi_upstream_disposition: Object.freeze(["wait", "rebuild", "abandon"]),
  legacy_unstructured: Object.freeze([]),
});
// @catalog-sync end

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
