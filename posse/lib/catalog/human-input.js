// Human-input action catalogue.
//
// `review_type` predates typed human-input gates, so some coordination and
// recovery prompts still carry that field even though they are not binary
// assessor reviews. Keep their action enums and bridge classification here so
// the TUI, bridge snapshots, and bridge answer validation cannot drift.

import { ONESHOT_SCOPE_SELECTION_SUBTYPE } from "./job.js";

const freezeChoices = (choices) => Object.freeze([...choices]);

export const HUMAN_INPUT_ACTION_ENUMS = Object.freeze({
  scope_expansion_request: freezeChoices(["approve", "deny"]),
  partial_work_recovery: freezeChoices(["extend", "commit", "revert"]),
  blocked_recovery: freezeChoices(["retry", "skip", "replan", "pass", "fail"]),
  dead_letter_recovery: freezeChoices(["retry", "skip"]),
  research_dead_letter_recovery: freezeChoices(["retry", "skip"]),
  oneshot_dead_letter_recovery: freezeChoices(["retry", "skip"]),
  stall_exhausted_recovery: freezeChoices(["retry", "skip"]),
  assessment: freezeChoices(["pass", "fail", "skip", "replan"]),
  needs_review: freezeChoices(["pass", "fail", "skip", "replan"]),
  assessment_parse_error: freezeChoices(["pass", "fail", "skip", "replan"]),
  unknown_verdict: freezeChoices(["pass", "fail", "skip", "replan"]),
  assessment_transport_error: freezeChoices(["retry", "pass", "fail", "skip", "replan"]),
  assessment_retry_limit: freezeChoices(["pass", "fail", "skip", "replan"]),
  replan_limit: freezeChoices(["replan", "pass", "fail", "skip"]),
  artifact_routing_admin: freezeChoices(["acknowledge"]),
});

export const HUMAN_INPUT_COORDINATION_REVIEW_TYPES = Object.freeze([
  "scope_expansion_request",
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
