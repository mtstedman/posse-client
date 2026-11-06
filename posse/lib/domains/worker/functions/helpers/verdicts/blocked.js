// lib/domains/worker/functions/helpers/verdicts/blocked.js

import { updateJobStatus } from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import { handle as handleNeedsReview } from "./needs_review.js";
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

  // The operator can accept an evidence gap even when they cannot repair the
  // harness. Reuse explicit assessment recovery instead of canceling the DAG.
  if (verdict?._assessment_infrastructure_review === true) {
    return handleNeedsReview(job, verdict, ctx);
  }

  if (
    !asksForClarification
    && !verdict?._disable_internal_retry
    && queueInternalAssessmentRetry(job, verdict, retryReason, {
      leaseToken: ctx.leaseToken,
      recordAssessorVerdict: ctx.recordAssessorVerdict,
      assessmentModelTier: ctx.assessmentModelTier,
    })
  ) {
    log(`${C.yellow}[assessor] BLOCKED WITHOUT NEW OPERATOR QUESTION${C.reset} WI#${job.work_item_id} job #${job.id}: retrying assessment at a stronger tier before operator recovery${reasonBrief}`);
    return;
  }

  if (!asksForClarification) {
    return handleNeedsReview(job, { ...verdict, _disable_internal_retry: true,
      _assessment_infrastructure_review: true, human_questions: [] }, ctx);
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
