// lib/domains/worker/functions/helpers/verdicts/pass.js

import { logEvent, storeArtifact, updateJobStatus } from "../../../../queue/functions/index.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../../catalog/event.js";

function coerceSuggestionText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  try {
    const json = JSON.stringify(value);
    if (json != null) return json.trim();
  } catch {
    // Fall through to String() for unusual in-process test values.
  }
  return String(value).trim();
}

export function handle(job, verdict, ctx) {
  const { emitLog: log, isFromSuggestion } = ctx;

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("succeeded")
    : updateJobStatus(job.id, "succeeded");
  if (!changed) return;
  log(`${C.yellow}[assessor] PASS${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}`);

  // Store improvement suggestions as artifacts only. The end-of-run review
  // presents them in batch, which avoids recursive suggestion chains.
  const MAX_SUGGESTIONS = 2;
  if (!verdict.suggestions || verdict.suggestions.length === 0 || isFromSuggestion) return;

  const capped = verdict.suggestions
    .slice(0, MAX_SUGGESTIONS)
    .map(coerceSuggestionText)
    .filter(Boolean);
  if (capped.length === 0) return;
  if (verdict.suggestions.length > MAX_SUGGESTIONS) {
    log(`${C.dim}[assessor] WI#${job.work_item_id} capped suggestions: ${verdict.suggestions.length} -> ${MAX_SUGGESTIONS}${C.reset}`);
  }

  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    artifact_type: "review",
    content_json: JSON.stringify({ type: "suggestions", suggestions: capped }),
  });

  log(`${C.dim}[assessor] WI#${job.work_item_id} ${capped.length} suggestion(s) stored for end-of-run review${C.reset}`);
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.JOB_ASSESSOR_SUGGESTIONS_STORED,
    actor_type: EVENT_ACTORS.ASSESSOR,
    message: `${capped.length} suggestion(s) stored: ${capped.map(s => s.slice(0, 60)).join("; ")}`,
  });
}
