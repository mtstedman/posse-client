import { normPath } from "../../../shared/scope/functions/path.js";
import { randomUUID } from "node:crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import { REVIEWED_HANDOFF_REASONS as REASONS } from "../../../catalog/reviewed-handoffs.js";
import { ReviewedHandoffSettings } from "../classes/ReviewedHandoffSettings.js";
import { isSequenceAllocationPath } from "../../../catalog/sequence-allocation.js";
import { finalReviewScope } from "../../assessment/functions/final-review-snapshot.js";
import { exactReviewedPath } from "../../git/functions/reviewed-file-objects.js";
import { parseJobPayload } from "./payload.js";
import { hasReviewedReservation, reviewedCompletion, workItemBranchGeneration } from "./reviewed-handoff-records.js";
import { findLockRowOverlap } from "./work-item-order.js";
import { addCrossWiMergeDependency, collectCrossWiPathProvenance, getWorkItemMergeDependencies } from "./cross-wi-deps.js";
import { now, TERMINAL_JOB_STATUSES } from "./common.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { blockedReviewedReservation } from "./reviewed-handoff-journal.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { logDurableEvent } from "./events.js";
import { reviewedTransferTelemetry } from "../../observability/functions/reviewed-handoff-telemetry.js";

const settings = new ReviewedHandoffSettings();
export function reviewedHandoffsEnabled() { return settings.enabled(); }

export function supportsReviewedAdmission(job, scope) {
  const payload = parseJobPayload(job);
  return ["dev", "fix"].includes(job.job_type) && [undefined, "code"].includes(payload.task_mode)
    && scope && !scope.assessmentBarrier && !scope.unknown && scope.files?.length > 0
    && !scope.roots?.length && scope.files.every(exactReviewedPath);
}

export function usesReviewedAdmission(job, scope) {
  return reviewedAdmissionRequested(job) && supportsReviewedAdmission(job, scope);
}

export function reviewedAdmissionRequested(job) {
  return reviewedHandoffsEnabled() || hasReviewedReservation(job);
}

function wait(job, lock, path, reason) {
  return { transfers: [], conflict: { type: lock.job_id && lock.lock_tier === "job" ? "job" : "work_item",
    lock, candidate: { path, lock_kind: "file" },
    wait_state: { reason, upstream_work_item_id: lock.work_item_id, waiter_job_id: job.id } } };
}

function orderWait(job, upstream, hit) {
  const result = wait(job, { work_item_id: upstream.id, job_id: null, lock_tier: "work_item_order",
    path: hit.right.path, lock_kind: hit.right.lock_kind }, hit.left.path, "work_item_order");
  result.conflict.work_item_order = true;
  result.conflict.candidate.lock_kind = hit.left.lock_kind;
  if (hit.left.job_id && hit.left.job_id !== job.id) result.conflict.wait_state.via_job_id = hit.left.job_id;
  return result;
}

// Prove the complete proposed graph, including hard job prerequisites and
// existing content edges. Exhaustion is a blocker, never proof of acyclicity.
export function reviewedDependencyProof(targetId, sourceIds, { maxNodes = 256, db = getDb() } = {}) {
  const visited = new Set();
  const queue = sourceIds.map((id) => ({ id, path: [targetId, id] }));
  while (queue.length) {
    const current = queue.shift();
    if (current.id === targetId) return { ok: false, reason: "merge_order_cycle", path: current.path };
    if (visited.has(current.id)) continue;
    if (visited.size >= maxNodes) return { ok: false, reason: REASONS.INCOMPLETE };
    visited.add(current.id);
    const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(current.id);
    if (!wi) return { ok: false, reason: REASONS.SOURCE };
    if (wi.merge_state === "merged") continue;
    const next = new Set(getWorkItemMergeDependencies(wi).map((dep) => dep.source_work_item_id));
    for (const row of db.prepare(`SELECT DISTINCT dep.work_item_id FROM job_dependencies jd
      JOIN jobs j ON j.id = jd.job_id JOIN jobs dep ON dep.id = jd.depends_on_job_id
      WHERE j.work_item_id = ? AND jd.dependency_kind = 'hard' AND dep.status != 'succeeded'
        AND dep.work_item_id != j.work_item_id`).all(wi.id)) next.add(row.work_item_id);
    for (const row of db.prepare(`SELECT DISTINCT w.holder_work_item_id FROM file_lane_waits w
      JOIN jobs j ON j.id = w.waiter_job_id WHERE w.waiter_work_item_id = ? AND j.status = 'queued'
      AND w.holder_work_item_id IS NOT NULL AND w.holder_work_item_id != ?`).all(wi.id, wi.id)) next.add(row.holder_work_item_id);
    for (const id of next) queue.push({ id, path: [...current.path, id] });
  }
  return { ok: true };
}

