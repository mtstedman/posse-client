import { humanInputChoicesForPayload } from "../../../catalog/human-input.js";
import { answerHumanInput } from "../../bridge/functions/human-input-answer.js";
import { getHumanGate, getJob, getLiveSchedulerBlockMessage, listJobsByWorkItem } from "../../queue/functions/index.js";
import { resolveGateReviewDiffTarget } from "../../queue/functions/gate-review-target.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  buildGateReviewDiff,
  formatGateReviewDiffText,
} from "../../ui/functions/admin/gate-review-diff.js";

const GATE_SHOW_CONTEXT_MAX_LINES = 20;

const VALUE_FLAGS = Object.freeze(["--feedback", "--text"]);

function flagFromArgs(argv = [], flag) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1).trim();
    if (value === flag) return String(argv[index + 1] || "").trim();
  }
  return "";
}

function feedbackFromArgs(argv = []) {
  return flagFromArgs(argv, "--feedback");
}

function positionalArgs(argv = []) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (VALUE_FLAGS.includes(value)) {
      index += 1;
      continue;
    }
    if (VALUE_FLAGS.some((flag) => value.startsWith(`${flag}=`))) continue;
    out.push(value);
  }
  return out;
}

/**
 * The gate choice an operator's CLI action names: exactly one of the gate's
 * offered ids (case-insensitive), or null. There are no friendly aliases;
 * `posse gate show` prints the ids and a miss lists them.
 */
export function resolveGateCliAction(requestedAction, choices = []) {
  const requested = String(requestedAction || "").trim().toLowerCase();
  if (!requested) return null;
  return (Array.isArray(choices) ? choices : [])
    .map((choice) => String(choice || "").trim())
    .find((choice) => choice.toLowerCase() === requested) || null;
}

function textLines(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  return raw.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
}

// The whole question, paragraph breaks included: an operator answering from
// the shell reads it here, however long it is.
function questionLines(value) {
  const raw = Array.isArray(value) ? value.map((entry) => String(entry ?? "")).join("\n\n") : String(value || "");
  const lines = raw.split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
  return lines;
}

/**
 * What `posse gate show` prints: the gate's question, its choices and, for a
 * verdict on code, the change it judges (stat plus a bounded patch), so an
 * operator answering from the shell sees what the TUI's [d] view shows.
 */
export function formatGateShowLines({ gateJob, payload = {}, choices = [], gateState = null, diffText = null } = {}) {
  const kind = payload.review_type || payload.subtype || "question";
  const wi = gateJob.work_item_id == null ? "" : ` for WI#${gateJob.work_item_id}`;
  const out = [`Gate #${gateJob.id} ${kind}${wi} (${gateJob.status}${gateState ? `, gate ${gateState}` : ""})`];
  const asked = questionLines(payload.questions);
  const questions = asked.length > 0 ? asked : questionLines(payload.prompt || gateJob.title);
  if (questions.length > 0) out.push("", "Question:", ...questions.map((line) => (line ? `  ${line}` : "")));
  const context = textLines(payload.context);
  if (context.length > 0) {
    out.push("", "Context:", ...context.slice(0, GATE_SHOW_CONTEXT_MAX_LINES).map((line) => `  ${line}`));
    if (context.length > GATE_SHOW_CONTEXT_MAX_LINES) {
      out.push(`  ... ${context.length - GATE_SHOW_CONTEXT_MAX_LINES} more context line(s)`);
    }
  }
  out.push("", `Choices: ${choices.length > 0 ? choices.join(", ") : "free-form answer"}`);
  out.push(choices.length > 0
    ? `Answer: posse gate answer ${gateJob.id} ${choices.join("|")} [--feedback "details"]`
    : `Answer: posse gate answer ${gateJob.id} --text "your answer"`);
  out.push("", ...(diffText || ["This gate does not judge a code change; there is no diff to show."]));
  return out;
}

// An answer only requeues the work it releases; a run executes it. With no
// live scheduler (the run that opened the gate already exited) nothing will,
// so name the queued work instead of implying it runs now. A detached run is
// not launched here: the bridge's `go --non-interactive` would also approve
// every other pending plan and scope gate, authority this answer never gave.
function queuedWithoutRun(workItemId, { liveSchedulerFn, listJobsFn }) {
  if (workItemId == null || liveSchedulerFn("main")) return [];
  return listJobsFn(workItemId).filter((job) => job.status === "queued").map((job) => Number(job.id));
}

