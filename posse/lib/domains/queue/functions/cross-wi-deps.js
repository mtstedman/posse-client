// Cross-work-item merge dependency primitives.
//
// Stored as a JSON array on `work_items.metadata_json` under the
// CROSS_WI_MERGE_DEPENDENCIES_KEY. Each entry records that the
// target WI must wait for a specific source WI (and optionally a path)
// to merge before it can merge itself. The orchestrator uses this to
// keep cross-WI file handoffs honest without needing a second table.

import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction, TERMINAL_JOB_STATUSES_SQL } from "./common.js";
import { logDurableEvent, logEvent, flushEventsNow } from "./events.js";
import { parseJobPayload } from "./payload.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const CROSS_WI_MERGE_DEPENDENCIES_KEY = "cross_wi_merge_dependencies";
// Work-item metadata key: { at, reason, branch } of the last time the work
// item's branch was deleted with its content (review rejection, rebuild,
// abandon). Applied-sync records from before then describe content that is
// gone (collectCrossWiPathProvenance).
export const WORK_ITEM_BRANCH_RESET_KEY = "branch_reset";

function readWorkItem(id) {
  return getDb().prepare(`SELECT * FROM work_items WHERE id = ?`).get(id);
}

function readJob(id) {
  return getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

function resolveWorkItem(workItemOrId) {
  return typeof workItemOrId === "object" && workItemOrId !== null
    ? workItemOrId
    : readWorkItem(workItemOrId);
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

function parseWorkItemMetadata(workItemOrMetadata = null) {
  const raw = typeof workItemOrMetadata === "object" && workItemOrMetadata !== null && "metadata_json" in workItemOrMetadata
    ? workItemOrMetadata.metadata_json
    : workItemOrMetadata;
  if (!raw) return {};
  if (typeof raw === "object") return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeCrossWiMergeDependency(dep = {}) {
  const sourceId = Number(dep.source_work_item_id ?? dep.work_item_id ?? dep.id);
  if (!Number.isFinite(sourceId) || sourceId <= 0) return null;
  return {
    source_work_item_id: sourceId,
    path: normalizeRepoPath(dep.path) || null,
    ...(dep.lock_kind === "root" || dep.lock_kind === "file" ? { lock_kind: dep.lock_kind } : {}),
    source_branch: typeof dep.source_branch === "string" && dep.source_branch.trim()
      ? dep.source_branch.trim()
      : null,
    source_lock_id: dep.source_lock_id ?? null,
    via_job_id: dep.via_job_id ?? null,
    created_at: dep.created_at || now(),
  };
}

export function getWorkItemMergeDependencies(workItemOrId) {
  const workItem = resolveWorkItem(workItemOrId);
  const metadata = parseWorkItemMetadata(workItem);
  const deps = Array.isArray(metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY])
    ? metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY]
    : [];
  return deps.map(normalizeCrossWiMergeDependency).filter(Boolean);
}

/**
 * Return work items in a stable topological merge order.
 *
 * Cross-WI handoffs record dependencies on the downstream work item, so the
 * source WI must appear before that downstream WI in review and auto-merge
 * queues. Items without an in-list dependency retain their relative database
 * order. Cyclic leftovers are appended in their original order as a defensive
 * fallback; cycle creation is rejected when dependencies are recorded.
 */
export function orderWorkItemsByMergeDependencies(workItems = []) {
  const items = Array.isArray(workItems) ? [...workItems] : [];
  if (items.length < 2) return items;

  const byId = new Map();
  const originalIndex = new Map();
  for (let index = 0; index < items.length; index++) {
    const id = Number(items[index]?.id);
    if (!Number.isFinite(id) || byId.has(id)) continue;
    byId.set(id, items[index]);
    originalIndex.set(id, index);
  }

  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  const dependents = new Map([...byId.keys()].map((id) => [id, new Set()]));
  for (const item of items) {
    const targetId = Number(item?.id);
    if (!byId.has(targetId)) continue;
    for (const dependency of getWorkItemMergeDependencies(item)) {
      const sourceId = Number(dependency.source_work_item_id);
      if (!byId.has(sourceId) || sourceId === targetId) continue;
      const targets = dependents.get(sourceId);
      if (targets.has(targetId)) continue;
      targets.add(targetId);
      indegree.set(targetId, (indegree.get(targetId) || 0) + 1);
    }
  }

  const byOriginalOrder = (left, right) => (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0);
  const ready = [...byId.keys()].filter((id) => indegree.get(id) === 0).sort(byOriginalOrder);
  const orderedIds = [];
  while (ready.length > 0) {
    const sourceId = ready.shift();
    orderedIds.push(sourceId);
    const targets = [...(dependents.get(sourceId) || [])].sort(byOriginalOrder);
    for (const targetId of targets) {
      const remaining = (indegree.get(targetId) || 0) - 1;
      indegree.set(targetId, remaining);
      if (remaining === 0) {
        ready.push(targetId);
        ready.sort(byOriginalOrder);
      }
    }
  }

  const emitted = new Set(orderedIds);
  for (const item of items) {
    const id = Number(item?.id);
    if (byId.has(id) && !emitted.has(id)) {
      orderedIds.push(id);
      emitted.add(id);
    }
  }

  const ordered = orderedIds.map((id) => byId.get(id));
  const represented = new Set(ordered);
  return [...ordered, ...items.filter((item) => !represented.has(item))];
}

function findMergeDependencyPath(startWorkItemId, targetWorkItemId) {
  const start = Number(startWorkItemId);
  const target = Number(targetWorkItemId);
  if (!Number.isFinite(start) || !Number.isFinite(target)) return null;
  const db = getDb();
  const readWi = db.prepare(`SELECT id, metadata_json FROM work_items WHERE id = ?`);
  const stack = [{ id: start, path: [start] }];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    const row = readWi.get(current.id);
    if (!row) continue;
    for (const dep of getWorkItemMergeDependencies(row)) {
      const next = Number(dep.source_work_item_id);
      if (!Number.isFinite(next) || seen.has(next)) continue;
      const nextPath = [...current.path, next];
      if (next === target) return nextPath;
      stack.push({ id: next, path: nextPath });
    }
  }
  return null;
}

