import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { TERMINAL_JOB_STATUSES } from "../../../queue/functions/common.js";
import { getSetting } from "../../../queue/functions/settings.js";

export const DEFAULT_RUNTIME_RETENTION_DAYS = 90;
export const RUNTIME_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

// Initialized to module load time so the first pass runs one interval into
// the process lifetime, not on the scheduler loop's very first tick — that
// tick lands right at boot, exactly when the prune backlog is largest and the
// loop can least afford a long synchronous transaction.
let _lastRuntimeRetentionAt = Date.now();

// Chunked-delete bounds. Each chunk is its own implicit transaction, so a
// pass never holds one giant write transaction; a pass that hits the cap
// reports truncated:true and the caller re-arms sooner than the full interval.
const RETENTION_DELETE_CHUNK = 2000;
const RETENTION_MAX_CHUNKS_PER_TABLE = 10;
const RETENTION_TRUNCATED_RETRY_MS = 5 * 60 * 1000;

const RETENTION_TARGETS = Object.freeze([
  Object.freeze({ table: "events", column: "created_at" }),
  Object.freeze({ table: "agent_calls", column: "created_at" }),
  Object.freeze({ table: "job_observations", column: "created_at" }),
  Object.freeze({ table: "session_recycle_savings", column: "recorded_at" }),
]);

const TERMINAL_JOB_STATUS_PLACEHOLDERS = TERMINAL_JOB_STATUSES.map(() => "?").join(", ");

function readRetentionDays() {
  let raw = null;
  try {
    raw = getSetting(SETTING_KEYS.RETENTION_DAYS);
  } catch {
    raw = null;
  }
  if (raw == null || String(raw).trim() === "") return DEFAULT_RUNTIME_RETENTION_DAYS;
  const parsed = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RUNTIME_RETENTION_DAYS;
}

function cutoffIsoForRetention(days, nowMs = Date.now()) {
  return new Date(nowMs - (days * 24 * 60 * 60 * 1000)).toISOString();
}

function tableExists(db, table) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
}