function loadGateJob(rawId, getJobFn) {
  const gateJobId = Number(rawId);
  if (!Number.isSafeInteger(gateJobId) || gateJobId <= 0) {
    return { error: { ok: false, reason: "invalid_gate_job_id", exitCode: 2 } };
  }
  const gateJob = getJobFn(gateJobId);
  if (!gateJob) return { error: { ok: false, reason: "no_such_job", exitCode: 1, job_id: gateJobId } };
  if (gateJob.job_type !== "human_input") {
    return { error: { ok: false, reason: "not_human_input", exitCode: 1, job_id: gateJobId } };
  }
  return { gateJobId, gateJob };
}

async function showGate(rawId, {
  projectDir,
  getJobFn,
  getHumanGateFn,
  resolveReviewDiffTargetFn,
  buildReviewDiffFn,
}) {
  const { error, gateJobId, gateJob } = loadGateJob(rawId, getJobFn);
  if (error) return error;
  const payload = parseJobPayload(gateJob);
  const choices = humanInputChoicesForPayload(payload);
  const target = resolveReviewDiffTargetFn(gateJob, { payload });
  const diff = target ? await buildReviewDiffFn({ projectDir, target }) : null;
  let gateState = null;
  try { gateState = getHumanGateFn(gateJobId)?.gate_state || null; } catch { gateState = null; }
  return {
    ok: true,
    subcommand: "show",
    job_id: gateJobId,
    work_item_id: gateJob.work_item_id ?? null,
    choices,
    review_diff: target,
    lines: formatGateShowLines({
      gateJob,
      payload,
      choices,
      gateState,
      diffText: diff ? formatGateReviewDiffText(diff) : null,
    }),
    exitCode: 0,
  };
}

export async function runGateCommand(argv = [], {
  projectDir = process.cwd(),
  getJobFn = getJob,
  answerHumanInputFn = answerHumanInput,
  getHumanGateFn = getHumanGate,
  resolveReviewDiffTargetFn = resolveGateReviewDiffTarget,
  buildReviewDiffFn = buildGateReviewDiff,
  liveSchedulerFn = getLiveSchedulerBlockMessage,
  listJobsFn = listJobsByWorkItem,
} = {}) {
  const args = positionalArgs(argv);
  if (["show", "diff"].includes(args[0]) && args.length === 2) {
    return showGate(args[1], {
      projectDir,
      getJobFn,
      getHumanGateFn,
      resolveReviewDiffTargetFn,
      buildReviewDiffFn,
    });
  }
  if (args[0] !== "answer" || args.length < 2) {
    return { ok: false, reason: "usage", exitCode: 2 };
  }

  const { error, gateJobId, gateJob } = loadGateJob(args[1], getJobFn);
  if (error) return error;

  const payload = parseJobPayload(gateJob);
  const choices = humanInputChoicesForPayload(payload);
  const text = flagFromArgs(argv, "--text");
  if (choices.length === 0) {
    // A gate without choices (a clarification) takes free text: --text, or
    // the words after the gate id. It used to have no CLI answer at all: every
    // action was refused as invalid against its empty choice list.
    const answer = text || args.slice(2).join(" ").trim();
    if (!answer) return { ok: false, reason: "answer_required", exitCode: 2, job_id: gateJobId, choices };
    const result = await answerHumanInputFn(gateJobId, { answer }, {
      projectDir,
      allowReviewGateAnswer: true,
      allowChoiceFeedback: false,
    });
    return result?.ok
      ? { ...result, action: "answer", answer_text: answer, exitCode: 0,
        queued_without_run: result.pending ? [] : queuedWithoutRun(gateJob.work_item_id, { liveSchedulerFn, listJobsFn }) }
      : { ...(result || {}), ok: false, action: "answer", answer_text: answer, exitCode: 1 };
  }
  if (args.length !== 3 && !text) return { ok: false, reason: "usage", exitCode: 2 };
  const action = text ? null : resolveGateCliAction(args[2], choices);
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
  // The resolved action travels beside the text so feedback that happens to
  // contain another action word cannot change the selection downstream.
  const result = await answerHumanInputFn(gateJobId, { answer, answer_metadata: { selected_action: action } }, {
    projectDir,
    allowReviewGateAnswer: true,
    allowChoiceFeedback: Boolean(feedback),
  });
  return result?.ok
    ? { ...result, action, feedback, exitCode: 0,
      queued_without_run: result.pending ? [] : queuedWithoutRun(gateJob.work_item_id, { liveSchedulerFn, listJobsFn }) }
    : { ...(result || {}), ok: false, action, feedback, exitCode: 1 };
}
