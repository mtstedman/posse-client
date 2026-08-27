import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getEvents, getSetting } from "../../../queue/functions/index.js";

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
  try {
    return getEvents(jobId, 100).filter((e) => e.event_type === "job.assessment_internal_retry").length;
  } catch {
    return 0;
  }
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
