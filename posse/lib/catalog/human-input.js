// Human-input action catalogue.
//
// `review_type` predates typed human-input gates, so some coordination and
// recovery prompts still carry that field even though they are not binary
// assessor reviews. Keep their action enums and bridge classification here so
// the TUI, bridge snapshots, and bridge answer validation cannot drift.

import {
  FAILED_JOB_STATUSES,
  JOB_STATUSES,
  ONESHOT_SCOPE_SELECTION_SUBTYPE,
} from "./job.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "./native-tools.js";

const freezeChoices = (choices) => Object.freeze([...choices]);
export const HUMAN_INPUT_BEST_JUDGMENT_ANSWER = "Continue with best judgment using the available evidence and explicit assumptions.";
// A gate without choices (a clarification) takes a free-text answer. One
// answered from outside the run that holds it is reserved for that run's
// prompt under this choice id, with the text alongside; the text is bounded.
export const HUMAN_INPUT_FREE_TEXT_CHOICE_ID = "free_text";
export const HUMAN_INPUT_FREE_TEXT_MAX_CHARS = 8000;
export const HUMAN_GATE_STATES = Object.freeze(["open", "resolving", "resolved", "superseded"]);
export const HUMAN_GATE_RECONCILE_REASONS = Object.freeze({
  CLOSED_CONTRACT_JOB: "closed_contract_job",
  TERMINAL_WORK_ITEM: "terminal_work_item",
  SOURCE_STATE_CHANGED: "source_state_changed",
  MISSING_ORIGINAL: "missing_original",
  REGISTERED_LEGACY: "registered_legacy",
  DUPLICATE_LEGACY: "duplicate_legacy",
  INVALID_LEGACY_CONTRACT: "invalid_legacy_contract",
  ORPHANED_GATE: "orphaned_gate",
  FAILED_RESOLUTION: "failed_resolution",
  ABANDONED_RESOLVER: "abandoned_resolver",
  TERMINAL_GATE_JOB: "terminal_gate_job",
});
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

// Recovery gates whose "retry" (canonical retry_with_changes, with or
// without operator guidance) re-runs the failed or blocked work through the
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
export const MERGE_RELEASING_RETRY_REVIEW_TYPES = Object.freeze([
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
  "blocked_recovery",
  "dead_letter_recovery",
  "research_dead_letter_recovery",
  "oneshot_dead_letter_recovery",
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
const ATTEMPT_REVIEW_DIFF = Object.freeze({ scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.ATTEMPT });
// A dead letter is a recovery choice; it judges code only when the job
// committed some before it died.
const COMMITTED_ATTEMPT_REVIEW_DIFF = Object.freeze({
  scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.ATTEMPT,
  requires_commit: true,
});
const WORK_ITEM_REVIEW_DIFF = Object.freeze({ scope: HUMAN_INPUT_REVIEW_DIFF_SCOPES.WORK_ITEM });
const HUMAN_INPUT_REVIEW_DIFF_POLICIES = Object.freeze({
  assessment: ATTEMPT_REVIEW_DIFF,
  needs_review: ATTEMPT_REVIEW_DIFF,
  assessment_parse_error: ATTEMPT_REVIEW_DIFF,
  assessment_evidence_missing: ATTEMPT_REVIEW_DIFF,
  unknown_verdict: ATTEMPT_REVIEW_DIFF,
  assessment_transport_error: ATTEMPT_REVIEW_DIFF,
  assessment_retry_limit: ATTEMPT_REVIEW_DIFF,
  replan_limit: ATTEMPT_REVIEW_DIFF,
  blocked_recovery: ATTEMPT_REVIEW_DIFF,
  dead_letter_recovery: COMMITTED_ATTEMPT_REVIEW_DIFF,
  oneshot_dead_letter_recovery: COMMITTED_ATTEMPT_REVIEW_DIFF,
  stall_exhausted_recovery: COMMITTED_ATTEMPT_REVIEW_DIFF,
  partial_work_recovery: WORK_ITEM_REVIEW_DIFF,
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

export const HUMAN_INPUT_ACTION_ENUMS = Object.freeze({
  scope_expansion_request: freezeChoices(["approve", "deny"]),
  scope_expansion_required: freezeChoices(["approve", "reject"]),
  partial_work_recovery: freezeChoices(["extend", "commit", "revert"]),
  blocked_recovery: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.blocked_recovery),
  dead_letter_recovery: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery),
  research_dead_letter_recovery: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery),
  oneshot_dead_letter_recovery: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery),
  stall_exhausted_recovery: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery),
  assessment: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  needs_review: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  assessment_parse_error: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  assessment_evidence_missing: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  unknown_verdict: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  assessment_transport_error: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  assessment_retry_limit: freezeChoices(["retry_assessment", "pass", "fail", "explicit_waiver", "replan"]),
  replan_limit: freezeChoices(["replan", "pass", "fail", "explicit_waiver"]),
  unexecuted_replan_limit: freezeChoices(["replan", "fail", "explicit_waiver"]),
  artifact_routing_admin: freezeChoices(["acknowledge"]),
  shared_trunk_provenance: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.shared_trunk_provenance),
  [POST_MERGE_DB_TASK_REVIEW_TYPE]: freezeChoices(["run", "skip"]),
  [MERGE_VERIFICATION_REVIEW_TYPE]: freezeChoices(["pass", "fail"]),
  [MERGE_FAILURE_RECOVERY_REVIEW_TYPE]: freezeChoices(["merge", "send_back"]),
  [WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE]: freezeChoices(["retry", "accept", "abandon"]),
  [CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE]: freezeChoices(["wait", "rebuild", "abandon"]),
});

