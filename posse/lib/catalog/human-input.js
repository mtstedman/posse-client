import { PLANNER_CLARIFICATION_REVIEW_TYPE } from "./tools/planner-clarification.js";
import { ENVIRONMENT_SETUP_REVIEW_TYPE } from "./tools/environment-setup.js";
import { readonlySet } from "./readonly-collections.js";
// Human-input action catalogue.
//
// `review_type` predates typed human-input gates, so some coordination and
// recovery prompts still carry that field even though they are not binary
// assessor reviews. HUMAN_GATE_ACTIONS is the one table of what each gate
// offers and accepts: the prompt, the bridge projection, answer validation and
// the durable gate contract all read it, so none of them can drift. An action
// has one spelling (the structured question vocabulary's); nothing here maps
// one word to another, and free text is an answer, never an action.

import {
  FAILED_JOB_STATUSES,
  JOB_STATUSES,
  ONESHOT_SCOPE_SELECTION_SUBTYPE,
} from "./job.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "./tools/interaction.js";

const freezeChoices = (choices) => Object.freeze([...choices]);
export const HUMAN_INPUT_BEST_JUDGMENT_ANSWER = "Continue with best judgment using the available evidence and explicit assumptions.";
// A gate without choices (a clarification) takes a free-text answer. One
// answered from outside the run that holds it is reserved for that run's
// prompt under this choice id, with the text alongside; the text is bounded.
export const HUMAN_INPUT_FREE_TEXT_CHOICE_ID = "free_text";
export const HUMAN_INPUT_FREE_TEXT_MAX_CHARS = 8000;
export const HUMAN_GATE_STATES = Object.freeze(["open", "resolving", "resolved", "superseded"]);
// Gate IDs are also the structured question IDs. No runtime name translation.
export function questionKindForReviewType(value) {
  const reviewType = String(value || "");
  return Object.hasOwn(WORK_ITEM_QUESTION_CHOICE_IDS, reviewType)
    ? reviewType
    : null;
}
export const HUMAN_GATE_RECONCILE_REASONS = Object.freeze({
  CLOSED_CONTRACT_JOB: "closed_contract_job",
  TERMINAL_WORK_ITEM: "terminal_work_item",
  SOURCE_STATE_CHANGED: "source_state_changed",
  MISSING_ORIGINAL: "missing_original",
  REGISTERED_LEGACY: "registered_legacy",
  DUPLICATE_LEGACY: "duplicate_legacy",
  INVALID_LEGACY_CONTRACT: "invalid_legacy_contract",
  CONTRACT_REFRESHED: "contract_refreshed",
  ORPHANED_GATE: "orphaned_gate",
  FAILED_RESOLUTION: "failed_resolution",
  ABANDONED_RESOLVER: "abandoned_resolver",
  TERMINAL_GATE_JOB: "terminal_gate_job",
});
// Why a blocked_recovery gate's assessment could not finish. The class picks
// what its retry replays: an infrastructure failure reassesses the preserved
// candidate, while missing bound evidence resumes the implementation, the only
// owner that can regenerate it.
export const ASSESSMENT_FAILURE_CLASSES = Object.freeze({
  INFRASTRUCTURE: "assessment_infrastructure",
  SOURCE_MISSING: "assessment_source_missing",
});
// Stamped on `_blocked_recovery.retry_scope` by a blocked_recovery retry.
export const BLOCKED_RECOVERY_RETRY_SCOPES = Object.freeze({
  ASSESSMENT: "assessment",
  IMPLEMENTATION: "implementation",
});
// A blocked job's verification is waived only by the waiver's own words.
// and are refused on every other list; they never waive.
export const SCOPE_APPROVAL_MODES = Object.freeze({ DEFAULT: "default", AUTO: "auto" });
export const SCOPE_APPROVAL_MODE_VALUES = Object.freeze(Object.values(SCOPE_APPROVAL_MODES));
export const SCOPE_MODE_APPROVAL_SOURCE = "scope_mode_auto";
// Operator gate opened when a work item merges for each database task held
// behind that merge. "run" requeues the held task; "skip" cancels it.
export const POST_MERGE_DB_TASK_REVIEW_TYPE = "post_merge_db_task";
// Work-item review gate opened instead of an automatic merge when a job's
// planned verification was replaced or waived because it already failed
// before the change (baseline debt) and the work is high-risk or touches
// auth/session/security code. "pass" lets the merge proceed; "fail" sends the
// work item back for rework with the operator's feedback (review rejection).
export const MERGE_VERIFICATION_REVIEW_TYPE = "merge_verification_review";
// Operator gate opened when Git refused a completed work item's merge (a
// conflict, a dirty target, a failed close-out refresh). "merge" merges it
// now, as `posse merge` would, once the operator resolved the repository
// condition; "send_back" returns the work item for rework on its branch.
// Gates opened before this type existed carry MERGE_VERIFICATION_REVIEW_TYPE
// with the merge-failure payload key; their pass/fail mean merge/send_back.
export const MERGE_FAILURE_RECOVERY_REVIEW_TYPE = "merge_failure_recovery";
export const MERGE_FAILURE_KINDS = Object.freeze({
  DIRTY_TREE: "dirty_tree",
  INTEGRATION_TEST: "integration_test",
  CONFLICT: "conflict",
  RUNTIME_PATH: "runtime_path",
  BRANCH_MISSING: "branch_missing",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
});
// Work-item gates (no original job) for states no job gate covers. A failed
// work item that still owns a branch or implementation work asks whether to
// retry its failed jobs on that branch, accept assessment-only failures, or
// abandon it. A completed work item whose cross-WI merge dependency points at
// a failed or canceled upstream asks whether to keep waiting for it, rebuild
// on the target branch without the inherited edits, or abandon.
export const WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE = "work_item_failure_disposition";
export const CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE = "cross_wi_upstream_disposition";
export const WORK_ITEM_DISPOSITION_REVIEW_TYPES = Object.freeze([
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
  CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
]);

