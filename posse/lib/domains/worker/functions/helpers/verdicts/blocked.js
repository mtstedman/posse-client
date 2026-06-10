// lib/worker/helpers/verdicts/blocked.js

import { updateJobStatus } from "../../../../queue/functions/index.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import { queueInternalAssessmentRetry } from "../verdict-shared.js";

export function handle(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor, reasonBrief } = ctx;

  const retryReason = verdict.reasons?.[0] || "assessor blocked pending more verification";
  if (!verdict?._disable_internal_retry && queueInternalAssessmentRetry(job, verdict, retryReason, {
    leaseToken: ctx.leaseToken,
    recordAssessorVerdict: ctx.recordAssessorVerdict,
  })) {
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("waiting_on_human")
    : updateJobStatus(job.id, "waiting_on_human");
  if (!changed) return;
  if (verdict.human_questions && verdict.human_questions.length > 0) {
    log(`${C.yellow}[assessor] BLOCKED (needs human)${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);
    const humanJob = spawnFromAssessor("failed", "human_input", {
      work_item_id: job.work_item_id,
      title: `Human input needed for: ${job.title}`,
      parent_job_id: job.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: job.id,
        questions: verdict.human_questions,
        context: verdict.reasons,
      }),
    });
    spawnedJobs.push(humanJob);
    log(`${C.yellow}[assessor]${C.reset} spawned human_input #${humanJob.id}`);
    return;
  }

  // No human_questions were provided, so spawn a generic unblock prompt instead
  // of letting the job sit in "blocked" forever.
  log(`${C.yellow}[assessor] BLOCKED${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);
  const unblockJob = spawnFromAssessor("failed", "human_input", {
    work_item_id: job.work_item_id,
    title: `Blocked: ${job.title.slice(0, 80)}`,
    parent_job_id: job.id,
    priority: "high",
    model_tier: "cheap",
    payload_json: JSON.stringify({
      original_job_id: job.id,
      questions: [
        `Job #${job.id} ("${job.title}") is blocked.`,
        `Reasons: ${verdict.reasons.join("; ")}`,
        "How should we proceed? (retry / skip / replan)",
      ],
      context: verdict.reasons,
    }),
  });
  spawnedJobs.push(unblockJob);
  log(`${C.yellow}[assessor]${C.reset} spawned unblock human_input #${unblockJob.id}`);
}
