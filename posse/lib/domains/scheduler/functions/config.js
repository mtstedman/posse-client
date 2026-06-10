import { getSetting } from "../../queue/functions/index.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";

export function readPositiveIntSetting(key, fallback = null) {
  try {
    const raw = getSetting(key);
    const parsed = Number.parseInt(String(raw || ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function readBoolSetting(key, fallback = false) {
  const raw = getSetting(key);
  if (raw == null || String(raw).trim() === "") return !!fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export const DEFAULT_POLL_MS = getCatalogRuntimeFallbackInt("scheduler_poll_ms", 500);
export const DEFAULT_REPAIR_POLL_MS = getCatalogRuntimeFallbackInt("scheduler_repair_poll_ms", 5000);
export const DEFAULT_LEASE_SEC = getCatalogRuntimeFallbackInt("default_lease_seconds", 120);
export const DEFAULT_CONCURRENCY = getCatalogRuntimeFallbackInt("scheduler_concurrency", 3);
export const LOCK_RENEW_SEC = 30;
export const PROGRESS_TIMEOUT_SEC = 300;
export const MAX_RUNNABLE_SCAN_PER_TICK = 25;
export const HEADLESS_HUMAN_TIMEOUT_SEC = getCatalogRuntimeFallbackInt("headless_human_timeout_sec", 600);
export const STALL_TIMEOUT_SEC = getCatalogRuntimeFallbackInt("stall_timeout", 600);
export const MAX_JOB_RUNTIME_SEC_OVERRIDE = null;

export const ATLAS_DRIFT_CHECK_INTERVAL_MS = Math.max(
  60 * 1000,
  getCatalogRuntimeFallbackInt("atlas_drift_check_interval_ms", 10 * 60 * 1000),
);

const DEFAULT_JOB_RUNTIME_MULTIPLIERS = Object.freeze({
  research: 4,
  plan: 3,
  preflight: 3,
  dev: 2,
  fix: 2,
  promote: 2,
  artificer: 2,
  assess: 2,
  delegate: 2,
  summarize: 2,
});

export function maxJobRuntimeSecFor(job) {
  const override = readMaxJobRuntimeSecOverride();
  if (override) return override;
  const jobType = String(job?.job_type || "").toLowerCase();
  const multiplier = DEFAULT_JOB_RUNTIME_MULTIPLIERS[jobType] || 2;
  return Math.max(1, readStallTimeoutSec() * multiplier);
}

export function readStallTimeoutSec() {
  return readPositiveIntSetting("stall_timeout", STALL_TIMEOUT_SEC);
}

export function readMaxJobRuntimeSecOverride() {
  return readPositiveIntSetting("max_job_runtime_sec", MAX_JOB_RUNTIME_SEC_OVERRIDE);
}

export function readHeadlessHumanTimeoutSec() {
  return readPositiveIntSetting("headless_human_timeout_sec", HEADLESS_HUMAN_TIMEOUT_SEC);
}

export function readAtlasDriftCheckIntervalMs() {
  return Math.max(
    60 * 1000,
    readPositiveIntSetting("atlas_drift_check_interval_ms", ATLAS_DRIFT_CHECK_INTERVAL_MS),
  );
}

export function readActiveWorktreeCap() {
  return readPositiveIntSetting("scheduler_max_active_worktrees", null);
}
