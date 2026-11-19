// The answerable-question contract of one human_input gate, shared by the
// work-item feed (`gate:<job>:<n>` questions) and the agent conversation's
// gate entries so the two can never disagree about kind, choices, state,
// generation, or whether question.answer applies.
import { gateQuestionChoiceEntries, questionChoiceDanger, validQuestionChoiceEntries } from "../../../catalog/question-choices.js";
import { FAILED_JOB_STATUSES, OPEN_HUMAN_GATE_JOB_STATUSES, PENDING_HUMAN_GATE_JOB_STATUSES } from "../../../catalog/job.js";
import { humanGateNameForPayload } from "../../../catalog/human-input.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../catalog/native-tools.js";
import { QUESTION_CHOICE_DANGERS, QUESTION_INPUT_KINDS, QUESTION_UNAVAILABLE_REASONS } from "../../../catalog/agent-conversation.js";
import { jobHasLiveLeaseAt } from "../../queue/functions/lease-state.js";
import { exactText, parseJsonObject, safeText } from "./feed-text.js";

const FAILED_JOB_STATUS_SET = new Set(FAILED_JOB_STATUSES);
const QUESTION_CHOICE_IDS = WORK_ITEM_QUESTION_CHOICE_IDS;
export const LIVE_OWNER_DELIVERY_QUESTION_KINDS = new Set([
  "file_scope_approval", "assessment_review", "assessment_transport_recovery",
  "assessment_retry_limit", "blocked_recovery", "partial_work_recovery",
  "dead_letter_recovery", "pipeline_head_recovery", "unexecuted_replan_recovery",
  "artifact_routing_admin", "one_shot_file_scope",
]);

const QUESTION_CHOICE_COPY = Object.freeze({
  approve: ["Approve", "Allow the exact requested transition."],
  reject: ["Reject", "Reject the exact requested transition."],
  pass: ["Pass", "Accept the current work as passing."],
  fail: ["Fail", "Mark the current work as failed."],
  skip: ["Skip", "Skip this work and continue where policy permits."],
  replan: ["Replan", "Return the Work Item to its planning path."],
  retry: ["Retry", "Retry through the canonical owner transition."],
  send_back: ["Send back", "Return the implementation for repair and reassessment."],
  retry_assessment: ["Retry assessment", "Run assessment again on the current implementation."],
  explicit_waiver: ["Explicit waiver", "Accept the current work while recording that deterministic verification did not pass."],
  "retry:claude": ["Retry with Claude", "Retry through the Claude provider path."],
  "retry:anthropic": ["Retry with Anthropic API", "Retry through the direct Anthropic API provider path."],
  "retry:openai": ["Retry with OpenAI", "Retry through the OpenAI provider path."],
  "retry:codex": ["Retry with Codex", "Retry through the Codex provider path."],
  "retry:grok": ["Retry with Grok", "Retry through the Grok provider path."],
  extend: ["Extend", "Resume partial work with an extended turn budget."],
  commit: ["Commit", "Commit the bounded partial output for assessment."],
  revert: ["Revert", "Discard the bounded partial output."],
  plan: ["Use planned flow", "Create a plan instead of a one-shot edit."],
  cancel: ["Cancel request", "Stop without creating a continuation job."],
  push: ["Push", "Run the repository-aware canonical push gate."],
  decline: ["Decline", "Close this push offer without pushing."],
  accept: ["Accept", "Accept the work item outcome and continue."],
  abandon: ["Abandon", "Stop the affected work item without retrying it."],
  wait: ["Wait", "Keep the dependent work item waiting for its upstream work."],
  rebuild: ["Rebuild", "Rebuild the dependent work from the updated upstream state."],
});

function choiceIdFromEntry(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  return String(entry.choice_id ?? entry.value ?? entry.id ?? "").trim();
}

export function storedChoiceRecord(entry) {
  const choiceId = choiceIdFromEntry(entry);
  if (!choiceId) return null;
  const overrides = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const [defaultLabel, defaultConsequence] = QUESTION_CHOICE_COPY[choiceId]
    || [choiceId, "Run the exact owner transition."];
  const danger = overrides.danger || questionChoiceDanger(choiceId);
  return {
    choice_id: choiceId,
    label: safeText(overrides.label || defaultLabel, 160, { nullable: false }),
    consequence: safeText(overrides.consequence || overrides.description || defaultConsequence, 400, { nullable: false }),
    danger,
    requires_confirmation: overrides.requires_confirmation === true || danger === "destructive",
  };
}

export function validStoredChoiceEntries(kind, entries) {
  return validQuestionChoiceEntries(kind, entries);
}

export function storedQuestionKind(payload) {
  try { return humanGateNameForPayload(payload); } catch { return "legacy_unstructured"; }
}

export function storedQuestionChoices(kind, payload) {
  if (kind === "legacy_unstructured") return [];
  const entries = kind === "one_shot_file_scope"
    ? payload?.selector?.options
    : gateQuestionChoiceEntries(kind, payload);
  if ((!Array.isArray(entries) || entries.length === 0) && LIVE_OWNER_DELIVERY_QUESTION_KINDS.has(kind)) {
    return (QUESTION_CHOICE_IDS[kind] || []).map(storedChoiceRecord).filter(Boolean);
  }
  if (!validStoredChoiceEntries(kind, entries)) {

    return [];
  }
  return entries.map((entry) => storedChoiceRecord(entry)).filter(Boolean);
}

