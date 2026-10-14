import { createHash } from "node:crypto";
import { REVIEWED_COMPLETION_KEY, REVIEWED_HANDOFF_VERSION, REVIEWED_HANDOFF_TRANSITIONS, REVIEWED_SOURCE_MERGE_KEY } from "../../../catalog/reviewed-handoffs.js";
import { parseJobPayload } from "./payload.js";
import { FINAL_REVIEW_CONTRACT_FIELDS } from "../../../catalog/final-review.js";

export function reviewedAuthorityFingerprint(payload) {
  return createHash("sha256").update(JSON.stringify([
    FINAL_REVIEW_CONTRACT_FIELDS.map((key) => [key, payload?.[key] ?? null]),
    payload?.dev_brief?.key_files ?? [],
  ])).digest("hex");
}

export function workItemBranchGeneration(workItem) {
  let metadata = workItem?.metadata_json || {};
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { return null; }
  }
  return createHash("sha256").update(JSON.stringify({
    work_item_id: workItem?.id || null, reset: metadata.branch_reset || null,
  })).digest("hex");
}

export function isReviewedTransfer(entry) {
  return entry?.version === REVIEWED_HANDOFF_VERSION && typeof entry.transfer_id === "string";
}

export function reviewedTransfers(job, { applied = false } = {}) {
  const payload = parseJobPayload(job);
  const entries = payload[applied ? "_cross_wi_file_syncs_applied" : "_cross_wi_file_syncs"];
  return (Array.isArray(entries) ? entries : []).filter(isReviewedTransfer);
}

export function hasReviewedReservation(job) {
  return reviewedTransfers(job).some((entry) => !["applied", "canceled"].includes(entry.state));
}

export function transitionReviewedTransfer(entry, state, details = {}) {
  if (state !== entry.state && !REVIEWED_HANDOFF_TRANSITIONS[entry.state]?.includes(state)) {
    throw new Error(`Invalid reviewed transfer transition: ${entry.state} -> ${state}`);
  }
  return { ...entry, ...details, state };
}

export function reviewedCompletion(job, workItem) {
  const receipt = parseJobPayload(job)[REVIEWED_COMPLETION_KEY];
  if (job?.status !== "succeeded" || !receipt || receipt.version !== REVIEWED_HANDOFF_VERSION
      || !["dev", "fix"].includes(job.job_type)
      || receipt.source_job_id !== job.id || receipt.source_work_item_id !== workItem?.id
      || receipt.source_generation !== workItemBranchGeneration(workItem)
      || receipt.attempt_count !== job.attempt_count
      || receipt.authority_fingerprint !== reviewedAuthorityFingerprint(parseJobPayload(job))
      || ["failed", "canceled"].includes(workItem?.status)) return null;
  return receipt;
}

export function reviewedSourceMergeProof(workItem, receipt) {
  let metadata;
  try { metadata = JSON.parse(workItem?.metadata_json || "{}"); } catch { return null; }
  const proof = metadata[REVIEWED_SOURCE_MERGE_KEY];
  return proof?.source_generation === receipt.source_generation
    && proof.source_generation === workItemBranchGeneration(workItem)
    && (proof.accepted_receipt_ids?.includes(receipt.receipt_id)
      || ((receipt.source_transfer_id || receipt.transfer_id)
        && proof.accepted_transfer_ids?.includes(receipt.source_transfer_id || receipt.transfer_id))) ? proof : null;
}
