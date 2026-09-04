// Compose the instance_status payload from runtime_status rows and the
// scheduler lock — entirely read-side, so stalled/offline phases are
// derived correctly even after the run process crashed without writing
// anything. Shared by ChangeStream (live emission) and state-snapshot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STALE_HEARTBEAT_MS = 90 * 1000; // 3× the 30s scheduler lock renewal
const OFFLINE_HEARTBEAT_MS = 10 * 60 * 1000;
const MAX_BOOT_STEPS = 30;
const MAX_LABEL_CHARS = 120;
const MAX_DETAIL_CHARS = 200;
const MAX_GIT_NAME_CHARS = 240;
const MAX_GIT_REMOTE_CHARS = 128;

let _cachedVersion;

function posseVersion() {
  if (_cachedVersion !== undefined) return _cachedVersion;
  try {
    const packagePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "..", "..", "package.json",
    );
    _cachedVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version || null;
  } catch {
    _cachedVersion = null;
  }
  return _cachedVersion;
}

function readJsonRow(db, key) {
  try {
    const row = db
      .prepare(`SELECT value_json, updated_at FROM runtime_status WHERE key = ?`)
      .get(key);
    if (!row) return null;
    return { value: JSON.parse(row.value_json), updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

function parseMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedText(value, maxChars) {
  const text = String(value || "").trim();
  return text ? text.slice(0, maxChars) : null;
}

function normalizedTimestamp(value) {
  const parsed = parseMs(value);
  return parsed == null ? null : new Date(parsed).toISOString();
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(parsed));
}

function normalizedGitOid(value) {
  const oid = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(oid) ? oid : null;
}

function normalizeSharedTrunkStatus(row, nowMs) {
  if (!row?.value || typeof row.value !== "object" || Array.isArray(row.value)) return null;
  const value = row.value;
  const lastAttemptAt = normalizedTimestamp(value.last_attempt_at);
  const lastSuccessAt = normalizedTimestamp(value.last_success_at);
  const lastSuccessMs = parseMs(lastSuccessAt);
  return {
    enabled: value.enabled === true,
    claims_enabled: value.claims_enabled === true,
    remote: boundedText(value.remote, MAX_GIT_REMOTE_CHARS),
    branch: boundedText(value.branch, MAX_GIT_NAME_CHARS),
    local_sha: normalizedGitOid(value.local_sha),
    remote_sha: normalizedGitOid(value.remote_sha),
    ahead_count: nonNegativeInteger(value.ahead_count ?? value.ahead),
    behind_count: nonNegativeInteger(value.behind_count ?? value.behind),
    last_attempt_at: lastAttemptAt,
    last_success_at: lastSuccessAt,
    last_sync_age_sec: lastSuccessMs == null
      ? null
      : Math.max(0, Math.floor((nowMs - lastSuccessMs) / 1000)),
    diverged: value.diverged === true,
    push_rejection_count: nonNegativeInteger(value.push_rejection_count),
    push_retry_count: nonNegativeInteger(value.push_retry_count),
    max_push_retry_depth: nonNegativeInteger(value.max_push_retry_depth),
    sync_unavailable_count: nonNegativeInteger(value.sync_unavailable_count),
    publication_unresolved: value.publication_unresolved === true,
    unresolved_operation_count: nonNegativeInteger(value.unresolved_operation_count),
    last_error_code: boundedText(value.last_error_code, 160),
    updated_at: normalizedTimestamp(row.updatedAt),
  };
}

function normalizeBootSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.slice(0, MAX_BOOT_STEPS).map((step) => ({
    label: String(step?.label || "").slice(0, MAX_LABEL_CHARS) || "step",
    status: ["pending", "running", "ok", "failed", "skipped", "deferred"].includes(step?.status)
      ? step.status
      : "pending",
    ...(Number.isFinite(Number(step?.percent))
      ? { percent: Math.max(0, Math.min(100, Number(step.percent))) }
      : {}),
    ...(step?.detail ? { detail: String(step.detail).slice(0, MAX_DETAIL_CHARS) } : {}),
    ...(step?.section ? { section: String(step.section).slice(0, 40) } : {}),
  }));
}

function bootIsSettled(steps) {
  return steps.every((step) => !["pending", "running"].includes(step.status));
}

function bootStepIsBackground(step) {
  return /atlas|warm|onnx|encod/i.test(String(step?.label || ""));
}

function schedulerHeartbeatMs(db, schedulerRow) {
  const fromRow = schedulerRow ? parseMs(schedulerRow.updatedAt) : null;
  let fromLock = null;
  try {
    const lock = db
      .prepare(`SELECT acquired_at, expires_at FROM scheduler_locks WHERE lock_name = 'main'`)
      .get();
    fromLock = parseMs(lock?.acquired_at) ?? parseMs(lock?.expires_at);
  } catch {
    fromLock = null;
  }
  if (fromRow == null) return fromLock;
  if (fromLock == null) return fromRow;
  return Math.max(fromRow, fromLock);
}

function countQueuedWorkItems(db) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM work_items
      WHERE status = 'queued'
    `).get();
    return Number(row?.count) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {import("better-sqlite3").Database} db — any handle on the
 *   orchestrator DB (the bridge passes its readonly connection).
 */
export function composeInstanceStatus(db, { nowMs = Date.now() } = {}) {
  const boot = readJsonRow(db, "boot");
  const scheduler = readJsonRow(db, "scheduler");
  const shutdown = readJsonRow(db, "shutdown");
  const sharedTrunk = readJsonRow(db, "shared_trunk");
  const sharedTrunkStatus = normalizeSharedTrunkStatus(sharedTrunk, nowMs);

  const heartbeatMs = schedulerHeartbeatMs(db, scheduler);
  const shutdownMs = shutdown ? (parseMs(shutdown.value?.at) ?? parseMs(shutdown.updatedAt)) : null;
  // Phone/web clients need Posse readiness, not optional local indexing
  // telemetry. Keep ATLAS/ONNX/encoder warm details on the local display.
  const bootSteps = normalizeBootSteps(boot?.value?.steps).filter((step) => !bootStepIsBackground(step));
  const bootSettled = bootSteps.length === 0 || bootIsSettled(bootSteps);
  const bootMs = boot ? parseMs(boot.updatedAt) : null;
  const heartbeatFresh = heartbeatMs != null && nowMs - heartbeatMs <= STALE_HEARTBEAT_MS;
  const bootFresh = bootMs != null && nowMs - bootMs <= STALE_HEARTBEAT_MS;

  const schedulerValue = scheduler?.value || {};
  const runningJobs = Number(schedulerValue.running_jobs) || 0;
  const queuedJobs = Number(schedulerValue.queued_jobs) || 0;
  const queuedWorkItems = countQueuedWorkItems(db);
  const hasQueuedWork = queuedJobs > 0 || queuedWorkItems > 0;

  let phase;
  if (shutdownMs != null && (heartbeatMs == null || shutdownMs >= heartbeatMs) && queuedWorkItems === 0) {
    phase = "offline";
  } else if (boot && !bootSettled && (bootFresh || heartbeatFresh)) {
    phase = "booting";
  } else if (heartbeatFresh) {
    phase = runningJobs > 0 ? "running" : hasQueuedWork ? "ready" : "idle";
  } else if (queuedWorkItems > 0) {
    phase = "ready";
  } else if (heartbeatMs != null && nowMs - heartbeatMs <= OFFLINE_HEARTBEAT_MS) {
    // The run process stopped renewing without a clean shutdown — wedged.
    phase = "stalled";
  } else if (heartbeatMs != null || bootMs != null) {
    phase = "offline";
  } else {
    // Never ran in this repo (serve without run) — nothing to report beyond
    // the bridge being reachable.
    phase = "offline";
  }

  return {
    phase,
    queued_work_items: queuedWorkItems,
    boot_steps: phase === "booting" ? bootSteps : [],
    scheduler: heartbeatMs != null
      ? {
          last_heartbeat_at: new Date(heartbeatMs).toISOString(),
          active_workers: Number(schedulerValue.active_workers) || 0,
          running_jobs: runningJobs,
          queued_jobs: queuedJobs,
          queued_work_items: queuedWorkItems,
        }
      : null,
    ...(sharedTrunkStatus ? { shared_trunk: sharedTrunkStatus } : {}),
    version: posseVersion(),
    updated_at: new Date(nowMs).toISOString(),
  };
}