function pruneOldArtifacts(db, cutoff) {
  if (!tableExists(db, "artifacts")) return 0;
  const hasJobs = tableExists(db, "jobs");
  const hasAttempts = tableExists(db, "job_attempts");
  const clauses = ["(job_id IS NULL AND attempt_id IS NULL)"];
  const params = [cutoff];
  if (hasJobs) {
    clauses.push(`EXISTS (
      SELECT 1 FROM jobs
      WHERE jobs.id = artifacts.job_id
        AND jobs.status IN (${TERMINAL_JOB_STATUS_PLACEHOLDERS})
    )`);
    params.push(...TERMINAL_JOB_STATUSES);
  }
  if (hasJobs && hasAttempts) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM job_attempts
      JOIN jobs ON jobs.id = job_attempts.job_id
      WHERE job_attempts.id = artifacts.attempt_id
        AND jobs.status IN (${TERMINAL_JOB_STATUS_PLACEHOLDERS})
    )`);
    params.push(...TERMINAL_JOB_STATUSES);
  }
  const info = db.prepare(`
    DELETE FROM artifacts
    WHERE created_at < ?
      AND (${clauses.join("\n        OR ")})
  `).run(...params);
  return Number(info?.changes || 0);
}

function pruneOldJobAttempts(db, cutoff) {
  if (!tableExists(db, "job_attempts")) return 0;
  if (!tableExists(db, "jobs")) return 0;
  const info = db.prepare(`
    DELETE FROM job_attempts
    WHERE started_at < ?
      AND (
        job_id IS NULL
        OR EXISTS (
          SELECT 1 FROM jobs
          WHERE jobs.id = job_attempts.job_id
            AND jobs.status IN (${TERMINAL_JOB_STATUS_PLACEHOLDERS})
        )
      )
  `).run(cutoff, ...TERMINAL_JOB_STATUSES);
  return Number(info?.changes || 0);
}

function pruneExpiredRunInsights(db, nowIso) {
  if (!tableExists(db, "run_insights")) return 0;
  const info = db.prepare(`
    DELETE FROM run_insights
    WHERE expires_at IS NOT NULL
      AND expires_at < ?
      AND (promoted_memory_id IS NULL OR promoted_memory_id = '')
  `).run(nowIso);
  return Number(info?.changes || 0);
}

export function runRuntimeRetention({
  db = getDb(),
  retentionDays = readRetentionDays(),
  nowMs = Date.now(),
  checkpoint = true,
} = {}) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) {
    return { attempted: false, skipped: "disabled", retentionDays: days };
  }
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = cutoffIsoForRetention(days, nowMs);
  const deleted = {};
  let totalDeleted = 0;
  let truncated = false;
  // Bulk age-based tables are pruned in bounded chunks, each chunk its own
  // implicit transaction, so this never blocks the caller (the scheduler
  // loop) behind one unbounded DELETE of a multi-month backlog.
  for (const target of RETENTION_TARGETS) {
    if (!tableExists(db, target.table)) {
      deleted[target.table] = 0;
      continue;
    }
    const chunkStmt = db.prepare(`
      DELETE FROM ${target.table}
      WHERE rowid IN (
        SELECT rowid FROM ${target.table} WHERE ${target.column} < ? LIMIT ?
      )
    `);
    let tableTotal = 0;
    for (let i = 0; i < RETENTION_MAX_CHUNKS_PER_TABLE; i++) {
      const changes = Number(chunkStmt.run(cutoff, RETENTION_DELETE_CHUNK)?.changes || 0);
      tableTotal += changes;
      if (changes < RETENTION_DELETE_CHUNK) break;
      if (i === RETENTION_MAX_CHUNKS_PER_TABLE - 1) truncated = true;
    }
    deleted[target.table] = tableTotal;
    totalDeleted += tableTotal;
  }
  // The scoped prunes (terminal-job artifacts/attempts, expired insights) are
  // naturally bounded by job turnover; keep them atomic in one transaction.
  totalDeleted += db.transaction(() => {
    let total = 0;
    const artifactChanges = pruneOldArtifacts(db, cutoff);
    deleted.artifacts = artifactChanges;
    total += artifactChanges;
    const attemptChanges = pruneOldJobAttempts(db, cutoff);
    deleted.job_attempts = attemptChanges;
    total += attemptChanges;
    const expiredInsightChanges = pruneExpiredRunInsights(db, nowIso);
    deleted.run_insights_expired = expiredInsightChanges;
    total += expiredInsightChanges;
    return total;
  })();
  let checkpointResult = null;
  if (checkpoint) {
    try {
      checkpointResult = db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      checkpointResult = { error: String(err?.message || err || "checkpoint failed") };
    }
  }
  return {
    attempted: true,
    ok: true,
    retentionDays: days,
    cutoff,
    deleted,
    totalDeleted,
    truncated,
    checkpoint: checkpointResult,
  };
}

export function maybeRunRuntimeRetention({
  nowMs = Date.now(),
  intervalMs = RUNTIME_RETENTION_INTERVAL_MS,
  force = false,
} = {}) {
  if (!force && _lastRuntimeRetentionAt > 0 && nowMs - _lastRuntimeRetentionAt < intervalMs) {
    return { attempted: false, skipped: "interval" };
  }
  _lastRuntimeRetentionAt = nowMs;
  try {
    const result = runRuntimeRetention({ nowMs });
    if (result.attempted && result.truncated) {
      // Backlog exceeded the per-pass chunk cap — re-arm well before the
      // full interval so the remainder drains in bounded slices instead of
      // silently waiting another hour per pass.
      _lastRuntimeRetentionAt = nowMs - Math.max(0, intervalMs - RETENTION_TRUNCATED_RETRY_MS);
    }
    if (result.attempted && result.totalDeleted > 0) {
      log.info("admin", "Runtime DB retention pruned old rows", {
        retentionDays: result.retentionDays,
        cutoff: result.cutoff,
        deleted: result.deleted,
        totalDeleted: result.totalDeleted,
        truncated: result.truncated === true,
      });
    }
    return result;
  } catch (err) {
    const message = String(err?.message || err || "retention failed");
    log.warn("admin", "Runtime DB retention failed", { error: message });
    return { attempted: true, ok: false, error: message };
  }
}

export function __resetRuntimeRetentionForTests() {
  _lastRuntimeRetentionAt = 0;
}