// Recovery gates whose "retry" (bare, or with ":" guidance) re-runs the
// failed or blocked work through the
// ordinary assessed pipeline. The answer requeues or creates the retried jobs
// while the gate is still resolving, and they block completion until they
// pass, so once resolved the retry leaves nothing for an operator to decide
// before merge: it must not hold the work item out of automatic merge
// (merge-holding-gate.js). A dead-letter retry routed to a provider
// ("retry:claude") never held; a plain "retry" held the work item forever
// (wowiekowie 2026-10-01: WI 167 recovered at 22:36 but was refused
// automatic merge as human_gate_active until a manual approval; WI 164's
// blocked-recovery retry #2205 would have held it the same way).
// Assessment-review answers replan and fail still hold; retry_assessment
// does not (merge-holding-gate.js).
export const BLOCKED_RECOVERY_GATE_KINDS = Object.freeze(["blocked_recovery", "failure_threshold_exhausted", "fix_chain_exhausted"]);

export const MERGE_RELEASING_RETRY_REVIEW_TYPES = Object.freeze([
  "failure_threshold_exhausted",
  "fix_chain_exhausted",
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
  "blocked_recovery",
  "dead_letter_recovery",
  "stall_exhausted_recovery",
]);

// Gates whose answer is a verdict on code, and which change that verdict
// judges. An attempt-scoped verdict (an assessment review, a blocked-recovery
// waiver, a dead letter that left a commit) judges the original job's latest
// committed attempt; a work-item verdict (merge verification, accepting a
// failed work item, keeping partial work) judges the work-item branch against
// its merge base plus any uncommitted worktree change. The TUI prompt offers
// that diff and `posse gate show` prints it. Plan, push, scope, clarification
// and coordination prompts judge no code and are absent, as is an
// unexecuted-replan limit (its job never ran) and a research dead letter.
export const HUMAN_INPUT_REVIEW_DIFF_SCOPES = Object.freeze({
  ATTEMPT: "attempt",
  WORK_ITEM: "work_item",
});
export const DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE = "dirty_worktree_recovery";
export const DIRTY_WORKTREE_RECOVERY_ERROR = "WORKTREE_DIRTY_RECOVERY_REQUIRED";
export const DIRTY_WORKTREE_RECOVERY_KEY = "_dirty_worktree_recovery";

const ATTEMPT_REVIEW_DIFF = Object.freeze({ scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.ATTEMPT });
// A dead letter is a recovery choice; it judges code only when the job
// committed some before it died.
const COMMITTED_ATTEMPT_REVIEW_DIFF = Object.freeze({
  scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.ATTEMPT,
  requires_commit: true,
});
const WORK_ITEM_REVIEW_DIFF = Object.freeze({ scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.WORK_ITEM });
const HUMAN_INPUT_REVIEW_DIFF_POLICIES = Object.freeze({
  assessment_review: ATTEMPT_REVIEW_DIFF,
  assessment_evidence_missing: ATTEMPT_REVIEW_DIFF,
  assessment_transport_recovery: ATTEMPT_REVIEW_DIFF,
  assessment_retry_limit: ATTEMPT_REVIEW_DIFF,
  pipeline_head_recovery: ATTEMPT_REVIEW_DIFF,
  blocked_recovery: ATTEMPT_REVIEW_DIFF,
  failure_threshold_exhausted: ATTEMPT_REVIEW_DIFF,
  fix_chain_exhausted: ATTEMPT_REVIEW_DIFF,
  dead_letter_recovery: COMMITTED_ATTEMPT_REVIEW_DIFF,
  stall_exhausted_recovery: COMMITTED_ATTEMPT_REVIEW_DIFF,
  partial_work_recovery: WORK_ITEM_REVIEW_DIFF,
  [DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE]: WORK_ITEM_REVIEW_DIFF,
  [MERGE_VERIFICATION_REVIEW_TYPE]: WORK_ITEM_REVIEW_DIFF,
  [MERGE_FAILURE_RECOVERY_REVIEW_TYPE]: WORK_ITEM_REVIEW_DIFF,
  // Only "accept" (pass the failed jobs as an operator review) judges code.
  [WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE]: Object.freeze({
    scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.WORK_ITEM,
    requires_choice: "accept",
  }),
});

