import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { parseJobPayload } from "./payload.js";

export function markScopeGrantUsed(job, file, updatePayload) {
  if (!job) return;
  const payload = parseJobPayload(job);
  let changed = false;
  for (const grant of payload._scope_grants || []) {
    if (!grant.used && grant.paths.includes(file)) { grant.used = true; changed = true; }
  }
  if (changed) updatePayload(job.id, JSON.stringify(payload));
}

export function recordUnusedScopeGrants(job, logEvent, updatePayload) {
  if (job?.status !== "succeeded") return;
  const payload = parseJobPayload(job);
  let changed = false;
  for (const grant of payload._scope_grants || []) {
    if (grant.used || grant.unused_recorded) continue;
    logEvent({ work_item_id: job.work_item_id, job_id: job.id,
      event_type: EVENT_TYPES.JOB_SCOPE_GRANT_UNUSED, actor_type: EVENT_ACTORS.SYSTEM,
      message: `Scope grant from gate #${grant.approval_job_id} was not used: ${grant.paths.join(", ")}`,
      event_json: JSON.stringify(grant) });
    grant.unused_recorded = true; changed = true;
  }
  if (changed) updatePayload(job.id, JSON.stringify(payload));
}
