// lib/domains/worker/functions/helpers/human-input.js
//
// Human-input handler for interactive questions surfaced through the display.
// Manages waiting state, timeout behavior, and abort-aware answer collection.

import { C } from "../../../../shared/format/functions/colors.js";
import { updateJobStatus } from "../../../queue/functions/index.js";
import { humanInputChoicesForPayload } from "../../../../catalog/human-input.js";

export const HUMAN_INPUT_BEST_JUDGMENT_ANSWER = "Continue with best judgment using the available evidence and explicit assumptions.";

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

export function resolveHumanInputPrompt(job, payload = {}) {
  const choices = humanInputChoicesForPayload(payload);
  const questions = normalizePromptQuestions(
    payload.questions,
    `Human input needed for: ${job.title}`,
    { collapseForChoices: choices.length > 0 },
  );
  const genericPrompt = !payload.review_type && !payload.subtype;
  const securitySensitive = isSecuritySensitivePrompt(payload);
  const allowsBestJudgment = !securitySensitive
    && (payload.allow_best_judgment === true
      || (choices.length === 0
        && (genericPrompt || /^Researcher questions:/i.test(String(job.title || "")))));
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
