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
const DEFAULT_HUMAN_GATE_SOURCE_STATES = Object.freeze(
  JOB_STATUSES.filter((status) => !["leased", "awaiting_assessment", "canceled"].includes(status)),
);

export const HUMAN_INPUT_ACTION_ENUMS = Object.freeze({
  scope_expansion_request: freezeChoices(["approve", "deny"]),
  scope_expansion_required: freezeChoices(["approve", "reject"]),
  partial_work_recovery: freezeChoices(["extend", "commit", "revert"]),
  blocked_recovery: freezeChoices(WORK_ITEM_QUESTION_CHOICE_IDS.blocked_recovery),
  dead_letter_recovery: freezeChoices(["retry_with_changes", "explicit_waiver"]),
  research_dead_letter_recovery: freezeChoices(["retry_with_changes", "explicit_waiver"]),
  oneshot_dead_letter_recovery: freezeChoices(["retry_with_changes", "explicit_waiver"]),
  stall_exhausted_recovery: freezeChoices(["retry_with_changes", "explicit_waiver"]),
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
    allowed_actions: ["retry_with_changes", "explicit_waiver"],
    allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"],
  },
  research_dead_letter_recovery: {
    gate_kind: "dead_letter_recovery",
    allowed_actions: ["retry_with_changes", "explicit_waiver"],
    allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"],
  },
  oneshot_dead_letter_recovery: {
    gate_kind: "dead_letter_recovery",
    allowed_actions: ["retry_with_changes", "explicit_waiver"],
    allowed_source_states: [...FAILED_JOB_STATUSES, "waiting_on_human"],
  },
  stall_exhausted_recovery: {
    gate_kind: "failure_threshold_exhausted",
    allowed_actions: ["retry_with_changes", "explicit_waiver"],
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
  const gateKind = registered?.gate_kind || source;
  return {
    gate_kind: gateKind,
    contract_version: 1,
    original_job_id: Number.isInteger(originalJobId) && originalJobId > 0 ? originalJobId : null,
    allowed_source_states: [...(registered?.allowed_source_states || DEFAULT_HUMAN_GATE_SOURCE_STATES)],
    allowed_actions: [...new Set(registered?.allowed_actions || fallbackActions)],
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
]);

const COORDINATION_REVIEW_TYPE_SET = new Set(HUMAN_INPUT_COORDINATION_REVIEW_TYPES);
const HUMAN_INPUT_CHOICE_ALIASES = Object.freeze({
  approve: /\b(approve|approved|yes|allow|allowed|ok|okay|proceed|ship)\b/i,
  deny: /\b(deny|denied|reject|rejected|no|decline|declined|cancel|canceled|cancelled|block|blocked)\b/i,
  reject: /\b(reject|rejected|deny|denied|no|decline|declined|cancel|canceled|cancelled|block|blocked)\b/i,
  retry: /\b(retry|rertry|re-try|rerun|re-run|reassess|re-assess|try again|run again|replan|re-plan|simplify|split|narrow|claude|openai|codex|grok)\b/i,
  skip: /\b(skip|skipped|unblock|ignore|bypass|cancel|canceled|cancelled)\b/i,
  retry_assessment: /\b(retry|rertry|re-try|rerun|re-run|reassess|re-assess|try again|run again)\b/i,
  retry_with_changes: /\b(retry|rertry|re-try|rerun|re-run|try again|run again|simplify|split|narrow|claude|openai|codex|grok)\b/i,
  explicit_waiver: /\b(skip|skipped|waive|waiver|unblock|ignore|bypass|cancel|canceled|cancelled)\b/i,
  replan: /\b(replan|re-plan|split|narrow|change plan)\b/i,
  pass: /\b(pass|passed|approve|approved|accept|accepted|mark done|succeed|succeeded)\b/i,
  fail: /\b(fail|failed|reject|rejected|dead[- ]?letter|deadletter|abandon|stop)\b/i,
  extend: /\b(extend|resume|continue|more turns?|larger turn|increase turn)\b/i,
  commit: /\b(commit|assess|assessment|keep|preserve|save)\b/i,
  revert: /\b(revert|discard|drop|dead[- ]?letter|deadletter|abandon|kill)\b/i,
  acknowledge: /\b(acknowledge|acknowledged|understood|noted|ok|okay)\b/i,
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

export function humanInputChoicesForPayload(payload = {}) {
  // Known review types are closed contracts. Persisted `choices` from older
  // jobs must not reintroduce an action that the resolver does not handle.
  const reviewChoices = humanInputChoicesForReviewType(payload.review_type);
  if (reviewChoices.length > 0) return reviewChoices;

  const explicit = normalizeHumanInputChoices(payload.choices);
  if (explicit.length > 0) return explicit;
  if (Array.isArray(payload.file_requests) && payload.file_requests.length > 0) {
    return ["approve", "reject"];
  }
  return [];
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
  for (const choice of normalizedChoices) {
    const normalizedChoice = choice.toLowerCase();
    if (
      text === normalizedChoice
      || text.startsWith(`${normalizedChoice}:`)
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
