// lib/domains/worker/functions/helpers/verdicts/blocked.js

import { logEvent, updateJobStatus } from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../../catalog/event.js";
import { queueInternalAssessmentRetry } from "../verdict-shared.js";

export function handle(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor, reasonBrief } = ctx;
  const humanQuestions = Array.isArray(verdict?.human_questions)
    ? verdict.human_questions.filter((question) => String(question || "").trim())
    : [];
  const jobPayload = parseJobPayload(job);
  const priorClarifications = Array.isArray(jobPayload?._human_clarifications)
    ? jobPayload._human_clarifications
    : [];
  const asksForClarification = humanQuestions.length > 0 && priorClarifications.length === 0;
  const retryReason = verdict.reasons?.[0] || "assessment reported blocked without an operator question";

  // Harness-owned evidence/access failures are not decisions an operator can
  // answer. In particular, assessment sanitization may remove a request to
  // paste repository files. Never replace that removed request with a generic
  // recovery gate: doing so turns one non-actionable assessor failure into a
  // recurring human prompt.
  if (verdict?._assessment_infrastructure_review === true) {
    const changed = typeof ctx.updateJobStatus === "function"
      ? ctx.updateJobStatus("failed")
      : updateJobStatus(job.id, "failed");
    if (!changed) return;
    log(`${C.yellow}[assessor] BLOCKED INFRASTRUCTURE EXHAUSTED${C.reset} WI#${job.work_item_id} job #${job.id}: failed closed without an operator gate${reasonBrief}`);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSMENT_INFRASTRUCTURE_EXHAUSTED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Blocked assessment was harness-owned and not operator-actionable; failed closed: ${verdict.reasons?.[0] || "assessment infrastructure exhausted"}`,
      event_json: JSON.stringify({ operator_actionable: false }),
    });
    return;
  }

  if (
    !asksForClarification
    && !verdict?._disable_internal_retry
    && queueInternalAssessmentRetry(job, verdict, retryReason, {
      leaseToken: ctx.leaseToken,
      recordAssessorVerdict: ctx.recordAssessorVerdict,
    })
  ) {
    log(`${C.yellow}[assessor] BLOCKED WITHOUT NEW OPERATOR QUESTION${C.reset} WI#${job.work_item_id} job #${job.id}: retrying assessment at a stronger tier before failing closed${reasonBrief}`);
    return;
  }

  if (!asksForClarification) {
    const changed = typeof ctx.updateJobStatus === "function"
      ? ctx.updateJobStatus("failed")
      : updateJobStatus(job.id, "failed");
    if (!changed) return;
    log(`${C.yellow}[assessor] BLOCKED WITHOUT NEW OPERATOR QUESTION EXHAUSTED${C.reset} WI#${job.work_item_id} job #${job.id}: failed closed without inventing a human gate${reasonBrief}`);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_ASSESSMENT_INFRASTRUCTURE_EXHAUSTED,
      actor_type: EVENT_ACTORS.ASSESSOR,
      message: `Blocked assessment supplied no new operator-actionable question after automatic recovery: ${retryReason}`,
      event_json: JSON.stringify({
        operator_actionable: false,
        retry_reason: retryReason,
        prior_clarification_count: priorClarifications.length,
      }),
    });
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("waiting_on_human")
    : updateJobStatus(job.id, "waiting_on_human");
  if (!changed) return;
  if (asksForClarification) {
    log(`${C.yellow}[assessor] BLOCKED (needs human)${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);
    const humanJob = spawnFromAssessor("failed", "human_input", {
      work_item_id: job.work_item_id,
      title: `Human input needed for: ${job.title}`,
      parent_job_id: job.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: job.id,
        questions: humanQuestions,
        context: verdict.reasons,
        allow_best_judgment: true,
      }),
    });
    spawnedJobs.push(humanJob);
    log(`${C.yellow}[assessor]${C.reset} spawned human_input #${humanJob.id}`);
  }
}