// Shared by advisory scans and the lease transaction. No writes here. The
// caller supplies the established lock projection, including queued repairs.
export function reviewedHandoffAdmission(job, scope, { order, workItemLocks, jobLocks,
  canRelease, sourceRejection, sameWorkItemConflict } = {}) {
  const db = getDb();
  const receiver = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job.work_item_id);
  const rows = scope.files.map((path) => ({ path, lock_kind: "file" }));
  if (sameWorkItemConflict) return { conflict: sameWorkItemConflict, transfers: [] };
  const blocked = blockedReviewedReservation(job);
  if (blocked) return wait(job, { work_item_id: job.work_item_id }, blocked.path, blocked.reason || REASONS.RECOVERY);
  // Every earlier planned writer remains a reservation. Only a completed
  // path, with no further writer in its source WI, can be exported.
  const wiRows = [...(order.byId.get(job.work_item_id)?.planned || []), ...rows];
  const rank = order.rank.get(job.work_item_id) ?? order.ordered.length;
  for (const id of order.ordered.slice(0, rank)) {
    const upstream = order.byId.get(id);
    const hit = findLockRowOverlap(wiRows, upstream.planned);
    if (hit) return orderWait(job, upstream, hit);
  }
  const transfers = new Map();
  for (const row of rows) {
    const active = jobLocks.find((lock) => lock.work_item_id !== job.work_item_id
      && (!lock.assessment_barrier || lock.reviewed_reservation)
      && findLockRowOverlap([row], [lock]));
    if (active) return wait(job, active, row.path, "active_job_lock");
    const holders = workItemLocks.filter((lock) => lock.work_item_id !== job.work_item_id
      && findLockRowOverlap([row], [lock]));
    if (!holders.length) continue;
    if (holders.length !== 1 || holders[0].lock_kind !== "file") return wait(job, holders[0], row.path, REASONS.SCOPE);
    const holder = holders[0];
    if (!reviewedHandoffsEnabled()) return wait(job, holder, row.path, REASONS.SOURCE);
    if (isSequenceAllocationPath(row.path) || !canRelease(holder.work_item_id, row.path).ok
        || sourceRejection(holder.work_item_id, row.path)) return wait(job, holder, row.path, REASONS.SOURCE);
    const source = db.prepare("SELECT * FROM work_items WHERE id = ?").get(holder.work_item_id);
    const sourceJobs = db.prepare("SELECT * FROM jobs WHERE work_item_id = ? ORDER BY id DESC").all(holder.work_item_id);
    const receipts = sourceJobs.map((candidate) => reviewedCompletion(candidate, source)).filter(Boolean)
      .filter((receipt) => receipt.files.some((file) => normPath(file.path) === row.path))
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at));
    const receipt = receipts[0];
    if (!receipt) return wait(job, holder, row.path, REASONS.SOURCE);
    const selectedFiles = receipt.files.filter((file) => scope.files.includes(normPath(file.path))
      && workItemLocks.some((lock) => lock.work_item_id === source.id && lock.lock_kind === "file" && lock.path === normPath(file.path)));
    // The review proved its outputs together. An output that changed in the
    // source but is not exported here (not requested by this receiver, or
    // still reserved by a later source writer) is a freshness requirement of
    // the exported subset: before source integration the receiver must
    // already hold that exact reviewed object, or the sync defers. Without it
    // a test arrives ahead of the implementation it was reviewed against and
    // the receiver's baseline fails before any developer edit. Ownership and
    // merge proof are unaffected: after integration the receiver takes the
    // source's final state whole.
    const omittedOutputs = receipt.files
      .filter((file) => file.change_kind !== "unchanged"
        && !selectedFiles.some((selected) => normPath(selected.path) === normPath(file.path))
        && !receipt.read_inputs.some((input) => normPath(input.path) === normPath(file.path)))
      .map((file) => ({ path: file.path, repo_path: file.repo_path, object: file.object }));
    const boundPaths = [...selectedFiles, ...receipt.read_inputs].map((entry) => ({ path: normPath(entry.path), lock_kind: "file" }));
    for (const candidate of sourceJobs) {
      if (candidate.id === receipt.source_job_id || !["dev", "fix", "promote"].includes(candidate.job_type)) continue;
      const writerScope = finalReviewScope(parseJobPayload(candidate));
      const overlaps = !writerScope.declared || findLockRowOverlap(boundPaths, [
        ...[...writerScope.files].map((path) => ({ path: normPath(path), lock_kind: "file" })),
        ...writerScope.roots.map((path) => ({ path: normPath(path), lock_kind: "root" })),
      ]);
      if (overlaps && (!TERMINAL_JOB_STATUSES.includes(candidate.status)
          || (Number(candidate.attempt_count) > 0 && String(candidate.finished_at || candidate.started_at || "") >= receipt.completed_at))) {
        return wait(job, holder, row.path, REASONS.SOURCE);
      }
    }
    if (selectedFiles.some((file) => file.object?.mode === "120000"
        || isSequenceAllocationPath(file.path) || !canRelease(holder.work_item_id, file.path).ok)) return wait(job, holder, row.path, REASONS.SCOPE);
    // Ownership is per-file. Preserve the complete review as evidence, while
    // importing only authorized files. All declared read inputs remain freshness
    // requirements: older receipts do not record per-output read dependencies.
    for (const input of receipt.read_inputs) {
      if (sourceJobs.some((candidate) => !TERMINAL_JOB_STATUSES.includes(candidate.status)
          && finalReviewScope(parseJobPayload(candidate)).files.has(input.path))) return wait(job, holder, row.path, REASONS.INPUT);
    }
    const required = [];
    for (const file of selectedFiles) {
      const provenance = collectCrossWiPathProvenance(source.id, file.path);
      if (provenance.complete === false) return wait(job, holder, row.path, REASONS.INCOMPLETE);
      if (provenance.outstanding.length) return wait(job, holder, row.path, "outstanding_content_claim");
      required.push(...getWorkItemMergeDependencies(source).filter((dep) => !dep.path || dep.path === file.path));
      for (const carried of provenance.carried) {
        if (!required.some((dep) => dep.source_work_item_id === carried.source_work_item_id)) required.push(carried);
      }
    }
    if (required.some((dep) => !dep.source_generation)) return wait(job, holder, row.path, REASONS.INCOMPLETE);
    transfers.set(receipt.receipt_id, { ...receipt, review_receipt: receipt, files: selectedFiles, omitted_outputs: omittedOutputs, path: selectedFiles[0].path,
      receiver_job_id: job.id, receiver_work_item_id: job.work_item_id,
      receiver_generation: workItemBranchGeneration(receiver), required_provenance: required,
      state: "reserved", donor_lock_ids: workItemLocks.filter((lock) => lock.work_item_id === source.id
        && selectedFiles.some((file) => normPath(file.path) === lock.path)).map((lock) => lock.id) });
  }
  // A receipt authorizes only its transferred paths. Sibling scopes still
  // wait for earlier held files so the WI cannot start on a divergent base.
  for (const id of order.ordered.slice(0, rank)) {
    const held = order.byId.get(id).held.filter((lock) => ![...transfers.values()].some((transfer) =>
      transfer.source_work_item_id === id && lock.lock_kind === "file" && transfer.files.some((file) => normPath(file.path) === lock.path)));
    const hit = findLockRowOverlap(wiRows, held);
    if (hit) return orderWait(job, order.byId.get(id), hit);
  }
  const proof = reviewedDependencyProof(job.work_item_id, [...transfers.values()].flatMap((entry) =>
    [entry.source_work_item_id, ...entry.required_provenance.map((dep) => dep.source_work_item_id)]));
  if (!proof.ok) {
    const transfer = transfers.values().next().value;
    const holder = workItemLocks.find((lock) => lock.work_item_id === transfer?.source_work_item_id
      && transfer.files.some((file) => normPath(file.path) === lock.path));
    return wait(job, holder || { work_item_id: transfer?.source_work_item_id }, holder?.path || scope.files[0], proof.reason);
  }
  const proposedFiles = new Map();
  for (const transfer of transfers.values()) {
    for (const file of transfer.files) {
      const previous = proposedFiles.get(file.path);
      if (previous && previous !== transfer.receipt_id) return wait(job, { work_item_id: transfer.source_work_item_id }, file.path, REASONS.SCOPE);
      proposedFiles.set(file.path, transfer.receipt_id);
    }
  }
  return { conflict: null, transfers: [...transfers.values()] };
}