export function humanGateStateAllowsAnswer(gateState) {
  return gateState == null || gateState === "open";
}

export function humanGateStateIsActive(gateState) {
  return humanGateStateAllowsAnswer(gateState) || gateState === "resolving";
}

const DEFAULT_HUMAN_GATE_SOURCE_STATES = Object.freeze(
  JOB_STATUSES.filter((status) => !["leased", "awaiting_assessment", "canceled"].includes(status)),
);

/**
 * What each gate offers and accepts, keyed by gate name (the payload's
 * review_type). One list per gate: the prompt shows it, the bridge projects
 * it, an answer must select from it and the persisted gate contract is
 * written from it. A gate named here with ["respond"] takes free text; a
 * gate not named here is rejected at creation.
 */
export const HUMAN_GATE_ACTIONS = Object.freeze(Object.fromEntries(
  Object.entries(WORK_ITEM_QUESTION_CHOICE_IDS)
    .filter(([kind]) => kind !== "legacy_unstructured")
    .map(([kind, choices]) => [kind, freezeChoices(choices.length > 0 ? choices : ["respond"])]),
));

export const HUMAN_GATE_RECOVERY_KINDS = Object.freeze([
  ENVIRONMENT_SETUP_REVIEW_TYPE,
  "blocked_recovery",
  "assessment_evidence_missing",
  "partial_work_recovery",
  "failure_threshold_exhausted",
  "fix_chain_exhausted",
  "assessment_transport_recovery",
  "assessment_retry_limit",
  "dead_letter_recovery",
  "artifact_routing_admin",
  "file_scope_approval",
]);

// Gates that withhold authority or a requirement instead of recovering failed
// work: plan approval, file-scope approval, installer approval, and a
// clarification (including the planner's dependency-setup question). The work
// behind them is not yet authorized, not failed, so an unanswered one stays
// open for the operator and never times out in a headless run.
export const AUTHORIZATION_GATE_KINDS = Object.freeze([
  "plan_approval",
  "file_scope_approval",
  ENVIRONMENT_SETUP_REVIEW_TYPE,
  "clarification",
  PLANNER_CLARIFICATION_REVIEW_TYPE,
]);