function repoPathsOverlap(left, right) {
  const a = normalizeRepoPath(left);
  const b = normalizeRepoPath(right);
  if (!a || !b) return false;
  if (a === "*" || a === "." || b === "*" || b === ".") return true;
  // Applied-sync records do not keep a lock kind, so a root (directory) entry
  // and a file entry overlap by prefix in either direction.
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A predicate for the applied-sync records of work item `workItemId` (on
 * rows `payloads`) that describe content its branch no longer holds: the
 * branch was deleted after they were applied, so the copied edits went with
 * it. Branch deletions record WORK_ITEM_BRANCH_RESET_KEY and drop the records
 * (queue-store discardCrossWiSyncRecordsForWorkItem); queues from before
 * that kept them. Live WI 170: review rejection deleted its branch and
 * requeued 2176, which still lists WI 167's planner.js/index.php syncs. Such
 * a legacy rejection left two marks: `_review_retry.rejected_at` on the
 * requeued jobs, and no merge dependency on the record's source (the
 * requeue cleared them). A rejection that keeps the branch (merge
 * verification "fail") keeps the dependencies, so its records still count.
 */
function staleAppliedSyncPredicate(workItemId, payloads) {
  const workItem = readWorkItem(workItemId);
  const resetAtMs = timestampMs(parseWorkItemMetadata(workItem)[WORK_ITEM_BRANCH_RESET_KEY]?.at);
  let legacyRejectedAtMs = null;
  for (const payload of payloads) {
    const rejectedAtMs = timestampMs(payload?._review_retry?.rejected_at);
    if (rejectedAtMs != null && (legacyRejectedAtMs == null || rejectedAtMs > legacyRejectedAtMs)) {
      legacyRejectedAtMs = rejectedAtMs;
    }
  }
  if (resetAtMs == null && legacyRejectedAtMs == null) return () => false;
  const dependencySources = new Set((workItem ? getWorkItemMergeDependencies(workItem) : [])
    .map((dep) => Number(dep.source_work_item_id)));
  return (entry) => {
    const appliedAtMs = timestampMs(entry?.applied_at);
    if (appliedAtMs == null) return false;
    if (resetAtMs != null && appliedAtMs <= resetAtMs) return true;
    return legacyRejectedAtMs != null
      && appliedAtMs < legacyRejectedAtMs
      && !dependencySources.has(Number(entry?.source_work_item_id));
  };
}

