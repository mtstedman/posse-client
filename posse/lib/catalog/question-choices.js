// Shared validation of structured question vocabulary and conditional choices.
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "./tools/interaction.js";
import { LEGACY_REVIEW_CHOICE_IDS, validReviewChoiceIDs } from "./gate-actions.js";
import { MERGE_FAILURE_RECOVERY_REVIEW_TYPE, mergeFailureRecoveryChoices } from "./human-input.js";

const CHOICE_SET_POLICIES = Object.freeze({
  dead_letter_recovery: Object.freeze({ orderedSubset: true }),
  work_item_failure_disposition: Object.freeze({ orderedSubset: true }),
  cross_wi_upstream_disposition: Object.freeze({ orderedSubset: true }),
  [MERGE_FAILURE_RECOVERY_REVIEW_TYPE]: Object.freeze({ optional: Object.freeze(["waive_tests"]) }),
});

export function questionChoiceId(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return String(entry.choice_id ?? entry.value ?? entry.id ?? "").trim();
}

export function validQuestionChoiceEntries(kind, entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 32) return false;
  const ids = entries.map(questionChoiceId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
  if (kind === "one_shot_file_scope") {
    return ids.length >= 3 && ids.at(-2) === "plan" && ids.at(-1) === "cancel"
      && ids.slice(0, -2).every((id) => /^candidate:sha256:[0-9a-f]{64}$/.test(id));
  }
  const allowed = WORK_ITEM_QUESTION_CHOICE_IDS[kind] || [];
  if (Object.hasOwn(LEGACY_REVIEW_CHOICE_IDS, kind)) return validReviewChoiceIDs(kind, ids, allowed);
  const policy = CHOICE_SET_POLICIES[kind];
  if (policy?.orderedSubset || policy?.optional) {
    let previous = -1;
    const ordered = ids.every((id) => {
      const index = allowed.indexOf(id);
      if (index <= previous) return false;
      previous = index;
      return true;
    });
    return ordered && (policy.orderedSubset
      || allowed.every((id) => policy.optional.includes(id) || ids.includes(id)));
  }
  return ids.length === allowed.length && ids.every((id, index) => id === allowed[index]);
}

// Validate saved vocabulary before narrowing eligibility; malformed choices
// must not become valid merely by dropping unknown entries. Keep label data.
export function gateQuestionChoiceEntries(kind, payload) {
  const entries = payload?.choices;
  if (kind !== MERGE_FAILURE_RECOVERY_REVIEW_TYPE) return entries;
  if (Array.isArray(entries) && entries.length && !validQuestionChoiceEntries(kind, entries)) return entries;
  const eligible = mergeFailureRecoveryChoices({
    integrationGate: payload?.merge_failure_recovery?.integration_gate,
    choices: Array.isArray(entries) ? entries.map(questionChoiceId) : null,
  });
  return Array.isArray(entries) && entries.length
    ? entries.filter((entry) => eligible.includes(questionChoiceId(entry))) : eligible;
}