export const HUMAN_GATE_RECOVERY_KINDS = Object.freeze([
  "developer_blocked",
  "assessor_evidence_unavailable",
  "blocked_cycle_exhausted",
  "failure_threshold_exhausted",
  "fix_chain_exhausted",
  "assessment_transport_unavailable",
  "assessment_retry_exhausted",
  "dead_letter_recovery",
  "artifact_routing_unavailable",
  "scope_expansion_required",
]);

export const CANONICAL_HUMAN_GATE_ACTIONS = Object.freeze([
  "pass",
  "fail",
  "explicit_waiver",
  "retry_assessment",
  "retry_with_changes",
  "replan",
  "recheck",
]);

const HUMAN_GATE_CONTRACTS = Object.freeze({
  scope_expansion_request: {
    gate_kind: "scope_expansion_required",
    allowed_actions: ["approve", "deny", "reject"],
    allowed_source_states: ["running", "blocked", "waiting_on_human", "waiting_on_review", "succeeded"],
  },
  scope_expansion_required: {
    gate_kind: "scope_expansion_required",
    allowed_actions: ["approve", "reject", "deny"],
    allowed_source_states: ["failed", "blocked", "waiting_on_human", "waiting_on_review"],
  },
  partial_work_recovery: {
    gate_kind: "blocked_cycle_exhausted",
    allowed_actions: ["extend", "commit", "revert"],
    allowed_source_states: ["running", "blocked", "waiting_on_human"],
  },
  blocked_recovery: {
    gate_kind: "developer_blocked",
    allowed_actions: [...WORK_ITEM_QUESTION_CHOICE_IDS.blocked_recovery],
    allowed_source_states: ["blocked", "waiting_on_human", "waiting_on_review", ...FAILED_JOB_STATUSES],
  },
  dead_letter_recovery: {
    gate_kind: "dead_letter_recovery",
    allowed_actions: [...WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery],
    allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"],
  },
  failure_threshold_exhausted: {
    unresolved_fact: "Which authorized disposition should follow repeated pipeline failure.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Automatic retry and replan limits are exhausted.",
  },
  blocked_cycle_exhausted: {
    unresolved_fact: "Whether partial blocked work should receive more budget, be preserved, or be discarded.",
    human_contribution: "recovery_choice",
    headless_behavior: "preserve_and_fail_closed",
    diagnostic_insufficient_reason: "The available actions intentionally produce different durable outcomes.",
  },
  research_dead_letter_recovery: {
    gate_kind: "dead_letter_recovery",
    allowed_actions: [...WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery],
    allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"],
  },
  oneshot_dead_letter_recovery: {
    gate_kind: "dead_letter_recovery",
    allowed_actions: [...WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery],
    allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"],
  },
  stall_exhausted_recovery: {
    gate_kind: "failure_threshold_exhausted",
    allowed_actions: [...WORK_ITEM_QUESTION_CHOICE_IDS.dead_letter_recovery],
    allowed_source_states: [...FAILED_JOB_STATUSES, "blocked", "waiting_on_human"],
  },
  assessment_transport_error: {
    gate_kind: "assessment_transport_unavailable",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
  assessment_retry_limit: {
    gate_kind: "assessment_retry_exhausted",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
  assessment_parse_error: {
    gate_kind: "assessment_review",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
  assessment_evidence_missing: {
    gate_kind: "assessor_evidence_unavailable",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
  unknown_verdict: {
    gate_kind: "assessment_review",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
  needs_review: {
    gate_kind: "assessment_review",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
  replan_limit: {
    gate_kind: "fix_chain_exhausted",
    allowed_actions: ["replan", "pass", "fail", "explicit_waiver"],
    allowed_source_states: ["waiting_on_review", "waiting_on_human", ...FAILED_JOB_STATUSES],
  },
  unexecuted_replan_limit: {
    gate_kind: "fix_chain_exhausted",
    allowed_actions: ["replan", "fail", "explicit_waiver"],
    allowed_source_states: ["waiting_on_review", "waiting_on_human", ...FAILED_JOB_STATUSES],
  },
  artifact_routing_admin: {
    gate_kind: "artifact_routing_unavailable",
    allowed_actions: ["acknowledge"],
    allowed_source_states: ["waiting_on_review", "waiting_on_human", ...FAILED_JOB_STATUSES],
  },
  shared_trunk_provenance: {
    gate_kind: "repository_recovery",
    allowed_actions: [...WORK_ITEM_QUESTION_CHOICE_IDS.shared_trunk_provenance],
    allowed_source_states: ["waiting_on_human", "succeeded"],
  },
  [POST_MERGE_DB_TASK_REVIEW_TYPE]: {
    gate_kind: POST_MERGE_DB_TASK_REVIEW_TYPE,
    allowed_actions: ["run", "skip"],
    allowed_source_states: ["waiting_on_human"],
  },
  [MERGE_VERIFICATION_REVIEW_TYPE]: {
    gate_kind: MERGE_VERIFICATION_REVIEW_TYPE,
    allowed_actions: ["pass", "fail"],
    allowed_source_states: ["succeeded"],
  },
  [MERGE_FAILURE_RECOVERY_REVIEW_TYPE]: {
    gate_kind: MERGE_FAILURE_RECOVERY_REVIEW_TYPE,
    allowed_actions: ["merge", "send_back"],
    allowed_source_states: ["succeeded"],
  },
  [WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE]: {
    gate_kind: WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
    allowed_actions: ["retry", "accept", "abandon"],
    allowed_source_states: ["waiting_on_human"],
  },
  [CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE]: {
    gate_kind: CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
    allowed_actions: ["wait", "rebuild", "abandon"],
    allowed_source_states: ["waiting_on_human"],
  },
  assessment: {
    gate_kind: "assessment_review",
    allowed_actions: ["retry_assessment", "pass", "fail", "explicit_waiver", "replan"],
    allowed_source_states: ["awaiting_assessment", "waiting_on_review", "waiting_on_human", "succeeded"],
  },
});

const HUMAN_GATE_ACTION_ALIASES = Object.freeze({
  retry: "retry_with_changes",
  skip: "explicit_waiver",
});

const HUMAN_GATE_ACTIONABILITY_PROFILES = Object.freeze({
  scope_expansion_request: {
    unresolved_fact: "Whether the work item may mutate files outside its current scope.",
    human_contribution: "authority",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Only the operator can grant additional mutation authority.",
  },
  scope_expansion_required: {
    unresolved_fact: "Whether the required out-of-scope files may be added to mutation authority.",
    human_contribution: "authority",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Repository evidence cannot expand the operator-approved scope.",
  },
  partial_work_recovery: {
    unresolved_fact: "Whether partial work should receive more budget, be preserved, or be discarded.",
    human_contribution: "recovery_choice",
    headless_behavior: "preserve_and_fail_closed",
    diagnostic_insufficient_reason: "Each action intentionally changes ownership or preservation state.",
  },
  blocked_recovery: {
    unresolved_fact: "Which authorized recovery path should own an exhausted blocked job.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Retry, replan, waiver, and failure have materially different state transitions.",
  },
  dead_letter_recovery: {
    unresolved_fact: "Whether terminal work should be retried through a selected provider, waived, or failed.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Recovering terminal work spends authority and execution budget.",
  },
  assessment_review: {
    unresolved_fact: "Whether available evidence justifies acceptance, rejection, waiver, or another assessment.",
    human_contribution: "semantic_judgment",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "The bounded automatic assessment path has already exhausted its evidence or judgment budget.",
  },
  assessor_evidence_unavailable: {
    unresolved_fact: "Whether to retry evidence acquisition, reject, replan, or explicitly waive missing evidence.",
    human_contribution: "authority",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Only an explicit waiver may substitute for required evidence.",
  },
  assessment_transport_unavailable: {
    unresolved_fact: "Whether to authorize another assessment attempt or choose a terminal disposition.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "Automatic assessment transport retries are exhausted.",
  },
  assessment_retry_exhausted: {
    unresolved_fact: "Whether to spend more assessment budget, replan, reject, or explicitly waive verification.",
    human_contribution: "authority",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "The configured automatic assessment budget is exhausted.",
  },
  fix_chain_exhausted: {
    unresolved_fact: "Whether to authorize a new strategy, reject the work, or waive the remaining defect.",
    human_contribution: "authority",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "The configured automatic repair strategy budget is exhausted.",
  },
  developer_blocked: {
    unresolved_fact: "Which authorized recovery path should follow the developer block.",
    human_contribution: "recovery_choice",
    headless_behavior: "fail_closed",
    diagnostic_insufficient_reason: "The available recovery choices spend different authority and budget.",
  },
  clarification: {
    unresolved_fact: "A task requirement cannot be derived from repository and work-item evidence.",
    human_contribution: "ambiguity_resolution",
    headless_behavior: "continue_with_best_judgment",
    diagnostic_insufficient_reason: "Continuing without an answer requires an explicit best-judgment assumption.",
  },
  plan_approval: {
    unresolved_fact: "Whether the proposed implementation plan is authorized to execute.",
    human_contribution: "authority",
    headless_behavior: "use_configured_plan_approval_policy",
    diagnostic_insufficient_reason: "Plan approval grants execution authority rather than supplying a discoverable fact.",
  },
  [POST_MERGE_DB_TASK_REVIEW_TYPE]: {
    unresolved_fact: "Whether the merged change is deployed, so its deferred task may write the project database.",
    human_contribution: "authority",
    headless_behavior: "do_not_run",
    diagnostic_insufficient_reason: "Posse cannot observe when the operator deploys the merged change.",
  },
  [MERGE_FAILURE_RECOVERY_REVIEW_TYPE]: {
    unresolved_fact: "Whether the repository condition that stopped the merge is resolved, so the work item can merge now, or the work must go back for rework.",
    human_contribution: "recovery_choice",
    headless_behavior: "do_not_merge",
    diagnostic_insufficient_reason: "Git refused the merge; only the operator can resolve the conflict or repository condition behind it.",
  },
  [MERGE_VERIFICATION_REVIEW_TYPE]: {
    unresolved_fact: "Whether work whose planned verification could not run may merge on review alone.",
    human_contribution: "authority",
    headless_behavior: "do_not_merge",
    diagnostic_insufficient_reason: "The planned test already failed before the change, so no executed check shows the risky change works.",
  },
  [WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE]: {
    unresolved_fact: "Whether a failed work item's branch should be retried, accepted despite assessment-only failures, or abandoned.",
    human_contribution: "recovery_choice",
    headless_behavior: "leave_parked",
    diagnostic_insufficient_reason: "Each choice spends execution budget, overrides an assessor verdict, or discards committed work.",
  },
  [CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE]: {
    unresolved_fact: "Whether a completed work item should wait for its failed upstream, be rebuilt without the inherited edits, or be abandoned.",
    human_contribution: "recovery_choice",
    headless_behavior: "leave_parked",
    diagnostic_insufficient_reason: "Only the operator knows whether the failed upstream work item will be recovered.",
  },
  push_offer: {
    unresolved_fact: "Whether committed work may be pushed to the configured remote.",
    human_contribution: "merge_push_choice",
    headless_behavior: "do_not_push",
    diagnostic_insufficient_reason: "Remote publication requires an explicit operator choice.",
  },
  oneshot_scope_selection: {
    unresolved_fact: "Which candidate file or scope the one-shot request intends to modify.",
    human_contribution: "ambiguity_resolution",
    headless_behavior: "use_deterministic_best_scope_or_fail_closed",
    diagnostic_insufficient_reason: "Multiple plausible mutation scopes remain after automatic inference.",
  },
});

function actionTransition(action) {
  const canonical = canonicalHumanGateAction(action);
  const transitions = {
    approve: "grant_scope_and_resume",
    deny: "deny_scope_and_fail_request",
    reject: "reject_request",
    extend: "increase_budget_and_resume",
    commit: "preserve_partial_work_and_assess",
    revert: "discard_partial_work_and_dead_letter",
    retry_assessment: "queue_new_assessment_attempt",
    retry_with_changes: "queue_recovery_attempt",
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

function gateSource(payload = {}) {
  if (payload?.subtype === "plan_approval") return "plan_approval";
  if (payload?.subtype === "push_offer") return "push_offer";
  if (
    payload?.subtype === ONESHOT_SCOPE_SELECTION_SUBTYPE
    || payload?.review_type === ONESHOT_SCOPE_SELECTION_SUBTYPE
  ) return ONESHOT_SCOPE_SELECTION_SUBTYPE;
  const reviewType = String(payload?.review_type || "").trim();
  if (HUMAN_GATE_CONTRACTS[reviewType]) return reviewType;
  if (Array.isArray(payload?.file_requests) && payload.file_requests.length > 0) {
    return "scope_expansion_request";
  }
  return String(payload?.gate_kind || payload?.review_type || "clarification");
}

export function canonicalHumanGateAction(action) {
  const normalized = String(action || "").trim();
  return HUMAN_GATE_ACTION_ALIASES[normalized] || normalized || null;
}

export function humanGateContractForPayload(payload = {}, {
  parentJobId = null,
} = {}) {
  const source = gateSource(payload);
  const registered = HUMAN_GATE_CONTRACTS[source];
  const explicitChoices = humanInputChoicesForPayload(payload);
  const originalJobId = Number(
    payload?.original_job_id
    ?? payload?.plan_job_id
    ?? parentJobId
  );
  const fallbackActions = explicitChoices.length > 0 ? explicitChoices : ["respond"];
  // review_type selects the action/source-state contract, while an explicit
  // gate_kind identifies the concrete recovery condition for deduplication.
  // Conflating them made fix-chain and failure-threshold gates look like a
  // generic developer block and could reuse an unrelated open prompt.
  const explicitGateKind = String(payload?.gate_kind || "").trim();
  const gateKind = explicitGateKind || registered?.gate_kind || source;
  const registeredActions = registered?.allowed_actions
    ? narrowedReviewChoices(payload, [...registered.allowed_actions])
    : null;
  const allowedActions = [...new Set(registeredActions || fallbackActions)];
  const profile = HUMAN_GATE_ACTIONABILITY_PROFILES[gateKind]
    || HUMAN_GATE_ACTIONABILITY_PROFILES[source]
    || HUMAN_GATE_ACTIONABILITY_PROFILES.clarification;
  return {
    gate_kind: gateKind,
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
  "scope_expansion_request",
  "scope_expansion_required",
  "partial_work_recovery",
  "blocked_recovery",
  "dead_letter_recovery",
  "research_dead_letter_recovery",
  "oneshot_dead_letter_recovery",
  "stall_exhausted_recovery",
  "artifact_routing_admin",
  "shared_trunk_provenance",
  POST_MERGE_DB_TASK_REVIEW_TYPE,
  MERGE_FAILURE_RECOVERY_REVIEW_TYPE,
  ...WORK_ITEM_DISPOSITION_REVIEW_TYPES,
]);

const COORDINATION_REVIEW_TYPE_SET = new Set(HUMAN_INPUT_COORDINATION_REVIEW_TYPES);
const HUMAN_INPUT_CHOICE_ALIASES = Object.freeze({
  approve: /\b(approve|approved|yes|allow|allowed|ok|okay|proceed|ship)\b/i,
  deny: /\b(deny|denied|reject|rejected|no|decline|declined|cancel|canceled|cancelled|block|blocked)\b/i,
  reject: /\b(reject|rejected|deny|denied|no|decline|declined|cancel|canceled|cancelled|block|blocked)\b/i,
  retry: /\b(retry|rertry|re-try|rerun|re-run|reassess|re-assess|try again|run again|replan|re-plan|simplify|split|narrow)\b/i,
  skip: /\b(skip|skipped|unblock|ignore|bypass|cancel|canceled|cancelled)\b/i,
  retry_assessment: /\b(retry|rertry|re-try|rerun|re-run|reassess|re-assess|try again|run again)\b/i,
  retry_with_changes: /\b(retry|rertry|re-try|rerun|re-run|try again|run again|simplify|split|narrow|claude|anthropic|openai|codex|grok)\b/i,
  explicit_waiver: /\b(skip|skipped|waive|waiver|unblock|ignore|bypass|cancel|canceled|cancelled)\b/i,
  replan: /\b(replan|re-plan|split|narrow|change plan)\b/i,
  pass: /\b(pass|passed|approve|approved|accept|accepted|mark done|succeed|succeeded)\b/i,
  fail: /\b(fail|failed|reject|rejected|dead[- ]?letter|deadletter|abandon|stop)\b/i,
  extend: /\b(extend|resume|continue|more turns?|larger turn|increase turn)\b/i,
  commit: /\b(commit|assess|assessment|keep|preserve|save)\b/i,
  revert: /\b(revert|discard|drop|dead[- ]?letter|deadletter|abandon|kill)\b/i,
  acknowledge: /\b(acknowledge|acknowledged|understood|noted|ok|okay)\b/i,
  merge: /\b(merge|merge now|retry merge|retry the merge)\b/i,
  send_back: /\b(send[ _-]?back|rework|return it)\b/i,
});

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
  const choices = HUMAN_INPUT_ACTION_ENUMS[String(reviewType || "").trim()];
  return choices ? [...choices] : [];
}

// A work-item disposition gate may offer fewer than its review type's
// actions (a merge deferred on a canceled upstream cannot "wait"). Its
// persisted choices narrow that closed contract; they never widen it. A
// failure gate that recorded no acceptable job told the operator accept is
// unavailable; gates persisted before their choices said so too (wowiekowie
// 2026-10-01, gate #2252) still offered it, so the record narrows it as well.
function narrowedReviewChoices(payload, reviewChoices) {
  const reviewType = String(payload?.review_type || "").trim();
  if (!WORK_ITEM_DISPOSITION_REVIEW_TYPES.includes(reviewType)) return reviewChoices;
  const offered = normalizeHumanInputChoices(payload?.choices);
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
  // Known review types are closed contracts. Persisted `choices` from older
  // jobs must not reintroduce an action that the resolver does not handle.
  const reviewChoices = humanInputChoicesForReviewType(payload.review_type);
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

const NON_INTERACTIVE_REVIEW_ACTIONS = Object.freeze({
  scope_expansion_request: "approve",
  scope_expansion_required: "approve",
  partial_work_recovery: "commit",
  blocked_recovery: "fail",
  assessment: "fail",
  needs_review: "fail",
  assessment_parse_error: "fail",
  assessment_evidence_missing: "fail",
  unknown_verdict: "fail",
  assessment_transport_error: "fail",
  assessment_retry_limit: "fail",
  replan_limit: "fail",
  unexecuted_replan_limit: "fail",
  artifact_routing_admin: "acknowledge",
});

// A scope-only run override uses the existing gate resolver and audit trail.
// Only known file-scope gates qualify; unrelated reviews remain interactive.
export function scopeModeHumanInputAnswerForPayload(payload = {}, scopeMode = SCOPE_APPROVAL_MODES.DEFAULT) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (scopeMode !== SCOPE_APPROVAL_MODES.AUTO || payload.requires_interactive_approval === true) return null;
  if (payload.subtype) return null;
  const reviewType = String(payload.review_type || "").trim();
  if (["scope_expansion_request", "scope_expansion_required"].includes(reviewType)) return "approve";
  if (!reviewType && Array.isArray(payload.file_requests) && payload.file_requests.length > 0) return "approve";
  return null;
}

/**
 * Return the bounded action a production non-interactive run may take without
 * inventing human judgment. Approval gates proceed, partial work is preserved
 * for assessment, and assessment/capability reviews fail closed. Recovery
 * contracts whose only escape is an explicit waiver remain human-owned.
 */
export function nonInteractiveHumanInputAnswerForPayload(payload = {}) {
  if (payload.subtype === "push_offer" || payload.subtype === "plan_approval") return null;
  if (
    payload.subtype === ONESHOT_SCOPE_SELECTION_SUBTYPE
    || payload.review_type === ONESHOT_SCOPE_SELECTION_SUBTYPE
  ) return "plan";

  const reviewType = String(payload.review_type || "").trim();
  const reviewAction = NON_INTERACTIVE_REVIEW_ACTIONS[reviewType];
  if (reviewAction) return reviewAction;

  if (
    Array.isArray(payload.file_requests)
    && payload.file_requests.length > 0
    && reviewType !== "blocked_recovery"
  ) return "approve";

  // Unknown closed-choice contracts are deliberately not guessed. Generic
  // clarification prompts can safely resume the agent with an explicit
  // best-judgment instruction because no privileged action is selected.
  if (humanInputChoicesForPayload(payload).length > 0 || reviewType) return null;
  return HUMAN_INPUT_BEST_JUDGMENT_ANSWER;
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

export function humanInputChoiceFromAnswer(answer, choices = []) {
  const text = String(answer || "").trim().toLowerCase();
  if (!text) return null;
  const normalizedChoices = normalizeHumanInputChoices(choices, { limit: Number.POSITIVE_INFINITY });
  if (/\b(?:no|not|never|don't|dont|cannot|can't|won't)\b[\s\S]{0,20}\b(?:pass|passed|approve|approved|accept|accepted|allow|allowed|mark done|succeed|succeeded)\b/.test(text)) {
    // A negated approval can accompany an explicit recovery action. Parse
    // that action without letting the negated word match an approval alias.
    for (const recoveryMatch of text.matchAll(/\b(?:retry(?::[a-z0-9_-]+)?|skip)\b/g)) {
      if (/\b(?:no|not|never|don't|dont|cannot|can't|won't)\s+$/.test(text.slice(0, recoveryMatch.index))) continue;
      const explicitRecovery = normalizedChoices.find(choice => choice.toLowerCase() === recoveryMatch[0]);
      if (explicitRecovery) return explicitRecovery;
    }
    return normalizedChoices.find((choice) => ["fail", "deny", "reject"].includes(choice.toLowerCase())) || null;
  }
  // Resolve an exact provider-qualified choice before testing decorated
  // prefixes. Otherwise the earlier `retry` entry captures `retry:claude`
  // and the durable resolution loses the operator's selected route.
  const exact = normalizedChoices.find((choice) => choice.toLowerCase() === text);
  if (exact) return exact;
  for (const choice of normalizedChoices) {
    const normalizedChoice = choice.toLowerCase();
    if (
      text.startsWith(`${normalizedChoice}:`)
      || text.startsWith(`${normalizedChoice} -`)
      || text.startsWith(`${normalizedChoice} —`)
    ) return choice;
  }
  for (const choice of normalizedChoices) {
    if (HUMAN_INPUT_CHOICE_ALIASES[choice.toLowerCase()]?.test(text)) return choice;
  }
  return null;
}

export function exactHumanInputChoiceFromAnswer(answer, choices = []) {
  const text = String(answer || "").trim();
  if (!text) return null;
  return normalizeHumanInputChoices(choices, { limit: Number.POSITIVE_INFINITY })
    .find((choice) => choice === text) || null;
}