/**
 * Where a work item's current content of `path` came from, for cross-WI
 * handoffs of that path out of it:
 *
 * - `carried`: work items whose pending edits to the path travel inside its
 *   content (applied, not skipped, cross-WI syncs and recorded merge
 *   dependencies on the path, followed transitively). A WI that copies the
 *   path from it copies their edits too, so it must merge after each of them.
 * - `outstanding`: work items whose pending edits to the path are NOT in its
 *   content because they released the path to it without a sync (the
 *   "existing order" release: they merge after it and rebase onto it). A WI
 *   that copies the path now would edit without those edits and conflict
 *   with them at merge, so it must wait until they merge.
 *
 * Merged, canceled and failed work items are left out (nothing can or need
 * wait on their merge); the walk still passes through them. Applied-sync
 * records from before a work item's branch was deleted are ignored: that
 * content is gone (staleAppliedSyncPredicate).
 */
export function collectCrossWiPathProvenance(workItemId, path, { maxWorkItems = 32 } = {}) {
  const startId = Number(workItemId);
  const targetPath = normalizeRepoPath(path);
  if (!Number.isFinite(startId) || startId <= 0 || !targetPath) return { carried: [], outstanding: [] };
  const readJobPayloads = getDb().prepare(`SELECT payload_json FROM jobs WHERE work_item_id = ?`);
  const carriedIds = new Set();
  const outstandingIds = new Set();
  const visited = new Set([startId]);
  // Each frontier entry walks one work item's content provenance; `lacking`
  // marks content this branch does not hold (reached through a bare release),
  // so everything found beyond it is outstanding rather than carried.
  const queue = [{ id: startId, lacking: false }];
  while (queue.length > 0 && visited.size <= maxWorkItems) {
    const current = queue.shift();
    const contentSources = new Set();
    const releasedBy = new Set();
    const payloads = readJobPayloads.all(current.id).map(parseJobPayload);
    const appliedBeforeBranchReset = staleAppliedSyncPredicate(current.id, payloads);
    for (const payload of payloads) {
      const applied = Array.isArray(payload?._cross_wi_file_syncs_applied) ? payload._cross_wi_file_syncs_applied : [];
      for (const entry of applied) {
        if (entry?.change_kind === "skipped" || !repoPathsOverlap(entry?.path, targetPath)) continue;
        if (appliedBeforeBranchReset(entry)) continue;
        contentSources.add(Number(entry?.source_work_item_id));
      }
      const releases = Array.isArray(payload?._cross_wi_existing_order_releases) ? payload._cross_wi_existing_order_releases : [];
      for (const entry of releases) {
        if (repoPathsOverlap(entry?.path, targetPath)) releasedBy.add(Number(entry?.source_work_item_id));
      }
    }
    for (const dep of getWorkItemMergeDependencies(current.id)) {
      if (dep.path && repoPathsOverlap(dep.path, targetPath)) contentSources.add(Number(dep.source_work_item_id));
    }
    const visit = (sourceId, lacking) => {
      if (!Number.isFinite(sourceId) || sourceId <= 0) return;
      (lacking ? outstandingIds : carriedIds).add(sourceId);
      if (visited.has(sourceId)) return;
      visited.add(sourceId);
      queue.push({ id: sourceId, lacking });
    };
    for (const sourceId of contentSources) visit(sourceId, current.lacking);
    for (const sourceId of releasedBy) visit(sourceId, true);
  }
  const live = (id, { allowFailed }) => {
    if (id === startId) return null;
    const wi = readWorkItem(id);
    if (!wi || wi.merge_state === "merged" || wi.status === "canceled") return null;
    if (!allowFailed && wi.status === "failed") return null;
    return wi;
  };
  const describe = (wi) => ({
    source_work_item_id: Number(wi.id),
    source_branch: String(wi.branch_name || "").trim() || null,
  });
  const outstanding = [...outstandingIds]
    .map((id) => live(id, { allowFailed: false }))
    .filter(Boolean)
    .map(describe);
  const outstandingSet = new Set(outstanding.map((entry) => entry.source_work_item_id));
  const carried = [...carriedIds]
    .filter((id) => !outstandingSet.has(id))
    .map((id) => live(id, { allowFailed: true }))
    .filter(Boolean)
    .map(describe);
  return { carried, outstanding };
}