// Gate kind and source-state contract per gate name. Actions are not here:
// HUMAN_GATE_ACTIONS is their one source.
const HUMAN_GATE_CONTRACTS = Object.freeze({
  clarification: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  one_shot_file_scope: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  plan_approval: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  push_offer: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  planner_clarification: { allowed_source_states: ["running"] },
  environment_setup: { allowed_source_states: ["running"] },
  file_scope_approval: { allowed_source_states: ["running", "blocked", "waiting_on_human", "waiting_on_review", "succeeded", "failed"] },
  dirty_worktree_recovery: { allowed_source_states: ["waiting_on_human", "waiting_on_review", "blocked"] },
  partial_work_recovery: { allowed_source_states: ["running", "blocked", "waiting_on_human"] },
  blocked_recovery: { allowed_source_states: ["blocked", "waiting_on_human", "waiting_on_review", ...FAILED_JOB_STATUSES] },
  dead_letter_recovery: { allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"] },
  stall_exhausted_recovery: { allowed_source_states: [...FAILED_JOB_STATUSES, "blocked", "waiting_on_human"] },
  assessment_review: { allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"] },
  assessment_evidence_missing: { allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"] },
  assessment_transport_recovery: { allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"] },
  assessment_retry_limit: { allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"] },
  pipeline_head_recovery: { allowed_source_states: ["waiting_on_review", "waiting_on_human", ...FAILED_JOB_STATUSES] },
  unexecuted_replan_recovery: { allowed_source_states: ["waiting_on_review", "waiting_on_human", ...FAILED_JOB_STATUSES] },
  artifact_routing_admin: { allowed_source_states: ["waiting_on_review", "waiting_on_human", ...FAILED_JOB_STATUSES] },
  shared_trunk_publication_unprovable: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  shared_trunk_fast_forward_blocked: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  shared_trunk_push_refused: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  shared_trunk_push_remote_error: { allowed_source_states: DEFAULT_HUMAN_GATE_SOURCE_STATES },
  shared_trunk_provenance: { allowed_source_states: ["waiting_on_human", "succeeded"] },
  post_merge_db_task: { allowed_source_states: ["waiting_on_human"] },
  merge_verification_review: { allowed_source_states: ["succeeded"] },
  merge_failure_recovery: { allowed_source_states: ["succeeded"] },
  work_item_failure_disposition: { allowed_source_states: ["waiting_on_human"] },
  cross_wi_upstream_disposition: { allowed_source_states: ["waiting_on_human"] },
  failure_threshold_exhausted: { allowed_source_states: ["blocked", "waiting_on_human", "waiting_on_review", ...FAILED_JOB_STATUSES] },
  fix_chain_exhausted: { allowed_source_states: ["blocked", "waiting_on_human", "waiting_on_review", ...FAILED_JOB_STATUSES] },
});

const HUMAN_GATE_ACTIONABILITY_PROFILES = Object.freeze({
  "clarification": {
    "unresolved_fact": "A task requirement cannot be derived from repository and work-item evidence.",
    "human_contribution": "ambiguity_resolution",
    "headless_behavior": "continue_with_best_judgment",
    "diagnostic_insufficient_reason": "Continuing without an answer requires an explicit best-judgment assumption."
  },
  "one_shot_file_scope": {
    "unresolved_fact": "Which candidate file or scope the one-shot request intends to modify.",
    "human_contribution": "ambiguity_resolution",
    "headless_behavior": "use_deterministic_best_scope_or_fail_closed",
    "diagnostic_insufficient_reason": "Multiple plausible mutation scopes remain after automatic inference."
  },
  "plan_approval": {
    "unresolved_fact": "Whether the proposed implementation plan is authorized to execute.",
    "human_contribution": "authority",
    "headless_behavior": "use_configured_plan_approval_policy",
    "diagnostic_insufficient_reason": "Plan approval grants execution authority rather than supplying a discoverable fact."
  },
  "push_offer": {
    "unresolved_fact": "Whether committed work may be pushed to the configured remote.",
    "human_contribution": "merge_push_choice",
    "headless_behavior": "do_not_push",
    "diagnostic_insufficient_reason": "Remote publication requires an explicit operator choice."
  },
  "planner_clarification": {
    "unresolved_fact": "A task requirement cannot be derived from repository and work-item evidence.",
    "human_contribution": "ambiguity_resolution",
    "headless_behavior": "continue_with_best_judgment",
    "diagnostic_insufficient_reason": "Continuing without an answer requires an explicit best-judgment assumption."
  },
  "environment_setup": {
    "unresolved_fact": "Whether this exact installer or database initializer may run on the user machine.",
    "human_contribution": "authority",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "Only explicit user approval authorizes environment setup."
  },
  "file_scope_approval": {
    "unresolved_fact": "Whether the required out-of-scope files may be added to mutation authority.",
    "human_contribution": "authority",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "Repository evidence cannot expand the operator-approved scope."
  },
  "dirty_worktree_recovery": {
    "unresolved_fact": "Which authorized recovery path should follow the developer block.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The available recovery choices spend different authority and budget."
  },
  "partial_work_recovery": {
    "unresolved_fact": "Whether partial work should receive more budget, be preserved, or be discarded.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "preserve_and_fail_closed",
    "diagnostic_insufficient_reason": "Each action intentionally changes ownership or preservation state."
  },
  "blocked_recovery": {
    "unresolved_fact": "Which authorized recovery path should follow the developer block.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The available recovery choices spend different authority and budget."
  },
  "dead_letter_recovery": {
    "unresolved_fact": "Whether terminal work should be retried through a selected provider, waived, or failed.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "Recovering terminal work spends authority and execution budget."
  },
  "stall_exhausted_recovery": {
    "unresolved_fact": "A task requirement cannot be derived from repository and work-item evidence.",
    "human_contribution": "ambiguity_resolution",
    "headless_behavior": "continue_with_best_judgment",
    "diagnostic_insufficient_reason": "Continuing without an answer requires an explicit best-judgment assumption."
  },
  "assessment_review": {
    "unresolved_fact": "Whether available evidence justifies acceptance, rejection, waiver, or another assessment.",
    "human_contribution": "semantic_judgment",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The bounded automatic assessment path has already exhausted its evidence or judgment budget."
  },
  "assessment_evidence_missing": {
    "unresolved_fact": "Whether to retry evidence acquisition, reject, replan, or explicitly waive missing evidence.",
    "human_contribution": "authority",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "Only an explicit waiver may substitute for required evidence."
  },
  "assessment_transport_recovery": {
    "unresolved_fact": "Whether to authorize another assessment attempt or choose a terminal disposition.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "Automatic assessment transport retries are exhausted."
  },
  "assessment_retry_limit": {
    "unresolved_fact": "Whether to spend more assessment budget, replan, reject, or explicitly waive verification.",
    "human_contribution": "authority",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The configured automatic assessment budget is exhausted."
  },
  "pipeline_head_recovery": {
    "unresolved_fact": "Whether to authorize a new strategy, reject the work, or waive the remaining defect.",
    "human_contribution": "authority",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The configured automatic repair strategy budget is exhausted."
  },
  "unexecuted_replan_recovery": {
    "unresolved_fact": "Whether to authorize a new strategy, reject the work, or waive the remaining defect.",
    "human_contribution": "authority",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The configured automatic repair strategy budget is exhausted."
  },
  "artifact_routing_admin": {
    "unresolved_fact": "A task requirement cannot be derived from repository and work-item evidence.",
    "human_contribution": "ambiguity_resolution",
    "headless_behavior": "continue_with_best_judgment",
    "diagnostic_insufficient_reason": "Continuing without an answer requires an explicit best-judgment assumption."
  },
  shared_trunk_publication_unprovable: {
    unresolved_fact: "Whether the operator has inspected and repaired the shared-trunk condition.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Acknowledgement records an operator decision before shared-trunk recovery resumes.",
  },
  shared_trunk_fast_forward_blocked: {
    unresolved_fact: "Whether the operator has inspected and repaired the shared-trunk condition.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Acknowledgement records an operator decision before shared-trunk recovery resumes.",
  },
  shared_trunk_push_refused: {
    unresolved_fact: "Whether the operator has inspected and repaired the shared-trunk condition.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Acknowledgement records an operator decision before shared-trunk recovery resumes.",
  },
  shared_trunk_push_remote_error: {
    unresolved_fact: "Whether the operator has inspected and repaired the shared-trunk condition.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Acknowledgement records an operator decision before shared-trunk recovery resumes.",
  },
  "shared_trunk_provenance": {
    "unresolved_fact": "A task requirement cannot be derived from repository and work-item evidence.",
    "human_contribution": "ambiguity_resolution",
    "headless_behavior": "continue_with_best_judgment",
    "diagnostic_insufficient_reason": "Continuing without an answer requires an explicit best-judgment assumption."
  },
  "post_merge_db_task": {
    "unresolved_fact": "Whether the merged change is deployed, so its deferred task may write the project database.",
    "human_contribution": "authority",
    "headless_behavior": "do_not_run",
    "diagnostic_insufficient_reason": "Posse cannot observe when the operator deploys the merged change."
  },
  "merge_verification_review": {
    "unresolved_fact": "Whether work whose planned verification could not run may merge on review alone.",
    "human_contribution": "authority",
    "headless_behavior": "do_not_merge",
    "diagnostic_insufficient_reason": "The planned test already failed before the change, so no executed check shows the risky change works."
  },
  "merge_failure_recovery": {
    "unresolved_fact": "Whether the repository condition that stopped the merge is resolved, so the work item can merge now, or the work must go back for rework.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "do_not_merge",
    "diagnostic_insufficient_reason": "Git refused the merge; only the operator can resolve the conflict or repository condition behind it."
  },
  "work_item_failure_disposition": {
    "unresolved_fact": "Whether a failed work item's branch should be retried, accepted despite assessment-only failures, or abandoned.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "leave_parked",
    "diagnostic_insufficient_reason": "Each choice spends execution budget, overrides an assessor verdict, or discards committed work."
  },
  "cross_wi_upstream_disposition": {
    "unresolved_fact": "Whether a completed work item should wait for its failed upstream, be rebuilt without the inherited edits, or be abandoned.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "leave_parked",
    "diagnostic_insufficient_reason": "Only the operator knows whether the failed upstream work item will be recovered."
  },
  "failure_threshold_exhausted": {
    "unresolved_fact": "Which authorized recovery path should follow the developer block.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The available recovery choices spend different authority and budget."
  },
  "fix_chain_exhausted": {
    "unresolved_fact": "Which authorized recovery path should follow the developer block.",
    "human_contribution": "recovery_choice",
    "headless_behavior": "fail_closed",
    "diagnostic_insufficient_reason": "The available recovery choices spend different authority and budget."
  }
});

function actionTransition(action) {
  const canonical = String(action || "").trim();
  const transitions = {
    approve: "grant_scope_and_resume",
    deny: "deny_scope_and_fail_request",
    reject: "reject_request",
    extend: "increase_budget_and_resume",
    commit: "preserve_partial_work_and_assess",
    revert: "discard_partial_work_and_dead_letter",
    retry_assessment: "queue_new_assessment_attempt",
    retry: "queue_recovery_attempt",
    skip: "cancel_original_job_and_release_dependents",
    acknowledge: "record_operator_acknowledgement",
    replan: "queue_new_research_and_plan",
    pass: "record_human_acceptance",
    fail: "record_terminal_rejection",
    explicit_waiver: "record_authority_backed_waiver",
    respond: "resume_with_human_answer",
    plan: "resume_with_selected_scope",
    run: "queue_post_merge_database_task",
    accept: "accept_assessment_only_failures_and_complete",
    abandon: "cancel_work_item_and_delete_branch",
    wait: "keep_merge_deferred_until_upstream_merges",
    rebuild: "requeue_on_target_branch_without_inherited_edits",
    merge: "merge_work_item_into_target",
    waive_tests: "record_candidate_test_waiver_and_merge",
    send_back: "requeue_work_item_for_rework",
  };
  if (String(action || "").startsWith("retry:")) return "queue_provider_specific_recovery";
  return transitions[canonical] || `resolve_gate_with_${canonical || "response"}`;
}

export function validateHumanGateActionabilityContract(contract = {}) {
  const actionability = contract.actionability;
  if (actionability?.schema_version !== 1) return { ok: false, reason: "actionability_schema_missing" };
  for (const field of ["unresolved_fact", "human_contribution", "headless_behavior", "diagnostic_insufficient_reason"]) {
    if (!String(actionability[field] || "").trim()) return { ok: false, reason: `actionability_${field}_missing` };
  }
  const transitions = actionability.action_transitions;
  if (!transitions || typeof transitions !== "object" || Array.isArray(transitions)) {
    return { ok: false, reason: "actionability_transitions_missing" };
  }
  for (const action of contract.allowed_actions || []) {
    if (!String(transitions[action] || "").trim()) return { ok: false, reason: `actionability_transition_missing:${action}` };
  }
  return { ok: true, reason: null };
}

export function humanGateNameForPayload(payload = {}) {
  const identities = [payload.gate_kind, payload.review_type, payload.subtype, payload.question_kind]
    .filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
  const name = identities[0] || (Array.isArray(payload.file_requests) && payload.file_requests.length > 0
    ? "file_scope_approval" : "clarification");
  if (!Object.hasOwn(HUMAN_GATE_ACTIONS, name)) throw new Error(`Unknown canonical gate ID: ${name}`);
  if (identities.some((value) => value !== name)) throw new Error(`Gate identity mismatch: ${identities.join(" != ")}`);
  return name;
}

export function canonicalHumanGatePayload(payload = {}) {
  const gate = humanGateNameForPayload(payload);
  return { ...payload, review_type: gate, gate_kind: gate, question_kind: gate };
}

export function humanGateContractForPayload(payload = {}, {
  parentJobId = null,
} = {}) {
  const source = humanGateNameForPayload(payload);
  const registered = HUMAN_GATE_CONTRACTS[source];
  const explicitChoices = humanInputChoicesForPayload(payload);
  const originalJobId = Number(
    payload?.original_job_id
    ?? payload?.plan_job_id
    ?? parentJobId
  );
  const allowedActions = [...new Set(source === "one_shot_file_scope" ? explicitChoices
    : narrowedReviewChoices(payload, [...HUMAN_GATE_ACTIONS[source]]))];
  const profile = HUMAN_GATE_ACTIONABILITY_PROFILES[source];
  return {
    gate_kind: source,
    contract_version: 2,
    original_job_id: Number.isInteger(originalJobId) && originalJobId > 0 ? originalJobId : null,
    allowed_source_states: [...(registered?.allowed_source_states || DEFAULT_HUMAN_GATE_SOURCE_STATES)],
    allowed_actions: allowedActions,
    actionability: {
      schema_version: 1,
      ...profile,
      action_transitions: Object.fromEntries(allowedActions.map((action) => [action, actionTransition(action)])),
    },
  };
}

export const HUMAN_INPUT_COORDINATION_REVIEW_TYPES = Object.freeze([
  "clarification",
  "failure_threshold_exhausted",
  "fix_chain_exhausted",
  PLANNER_CLARIFICATION_REVIEW_TYPE,
  ENVIRONMENT_SETUP_REVIEW_TYPE,
  "file_scope_approval",
  DIRTY_WORKTREE_RECOVERY_REVIEW_TYPE,
  "partial_work_recovery",
  "blocked_recovery",
  "dead_letter_recovery",
  "stall_exhausted_recovery",
  "artifact_routing_admin",
  "shared_trunk_publication_unprovable",
  "shared_trunk_fast_forward_blocked",
  "shared_trunk_push_refused",
  "shared_trunk_push_remote_error",
  "shared_trunk_provenance",
  POST_MERGE_DB_TASK_REVIEW_TYPE,
  MERGE_FAILURE_RECOVERY_REVIEW_TYPE,
  ...WORK_ITEM_DISPOSITION_REVIEW_TYPES,
]);

const COORDINATION_REVIEW_TYPE_SET = readonlySet(HUMAN_INPUT_COORDINATION_REVIEW_TYPES);
export function normalizeHumanInputChoices(choices, { limit = 9 } = {}) {
  if (!Array.isArray(choices)) return [];
  const normalized = choices
    .map((choice) => String(choice || "").trim())
    .filter(Boolean)
    .filter((choice, index, all) => all.indexOf(choice) === index);
  return Number.isFinite(Number(limit))
    ? normalized.slice(0, Math.max(0, Number(limit)))
    : normalized;
}

export function humanInputChoicesForReviewType(reviewType) {
  const choices = HUMAN_GATE_ACTIONS[String(reviewType || "").trim()];
  return choices ? [...choices] : [];
}

// Creation, presentation and answer dispatch share this eligibility rule.
// An explicit narrower offer (e.g. after the target moved) cannot regain a
// waiver just because historical candidate evidence remains in the payload.
export function mergeFailureRecoveryChoices({ integrationGate = null, allowWaive = null, choices = null } = {}) {
  const canWaive = allowWaive !== false && !!integrationGate?.candidate_tree && !!integrationGate?.target_head
    && (!Array.isArray(choices) || choices.length === 0 || choices.includes("waive_tests"));
  return humanInputChoicesForReviewType(MERGE_FAILURE_RECOVERY_REVIEW_TYPE)
    .filter((choice) => choice !== "waive_tests" || canWaive);
}

// A work-item disposition gate may offer fewer than its review type's
// actions (a merge deferred on a canceled upstream cannot "wait"). Its
// persisted choices narrow that closed contract; they never widen it. A
// failure gate that recorded no acceptable job told the operator accept is
// unavailable; gates persisted before their choices said so too (wowiekowie
// 2026-10-01, gate #2252) still offered it, so the record narrows it as well.
function narrowedReviewChoices(payload, reviewChoices) {
  const reviewType = String(payload?.review_type || "").trim();
  const offered = normalizeHumanInputChoices(payload?.choices);
  if (["assessment_review", "assessment_evidence_missing", "assessment_transport_recovery", "assessment_retry_limit", "pipeline_head_recovery",
    "unexecuted_replan_recovery"].includes(reviewType)
    && offered.length > 0 && offered.every((action) => reviewChoices.includes(action))
    && offered.every((action, index) => index === 0 || reviewChoices.indexOf(action) > reviewChoices.indexOf(offered[index - 1]))) {
    return offered;
  }
  if (reviewType === MERGE_FAILURE_RECOVERY_REVIEW_TYPE) {
    return mergeFailureRecoveryChoices({
      integrationGate: payload?.merge_failure_recovery?.integration_gate,
      choices: offered,
    });
  }
  if (!WORK_ITEM_DISPOSITION_REVIEW_TYPES.includes(reviewType)) return reviewChoices;
  const acceptUnavailable = reviewType === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE
    && Array.isArray(payload?.acceptable_job_ids)
    && payload.acceptable_job_ids.length === 0;
  const narrowed = reviewChoices.filter((choice) => (
    offered.includes(choice) && !(acceptUnavailable && choice === "accept")
  ));
  if (narrowed.length > 0) return narrowed;
  return acceptUnavailable ? reviewChoices.filter((choice) => choice !== "accept") : reviewChoices;
}

export function humanInputChoicesForPayload(payload = {}) {
  // Known gates are closed contracts (HUMAN_GATE_ACTIONS). Persisted `choices`
  // from older jobs must not reintroduce an action that the resolver does not
  // handle. A gate whose only action is `respond` offers no choices: it takes
  // free text.
  const kind = humanGateNameForPayload(payload);
  if (kind === "one_shot_file_scope" && Array.isArray(payload.selector?.options)) {
    const choices = payload.selector.options.map((option) => option.value);
    if (choices.length >= 3 && choices.length <= 12 && new Set(choices).size === choices.length
      && choices.at(-2) === "plan" && choices.at(-1) === "cancel"
      && choices.slice(0, -2).every((value) => /^candidate:sha256:[0-9a-f]{64}$/.test(value))) return choices;
  }
  const reviewChoices = humanInputChoicesForReviewType(kind)
    .filter((choice) => choice !== "respond");
  if (reviewChoices.length > 0) return narrowedReviewChoices(payload, reviewChoices);

  const explicit = normalizeHumanInputChoices(payload.choices);
  if (explicit.length > 0) return explicit;
  if (Array.isArray(payload.file_requests) && payload.file_requests.length > 0) {
    return ["approve", "reject"];
  }
  return [];
}

/**
 * The review-diff policy of a gate whose answer is a verdict on code
 * ({ scope, requires_commit? }), or null for a prompt that judges no code.
 */
export function humanInputReviewDiffPolicyForPayload(payload = {}) {
  const policy = HUMAN_INPUT_REVIEW_DIFF_POLICIES[String(payload?.review_type || "").trim()];
  if (!policy) return null;
  if (policy.requires_choice && !humanInputChoicesForPayload(payload).includes(policy.requires_choice)) return null;
  return policy;
}

// A scope-only run override uses the existing gate resolver and audit trail.
// Only known file-scope gates qualify; unrelated reviews remain interactive.
export function scopeModeHumanInputAnswerForPayload(payload = {}, scopeMode = SCOPE_APPROVAL_MODES.DEFAULT) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (scopeMode !== SCOPE_APPROVAL_MODES.AUTO || payload.requires_interactive_approval === true) return null;
  if (payload.subtype) return null;
  const reviewType = String(payload.review_type || "").trim();
  if (reviewType === "file_scope_approval") return "approve";
  if (!reviewType && Array.isArray(payload.file_requests) && payload.file_requests.length > 0) return "approve";
  return null;
}

// An unattended policy may select only an action offered by this gate.
// With the default ask policy the gate remains open for the operator.
export function nonInteractiveHumanInputAnswerForPayload(payload = {}, policy = "ask") {
  if (payload.requires_interactive_approval === true || ["push_offer", "environment_setup"].includes(payload.subtype || payload.review_type)) return null;
  const action = String(policy).startsWith("auto:") ? policy.slice(5) : null;
  return action && humanInputChoicesForPayload(payload).includes(action) ? action : null;
}

export function isHumanInputCoordinationPayload(payload = {}) {
  if (
    payload?.subtype === ONESHOT_SCOPE_SELECTION_SUBTYPE
    || payload?.review_type === ONESHOT_SCOPE_SELECTION_SUBTYPE
  ) return true;
  return COORDINATION_REVIEW_TYPE_SET.has(String(payload?.review_type || ""));
}

export function isHumanInputReviewPayload(payload = {}) {
  if (!payload?.review_type || isHumanInputCoordinationPayload(payload)) return false;
  return true;
}

const HUMAN_INPUT_CHOICE_FEEDBACK_SEPARATOR = ":";

/**
 * The offered choice an answer selects: the choice id itself, or the id
 * followed by ":" and feedback ("pass: the frozen tests passed"). Nothing else
 * selects a choice; "yes", "looks good" or "do not approve" are human text and
 * select nothing, so the gate stays open and names its choices. Matching is
 * case-insensitive on the id only.
 */
export function humanInputChoiceFromAnswer(answer, choices = []) {
  const text = String(answer || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  const normalizedChoices = normalizeHumanInputChoices(choices, { limit: Number.POSITIVE_INFINITY });
  const exact = normalizedChoices.find((choice) => choice.toLowerCase() === lowered);
  if (exact) return exact;
  // The longest id first, so `retry:codex: ...` is not read as `retry`.
  for (const choice of [...normalizedChoices].sort((a, b) => b.length - a.length)) {
    if (lowered.startsWith(`${choice.toLowerCase()}${HUMAN_INPUT_CHOICE_FEEDBACK_SEPARATOR}`)) return choice;
  }
  return null;
}

/**
 * The feedback an answer carries beside its selected choice ("pass: the
 * frozen tests passed" → "the frozen tests passed"), or "" for a bare choice
 * or an answer that selects none.
 */
export function humanInputChoiceFeedback(answer, choices = []) {
  const text = String(answer || "").trim();
  const choice = humanInputChoiceFromAnswer(text, choices);
  if (!choice || text.toLowerCase() === choice.toLowerCase()) return "";
  return text.slice(choice.length + HUMAN_INPUT_CHOICE_FEEDBACK_SEPARATOR.length).trim();
}

export function exactHumanInputChoiceFromAnswer(answer, choices = []) {
  const text = String(answer || "").trim();
  if (!text) return null;
  return normalizeHumanInputChoices(choices, { limit: Number.POSITIVE_INFINITY })
    .find((choice) => choice === text) || null;
}
