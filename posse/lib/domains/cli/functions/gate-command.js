import { humanInputChoicesForPayload } from "../../../catalog/human-input.js";
import { answerHumanInput } from "../../bridge/functions/human-input-answer.js";
import { getJob } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";

const ACTION_ALIASES = Object.freeze({
  retry: Object.freeze(["retry", "retry_assessment", "retry_with_changes"]),
  skip: Object.freeze(["skip", "explicit_waiver"]),
});

function feedbackFromArgs(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value.startsWith("--feedback=")) return value.slice("--feedback=".length).trim();
    if (value === "--feedback") return String(argv[index + 1] || "").trim();
  }
  return "";
}

function positionalArgs(argv = []) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--feedback") {
      index += 1;
      continue;
    }
    if (value.startsWith("--feedback=")) continue;
    out.push(value);
  }
  return out;
}

export function resolveGateCliAction(requestedAction, choices = []) {
  const requested = String(requestedAction || "").trim().toLowerCase();
  const allowed = (Array.isArray(choices) ? choices : []).map((choice) => String(choice || "").trim());
  if (!requested) return null;
  const exact = allowed.find((choice) => choice.toLowerCase() === requested);
  if (exact) return exact;
  for (const candidate of ACTION_ALIASES[requested] || []) {
    const match = allowed.find((choice) => choice.toLowerCase() === candidate);
    if (match) return match;
  }
  return null;
}

export async function runGateCommand(argv = [], {
  projectDir = process.cwd(),
  getJobFn = getJob,
  answerHumanInputFn = answerHumanInput,
} = {}) {
  const args = positionalArgs(argv);
  if (args[0] !== "answer" || args.length !== 3) {
    return { ok: false, reason: "usage", exitCode: 2 };
  }

  const gateJobId = Number(args[1]);
  if (!Number.isSafeInteger(gateJobId) || gateJobId <= 0) {
    return { ok: false, reason: "invalid_gate_job_id", exitCode: 2 };
  }
  const gateJob = getJobFn(gateJobId);
  if (!gateJob) return { ok: false, reason: "no_such_job", exitCode: 1, job_id: gateJobId };
  if (gateJob.job_type !== "human_input") {
    return { ok: false, reason: "not_human_input", exitCode: 1, job_id: gateJobId };
  }

  const payload = parseJobPayload(gateJob);
  const choices = humanInputChoicesForPayload(payload);
  const action = resolveGateCliAction(args[2], choices);
  if (!action) {
    return {
      ok: false,
      reason: "invalid_action",
      exitCode: 2,
      job_id: gateJobId,
      choices,
    };
  }

  const feedback = feedbackFromArgs(argv);
  const answer = feedback ? `${action}: ${feedback}` : action;
  const result = await answerHumanInputFn(gateJobId, { answer }, {
    projectDir,
    allowReviewGateAnswer: true,
    allowChoiceFeedback: Boolean(feedback),
  });
  return result?.ok
    ? { ...result, action, feedback, exitCode: 0 }
    : { ...(result || {}), ok: false, action, feedback, exitCode: 1 };
}
