import { normPath } from "../../../shared/scope/functions/path.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { parseJobPayload } from "./payload.js";
import { now, runImmediateTransaction } from "./common.js";
import { isLeaseValid } from "./attempts.js";
import { reviewedTransfers, transitionReviewedTransfer, workItemBranchGeneration } from "./reviewed-handoff-records.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { REVIEWED_HANDOFF_REASONS, REVIEWED_HANDOFF_OUTCOMES } from "../../../catalog/reviewed-handoffs.js";
import { finalReviewScope } from "../../assessment/functions/final-review-snapshot.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { logDurableEvent } from "./events.js";
import { reviewedDestinationChanged } from "../../git/functions/reviewed-destination-state.js";
import { reviewedTransferTelemetry } from "../../observability/functions/reviewed-handoff-telemetry.js";

export function reviewedTransferBlockerKey(job, transfer) {
  const db = getDb();
  const read = db.prepare("SELECT * FROM work_items WHERE id = ?");
  const source = read.get(transfer.source_work_item_id);
  const receiver = read.get(job.work_item_id);
  const latest = db.prepare(`SELECT a.id, a.commit_hash FROM job_attempts a JOIN jobs j ON j.id = a.job_id
    WHERE j.work_item_id = ? AND a.commit_hash IS NOT NULL ORDER BY a.id DESC LIMIT 1`).get(job.work_item_id);
  return JSON.stringify([transfer.receipt_id, workItemBranchGeneration(source), source?.status,
    source?.merge_state, workItemBranchGeneration(receiver), receiver?.merge_base_hash,
    latest || null, parseJobPayload(job)._retry_generation ?? null, transfer.reconcile_requested_at || null]);
}

export function blockedReviewedReservation(job) {
  return reviewedTransfers(job).find((entry) => entry.state === "blocked"
    && entry.blocked_key === reviewedTransferBlockerKey(job, entry)
    && !reviewedDestinationChanged(entry.blocked_destination));
}

// Only states which prove Git was never touched can return ownership without
// taking a filesystem lock. The applying journal is durable before the first
// mutation, and cancellation has already removed the worker's lease token.
export function cancelUnusedReviewedTransfers(jobId, { staleOnly = false, leaseToken = null } = {}) {
  const db = getDb();
  const execute = () => {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
    if (!job) return 0;
    const canceled = !job.lease_token && ["canceled", "dead_letter"].includes(job.status);
    const ownsStaleCleanup = staleOnly && leaseToken && job.lease_token === leaseToken && isLeaseValid(jobId, leaseToken);
    if (!canceled && !ownsStaleCleanup) return 0;
    const unused = reviewedTransfers(job).filter((entry) => {
      if (!["reserved", "blocked"].includes(entry.state) || entry.applying_at) return false;
      if (!staleOnly) return true;
      const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(entry.source_work_item_id);
      return !source || ["failed", "canceled"].includes(source.status) || workItemBranchGeneration(source) !== entry.source_generation;
    });
    if (!unused.length) return 0;
    const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job.work_item_id);
    const metadata = JSON.parse(wi.metadata_json || "{}");
    const ids = new Set(unused.map((entry) => entry.transfer_id));
    metadata.cross_wi_merge_dependencies = (metadata.cross_wi_merge_dependencies || []).filter((dep) => !ids.has(dep.transfer_id));
    db.prepare("UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(metadata), now(), wi.id);
    for (const entry of unused) {
      const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(entry.source_work_item_id);
      for (const file of entry.files) {
        db.prepare(`UPDATE work_item_file_locks SET released_at = ?, release_reason = 'unused_reviewed_reservation'
          WHERE work_item_id = ? AND path = ? AND released_at IS NULL AND source_job_id = ?`).run(now(), wi.id, normPath(file.path), job.id);
        if (source && source.merge_state !== "merged" && !["failed", "canceled"].includes(source.status)
            && workItemBranchGeneration(source) === entry.source_generation) {
          // Restore the original rows only if no other WI has acquired the
          // claim. Reservations have prevented another live writer meanwhile.
          const other = db.prepare(`SELECT 1 FROM work_item_file_locks WHERE path = ? AND released_at IS NULL AND work_item_id != ?`).get(normPath(file.path), source.id);
          const own = db.prepare("SELECT 1 FROM work_item_file_locks WHERE work_item_id = ? AND path = ? AND released_at IS NULL").get(source.id, normPath(file.path));
          if (!other && !own) db.prepare(`UPDATE work_item_file_locks SET released_at = NULL, release_reason = NULL
            WHERE id = (SELECT id FROM work_item_file_locks WHERE work_item_id = ? AND path = ?
              AND release_reason = 'reviewed_handoff' ORDER BY id DESC LIMIT 1)`).run(source.id, normPath(file.path));
        }
      }
    }
    const payload = parseJobPayload(job);
    payload._cross_wi_file_syncs = payload._cross_wi_file_syncs.filter((entry) => !ids.has(entry.transfer_id));
    const canceledTransfers = unused.map((entry) => transitionReviewedTransfer(entry, "canceled", { canceled_at: now(),
      application_outcome: entry.rollback_verified_at ? REVIEWED_HANDOFF_OUTCOMES.RESTORED : REVIEWED_HANDOFF_OUTCOMES.UNUSED }));
    payload._cross_wi_file_syncs_rolled_back = [...(payload._cross_wi_file_syncs_rolled_back || []), ...canceledTransfers];
    db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), now(), jobId);
    for (const [index, entry] of canceledTransfers.entries()) logDurableEvent({ job_id: jobId, work_item_id: wi.id,
      event_type: EVENT_TYPES.WORK_ITEM_REVIEWED_TRANSFER_STATE, actor_type: EVENT_ACTORS.WORKER,
      message: "Reviewed file transfer canceled", event_json: JSON.stringify(reviewedTransferTelemetry(entry, unused[index])) });
    notifyQueueStateChanged({ reason: "reviewed_handoff_canceled", jobId, workItemId: wi.id });
    return unused.length;
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function reviewedTransferOwner(jobId, transfer, leaseToken) {
  const db = getDb();
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job?.work_item_id);
  if (!job || !leaseToken || job.lease_token !== leaseToken || !isLeaseValid(jobId, leaseToken)
      || ["failed", "canceled"].includes(wi?.status)
      || transfer.receiver_job_id !== job.id || transfer.receiver_work_item_id !== wi?.id
      || transfer.receiver_generation !== workItemBranchGeneration(wi)) {
    throw Object.assign(new Error("Reviewed transfer no longer owns the receiver lease/generation"), { code: REVIEWED_HANDOFF_REASONS.LEASE });
  }
  const current = reviewedTransfers(job).find((entry) => entry.transfer_id === transfer.transfer_id);
  if (!current) throw new Error("Reviewed reservation disappeared");
  const scope = new Set([...finalReviewScope(parseJobPayload(job)).files].map(normPath));
  for (const file of current.files) {
    if (!scope.has(normPath(file.path))) throw new Error(`Reviewed path is no longer authorized: ${file.path}`);
    if (!db.prepare(`SELECT 1 FROM work_item_file_locks WHERE work_item_id = ? AND path = ?
      AND lock_kind = 'file' AND released_at IS NULL`).get(wi.id, normPath(file.path))) throw new Error(`Reviewed reservation missing: ${file.path}`);
  }
  return { job, workItem: wi, transfer: current };
}

