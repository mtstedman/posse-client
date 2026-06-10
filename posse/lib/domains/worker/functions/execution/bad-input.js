import { logEvent } from "../../../queue/functions/index.js";
import { jobLog, log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { buildPromptExcerpt } from "../helpers/diagnostics.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";

export function logBadInputFailure(job, {
  attemptId = null,
  layer = "worker",
  upstream = "unknown",
  classification = "invalid_input",
  detail = "",
  snippet = "",
} = {}) {
  if (!job) return;
  const summary = `${layer} <= ${upstream} [${classification}]${detail ? ` - ${detail}` : ""}`;
  jobLog("BAD_INPUT", {
    wi: job.work_item_id,
    job: job.id,
    detail: summary.slice(0, 220),
  });
  log.warn("bad_input", summary, {
    jobId: job.id,
    wiId: job.work_item_id,
    attemptId,
    layer,
    upstream,
    classification,
    snippet: snippet ? buildPromptExcerpt(snippet, 500) : undefined,
  });
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    event_type: EVENT_TYPES.JOB_BAD_INPUT,
    actor_type: EVENT_ACTORS.WORKER,
    message: summary,
    event_json: JSON.stringify({
      layer,
      upstream,
      classification,
      detail,
      snippet: snippet ? buildPromptExcerpt(snippet, 500) : "",
    }),
  });
}
