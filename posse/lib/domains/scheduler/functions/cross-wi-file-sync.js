// @ts-check

import { logEvent, releaseWorkItemFileLockForPath, updateJobPayload, getJob, getWorkItem, crossWiMergeDependencyWouldCycle, crossWiSyncSourceRejection, collectCrossWiPathProvenance, describeWorkItemMergeParking, workItemMergeParking, workItemWaitsOnWorkItem, workItemCanReleaseFileLock, recordFileLaneWait, parseJobPayload, runImmediateTransaction } from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { isSequenceAllocationPath } from "../../../catalog/sequence-allocation.js";
import { REVIEWED_HANDOFF_REASONS } from "../../../catalog/reviewed-handoffs.js";
import { handoffCandidateCoversPath, normalizeHandoffPath } from "./lock-timing.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

export const OPERATOR_PARKED_REJECTED_LOCK_RELEASE_MS = 15 * 60_000;

export function parseLockMetadata(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function prepareCrossWiFileSyncHandoff(job, conflict, ownerId, { recordWait = true } = {}) {
  if (!job || conflict?.type !== "work_item") return false;
  const lockKind = conflict.lock?.lock_kind;
  if (lockKind !== "file" && lockKind !== "root") return false;
  if (lockKind === "root" && conflict.candidate?.lock_kind !== "root") return false;

  const lockPath = normalizeHandoffPath(conflict.lock?.path);
  if (!lockPath || !handoffCandidateCoversPath(conflict.candidate, lockPath)) return false;
  if (lockKind === "root" && (lockPath === "*" || lockPath === ".")) return false;
  const path = lockPath;

  const sourceWiId = Number(conflict.lock?.work_item_id);
  if (!Number.isFinite(sourceWiId) || sourceWiId === Number(job.work_item_id)) return false;

  const sourceWi = getWorkItem(sourceWiId);
  const sourceBranch = String(sourceWi?.branch_name || "").trim();
  if (!sourceWi || !sourceBranch) return false;
  // A failed or canceled work item's content is abandoned (its locks are
  // released with it); never hand anything out of it.
  if (sourceWi.status === "failed" || sourceWi.status === "canceled") return false;
  const holderParking = workItemMergeParking(sourceWi);
  const sourceRejection = crossWiSyncSourceRejection(sourceWiId, path, lockKind);
  const parkedAtMs = Date.parse(holderParking?.parked_at || "");
  const releaseRejectedParkedLock = holderParking?.reason === "operator_gate"
    && sourceRejection != null
    && Number.isFinite(parkedAtMs)
    && Date.now() - parkedAtMs >= OPERATOR_PARKED_REJECTED_LOCK_RELEASE_MS;

  const recordBlocked = (message, eventDetail) => {
    if (!recordWait) return false;
    const normalizedBlockers = Array.isArray(eventDetail?.blockers)
      ? eventDetail.blockers.slice(0, 10).map((blocker) => ({
          job_id: blocker.job_id ?? blocker.id ?? null,
          status: blocker.job_status ?? blocker.status ?? null,
          job_type: blocker.job_type ?? null,
          path: blocker.path ?? null,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : [];
    const detail = {
      source_work_item_id: sourceWiId,
      path,
      lock_kind: lockKind,
      ...eventDetail,
      ...(normalizedBlockers.length > 0 ? { blockers: normalizedBlockers } : {}),
    };
    const wait = recordFileLaneWait({
      waiter_job_id: job.id,
      waiter_work_item_id: job.work_item_id,
      holder_type: "work_item",
      holder_job_id: conflict.lock?.job_id || null,
      holder_work_item_id: sourceWiId,
      path,
      lock_kind: lockKind,
      wait_state: detail,
    });
    if (wait?.transition === "created" || wait?.transition === "changed") {
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_BLOCKED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        actor_id: ownerId,
        message,
        event_json: JSON.stringify(detail),
      });
    }
    return false;
  };

  const releaseCheck = workItemCanReleaseFileLock(sourceWiId, path, lockKind, {
    allowOperatorParked: releaseRejectedParkedLock,
  });
  if (!releaseCheck.ok) {
    return recordBlocked(
      `Cross-WI handoff skipped for ${path}; WI#${sourceWiId} still has ${releaseCheck.blockers.length} unresolved writer(s)`,
      { reason: releaseCheck.reason, blockers: releaseCheck.blockers },
    );
  }

  const mergeOrderCheck = crossWiMergeDependencyWouldCycle(job.work_item_id, sourceWiId);
  // "Existing order": the holder is already ordered to merge after this WI
  // (it synced something from it). The reverse dependency would cycle, and
  // keeping the lock until the holder merges would deadlock, so the lock is
  // released to this WI without a content copy; the holder later rebases its
  // own commits onto this WI's merge. Copying the holder's content here
  // instead would make that rebase replay its commits onto their own final
  // state. The holder's pending edits stay claimed, though: the release is
  // recorded on this job, a later handoff of the path out of this WI waits
  // until the holder merges, and when this WI merges the holder gets its lock
  // back (queue file-locks restoreExistingOrderClaimLocks). Before, the
  // release was bare and a third WI synced the path from this WI without the
  // holder's edits (H8).
  const existingOrder = mergeOrderCheck.wouldCycle && mergeOrderCheck.reason === "merge_order_cycle";
  if (mergeOrderCheck.wouldCycle && !existingOrder) {
    return recordBlocked(
      `Cross-WI handoff skipped for ${path}; merge order would become cyclic`,
      { reason: mergeOrderCheck.reason, merge_order_path: mergeOrderCheck.path },
    );
  }

  const requesterWiId = Number(job.work_item_id);
  // Work items whose pending edits to the path the holder's content lacks
  // (they released the path to it bare). Taking the path now would edit it
  // without those edits, which then conflict with them at merge.
  const provenance = collectCrossWiPathProvenance(sourceWiId, path);
  if (provenance.complete === false) return recordBlocked(`Cross-WI handoff held for ${path}; provenance walk is incomplete`, { reason: REVIEWED_HANDOFF_REASONS.INCOMPLETE });
  const outstanding = provenance.outstanding
    .filter((entry) => entry.source_work_item_id !== requesterWiId);

  // Holds until merge: a sequence-allocation file (version pin, migration
  // manifest) stays with its holder, since two WIs that bump from one base
  // claim the same number (H7); a path whose holder lacks another WI's
  // pending edits waits for that WI (H8). After the merge, the waiting dev job
  // merges the target into its worktree before it starts. A hold is dropped
  // only for a WI that itself waits on this one (it would deadlock).
  const holds = [
    ...(lockKind === "file" && isSequenceAllocationPath(path)
      ? [{ work_item_id: sourceWiId, reason: "sequence_allocation_held_until_merge" }]
      : []),
    // A lock given back to an existing-order holder when the WI it released
    // the path to merged: the holder's edits are still pending.
    ...(parseLockMetadata(conflict.lock?.metadata_json)?.hold_until_merge === true
      ? [{ work_item_id: sourceWiId, reason: "existing_order_claim_held_until_merge" }]
      : []),
    ...outstanding.map((entry) => ({
      work_item_id: entry.source_work_item_id,
      reason: "unsynced_upstream_edits_pending_merge",
    })),
  ];
  const deadlockedHolds = [];
  const blockingHolds = [];
  for (const hold of holds) {
    const waits = workItemWaitsOnWorkItem(hold.work_item_id, requesterWiId);
    if (waits.waits) deadlockedHolds.push({ ...hold, wait_path: waits.path });
    else blockingHolds.push(hold);
  }
  if (blockingHolds.length > 0) {
    const pendingIds = [...new Set(blockingHolds.map((hold) => hold.work_item_id))];
    const reason = blockingHolds[0].reason;
    const message = reason === "sequence_allocation_held_until_merge"
      ? `Cross-WI handoff held for ${path}; sequence-allocation file stays with WI#${sourceWiId} until it merges`
      : reason === "existing_order_claim_held_until_merge"
        ? `Cross-WI handoff held for ${path}; WI#${sourceWiId} keeps it for its pending edits until it merges`
        : `Cross-WI handoff held for ${path}; WI#${sourceWiId}'s copy lacks pending edits from ${pendingIds.map((id) => `WI#${id}`).join(", ")} until ${pendingIds.length === 1 ? "it merges" : "they merge"}`;
    return recordBlocked(message, { reason, pending_work_item_ids: pendingIds });
  }
  // Nothing unmerged is ever copied between work items (NEW-H5). Overlapping
  // work items are ordered per work item before any lock is taken (queue
  // work-item-order.js), so a requester reaches another work item's idle lock
  // here only when:
  //   - the holder itself waits on the requester: a lock-holding cycle the
  //     order had to break (two started work items each later planned files
  //     the other holds), or a chain left by earlier syncs. Holding the lock
  //     would deadlock, so it is released bare, like an existing-order
  //     release: the requester edits the path from its own base, the
  //     holder's edits stay claimed (the release is recorded on this job, a
  //     later handoff out of this work item waits for them, and the holder
  //     gets its lock back when this work item merges), and the holder's
  //     waiting job starts after this one merges, from the target. This used
  //     to copy the holder's content and record a merge dependency unless its
  //     writer had been rejected; a later review rejection, rebuild or merge
  //     review "fail" of the holder then left the requester carrying
  //     discarded hunks with no gate (run 1250b red team 2, finding 1);
  //   - or the holder is a completed work item parked until an operator acts
  //     (an open gate, a failed merge, a failed upstream, automatic merge off;
  //     queue workItemMergeParking), which is not in the work-item order. The
  //     job waits: the scheduler finishes the run as needs-action naming the
  //     parked work item and its gate, and once the operator settles it (it
  //     merges, or fails or is canceled and its locks release) this work item
  //     builds on the target. Copying its content instead (the handoff from
  //     before work items were ordered) shipped its discarded hunks when the
  //     operator then rejected or rebuilt it (finding 1).
  // Anything else waits for the holder to merge and then builds on the
  // target.
  //
  // A bare release records no merge dependency, yet both work items end up
  // with edits to the path. The holder only gets here while it waits on this
  // work item, so its waiting job starts after this one merges, and dev/fix
  // setup merges that target in first (conflicts are handed to the dev). If
  // that job goes away and the holder finishes first, whichever merges second
  // is refreshed onto the target at close-out, and a true overlap fails that
  // merge for review rather than landing silently.
  let holderWaitPath = null;
  if (!existingOrder) {
    const holderWaits = workItemWaitsOnWorkItem(sourceWiId, requesterWiId);
    if ("complete" in holderWaits && holderWaits.complete === false) return recordBlocked(`Cross-WI handoff held for ${path}; dependency walk is incomplete`, { reason: REVIEWED_HANDOFF_REASONS.INCOMPLETE });
    if (!holderWaits.waits) {
      if (holderParking && !releaseRejectedParkedLock) {
        return recordBlocked(
          `Cross-WI handoff held for ${path}; ${describeWorkItemMergeParking(holderParking)}, so this work item waits until it merges and then builds on the target`,
          { reason: "upstream_parked", holder_parking: holderParking },
        );
      }
      if (!releaseRejectedParkedLock) {
        return recordBlocked(
          `Cross-WI handoff declined for ${path}; WI#${sourceWiId} keeps it until it merges, then this work item builds on the target`,
          { reason: "upstream_merge_pending" },
        );
      }
      holderWaitPath = `operator_gate:${holderParking.gate_job_id}`;
    } else {
      holderWaitPath = holderWaits.path;
    }
  }

  const db = getDb();
  const applyHandoff = () => {
    const currentReleaseCheck = workItemCanReleaseFileLock(sourceWiId, path, lockKind, {
      allowOperatorParked: releaseRejectedParkedLock,
    });
    if (!currentReleaseCheck.ok) {
      return { ok: false, released: 0, reason: currentReleaseCheck.reason };
    }

    const released = releaseWorkItemFileLockForPath(
      sourceWiId,
      path,
      lockKind,
      existingOrder
        ? `cross_wi_existing_order_to_wi_${job.work_item_id}_job_${job.id}`
        : `cross_wi_order_release_to_wi_${job.work_item_id}_job_${job.id}`,
    );
    if (released <= 0) return { ok: false, released: 0 };

    // The holder's pending edits stay claimed: recorded on this job, they
    // hold later handoffs out of this work item and give the holder its lock
    // back when this work item merges (queue file-locks
    // restoreExistingOrderClaimLocks).
    const freshJob = getJob(job.id) || job;
    const payload = parseJobPayload(freshJob);
    const listKey = "_cross_wi_existing_order_releases";
    const existing = Array.isArray(payload[listKey]) ? payload[listKey] : [];
    const existingIndex = existing.findIndex((entry) =>
      normalizeHandoffPath(entry?.path) === path
      && Number(entry?.source_work_item_id) === sourceWiId
    );
    if (existingIndex < 0) {
      payload[listKey] = [
        ...existing,
        {
          path,
          lock_kind: lockKind,
          source_work_item_id: sourceWiId,
          source_branch: sourceBranch,
          source_lock_id: conflict.lock?.id ?? null,
          ...(sourceRejection ? { source_rejection: sourceRejection } : {}),
          ...(holderWaitPath ? { holder_wait_path: holderWaitPath } : {}),
          prepared_at: new Date().toISOString(),
        },
      ];
      updateJobPayload(job.id, JSON.stringify(payload));
    }

    return { ok: true, released };
  };

  let handoff;
  try {
    // Route through runImmediateTransaction (not a raw db.transaction) so the
    // deferred wake emissions the lock release + payload update queue while
    // db.inTransaction get flushed on commit / discarded on rollback. A native
    // db.transaction bypasses those lifecycle hooks, which would leak a
    // released-lock wake into the next unrelated commit (index drops a
    // still-held lock) or drop a real one on an unrelated rollback.
    handoff = runImmediateTransaction(db, applyHandoff);
  } catch (err) {
    return recordBlocked(
      `Cross-WI handoff skipped for ${path}; ${err?.message || err}`,
      { reason: "handoff_record_failed", error: err?.message || String(err) },
    );
  }
  if (!handoff.ok) {
    return recordBlocked(
      existingOrder
        ? `Cross-WI handoff skipped for ${path}; existing-order lock release found no active lock`
        : `Cross-WI handoff skipped for ${path}; ${handoff.reason || "source lock was no longer releasable"}`,
      {
        reason: handoff.reason || "lock_release_failed",
        ...(existingOrder ? { existing_merge_order: true, merge_order_path: mergeOrderCheck.path } : {}),
      },
    );
  }

  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_PREPARED,
    actor_type: EVENT_ACTORS.SCHEDULER,
    actor_id: ownerId,
    message: existingOrder
      ? `Released downstream lock for ${path}; WI#${sourceWiId} is already ordered after WI#${job.work_item_id} (its pending edits stay claimed until it merges)`
      : releaseRejectedParkedLock
        ? `Released WI#${sourceWiId}'s unreviewed lock on ${path} after 15 minutes parked on gate #${holderParking.gate_job_id}; no content was copied and its pending edits stay claimed until it resumes and merges`
      : `Released WI#${sourceWiId}'s idle lock on ${path} without its content${sourceRejection ? ` (${sourceRejection})` : ""}; WI#${sourceWiId} waits on WI#${job.work_item_id}, so holding it would deadlock, and its pending edits stay claimed until it merges`,
    event_json: JSON.stringify({
      source_work_item_id: sourceWiId,
      source_branch: sourceBranch,
      path,
      lock_kind: lockKind,
      released: handoff.released,
      merge_dependency_added: false,
      pending_claim_recorded: true,
      ...(releaseRejectedParkedLock ? { operator_parked_release: true, gate_job_id: holderParking.gate_job_id } : {}),
      ...(existingOrder ? { existing_merge_order: true, merge_order_path: mergeOrderCheck.path } : { holder_wait_path: holderWaitPath }),
      ...(sourceRejection ? { source_rejection: sourceRejection } : {}),
      ...(deadlockedHolds.length > 0
        ? {
          holds_skipped_to_avoid_deadlock: deadlockedHolds.map((hold) => ({
            work_item_id: hold.work_item_id,
            reason: hold.reason,
            wait_path: hold.wait_path,
          })),
        }
        : {}),
    }),
  });
  return true;
}
