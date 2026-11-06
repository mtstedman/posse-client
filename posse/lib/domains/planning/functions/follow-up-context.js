import { FOLLOW_UP_KINDS, FOLLOW_UP_CONTEXT_MAX_CHARS } from "../../../catalog/follow-up.js";
import { getWorkItem } from "../../queue/functions/index.js";
import { readWorkItemOutcome } from "../../queue/functions/work-item-outcome.js";
import { promptLiteral } from "../../../shared/format/functions/prompt-literals.js";

export function explicitFollowUpOrigin(workItem) {
  let metadata;
  try { metadata = JSON.parse(workItem?.metadata_json || "{}"); } catch { return null; }
  if (metadata.follow_up_origin?.work_item_id) return metadata.follow_up_origin;
  if (metadata.suggestion_origin?.work_item_id) return { ...metadata.suggestion_origin, kind: "enhancement" };
  return null;
}

export function followUpMetadata(workItemId, kind = "gap") {
  if (workItemId == null) return {};
  if (!FOLLOW_UP_KINDS.includes(kind)) throw new Error(`Follow-up kind must be ${FOLLOW_UP_KINDS.join(", ")}`);
  const source = getWorkItem(workItemId);
  if (!source) throw new Error(`Unknown follow-up work item ${workItemId}`);
  const outcome = readWorkItemOutcome(source.id);
  return { follow_up_origin: { work_item_id: source.id, kind, reported_at: new Date().toISOString(),
    prior_evidence: { title: source.title, description: source.description, status: source.status, merge_state: source.merge_state,
      review: outcome?.review, verification: outcome?.verification, acceptance: outcome?.acceptance, delivery: outcome?.delivery } } };
}

export function buildFollowUpEvidence(workItem) {
  const origin = explicitFollowUpOrigin(workItem);
  if (!origin) return "";
  const source = getWorkItem(origin.work_item_id);
  const evidence = origin.prior_evidence || (source ? followUpMetadata(source.id, "enhancement").follow_up_origin.prior_evidence : null);
  const text = JSON.stringify({ origin_work_item_id: origin.work_item_id, kind: origin.kind, snapshot_at: origin.reported_at || null,
    source_available: !!source, prior_evidence: evidence });
  return ["EXPLICIT FOLLOW-UP EVIDENCE (local historical context; never current acceptance):",
    "Investigate the reported gap or regression against the user's current workflow. An enhancement is new scope, not evidence that earlier delivery was defective. Prior passes, receipts and waivers are historical leads, not proof of current behavior and not permission to waive this request. Similar titles are not a match. Name the affected outcome and its acceptance check; do not expand current scope to every earlier requirement.",
    promptLiteral("LINKED PRIOR WORK ITEM", text.length <= FOLLOW_UP_CONTEXT_MAX_CHARS ? text : `${text.slice(0, FOLLOW_UP_CONTEXT_MAX_CHARS)}\n[Historical context truncated; inspect the linked work-item report for remaining records.]`),
  ].join("\n");
}