/**
 * True when `fromWorkItemId` cannot finish and merge until `toWorkItemId`
 * merges: it is ordered after it through merge dependencies, or one of its
 * queued jobs waits on a work-item lock that the target (transitively) holds.
 * A work item that holds a lock "until merge" must not make the target wait
 * on it when this is true, or neither can ever merge.
 *
 * Lane waits include work-item order waits (holder_type 'work_item' with the
 * work_item_order reason): a work item whose jobs wait in the order on the
 * target does wait on it, and the scheduler's cross-WI handoff needs that to
 * break a lock-holding cycle. The answer only ever releases a lock bare (no
 * content copy, no merge dependency); nothing unmerged is copied between work
 * items on its strength (run 1250b red team 2, finding 4: per-job order waits
 * once made an earlier work item copy a later one's file through this check).
 */
export function workItemWaitsOnWorkItem(fromWorkItemId, toWorkItemId, { maxWorkItems = 64 } = {}) {
  const startId = Number(fromWorkItemId);
  const targetId = Number(toWorkItemId);
  if (!Number.isFinite(startId) || !Number.isFinite(targetId) || startId <= 0 || targetId <= 0) {
    return { waits: false, path: [] };
  }
  if (startId === targetId) return { waits: true, path: [startId] };
  const db = getDb();
  const readLaneHolders = db.prepare(`
    SELECT DISTINCT w.holder_work_item_id
    FROM file_lane_waits w
    JOIN jobs j ON j.id = w.waiter_job_id
    WHERE w.waiter_work_item_id = ?
      AND w.holder_type = 'work_item'
      AND w.holder_work_item_id IS NOT NULL
      AND j.status = 'queued'
  `);
  const queue = [{ id: startId, path: [startId] }];
  const visited = new Set([startId]);
  while (queue.length > 0 && visited.size <= maxWorkItems) {
    const current = queue.shift();
    const next = new Set();
    const row = readWorkItem(current.id);
    for (const dep of row ? getWorkItemMergeDependencies(row) : []) {
      const source = readWorkItem(dep.source_work_item_id);
      if (source && source.merge_state !== "merged") next.add(Number(dep.source_work_item_id));
    }
    for (const lane of readLaneHolders.all(current.id)) next.add(Number(lane.holder_work_item_id));
    for (const id of next) {
      if (!Number.isFinite(id) || visited.has(id)) continue;
      const nextPath = [...current.path, id];
      if (id === targetId) return { waits: true, path: nextPath };
      visited.add(id);
      queue.push({ id, path: nextPath });
    }
  }
  return { waits: false, path: [] };
}

export function crossWiMergeDependencyWouldCycle(targetWorkItemId, sourceWorkItemId) {
  const targetId = Number(targetWorkItemId);
  const sourceId = Number(sourceWorkItemId);
  if (!Number.isFinite(targetId) || !Number.isFinite(sourceId) || targetId <= 0 || sourceId <= 0) {
    return { wouldCycle: true, path: [], reason: "invalid_work_item" };
  }
  if (targetId === sourceId) {
    return { wouldCycle: true, path: [targetId], reason: "self_dependency" };
  }
  const reversePath = findMergeDependencyPath(sourceId, targetId);
  if (reversePath) {
    return { wouldCycle: true, path: [targetId, ...reversePath], reason: "merge_order_cycle" };
  }
  return { wouldCycle: false, path: [], reason: "ok" };
}

