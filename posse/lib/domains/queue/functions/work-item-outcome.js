import { readAdmissionBudget } from "./admission-budget.js";
import { readAcceptance } from "./acceptance.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getWorkItem, listJobsByWorkItem } from "./index.js";
import { latestImplementationCommit, postChangeReceiptsAtCommit } from "./verification-receipts.js";
import { mergeVerificationReviewRequirement, committedJobIdsForWorkItem } from "./merge-verification-review.js";
import { getPublicationTelemetry } from "./publication-telemetry.js";
import { projectWorkItemOutcome } from "../../assessment/functions/work-item-outcome.js";
import { EVENT_TYPES } from "../../../catalog/event.js";

export function readWorkItemOutcome(workItemId) {
  const workItem = getWorkItem(workItemId);
  if (!workItem) return null;
  const jobs = listJobsByWorkItem(workItemId);
  let evidenceAvailable = true;
  let candidateCommit = null, receipts = [], waivers = [], gates = [], mergeCommit = null;
  try {
    candidateCommit = latestImplementationCommit(workItemId);
    receipts = postChangeReceiptsAtCommit(workItemId, candidateCommit);
    waivers = mergeVerificationReviewRequirement(jobs, { committedJobIds: committedJobIdsForWorkItem(workItemId) }).waivers;
    const metadata = JSON.parse(workItem.metadata_json || "{}");
    waivers.push(...(Array.isArray(metadata.target_debt) ? metadata.target_debt : [])
      .filter(entry => entry.waived_by_gate && !entry.resolved_by)
      .map(entry => ({ command: entry.command, commit: entry.commit, gate_id: entry.waived_by_gate })));
    gates = getDb().prepare("SELECT hg.gate_job_id AS id, hg.gate_kind AS question_kind FROM human_gates hg JOIN jobs j ON j.id = hg.gate_job_id WHERE j.work_item_id = ? AND hg.gate_state IN ('open', 'resolving') ORDER BY hg.gate_job_id").all(workItemId);
  } catch { evidenceAvailable = false; /* legacy/missing evidence cannot establish a pass */ }
  if (workItem.merge_state === "merged") {
    try {
      const event = getDb().prepare("SELECT event_json FROM queue_event_state WHERE work_item_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1")
        .get(workItemId, EVENT_TYPES.WORK_ITEM_MERGED);
      const meta = JSON.parse(event?.event_json || "{}");
      mergeCommit = meta.merge_hash || null;
    } catch { /* no exact merge receipt */ }
  }
  let acceptance = null;
  try { acceptance = readAcceptance(workItemId); } catch { evidenceAvailable = false; }
  return projectWorkItemOutcome({ budget: readAdmissionBudget(workItemId), acceptance, workItem, jobs, candidateCommit, receipts, waivers, gates, mergeCommit, evidenceAvailable, publication: getPublicationTelemetry() });
}
