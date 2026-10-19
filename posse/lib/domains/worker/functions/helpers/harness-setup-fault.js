// Posse-side provider setup faults: the tool catalog or the dispatch request
// Posse built was rejected before any model turn ran. They are not the job's
// failure, so the attempt is refunded rather than charged toward the same-error
// dead letter. Keep the set narrow (by code) so real provider failures count.

import { CODEX_CORE_DECLARATIONS_INVALID } from "../../../providers/functions/codex/research-mcp-surface.js";
import { completeAttempt, createJob, getAttempts, getJob, logEvent, runInTransaction } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../../catalog/native-tools.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { refreshAndExtractInsights } from "./insights.js";

export const HARNESS_SETUP_FAULT_PREFIX = "Harness setup fault (not charged):";

// Backoff before the single automatic requeue; a repeat parks on a gate.
export const HARNESS_SETUP_FAULT_BACKOFF_MS = 15_000;

/**
 * The harness fault code for an attempt error, or null when the error may be
 * the provider's or the task's.
 * @param {unknown} err
 * @returns {string|null}
 */
export function harnessSetupFaultCode(err) {
  const code = String(err?.code || "");
  if (code === CODEX_CORE_DECLARATIONS_INVALID) return code;
  // The native dispatcher validates the start frame before dispatch.started,
  // so an exit with no event at all is a refused Posse request.
  if (code === "provider_dispatch_protocol"
    && err?.details?.started === false
    && String(err?.message || "").startsWith("Provider dispatch exited without a terminal event")) {
    return "provider_dispatch_start_rejected";
  }
  return null;
}

function priorFaultInGeneration(job, attemptId, faultCode) {
  const generation = Math.max(0, Number(parseJobPayload(getJob(job.id) || job)?._retry_generation) || 0);
  return getAttempts(job.id).some((entry) => {
    if (Number(entry.id) === Number(attemptId) || Number(entry.attempt_number || 0) <= generation || !entry.notes) return false;
    try {
      return JSON.parse(entry.notes)?.harness_fault_code === faultCode;
    } catch {
      return false;
    }
  });
}

/**
 * Refund a harness setup fault: requeue once with backoff, and park a repeat
 * in the same retry generation on a blocked-recovery gate whose retry resumes
 * this job. Never dead-letters: nothing about the task was tried.
 * @returns {"requeued"|"parked"|"lease_lost"}
 */
export function settleHarnessSetupFault(worker, { attempt, err, faultCode, job, leaseToken, startTime }) {
  const repeated = priorFaultInGeneration(job, attempt.id, faultCode);
  const detail = String(err?.message || faultCode).slice(0, 2000);
  completeAttempt(attempt.id, {
    status: "interrupted",
    duration_ms: Date.now() - startTime,
    error_text: `${HARNESS_SETUP_FAULT_PREFIX} ${faultCode}: ${detail}`,
    notes: JSON.stringify({ harness_fault: true, harness_fault_code: faultCode }),
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attempt.id,
    event_type: repeated ? EVENT_TYPES.JOB_BLOCKED : EVENT_TYPES.JOB_PROVIDER_ERROR,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: repeated
      ? `Harness setup fault repeated (${faultCode}); parked for operator recovery (attempt not consumed)`
      : `Harness setup fault (${faultCode}); requeuing in ${Math.round(HARNESS_SETUP_FAULT_BACKOFF_MS / 1000)}s (attempt not consumed)`,
    event_json: JSON.stringify({ harness_fault: true, harness_fault_code: faultCode, detail: detail.slice(0, 500) }),
  });
  if (!repeated) {
    const readyAt = new Date(Date.now() + HARNESS_SETUP_FAULT_BACKOFF_MS).toISOString();
    if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { attemptId: attempt.id, readyAt })) return "lease_lost";
    worker.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: harness setup fault ${faultCode} — requeuing in ${Math.round(HARNESS_SETUP_FAULT_BACKOFF_MS / 1000)}s (attempt not consumed)${C.reset}`);
    return "requeued";
  }
  const parked = runInTransaction(() => {
    if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human", { attemptId: attempt.id })) return false;
    createJob({
      work_item_id: job.work_item_id,
      job_type: "human_input",
      title: `Blocked: ${String(job.title || "").slice(0, 80)}`,
      parent_job_id: job.id,
      priority: "high",
      payload_json: JSON.stringify({
        original_job_id: job.id,
        review_type: "blocked_recovery",
        question_kind: "blocked_recovery",
        choices: WORK_ITEM_QUESTION_CHOICE_IDS.blocked_recovery,
        harness_fault_code: faultCode,
        questions: [`Posse could not start a provider for job #${job.id} (${faultCode}). What should be done?`],
        context: [
          `Task: ${job.title}`,
          `Harness setup fault: ${detail}`,
          "",
          "Posse's own provider setup failed twice before any model turn ran; no attempt was charged. Repair the setup fault, then choose retry to resume this job.",
        ].join("\n"),
      }),
    });
    return true;
  });
  if (!parked) return "lease_lost";
  worker.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: harness setup fault ${faultCode} repeated — parked for operator recovery (attempt not consumed)${C.reset}`);
  refreshAndExtractInsights(job.work_item_id);
  return "parked";
}