export function addCrossWiMergeDependency(targetWorkItemId, sourceWorkItemId, details = {}) {
  const db = getDb();
  const execute = () => {
    const targetId = Number(targetWorkItemId);
    const sourceId = Number(sourceWorkItemId);
    if (!Number.isFinite(targetId) || !Number.isFinite(sourceId) || targetId <= 0 || sourceId <= 0 || targetId === sourceId) {
      return { ok: false, added: false, reason: "invalid_dependency" };
    }

    const target = readWorkItem(targetId);
    const source = readWorkItem(sourceId);
    if (!target || !source) return { ok: false, added: false, reason: "missing_work_item" };

    const cycleCheck = crossWiMergeDependencyWouldCycle(targetId, sourceId);
    if (cycleCheck.wouldCycle) {
      return { ok: false, added: false, reason: cycleCheck.reason, path: cycleCheck.path };
    }

    const metadata = parseWorkItemMetadata(target);
    const deps = Array.isArray(metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY])
      ? metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY].map(normalizeCrossWiMergeDependency).filter(Boolean)
      : [];
    const nextDep = normalizeCrossWiMergeDependency({
      ...details,
      source_work_item_id: sourceId,
      created_at: details.created_at || now(),
    });
    if (!nextDep) return { ok: false, added: false, reason: "invalid_dependency" };

    const existing = deps.find((dep) =>
      Number(dep.source_work_item_id) === sourceId
      && normalizeRepoPath(dep.path) === normalizeRepoPath(nextDep.path)
    );
    if (existing) {
      // Backfill lock_kind on rows persisted before kinds were recorded so a
      // re-prepared handoff repairs root-coverage matching for the stored
      // row. Absent-only: never flip an already-recorded kind.
      if (nextDep.lock_kind && !existing.lock_kind) {
        const repaired = { ...existing, lock_kind: nextDep.lock_kind };
        metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY] = deps.map((dep) => (dep === existing ? repaired : dep));
        db.prepare(`UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify(metadata), now(), targetId);
        return { ok: true, added: false, dependency: repaired };
      }
      return { ok: true, added: false, dependency: existing };
    }

    metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY] = [...deps, nextDep];
    db.prepare(`UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(metadata), now(), targetId);
    return { ok: true, added: true, dependency: nextDep };
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function removeCrossWiMergeDependency(targetWorkItemId, sourceWorkItemId, { path = null, reason = "dependency_removed" } = {}) {
  const db = getDb();
  const execute = () => {
    const targetId = Number(targetWorkItemId);
    const sourceId = Number(sourceWorkItemId);
    if (!Number.isFinite(targetId) || !Number.isFinite(sourceId) || targetId <= 0 || sourceId <= 0) {
      return { ok: false, removed: 0, reason: "invalid_dependency" };
    }
    const target = readWorkItem(targetId);
    if (!target) return { ok: false, removed: 0, reason: "missing_work_item" };
    const metadata = parseWorkItemMetadata(target);
    const deps = Array.isArray(metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY])
      ? metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY].map(normalizeCrossWiMergeDependency).filter(Boolean)
      : [];
    const normalizedPath = normalizeRepoPath(path);
    const kept = deps.filter((dep) => {
      if (Number(dep.source_work_item_id) !== sourceId) return true;
      if (normalizedPath && normalizeRepoPath(dep.path) !== normalizedPath) return true;
      return false;
    });
    const removed = deps.length - kept.length;
    if (removed === 0) return { ok: true, removed: 0, reason: "not_found" };
    if (kept.length > 0) metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY] = kept;
    else delete metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY];
    db.prepare(`UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?`)
      .run(Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null, now(), targetId);
    logEvent({
      work_item_id: targetId,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_REMOVED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Removed cross-WI merge dependency on WI#${sourceId}${normalizedPath ? ` for ${normalizedPath}` : ""}`,
      event_json: JSON.stringify({ source_work_item_id: sourceId, path: normalizedPath || null, reason, removed }),
    });
    return { ok: true, removed, reason };
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function clearCrossWiMergeDependenciesForWorkItem(workItemId, reason = "work_item_merged") {
  const db = getDb();
  const execute = () => {
    const wiId = Number(workItemId);
    if (!Number.isFinite(wiId) || wiId <= 0) return { ok: false, removed: 0, reason: "invalid_work_item" };
    const wi = readWorkItem(wiId);
    if (!wi) return { ok: false, removed: 0, reason: "missing_work_item" };
    const metadata = parseWorkItemMetadata(wi);
    const deps = Array.isArray(metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY])
      ? metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY].map(normalizeCrossWiMergeDependency).filter(Boolean)
      : [];
    if (deps.length === 0) return { ok: true, removed: 0, reason: "none" };
    delete metadata[CROSS_WI_MERGE_DEPENDENCIES_KEY];
    db.prepare(`UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?`)
      .run(Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null, now(), wiId);
    logEvent({
      work_item_id: wiId,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_MERGE_DEPENDENCIES_CLEARED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Cleared ${deps.length} cross-WI merge dependenc${deps.length === 1 ? "y" : "ies"} after ${reason}`,
      event_json: JSON.stringify({ reason, removed: deps.length }),
    });
    return { ok: true, removed: deps.length, reason };
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

function logStaleCrossWiDependencyOnce(targetWorkItemId, sourceWorkItemId, reason, source = null) {
  // Flush pending batched events so the dedupe check below sees them.
  flushEventsNow();
  const db = getDb();
  const key = `${targetWorkItemId}:${sourceWorkItemId}:${reason}`;
  const previous = db.prepare(`
    SELECT 1
    FROM queue_event_state
    WHERE work_item_id = ?
      AND event_type = ?
      AND json_extract(event_json, '$.dedupe_key') = ?
    LIMIT 1
  `).get(targetWorkItemId, EVENT_TYPES.WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_STALE, key);
  if (previous) return;
  logDurableEvent({
    work_item_id: targetWorkItemId,
    event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_STALE,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Cross-WI merge dependency on WI#${sourceWorkItemId} is stale (${reason})`,
    event_json: JSON.stringify({
      visible: true,
      dedupe_key: key,
      source_work_item_id: sourceWorkItemId,
      source_status: source?.status || null,
      source_merge_state: source?.merge_state || null,
      reason,
    }),
  });
}

