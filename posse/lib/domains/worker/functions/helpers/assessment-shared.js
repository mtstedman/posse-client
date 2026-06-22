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
