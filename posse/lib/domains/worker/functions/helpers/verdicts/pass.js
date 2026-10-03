// lib/domains/worker/functions/helpers/verdicts/pass.js

import {
  addDependency,
  cancelPendingReviewGatesForOriginal,
  listJobsByWorkItem,
  logEvent,
  storeArtifact,
  updateJobPayload,
  updateJobStatus,
} from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
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

  const siblingFailure = verdict?._sibling_owned_failure;
  const ownerJobIds = [...new Set((Array.isArray(siblingFailure?.owner_job_ids)
    ? siblingFailure.owner_job_ids
    : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0 && id !== Number(job.id)))];
  if (ownerJobIds.length > 0) {
    const payload = parseJobPayload(job);
    payload._assess_only = true;
    payload._sibling_owned_reassessment = {
      owner_job_ids: ownerJobIds,
      identities: siblingFailure.identities || [],
      paths: siblingFailure.paths || [],
      parked_at: new Date().toISOString(),
    };
    updateJobPayload(job.id, JSON.stringify(payload));
    for (const ownerJobId of ownerJobIds) addDependency(job.id, ownerJobId, "hard");
    const requeued = typeof ctx.updateJobStatus === "function"
      ? ctx.updateJobStatus("queued")
      : updateJobStatus(job.id, "queued");
    if (requeued) {
      log(`${C.yellow}[assessor] DEFERRED${C.reset} WI#${job.work_item_id} job #${job.id}: project-root failure belongs to sibling ${ownerJobIds.map((id) => `#${id}`).join(", ")}; re-assessing after it settles`);
    }
    return;
  }

  const changed = typeof ctx.updateJobStatus === "function"
    ? ctx.updateJobStatus("succeeded")
    : updateJobStatus(job.id, "succeeded");
  if (!changed) return;
  if (parseJobPayload(job)?._sibling_owned_reassessment) {
    const lineageIds = new Set([Number(job.id)]);
    const candidates = listJobsByWorkItem(job.work_item_id);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const candidate of candidates) {
        if (lineageIds.has(Number(candidate.id))) continue;
        const payload = parseJobPayload(candidate);
        if (lineageIds.has(Number(payload.root_job_id)) || lineageIds.has(Number(payload.original_job_id))) {
          lineageIds.add(Number(candidate.id));
          expanded = true;
        }
      }
    }
    for (const lineageId of lineageIds) cancelPendingReviewGatesForOriginal(lineageId);
  }
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
