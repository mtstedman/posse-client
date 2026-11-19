import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getEvents, getJob, getSetting } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

// Job payload key counting the internal assessment retries queued for the job.
// The retry events are tail-pruned from the database, and a later process run
// reads only its own event archive, so the limit is counted on the job.
export const ASSESSMENT_INTERNAL_RETRIES_PAYLOAD_KEY = "_assess_internal_retries";

export function getAssessmentInternalRetryLimit() {
  try {
    const raw = getSetting(SETTING_KEYS.ASSESSOR_INTERNAL_RETRY_LIMIT);
    if (raw == null || raw === "") return 2;
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 2;
  } catch {
    return 2;
  }
}

export function countInternalAssessmentRetries(jobId) {
  let recorded = 0;
  try {
    recorded = Math.max(0, Math.floor(Number(parseJobPayload(getJob(jobId))[ASSESSMENT_INTERNAL_RETRIES_PAYLOAD_KEY]) || 0));
  } catch { /* count the retained events only */ }
  // Retained events still count retries queued before the count was recorded.
  let logged = 0;
  try {
    logged = getEvents(jobId, 100).filter((e) => e.event_type === "job.assessment_internal_retry").length;
  } catch { /* the recorded count stands */ }
  return Math.max(recorded, logged);
}

// A/B harnesses compare execution routes, not assessor strength. The harness
// supervisor pins the assessor invariant through the environment so every
// assessment call across arms uses the same effort and provider route.
export function harnessAssessorEffort(env = process.env) {
  if (!env.POSSE_AB_HARNESS) return null;
  const effort = String(env.POSSE_AB_ASSESSOR_EFFORT || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(effort) ? effort : null;
}

export function harnessAssessorProvider(env = process.env) {
  if (!env.POSSE_AB_HARNESS) return null;
  return String(env.POSSE_AB_ASSESSOR_PROVIDER || "").trim().toLowerCase() || null;
}
