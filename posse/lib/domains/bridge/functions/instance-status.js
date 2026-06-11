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

function bootLooksLikeWarming(steps) {
  const active = steps.filter((step) => ["pending", "running"].includes(step.status));
  if (active.length === 0) return false;
  return active.every((step) => /atlas|warm|onnx|encod/i.test(step.label));
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

/**
 * @param {import("better-sqlite3").Database} db — any handle on the
 *   orchestrator DB (the bridge passes its readonly connection).
 */
export function composeInstanceStatus(db, { nowMs = Date.now() } = {}) {
  const boot = readJsonRow(db, "boot");
  const scheduler = readJsonRow(db, "scheduler");
  const shutdown = readJsonRow(db, "shutdown");

  const heartbeatMs = schedulerHeartbeatMs(db, scheduler);
  const shutdownMs = shutdown ? (parseMs(shutdown.value?.at) ?? parseMs(shutdown.updatedAt)) : null;
  const bootSteps = normalizeBootSteps(boot?.value?.steps);
  const bootSettled = bootSteps.length === 0 || bootIsSettled(bootSteps);
  const bootMs = boot ? parseMs(boot.updatedAt) : null;
  const heartbeatFresh = heartbeatMs != null && nowMs - heartbeatMs <= STALE_HEARTBEAT_MS;
  const bootFresh = bootMs != null && nowMs - bootMs <= STALE_HEARTBEAT_MS;

  const schedulerValue = scheduler?.value || {};
  const runningJobs = Number(schedulerValue.running_jobs) || 0;
  const queuedJobs = Number(schedulerValue.queued_jobs) || 0;

  let phase;
  if (shutdownMs != null && (heartbeatMs == null || shutdownMs >= heartbeatMs)) {
    phase = "offline";
  } else if (boot && !bootSettled && (bootFresh || heartbeatFresh)) {
    phase = bootLooksLikeWarming(bootSteps) ? "warming" : "booting";
  } else if (heartbeatFresh) {
    phase = runningJobs > 0 ? "running" : queuedJobs > 0 ? "ready" : "idle";
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
    boot_steps: phase === "booting" || phase === "warming" ? bootSteps : [],
    scheduler: heartbeatMs != null
      ? {
          last_heartbeat_at: new Date(heartbeatMs).toISOString(),
          active_workers: Number(schedulerValue.active_workers) || 0,
          running_jobs: runningJobs,
          queued_jobs: queuedJobs,
        }
      : null,
    version: posseVersion(),
    updated_at: new Date(nowMs).toISOString(),
  };
}
