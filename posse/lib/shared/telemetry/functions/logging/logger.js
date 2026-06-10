// lib/logger.js — Structured file logger for post-mortem debugging
//
// Writes JSON-lines to logs/posse-{date}.log. Supplements the DB event log
// (logEvent) and TUI display (addEvent) with disk-based diagnostics that
// survive crashes and don't require DB access to read.
//
// Usage:
//   import { log } from "./logger.js";
//   log.info("scheduler", "Boot complete", { concurrency: 3 });
//   log.warn("worker", "Lease renewal failed", { jobId: 42 });
//   log.error("assessor", "Verdict parse error", { raw: "..." });

import { DatedRotatingLog } from "../../classes/logging/DatedRotatingLog.js";
import { scrubSecrets } from "../../classes/logging/secret-scrub.js";
import { getAccountSetting } from "../../../../domains/settings/functions/account-settings.js";
import { appendRunTelemetry } from "../run-telemetry.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const DEFAULT_MIN_LEVEL = LEVELS.info;

function minLevel() {
  try {
    const level = String(getAccountSetting("posse_log_level") || "info").trim().toLowerCase();
    if (LEVELS[level] != null) return LEVELS[level];
  } catch {
    // Account settings may not be ready during early boot.
  }
  return DEFAULT_MIN_LEVEL;
}

const runtimeLog = new DatedRotatingLog({
  filePrefix: "posse-",
  onOpenError: (err, logDir) => {
    process.stderr.write(`[logger] Cannot open log file in ${logDir}: ${err.message}\n`);
  },
});

// ─── Core Write ─────────────────────────────────────────────────────────────

function _entry(level, source, message, data) {
  const entry = {
    t: new Date().toISOString(),
    level,
    src: source,
    msg: message,
  };

  // Flatten common fields to top level for grep-ability
  if (data) {
    if (data.jobId != null) entry.job = data.jobId;
    if (data.wiId != null) entry.wi = data.wiId;
    if (data.provider) entry.provider = data.provider;
    // Everything else goes in 'd'
    const { jobId, wiId, provider, ...rest } = data;
    if (Object.keys(rest).length > 0) entry.d = rest;
  }

  return entry;
}

function _scrubValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return scrubSecrets(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => _scrubValue(item, seen));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = _scrubValue(item, seen);
  }
  seen.delete(value);
  return out;
}

function _scrubEntry(entry) {
  try {
    return _scrubValue(entry);
  } catch {
    return entry;
  }
}

function _write(level, source, message, data) {
  if (LEVELS[level] < minLevel()) return;

  const entry = _scrubEntry(_entry(level, source, message, data));
  try {
    runtimeLog.write(JSON.stringify(entry));
  } catch { /* best effort — don't crash the system over logging */ }
  try { appendRunTelemetry("runtime", entry); } catch { /* best effort */ }
}

export function writeRuntimeLogAtDir(dir, level, source, message, data) {
  if (LEVELS[level] < minLevel()) return false;
  const targetLog = new DatedRotatingLog({
    dir,
    filePrefix: "posse-",
    onOpenError: (err, logDir) => {
      process.stderr.write(`[logger] Cannot open log file in ${logDir}: ${err.message}\n`);
    },
  });
  try {
    return targetLog.write(JSON.stringify(_scrubEntry(_entry(level, source, message, data))));
  } catch {
    return false;
  } finally {
    targetLog.close();
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const log = {
  debug: (source, message, data) => _write("debug", source, message, data),
  info:  (source, message, data) => _write("info",  source, message, data),
  warn:  (source, message, data) => _write("warn",  source, message, data),
  error: (source, message, data) => _write("error", source, message, data),
};

export function __testLogLevelValue() {
  return minLevel();
}

// ─── Job Lifecycle Log ─────────────────────────────────────────────────────
// Human-readable, one-line-per-event log for job lifecycle tracking.
// Written to .posse/logs/jobs-{date}.log. Easy to tail, grep, and review post-run.
//
// Format: TIMESTAMP | WI#id | JOB#id | EVENT | details
// Example: 2026-04-06T14:23:01Z | WI#3 | JOB#17 | START | dev "Add auth middleware" (sonnet, attempt 1)
//          2026-04-06T14:25:33Z | WI#3 | JOB#17 | ASSESSED | pass (high) — all files present
//          2026-04-06T14:25:33Z | WI#3 | JOB#17 | DONE | succeeded in 152s

const runtimeJobLog = new DatedRotatingLog({ filePrefix: "jobs-" });

/**
 * Log a job lifecycle event in human-readable format.
 * @param {string} event - Event name (START, ATTEMPT_FAIL, ASSESSED, DONE, DEAD_LETTER, ESCALATED, etc.)
 * @param {{ wi?: number, job?: number, detail?: string }} ctx
 */
export function jobLog(event, { wi = null, job = null, detail = "" } = {}) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const wiTag = wi != null ? `WI#${wi}` : "WI#?";
  const jobTag = job != null ? `JOB#${job}` : "JOB#?";
  // detail can carry provider errors or command output; scrub like the runtime log.
  let safeDetail = String(detail ?? "");
  try { safeDetail = scrubSecrets(safeDetail); } catch { /* best effort */ }
  const line = `${ts} | ${wiTag.padEnd(6)} | ${jobTag.padEnd(7)} | ${event.padEnd(14)} | ${safeDetail}`;
  try { runtimeJobLog.write(line); } catch { /* best effort */ }
  try {
    appendRunTelemetry("jobs", { ts, event, wi, job, detail: safeDetail, line });
  } catch { /* best effort */ }
}

/** Flush and close all log files. Call on graceful shutdown. */
export function closeLog() {
  runtimeLog.close();
  runtimeJobLog.close();
}
