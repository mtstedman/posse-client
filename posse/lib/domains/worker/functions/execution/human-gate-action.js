// lib/domains/worker/functions/execution/human-gate-action.js
//
// The action a human answer selects for a gate, read from the gate's contract
// (HUMAN_GATE_ACTIONS) rather than from the words in the answer. A gate that
// takes only text (a clarification, a one-shot scope selector) resolves as
// `respond` and keeps its text whole; a closed-choice gate resolves to one of
// its offered choices, either the typed selection an input surface already
// validated and carried in the answer metadata (`selected_action`) or the
// choice the answer names exactly ("pass", or "pass: feedback"). Nothing here
// reads a verdict out of prose: magic-scan gate #476 (2026-10-28) answered its
// clarification "yes" and a generic review classifier turned that into
// `pass`, which the gate contract (allowed: respond) rejected, re-asked, and
// rejected again. A typed "yes" is a human response, and is classed as one.

import {
  exactHumanInputChoiceFromAnswer,
  humanInputChoiceFromAnswer,
  humanInputChoicesForPayload,
  isHumanInputReviewPayload,
} from "../../../../catalog/human-input.js";
import { extractLatestActionableHumanAnswerText } from "./human-review.js";

export const HUMAN_GATE_TEXT_ACTION = "respond";

/** The blocked-recovery transition a resolved gate action names. */
export function blockedRecoveryDecisionForAction(action) {
  switch (String(action || "")) {
    case "retry":
      return "retry";
    case "explicit_waiver":
      return "waive";
    case "replan":
    case "skip":
    case "fail":
    case "pass":
      return action;
    default:
      return "unknown";
  }
}

/**
 * The selection an input surface validated and carried with the answer
 * (Display.deliverQuestionAnswer, the TUI's numbered choice, the bridge's
 * resolved CLI action), or null for a typed-free answer. The latest entry
 * that carries one wins, as the latest answer text does.
 */
export function typedHumanAnswerAction(answers) {
  if (!Array.isArray(answers)) return null;
  for (let index = answers.length - 1; index >= 0; index--) {
    const metadata = answers[index]?.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    const typed = String(metadata.selected_action ?? "").trim();
    if (typed) return typed;
  }
  return null;
}

function offered(choices) {
  return choices.length > 0 ? choices.join(", ") : HUMAN_GATE_TEXT_ACTION;
}

/**
 * Resolve the action a collected answer selects for `payload`'s gate.
 *
 * - A gate without choices that is not a review (a clarification, a
 *   coordination prompt) resolves as `respond`; its text is never scanned.
 * - A review gate without a catalogued choice list cannot be resolved from
 *   prose; it stays unresolved with a diagnostic naming the contract.
 * - A closed gate resolves to the typed selection when one was carried, after
 *   checking it is offered and does not contradict an exact answer text; else
 *   to the offered choice the text names exactly, bare or with ":" feedback.
 *
 * The result is a choice in the gate's own vocabulary; the durable gate
 * contract still validates it when the resolution is claimed. Messages never
 * include the answer text.
 * @returns {{ ok: true, action: string, choices: string[], typed: boolean }
 *   | { ok: false, reason: string, message: string, choices: string[] }}
 */
export function resolveHumanGateAction({ payload = {}, answers = [] } = {}) {
  const choices = humanInputChoicesForPayload(payload);
  const text = extractLatestActionableHumanAnswerText(answers);
  const typed = typedHumanAnswerAction(answers);
  const kind = String(payload?.gate_kind || payload?.review_type || payload?.subtype || "clarification");
  const notOffered = (action) => ({
    ok: false,
    reason: "typed_action_not_offered",
    choices,
    message: `Human input selected action "${action}", which gate kind ${kind} does not offer (allowed: ${offered(choices)})`,
  });

  if (choices.length === 0) {
    if (isHumanInputReviewPayload(payload)) {
      return {
        ok: false,
        reason: "review_contract_unknown",
        choices,
        message: `Human input for review type ${String(payload.review_type)} has no catalogued action list; a verdict cannot be read from prose`,
      };
    }
    if (typed && typed !== HUMAN_GATE_TEXT_ACTION) return notOffered(typed);
    return { ok: true, action: HUMAN_GATE_TEXT_ACTION, choices, typed: typed != null };
  }

  if (typed) {
    if (!choices.includes(typed)) return notOffered(typed);
    const exact = exactHumanInputChoiceFromAnswer(text, choices);
    if (exact && exact !== typed) {
      return {
        ok: false,
        reason: "typed_action_mismatch",
        choices,
        message: `Human input selected action "${typed}" but its answer names a different offered action (allowed: ${offered(choices)})`,
      };
    }
    return { ok: true, action: typed, choices, typed: true };
  }

  const action = humanInputChoiceFromAnswer(text, choices);
  if (!action) {
    return {
      ok: false,
      reason: "choice_not_selected",
      choices,
      message: `Human input did not select one of: ${offered(choices)}`,
    };
  }
  return { ok: true, action, choices, typed: false };
}
