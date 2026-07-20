// lib/domains/worker/functions/helpers/human-input.js
//
// Human-input handler for interactive questions surfaced through the display.
// Manages waiting state, timeout behavior, and abort-aware answer collection.

import { C } from "../../../../shared/format/functions/colors.js";
import { updateJobStatus } from "../../../queue/functions/index.js";
import { humanInputChoicesForPayload } from "../../../../catalog/human-input.js";

export const HUMAN_INPUT_BEST_JUDGMENT_ANSWER = "Continue with best judgment using the available evidence and explicit assumptions.";

const HARNESS_REVIEW_ANSWERS = Object.freeze({
  partial_work_recovery: "commit",
  blocked_recovery: "fail",
  dead_letter_recovery: "skip",
  research_dead_letter_recovery: "skip",
  oneshot_dead_letter_recovery: "skip",
  stall_exhausted_recovery: "skip",
  assessment: "fail",
  needs_review: "fail",
  assessment_parse_error: "fail",
  unknown_verdict: "fail",
  assessment_transport_error: "fail",
  assessment_retry_limit: "fail",
  replan_limit: "fail",
  artifact_routing_admin: "acknowledge",
});

function isAbHarnessEnvironment(env = process.env) {
  return Boolean(env.POSSE_AB_HARNESS || env.POSSE_AB_CELL || env.POSSE_AB_ARM);
}

function normalizePromptQuestions(questions, fallback, { collapseForChoices = false } = {}) {
  const normalized = (Array.isArray(questions) ? questions : [questions])
    .map((question) => String(question || "").trim())
    .filter(Boolean);
  const resolved = normalized.length > 0 ? normalized : [fallback];
  return collapseForChoices && resolved.length > 1 ? [resolved.join("\n\n")] : resolved;
}

function isSecuritySensitivePrompt(payload = {}) {
  if (payload.subtype === "plan_approval" || payload.subtype === "push_offer") return true;
  if (payload.subtype === "oneshot_scope_selection" || payload.review_type === "oneshot_scope_selection") return true;
  if (payload.review_type === "scope_expansion_request") return true;
  return Array.isArray(payload.file_requests)
    && payload.file_requests.length > 0
    && payload.review_type !== "blocked_recovery";
}

export function unattendedHarnessAnswerForPayload(payload = {}, {
  autoApprove = false,
} = {}) {
  if (payload.subtype === "push_offer" || payload.subtype === "plan_approval") return null;
  if (payload.subtype === "oneshot_scope_selection" || payload.review_type === "oneshot_scope_selection") {
    return "plan";
  }

  const choices = humanInputChoicesForPayload(payload);
  if (payload.review_type === "scope_expansion_request") {
    return autoApprove ? "approve" : "deny";
  }
  if (
    payload.review_type !== "blocked_recovery"
    && Array.isArray(payload.file_requests)
    && payload.file_requests.length > 0
  ) {
    return autoApprove ? "approve" : "reject";
  }

  const preferred = HARNESS_REVIEW_ANSWERS[payload.review_type];
  if (preferred && choices.includes(preferred)) return preferred;
  if (choices.length > 0) return choices[0];
  if (payload.review_type) return "fail";
  if (!isSecuritySensitivePrompt(payload)) return HUMAN_INPUT_BEST_JUDGMENT_ANSWER;
  return null;
}

export function resolveHumanInputPrompt(job, payload = {}) {
  const choices = humanInputChoicesForPayload(payload);
  const questions = normalizePromptQuestions(
    payload.questions,
    `Human input needed for: ${job.title}`,
    { collapseForChoices: choices.length > 0 },
  );
  const genericPrompt = !payload.review_type && !payload.subtype;
  const securitySensitive = isSecuritySensitivePrompt(payload);
  const allowsBestJudgment = choices.length === 0
    && !securitySensitive
    && (payload.allow_best_judgment === true
      || genericPrompt
      || /^Researcher questions:/i.test(String(job.title || "")));
  return {
    questions,
    context: payload.context || "",
    promptOptions: {
      choices,
      ...(allowsBestJudgment ? {
        escapeAnswer: HUMAN_INPUT_BEST_JUDGMENT_ANSWER,
        escapeLabel: "best judgment",
      } : {}),
    },
  };
}

export async function runHumanInputHandler(worker, job, abortSignal = null) {
  const payload = worker.parsePayload(job);
  const { questions, context, promptOptions } = resolveHumanInputPrompt(job, payload);

  if (worker.nonInteractive && isAbHarnessEnvironment()) {
    const answer = unattendedHarnessAnswerForPayload(payload, { autoApprove: worker.autoApprove });
    if (answer) {
      worker.emit(
        job.id,
        `${C.cyan}[human] Harness resolved unattended input with "${answer}"${C.reset}`,
      );
      return JSON.stringify({
        questions,
        answers: questions.map((question) => ({ question, answer })),
        unattended: true,
        source: "ab_harness",
      });
    }
  }

  if (worker.display && worker.display.askQuestions) {
    updateJobStatus(job.id, "waiting_on_human");
    const DISPLAY_TIMEOUT_MS = 3600 * 1000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Human input timed out after ${DISPLAY_TIMEOUT_MS / 1000}s - no response from display`)), DISPLAY_TIMEOUT_MS);
    });
    const aborted = worker._abortPromise(job.id, abortSignal);
    try {
      const answers = await Promise.race([
        worker.display.askQuestions(job.id, questions, context, job.work_item_id, promptOptions),
        timeout,
        ...(aborted ? [aborted] : []),
      ]);
      return JSON.stringify({ questions, answers });
    } finally {
      clearTimeout(timer);
    }
  }

  updateJobStatus(job.id, "waiting_on_human");
  worker.emit(job.id, `${C.yellow}[human] Needs input: ${questions[0]}${C.reset}`);
  return null;
}
