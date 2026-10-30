// Canonical structured-question and completion vocabulary for deterministic tools.
// This module is pure data so queue, worker, and handoff projections share identities.
// @catalog-sync id=posse.work_item.question_vocabulary role=authority relation=strict compare=values extract=js-question-vocabulary symbol=WORK_ITEM_QUESTION_CHOICE_IDS projection_source=posse
// @linked_repos posse:posse/test/fixtures/work-item-overview/protocol/question-vocabulary-v1.json#kinds posse-bossy:catalog/work_item_overview.go#QUESTION_VOCABULARY posse-bossy:catalog/testdata/repository_work_item_overview/question-vocabulary-v1.json#kinds
export const WORK_ITEM_QUESTION_CHOICE_IDS = Object.freeze({
  clarification: Object.freeze([]),
  planner_clarification: Object.freeze([]),
  dirty_worktree_recovery: Object.freeze(["commit", "send_back", "fail"]),
  assessment_evidence_missing: Object.freeze(["send_back", "retry_assessment", "retry", "replan", "pass", "fail", "explicit_waiver"]),
  stall_exhausted_recovery: Object.freeze(["retry", "retry:claude", "retry:anthropic", "retry:openai", "retry:codex", "retry:grok", "skip", "fail"]),
  failure_threshold_exhausted: Object.freeze(["retry", "replan", "fail", "explicit_waiver"]),
  fix_chain_exhausted: Object.freeze(["retry", "replan", "fail", "explicit_waiver"]),
  plan_approval: Object.freeze(["approve", "reject"]),
  file_scope_approval: Object.freeze(["approve", "reject"]),
  environment_setup: Object.freeze(["approve", "reject"]),
  assessment_review: Object.freeze(["send_back", "retry_assessment", "replan", "pass", "fail", "explicit_waiver"]),
  assessment_transport_recovery: Object.freeze(["send_back", "retry_assessment", "retry", "replan", "pass", "fail", "explicit_waiver"]),
  assessment_retry_limit: Object.freeze(["send_back", "retry_assessment", "replan", "pass", "fail", "explicit_waiver"]),
  unexecuted_replan_recovery: Object.freeze(["replan", "fail", "explicit_waiver"]),
  blocked_recovery: Object.freeze(["retry", "replan", "fail", "explicit_waiver"]),
  partial_work_recovery: Object.freeze(["extend", "commit", "revert"]),
  dead_letter_recovery: Object.freeze([
    "retry", "retry:claude", "retry:anthropic", "retry:openai", "retry:codex", "retry:grok", "skip", "fail",
  ]),
  pipeline_head_recovery: Object.freeze(["replan", "pass", "fail", "explicit_waiver"]),
  artifact_routing_admin: Object.freeze(["acknowledge"]),
  one_shot_file_scope: Object.freeze(["plan", "cancel"]),
  push_offer: Object.freeze(["push", "decline"]),
  shared_trunk_publication_unprovable: Object.freeze(["acknowledge"]),
  shared_trunk_fast_forward_blocked: Object.freeze(["acknowledge"]),
  shared_trunk_push_refused: Object.freeze(["acknowledge"]),
  shared_trunk_push_remote_error: Object.freeze(["acknowledge"]),
  shared_trunk_provenance: Object.freeze(["accept", "reject"]),
  // @linked +posse:posse/lib/domains/bridge/functions/work-item-feed.js#validStoredChoiceEntries +posse:posse/lib/domains/queue/functions/interaction-contract.js#validChoiceEntries (ordered subsets)
  work_item_failure_disposition: Object.freeze(["retry", "accept", "abandon"]),
  // @linked +posse:posse/lib/domains/bridge/functions/work-item-feed.js#validStoredChoiceEntries +posse:posse/lib/domains/queue/functions/interaction-contract.js#validChoiceEntries (ordered subsets)
  cross_wi_upstream_disposition: Object.freeze(["wait", "rebuild", "abandon"]),
  merge_verification_review: Object.freeze(["pass", "fail"]),
  merge_failure_recovery: Object.freeze(["merge", "commit", "waive_tests", "send_back"]),
  post_merge_db_task: Object.freeze(["run", "skip"]),
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
