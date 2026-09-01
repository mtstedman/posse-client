// lib/domains/worker/functions/helpers/verdicts/needs_review.js

import { logEvent, updateJobStatus } from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import {
  logBadInput,
  queueInternalAssessmentRetry,
} from "../verdict-shared.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../../catalog/event.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../../../catalog/native-tools.js";

function isAssessmentDispositionQuestion(question) {
  const text = String(question || "").trim().toLowerCase();
  return /should (?:this|it) pass or fail/.test(text)
    || /\bpass\s*\/\s*fail\b/.test(text)
    || /\bindicate pass(?:\s+or\s+|\s*\/\s*)fail\b/.test(text);
}

export function handle(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor, reasonBrief } = ctx;

  const explicitHumanQuestions = Array.isArray(verdict.human_questions)
    ? verdict.human_questions.filter((question) => String(question || "").trim())
    : [];
  const hasOperatorOnlyQuestion = explicitHumanQuestions.some((question) => !isAssessmentDispositionQuestion(question));
  const jobPayload = parseJobPayload(job);
  const priorClarifications = Array.isArray(jobPayload?._human_clarifications)
    ? jobPayload._human_clarifications
    : [];
  const asksForClarification = hasOperatorOnlyQuestion && priorClarifications.length === 0;
  const retryReason = verdict.reasons?.[0] || "assessment could not reach a confident terminal verdict";
  if (
    !asksForClarification
    && !verdict?._disable_internal_retry
    && queueInternalAssessmentRetry(job, verdict, retryReason, {
      leaseToken: ctx.leaseToken,
      recordAssessorVerdict: ctx.recordAssessorVerdict,
    })
  ) {
    log(`${C.yellow}[assessor] NEEDS REVIEW${C.reset} WI#${job.work_item_id} job #${job.id}: retrying assessment at a stronger tier before asking the operator${reasonBrief}`);
    return;
  }

  if (!asksForClarification) {
    const changed = typeof ctx.updateJobStatus === "function"
      ? ctx.updateJobStatus("failed")
      : updateJobStatus(job.id, "failed");
    if (!changed) return;
    log(`${C.yellow}[assessor] NEEDS REVIEW EXHAUSTED${C.reset} WI#${job.work_item_id} job #${job.id}: automatic assessment recovery exhausted; failed closed without an operator gate${reasonBrief}`);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSMENT_INFRASTRUCTURE_EXHAUSTED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Automatic assessment recovery exhausted without an operator-only question: ${retryReason}`,
      event_json: JSON.stringify({ operator_actionable: false, retry_reason: retryReason }),
    });
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("waiting_on_review")
    : updateJobStatus(job.id, "waiting_on_review");
  if (!changed) return;
  log(`${C.yellow}[assessor] NEEDS REVIEW${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);

  // Always spawn a human_input job. Without one, waiting_on_review is a
  // permanent trap with no mechanism to unblock.
  const questions = explicitHumanQuestions;
  const humanJob = spawnFromAssessor("failed", "human_input", {
    work_item_id: job.work_item_id,
    title: `Review needed: ${job.title}`,
    parent_job_id: job.id,
    priority: "high",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      original_job_id: job.id,
      questions,
      context: verdict.reasons,
      ...(asksForClarification
        ? { allow_best_judgment: true }
        : {
            review_type: "needs_review",
            question_kind: "assessment_review",
            choices: WORK_ITEM_QUESTION_CHOICE_IDS.assessment_review,
          }),
    }),
  });
  spawnedJobs.push(humanJob);
  log(`${C.yellow}[assessor]${C.reset} spawned review #${humanJob.id}`);
}

export function handleParseError(job, verdict, ctx) {
  const { emitLog: log } = ctx;

  const retryReason = verdict.reasons?.[0] || "assessor output could not be parsed";
  if (!verdict?._disable_internal_retry && queueInternalAssessmentRetry(job, verdict, retryReason, {
    leaseToken: ctx.leaseToken,
    recordAssessorVerdict: ctx.recordAssessorVerdict,
  })) {
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("failed")
    : updateJobStatus(job.id, "failed");
  if (!changed) return;
  log(`${C.yellow}[assessor] PARSE ERROR EXHAUSTED${C.reset} WI#${job.work_item_id} job #${job.id}: failed closed without an operator gate`);
  logBadInput(job, verdict, "parse_error", verdict.reasons.join("; "));

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_ASSESSMENT_PARSE_ERROR,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `Assessment unparseable after automatic recovery; failed closed without an operator gate. Reasons: ${verdict.reasons.join("; ")}`,
    event_json: JSON.stringify({ operator_actionable: false }),
  });
}

export function handleUnknownVerdict(job, verdict, ctx) {
  const { emitLog: log } = ctx;

  const retryReason = `unknown assessor verdict "${verdict.verdict}"`;
  if (!verdict?._disable_internal_retry && queueInternalAssessmentRetry(job, verdict, retryReason, {
    leaseToken: ctx.leaseToken,
    recordAssessorVerdict: ctx.recordAssessorVerdict,
  })) {
    return;
  }

  log(`${C.yellow}[assessor] UNKNOWN VERDICT "${verdict.verdict}"${C.reset} WI#${job.work_item_id} job #${job.id}: failed closed without an operator gate`);
  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("failed")
    : updateJobStatus(job.id, "failed");
  if (!changed) return;
  logBadInput(job, verdict, "unknown_verdict", `Unknown verdict "${verdict.verdict}"`);

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_UNKNOWN_VERDICT,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `Unknown verdict "${verdict.verdict}" after automatic recovery; failed closed without an operator gate`,
    event_json: JSON.stringify({ operator_actionable: false }),
  });
}
