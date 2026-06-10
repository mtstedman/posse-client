// Cross-work-item merge dependency primitives.
//
// Stored as a JSON array on `work_items.metadata_json` under the
// CROSS_WI_MERGE_DEPENDENCIES_KEY. Each entry records that the
// target WI must wait for a specific source WI (and optionally a path)
// to merge before it can merge itself. The orchestrator uses this to
// keep cross-WI file handoffs honest without needing a second table.

import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction, TERMINAL_JOB_STATUSES_SQL } from "./common.js";
import { logEvent, flushEventsNow } from "./events.js";
import { parseJobPayload } from "./payload.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const CROSS_WI_MERGE_DEPENDENCIES_KEY = "cross_wi_merge_dependencies";

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
    if (existing) return { ok: true, added: false, dependency: existing };

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
    FROM events
    WHERE work_item_id = ?
      AND event_type = ?
      AND json_extract(event_json, '$.dedupe_key') = ?
    LIMIT 1
  `).get(targetWorkItemId, EVENT_TYPES.WORK_ITEM_CROSS_WI_MERGE_DEPENDENCY_STALE, key);
  if (previous) return;
  logEvent({
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

export function rollbackPendingCrossWiSyncHandoffsForJob(jobOrId, reason = "job_terminal_before_sync") {
  const db = getDb();
  const execute = () => {
    const inputJob = typeof jobOrId === "object" && jobOrId !== null ? jobOrId : null;
    const jobId = Number(inputJob?.id ?? jobOrId);
    const job = Number.isFinite(jobId) ? (readJob(jobId) || inputJob) : inputJob;
    if (!job?.id) return { ok: false, rolled_back: 0, reason: "missing_job" };
    const syncs = pendingCrossWiFileSyncsForJob(job);
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
    delete payload._cross_wi_file_syncs;
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
      continue;
    }
    if (source?.status === "failed" && !hasUnresolvedJobsForWorkItem(source.id)) {
      logStaleCrossWiDependencyOnce(workItem.id, entry.source_work_item_id, "upstream_failed", source);
      continue;
    }
    if (!source || source.merge_state !== "merged") {
      blockers.push({
        ...entry,
        source_work_item: source || null,
        reason: source ? "upstream_not_merged" : "upstream_missing",
      });
    }
  }
  return blockers;
}

export function getWorkItemRecycleOverride(workItemOrId) {
  const workItem = resolveWorkItem(workItemOrId);
  const value = String(workItem?.session_recycle || "").trim().toLowerCase();
  if (value === "on") return "dev-fix";
  if (value === "off") return "off";
  return null;
}
