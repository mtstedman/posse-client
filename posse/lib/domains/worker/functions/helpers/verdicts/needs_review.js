// lib/domains/worker/functions/helpers/verdicts/needs_review.js

import { logEvent, updateJobStatus } from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import {
  logBadInput,
  queueInternalAssessmentRetry,
} from "../verdict-shared.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../../catalog/event.js";

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
    !hasOperatorOnlyQuestion
    && !verdict?._disable_internal_retry
    && queueInternalAssessmentRetry(job, verdict, retryReason, {
      leaseToken: ctx.leaseToken,
      recordAssessorVerdict: ctx.recordAssessorVerdict,
    })
  ) {
    log(`${C.yellow}[assessor] NEEDS REVIEW${C.reset} WI#${job.work_item_id} job #${job.id}: retrying assessment at a stronger tier before asking the operator${reasonBrief}`);
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("waiting_on_review")
    : updateJobStatus(job.id, "waiting_on_review");
  if (!changed) return;
  log(`${C.yellow}[assessor] NEEDS REVIEW${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);

  // Always spawn a human_input job. Without one, waiting_on_review is a
  // permanent trap with no mechanism to unblock.
  const questions = asksForClarification || (!hasOperatorOnlyQuestion && explicitHumanQuestions.length > 0)
    ? explicitHumanQuestions
    : [`Job #${job.id} ("${job.title}") needs human review.\nReasons: ${verdict.reasons.join("; ")}\nShould this pass or fail?`];
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
        : { review_type: "needs_review" }),
    }),
  });
  spawnedJobs.push(humanJob);
  log(`${C.yellow}[assessor]${C.reset} spawned review #${humanJob.id}`);
}

export function handleParseError(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor } = ctx;

  const retryReason = verdict.reasons?.[0] || "assessor output could not be parsed";
  if (!verdict?._disable_internal_retry && queueInternalAssessmentRetry(job, verdict, retryReason, {
    leaseToken: ctx.leaseToken,
    recordAssessorVerdict: ctx.recordAssessorVerdict,
  })) {
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("waiting_on_review")
    : updateJobStatus(job.id, "waiting_on_review");
  if (!changed) return;
  log(`${C.yellow}[assessor] PARSE ERROR${C.reset} WI#${job.work_item_id} job #${job.id}: could not parse verdict, flagged for review`);
  logBadInput(job, verdict, "parse_error", verdict.reasons.join("; "));

  const rawExcerpt = (verdict.raw || "").slice(0, 500).trim();
  const reviewJob = spawnFromAssessor("failed", "human_input", {
    work_item_id: job.work_item_id,
    title: `Assessment unparseable: ${job.title.slice(0, 60)}`,
    parent_job_id: job.id,
    priority: "high",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      original_job_id: job.id,
      questions: [
        `The assessor could not produce valid JSON for job #${job.id} ("${job.title}"), ` +
        `but here is what it said:\n\n${rawExcerpt}\n\nShould this pass or fail?`,
      ],
      context: verdict.reasons.join("; "),
      review_type: "assessment_parse_error",
    }),
  });
  spawnedJobs.push(reviewJob);
  log(`${C.yellow}[assessor]${C.reset} spawned review #${reviewJob.id}`);

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_ASSESSMENT_PARSE_ERROR,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `Assessment unparseable - flagged for human review. Reasons: ${verdict.reasons.join("; ")}`,
  });
}

export function handleUnknownVerdict(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor } = ctx;

  log(`${C.yellow}[assessor] UNKNOWN VERDICT "${verdict.verdict}"${C.reset} WI#${job.work_item_id} job #${job.id}: flagged for review`);
  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("waiting_on_review")
    : updateJobStatus(job.id, "waiting_on_review");
  if (!changed) return;
  logBadInput(job, verdict, "unknown_verdict", `Unknown verdict "${verdict.verdict}"`);

  const unknownReviewJob = spawnFromAssessor("failed", "human_input", {
    work_item_id: job.work_item_id,
    title: `Unknown verdict "${verdict.verdict}": ${job.title.slice(0, 50)}`,
    parent_job_id: job.id,
    priority: "high",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      original_job_id: job.id,
      questions: [
        `The assessor returned an unknown verdict "${verdict.verdict}" for job #${job.id} ("${job.title}"). ` +
        `Reasons: ${verdict.reasons.join("; ")}. ` +
        "Please review the work and indicate pass/fail.",
      ],
      context: verdict.raw || "",
      review_type: "unknown_verdict",
    }),
  });
  spawnedJobs.push(unknownReviewJob);

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_UNKNOWN_VERDICT,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `Unknown verdict "${verdict.verdict}" - flagged for human review`,
  });
}