function questionStateForJob(job) {
  // History replay may observe a gate job before reconciliation has copied a
  // completed durable contract back onto the job row. Never turn that stale
  // row into a fresh actionable question.
  if (job?.human_gate_state === "resolved") return "answered";
  if (job?.human_gate_state === "superseded") return "rejected";
  if (job?.human_gate_state === "resolving") return "pending";
  if (OPEN_HUMAN_GATE_JOB_STATUSES.includes(job?.status)) return "open";
  if (PENDING_HUMAN_GATE_JOB_STATUSES.includes(job?.status)) return "pending";
  if (job?.status === "succeeded") return "answered";
  if (FAILED_JOB_STATUS_SET.has(job?.status)) return "rejected";
  return "closed";
}

export function observedQuestionStateForJob(job, observedAt = new Date().toISOString(), {
  allowLiveOwnerDelivery = false,
} = {}) {
  const state = questionStateForJob(job);
  if (state !== "open" || !jobHasLiveLeaseAt(job, observedAt)) return state;
  return allowLiveOwnerDelivery ? "open" : "pending";
}

export function storedQuestionAction(db, questionId) {
  try {
    return db.prepare(`
      SELECT * FROM agent_interactions
      WHERE kind = 'approval'
        AND json_extract(metadata_json, '$.work_item_action.action_kind') = 'question.answer'
        AND json_extract(metadata_json, '$.work_item_action.target.question_id') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(questionId) || null;
  } catch {
    return null;
  }
}

export function actionMetadata(row) {
  const action = parseJsonObject(row?.metadata_json).work_item_action;
  return action && typeof action === "object" && !Array.isArray(action) ? action : null;
}

export function sanitizeChoiceRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const choiceId = exactText(value.choice_id, 128);
  const label = safeText(value.label, 160, { nullable: false });
  const consequence = safeText(value.consequence, 400, { nullable: false });
  if (!choiceId || !label || !consequence || !QUESTION_CHOICE_DANGERS.includes(value.danger)
    || typeof value.requires_confirmation !== "boolean") return null;
  return {
    choice_id: choiceId,
    label,
    consequence,
    danger: value.danger,
    requires_confirmation: value.requires_confirmation,
  };
}

/** The question texts of a gate: a choice gate asks one joined question. */
export function gateQuestionTexts(job, payload, choices) {
  const rawQuestions = Array.isArray(payload.questions) && payload.questions.length > 0
    ? payload.questions
    : [payload.prompt || job.title || "Human input requested"];
  return choices.length > 0 && rawQuestions.length > 1
    ? [rawQuestions.join("\n\n")]
    : rawQuestions;
}

/**
 * Question `gate:<job>:<questionIndex>` of a human_input gate job. `job` is a
 * jobs row carrying `human_gate_state` and `human_gate_generation` from its
 * human_gates row. Returns null when the index is out of range.
 */
export function projectGateQuestionContract(db, job, { questionIndex = 0, observedAt = new Date().toISOString() } = {}) {
  const payload = parseJsonObject(job?.payload_json);
  const kind = storedQuestionKind(payload);
  const choices = storedQuestionChoices(kind, payload);
  const questions = gateQuestionTexts(job, payload, choices);
  if (!Number.isSafeInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) return null;
  const questionId = `gate:${job.id}:${questionIndex}`;
  const actionRow = storedQuestionAction(db, questionId);
  const action = actionMetadata(actionRow);
  let state = observedQuestionStateForJob(job, observedAt, {
    allowLiveOwnerDelivery: LIVE_OWNER_DELIVERY_QUESTION_KINDS.has(kind),
  });
  // An answer naming an earlier generation is refused as stale, so it is not
  // in flight for the gate's current one.
  const generation = String(job?.human_gate_generation ?? 1);
  const answersCurrent = String(action?.descriptor?.question_generation ?? generation) === generation;
  if (answersCurrent && ["reserved", "delivered"].includes(action?.state) && ["open", "pending"].includes(state)) {
    state = "pending";
  }
  const actionable = state === "open" && choices.length > 0 && kind !== "legacy_unstructured";
  return {
    question_id: questionId,
    kind,
    input_kind: choices.length > 0 ? QUESTION_INPUT_KINDS[0] : QUESTION_INPUT_KINDS[1],
    prompt_summary: safeText(questions[questionIndex], 2000, { nullable: false }),
    context_summary: safeText(payload.context || payload.prompt, 1000),
    question_count: questions.length,
    state,
    expires_at: payload.expires_at || null,
    // Always the gate's current generation (bug sweep 5 batch 3, U4): the
    // answer contract compares against it, and a stored answer's older
    // generation would make every inline answer stale.
    generation,
    choices,
    actionable,
    unavailable_reason: actionable || state !== "open" ? null : QUESTION_UNAVAILABLE_REASONS[0],
    action_row: actionRow,
    action,
  };
}
