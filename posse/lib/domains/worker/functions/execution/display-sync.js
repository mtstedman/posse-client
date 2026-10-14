import { DETERMINISTIC_AUDIT_ROLE } from "../../../../catalog/worker-display.js";

// Assessment starts with deterministic checks. TrackedProviderClient replaces
// this phase with the assessor role only when a provider call is dispatched.
export function syncAssessorWorkerDisplay(display, job, {
  shortJobTitle,
  attempt = 1,
} = {}) {
  if (!display || !job?.id) return;
  display.setWorker(job.id, {
    role: DETERMINISTIC_AUDIT_ROLE,
    activity: `auditing: ${shortJobTitle(job).slice(0, 40)}`,
    tier: null,
    effort: null,
    attempt,
    workItemId: job.work_item_id,
    provider: null,
    modelName: null,
  });
}

// Verdict routing is shared by model assessments and deterministic audits.
export function assessmentDisplayMessage(message, modelCalled = false) {
  return modelCalled ? message : message.replaceAll("[assessor]", `[${DETERMINISTIC_AUDIT_ROLE}]`);
}