export function reserveReviewedHandoffs(job, transfers, leaseToken) {
  if (!transfers.length) return;
  const db = getDb();
  if (!db.inTransaction) throw new Error("Reviewed ownership transfer requires a lease transaction");
  const payload = parseJobPayload(job);
  const reserved = transfers.map((proposal) => ({ ...proposal, transfer_id: randomUUID(), reserved_at: now(), lease_token: leaseToken }));
  for (const entry of reserved) {
    for (const file of entry.files) {
      for (const source of [{ ...entry, source_work_item_id: entry.source_work_item_id }, ...entry.required_provenance.filter((dep) => !dep.path || dep.path === file.path)]) {
        const result = addCrossWiMergeDependency(job.work_item_id, source.source_work_item_id, {
          ...source, version: entry.version, transfer_id: entry.transfer_id,
          // The downstream reservation owns rollback; source proof continues
          // to name the upstream subset accepted by its source merge.
          source_transfer_id: source.source_transfer_id || source.transfer_id || entry.transfer_id,
          path: file.path, via_job_id: job.id,
        });
        if (!result.ok) throw new Error(`Reviewed handoff dependency rejected: ${result.reason}`);
      }
      db.prepare(`UPDATE work_item_file_locks SET released_at = ?, release_reason = 'reviewed_handoff'
        WHERE work_item_id = ? AND path = ? AND lock_kind = 'file' AND released_at IS NULL`)
        .run(now(), entry.source_work_item_id, normPath(file.path));
    }
  }
  payload._cross_wi_file_syncs = [...(payload._cross_wi_file_syncs || []), ...reserved];
  db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), job.id);
  for (const entry of reserved) logDurableEvent({ job_id: job.id, work_item_id: job.work_item_id,
    event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_PREPARED, actor_type: EVENT_ACTORS.SCHEDULER,
    message: `Reserved reviewed files from WI#${entry.source_work_item_id}`,
    event_json: JSON.stringify({ ...reviewedTransferTelemetry(entry),
      source_work_item_id: entry.source_work_item_id, source_commit: entry.source_commit,
      completed_at: entry.completed_at, reserved_at: entry.reserved_at, paths: entry.files.map((file) => file.path) }) });
  notifyQueueStateChanged({ reason: "reviewed_handoff_reserved", jobId: job.id, workItemId: job.work_item_id });
}
