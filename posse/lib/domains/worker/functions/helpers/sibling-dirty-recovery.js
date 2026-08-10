// Durable linkage between sibling-owned dirt deferred by scoped commits and
// the recovery snapshot that eventually preserves it.

import {
  getEventsByWorkItem,
  getJob,
} from "../../../queue/functions/index.js";
import { logDurableEvent } from "../../../queue/functions/events.js";
import { TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";

const UNSUCCESSFUL_TERMINAL_JOB_STATUSES = new Set(
  TERMINAL_JOB_STATUSES.filter((status) => status !== "succeeded"),
);

function parseEventJson(event) {
  try {
    return typeof event?.event_json === "string"
      ? JSON.parse(event.event_json)
      : (event?.event_json || {});
  } catch {
    return {};
  }
}

function pathOwnerKey(ownerJobId, file) {
  return `${ownerJobId}:${file}`;
}

function eventId(value) {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function siblingEntriesFromEvent(event) {
  if (event?.event_type !== EVENT_TYPES.JOB_SCOPE_SIBLING_DIRTY_SKIPPED) return [];
  const payload = parseEventJson(event);
  const entries = [
    ...(Array.isArray(payload.dirty) ? payload.dirty : []),
    ...(Array.isArray(payload.untracked) ? payload.untracked : []),
    ...(Array.isArray(payload.staging) ? payload.staging : []),
    ...(Array.isArray(payload.entries) ? payload.entries : []),
  ];
  return entries.map((entry) => ({
    path: String(entry?.file || entry?.path || "").replace(/\\/g, "/").replace(/^\.\//, "").trim(),
    owner_job_id: Number(entry?.job_id),
    source_event_id: eventId(event?.id),
    source_job_id: event?.job_id ?? null,
  })).filter((entry) => entry.path && Number.isFinite(entry.owner_job_id));
}

function recoveredEntriesFromEvent(event) {
  if (event?.event_type !== EVENT_TYPES.WORKTREE_SIBLING_DIRTY_RECOVERED) return [];
  const payload = parseEventJson(event);
  return (Array.isArray(payload.entries) ? payload.entries : [])
    .map((entry) => ({
      path: String(entry?.path || entry?.file || "").replace(/\\/g, "/").replace(/^\.\//, "").trim(),
      owner_job_id: Number(entry?.owner_job_id ?? entry?.job_id),
      source_event_id: eventId(entry?.source_event_id),
    }))
    .filter((entry) => entry.path && Number.isFinite(entry.owner_job_id));
}

function ownerNeedsRecovery(ownerJobId, explicitOwnerJobIds) {
  if (explicitOwnerJobIds) return explicitOwnerJobIds.has(ownerJobId);
  const owner = getJob(ownerJobId);
  return UNSUCCESSFUL_TERMINAL_JOB_STATUSES.has(owner?.status);
}

function linkSiblingDirtyRecoverySnapshotInternal({
  workItemId,
  snapshotDir,
  jobId = null,
  reason = "dirty-worktree-recovery",
  ownerJobIds = null,
} = {}) {
  if (!workItemId || !snapshotDir) return [];
  const snapshotRef = String(snapshotDir);
  const explicitOwnerJobIds = Array.isArray(ownerJobIds)
    ? new Set(ownerJobIds.map(Number).filter(Number.isFinite))
    : null;
  const events = getEventsByWorkItem(workItemId, 1000);
  const recoveredThrough = new Map();
  for (const entry of events.flatMap(recoveredEntriesFromEvent)) {
    const key = pathOwnerKey(entry.owner_job_id, entry.path);
    const sourceEventId = entry.source_event_id ?? Number.POSITIVE_INFINITY;
    recoveredThrough.set(key, Math.max(recoveredThrough.get(key) ?? 0, sourceEventId));
  }
  const selected = new Map();
  for (const entry of events.flatMap(siblingEntriesFromEvent)) {
    const key = pathOwnerKey(entry.owner_job_id, entry.path);
    const recoveredSourceEventId = recoveredThrough.get(key);
    if (recoveredSourceEventId != null && (entry.source_event_id == null || entry.source_event_id <= recoveredSourceEventId)) continue;
    if (selected.has(key)) continue;
    if (!ownerNeedsRecovery(entry.owner_job_id, explicitOwnerJobIds)) continue;
    selected.set(key, entry);
  }
  const entries = [...selected.values()];
  if (entries.length === 0) return [];

  const ownerCount = new Set(entries.map((entry) => entry.owner_job_id)).size;
  logDurableEvent({
    work_item_id: workItemId,
    job_id: jobId,
    event_type: EVENT_TYPES.WORKTREE_SIBLING_DIRTY_RECOVERED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Preserved ${entries.length} sibling-deferred path(s) from ${ownerCount} unsuccessful owner job(s) in snapshot ${snapshotRef}`,
    event_json: JSON.stringify({
      review_visible: true,
      recovery_required: true,
      snapshot_dir: snapshotRef,
      reason,
      entries,
    }),
  });
  return entries;
}

export function linkSiblingDirtyRecoverySnapshot(options = {}) {
  try {
    return linkSiblingDirtyRecoverySnapshotInternal(options);
  } catch (err) {
    log.warn("sibling-dirty-recovery", "Could not persist sibling recovery snapshot linkage", {
      work_item_id: options?.workItemId ?? null,
      job_id: options?.jobId ?? null,
      snapshot_dir: options?.snapshotDir ? String(options.snapshotDir) : null,
      error: err?.message || String(err),
    });
    return [];
  }
}