export function updateReviewedTransfer(jobId, transfer, leaseToken, state, details = {}) {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const owner = reviewedTransferOwner(jobId, transfer, leaseToken);
    if (state === "applying") {
      const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(owner.transfer.source_work_item_id);
      if (!source || ["failed", "canceled"].includes(source.status)
          || workItemBranchGeneration(source) !== owner.transfer.source_generation) {
        throw Object.assign(new Error("Reviewed source changed before application"), { code: REVIEWED_HANDOFF_REASONS.GENERATION });
      }
    }
    const next = transitionReviewedTransfer(owner.transfer, state, { ...details, updated_at: now(),
      ...(state === "blocked" ? { blocked_key: reviewedTransferBlockerKey(owner.job, owner.transfer),
        // A different setup blocker must not inherit a stale Git snapshot.
        blocked_destination: details.blocked_destination ?? null } : {}) });
    const payload = parseJobPayload(owner.job);
    payload._cross_wi_file_syncs = payload._cross_wi_file_syncs.map((entry) => entry.transfer_id === next.transfer_id ? next : entry);
    if (state === "applied") {
      const deleted = next.integrated ? (next.deleted_paths || []) : next.files.filter((file) => file.object == null).map((file) => file.path);
      next.deleted_paths = deleted;
      next.reconciled_fields_by_path = {};
      for (const path of deleted) {
        const reconciled = [];
        for (const field of ["files_to_modify", "must_modify"]) {
          if (!Array.isArray(payload[field])) continue;
          const kept = payload[field].filter((value) => normPath(value) !== normPath(path));
          if (kept.length !== payload[field].length) reconciled.push(field);
          payload[field] = kept;
        }
        next.reconciled_fields_by_path[path] = reconciled;
      }
      payload._cross_wi_file_syncs = payload._cross_wi_file_syncs.filter((entry) => entry.transfer_id !== next.transfer_id);
      payload._cross_wi_file_syncs_applied = [...(payload._cross_wi_file_syncs_applied || []), next];
    }
    db.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), now(), jobId);
    if (owner.transfer.state !== state || owner.transfer.blocked_key !== next.blocked_key || owner.transfer.reason !== next.reason) {
      logDurableEvent({ job_id: jobId, work_item_id: owner.job.work_item_id,
        event_type: EVENT_TYPES.WORK_ITEM_REVIEWED_TRANSFER_STATE, actor_type: EVENT_ACTORS.WORKER,
        message: `Reviewed file transfer ${state}`,
        event_json: JSON.stringify(reviewedTransferTelemetry(next, owner.transfer)) });
    }
    notifyQueueStateChanged({ reason: `reviewed_handoff_${state}`, jobId, workItemId: owner.job.work_item_id });
    return next;
  });
}