function hasUnresolvedJobsForWorkItem(workItemId) {
  const db = getDb();
  return !!db.prepare(`
    SELECT 1
    FROM jobs
    WHERE work_item_id = ?
      AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
    LIMIT 1
  `).get(workItemId);
}

function pendingCrossWiFileSyncsForJob(job = {}) {
  const payload = parseJobPayload(job);
  return (Array.isArray(payload?._cross_wi_file_syncs) ? payload._cross_wi_file_syncs : [])
    .map((entry) => ({
      ...entry,
      path: normalizeRepoPath(entry?.path),
      source_work_item_id: Number(entry?.source_work_item_id),
      source_branch: typeof entry?.source_branch === "string" ? entry.source_branch.trim() : null,
    }))
    .filter((entry) => entry.path && entry.source_branch && Number.isFinite(entry.source_work_item_id));
}

// `filter` limits the rollback to some pending syncs (the rest stay pending).
export function rollbackPendingCrossWiSyncHandoffsForJob(jobOrId, reason = "job_terminal_before_sync", { filter = null } = {}) {
  const db = getDb();
  const execute = () => {
    const inputJob = typeof jobOrId === "object" && jobOrId !== null ? jobOrId : null;
    const jobId = Number(inputJob?.id ?? jobOrId);
    const job = Number.isFinite(jobId) ? (readJob(jobId) || inputJob) : inputJob;
    if (!job?.id) return { ok: false, rolled_back: 0, reason: "missing_job" };
    const pending = pendingCrossWiFileSyncsForJob(job);
    const syncs = typeof filter === "function" ? pending.filter(filter) : pending;
    if (syncs.length === 0) return { ok: true, rolled_back: 0, reason: "none" };
    let rolledBack = 0;
    for (const sync of syncs) {
      // Do not re-acquire the source WI file lock here: the handoff already
      // moved cross-WI ordering onto dependency metadata, which this removes.
      const removed = removeCrossWiMergeDependency(job.work_item_id, sync.source_work_item_id, {
        path: sync.path,
        reason,
      });
      if (removed.ok && removed.removed > 0) rolledBack += removed.removed;
      // Dependencies this handoff added for work items whose edits travel in
      // the source's content (only the ones it created, never pre-existing).
      const carriedIds = Array.isArray(sync.carried_dependency_work_item_ids) ? sync.carried_dependency_work_item_ids : [];
      for (const carriedId of carriedIds) {
        const carriedRemoved = removeCrossWiMergeDependency(job.work_item_id, carriedId, {
          path: sync.path,
          reason,
        });
        if (carriedRemoved.ok && carriedRemoved.removed > 0) rolledBack += carriedRemoved.removed;
      }
    }
    const payload = parseJobPayload(job);
    payload._cross_wi_file_syncs_rolled_back = [
      ...(Array.isArray(payload._cross_wi_file_syncs_rolled_back) ? payload._cross_wi_file_syncs_rolled_back : []),
      ...syncs.map((sync) => ({
        path: sync.path,
        source_work_item_id: sync.source_work_item_id,
        source_branch: sync.source_branch,
        reason,
        rolled_back_at: now(),
      })),
    ];
    const syncKey = (entry) => `${Number(entry?.source_work_item_id)}:${normalizeRepoPath(entry?.path)}`;
    const rolledBackKeys = new Set(syncs.map(syncKey));
    const kept = (Array.isArray(payload._cross_wi_file_syncs) ? payload._cross_wi_file_syncs : [])
      .filter((entry) => !rolledBackKeys.has(syncKey(entry)));
    if (kept.length > 0) payload._cross_wi_file_syncs = kept;
    else delete payload._cross_wi_file_syncs;
    db.prepare(`UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(payload), now(), job.id);
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.WORK_ITEM_CROSS_WI_FILE_HANDOFF_ROLLED_BACK,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Rolled back ${rolledBack} pending cross-WI file handoff dependency record(s)`,
      event_json: JSON.stringify({
        visible: true,
        reason,
        syncs: syncs.map((sync) => ({
          path: sync.path,
          source_work_item_id: sync.source_work_item_id,
          source_branch: sync.source_branch,
        })),
        rolled_back: rolledBack,
      }),
    });
    return { ok: true, rolled_back: rolledBack, reason };
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function listCrossWiMergeBlockers(workItemOrId) {
  const workItem = resolveWorkItem(workItemOrId);
  if (!workItem) return [];
  const bySource = new Map();
  for (const dep of getWorkItemMergeDependencies(workItem)) {
    const sourceId = Number(dep.source_work_item_id);
    if (!Number.isFinite(sourceId)) continue;
    if (!bySource.has(sourceId)) {
      bySource.set(sourceId, { source_work_item_id: sourceId, paths: [], dependency: dep });
    }
    if (dep.path) bySource.get(sourceId).paths.push(dep.path);
  }

  const blockers = [];
  for (const entry of bySource.values()) {
    const source = readWorkItem(entry.source_work_item_id);
    if (source?.status === "canceled") {
      logStaleCrossWiDependencyOnce(workItem.id, entry.source_work_item_id, "upstream_canceled", source);
    }
    if (source?.status === "failed" && !hasUnresolvedJobsForWorkItem(source.id)) {
      logStaleCrossWiDependencyOnce(workItem.id, entry.source_work_item_id, "upstream_failed", source);
    }
    if (!source || source.merge_state !== "merged") {
      blockers.push({
        ...entry,
        source_work_item: source || null,
        reason: !source
          ? "upstream_missing"
          : source.status === "canceled"
            ? "upstream_canceled"
            : source.status === "failed" && !hasUnresolvedJobsForWorkItem(source.id)
              ? "upstream_failed"
              : "upstream_not_merged",
      });
    }
  }
  return blockers;
}

/**
 * Upstream work items this one must merge after that are still in flight (not
 * merged, failed or canceled). While any remain, an automatic merge can only
 * be deferred, so callers skip it quietly instead of authorizing, deferring
 * and releasing it on every pass (NEW-L1). A failed, canceled or missing
 * upstream is not in flight: a merge authorization still goes through the
 * deferral path, which reports the stale dependency.
 *
 * `includeStale` also returns failed and canceled upstreams. Such a merge
 * defers just the same until the operator recovers the upstream or rebuilds
 * this work item through its cross-WI upstream gate, so the auto-merge pass
 * skips it quietly too, including after the gate was answered "wait".
 */
export function pendingCrossWiMergeUpstreamIds(workItemOrId, { includeStale = false } = {}) {
  const workItem = resolveWorkItem(workItemOrId);
  if (!workItem) return [];
  const ids = new Set();
  for (const dep of getWorkItemMergeDependencies(workItem)) {
    const source = readWorkItem(dep.source_work_item_id);
    if (!source || source.merge_state === "merged") continue;
    if (!includeStale && (source.status === "failed" || source.status === "canceled")) continue;
    ids.add(Number(source.id));
  }
  return [...ids];
}

export function getWorkItemRecycleOverride(workItemOrId) {
  const workItem = resolveWorkItem(workItemOrId);
  const value = String(workItem?.session_recycle || "").trim().toLowerCase();
  if (value === "on") return "dev-fix";
  if (value === "off") return "off";
  return null;
}
