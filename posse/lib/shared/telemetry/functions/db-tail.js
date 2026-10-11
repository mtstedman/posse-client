import crypto from "node:crypto";
import { TERMINAL_JOB_STATUSES_SQL } from "../../../catalog/job.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getIntSetting } from "../../../domains/queue/functions/settings.js";
import { recordMemorySample } from "./memory.js";
import { appendRunTelemetry, getRunTelemetryId, getRunTelemetryStartedAt } from "./run-telemetry.js";

export const DEFAULT_DB_TELEMETRY_TAIL_LIMIT = 20;
// Post-job finalizers (ATLAS auto-feedback) read job_observations from the
// live table after the job turns terminal; a grace window keeps just-written
// rows out of the prune so a concurrent writer cannot evict them first.
const JOB_OBSERVATION_PRUNE_GRACE_MS = 10 * 60 * 1000;
let _pruneSampleCounter = 0;
const ARCHIVE_FETCH_CHUNK_SIZE = 250;
const EXPORT_CLAIM_STALE_MS = 5 * 60 * 1000;

function exportStream(tableName) {
  if (tableName === "events") return "events";
  if (tableName === "job_observations") return "observations";
  throw new Error(`Unsupported telemetry export table: ${tableName}`);
}

/** Recover pending and stale claims. A crash after append can replay one row;
 * export_id lets readers discard that duplicate without losing the row. */
export function drainTelemetryExports(db, tableName, { limit = ARCHIVE_FETCH_CHUNK_SIZE } = {}) {
  if (db.inTransaction) return 0;
  const stream = exportStream(tableName);
  const staleBefore = new Date(Date.now() - EXPORT_CLAIM_STALE_MS).toISOString();
  const ids = db.prepare(`
    SELECT id FROM ${tableName}
    WHERE export_state = 'pending'
       OR (export_state = 'writing' AND (export_claimed_at IS NULL OR export_claimed_at < ?))
    ORDER BY id ASC LIMIT ?
  `).all(staleBefore, Math.max(0, Number(limit) || 0)).map((row) => row.id);
  let mirrored = 0;
  for (const id of ids) {
    const token = crypto.randomUUID();
    const claimed = db.prepare(`
      UPDATE ${tableName}
      SET export_state = 'writing', export_claim_token = ?, export_claimed_at = ?
      WHERE id = ? AND (export_state = 'pending'
        OR (export_state = 'writing' AND (export_claimed_at IS NULL OR export_claimed_at < ?)))
      RETURNING *
    `).get(token, new Date().toISOString(), id, staleBefore);
    if (!claimed) continue;
    const { export_state: _state, export_claim_token: _token, export_claimed_at: _claimedAt, export_run_id: recordedRunId, ...record } = claimed;
    const runId = recordedRunId || (Date.parse(record.created_at || "") >= Date.parse(getRunTelemetryStartedAt())
      ? getRunTelemetryId() : null);
    let payload = record;
    if (tableName === "job_observations") {
      let detail = null;
      try { detail = JSON.parse(String(record.detail_json || "null")); } catch { /* retain raw detail_json */ }
      payload = { ...record, detail };
    }
    // Rows without a run ID that predate this process are legacy data. The
    // migration marks them mirrored; manually imported legacy rows follow it.
    const ok = runId ? appendRunTelemetry(stream, { ...payload, export_id: `${tableName}:${id}` }, { runId }) : true;
    const next = ok ? "mirrored" : "pending";
    db.prepare(`
      UPDATE ${tableName}
      SET export_state = ?, export_claim_token = NULL, export_claimed_at = NULL
      WHERE id = ? AND export_claim_token = ?
    `).run(next, id, token);
    if (ok) mirrored += 1;
  }
  return mirrored;
}

export function getDbTelemetryTailLimit() {
  try {
    const value = getIntSetting(
      SETTING_KEYS.DB_TELEMETRY_TAIL_LIMIT,
      DEFAULT_DB_TELEMETRY_TAIL_LIMIT,
    );
    if (!Number.isFinite(value)) return DEFAULT_DB_TELEMETRY_TAIL_LIMIT;
    return Math.max(0, value);
  } catch {
    return DEFAULT_DB_TELEMETRY_TAIL_LIMIT;
  }
}

export function pruneTelemetryTableToTail(db, tableName, limit = getDbTelemetryTailLimit()) {
  if (db.inTransaction) return 0; // Never mirror uncommitted rows.
  const safeTable = String(tableName || "");
  exportStream(safeTable);
  drainTelemetryExports(db, safeTable);
  const safeLimit = Math.max(0, Number.parseInt(String(limit ?? 0), 10) || 0);
  if (safeLimit === 0) return 0;
  // job_observations feed the post-job ATLAS auto-feedback finalizer, which
  // reads the live table once the job turns terminal. Job-scoped rows are
  // exempt from the tail prune until their job is terminal AND a grace
  // window has passed (covering the terminal-flip → finalizer read window).
  // Job-less rows keep the plain tail behavior; everything is mirrored to
  // the JSONL archive regardless.
  const prunablePredicate = safeTable === "job_observations"
    ? `AND (job_id IS NULL OR (
         job_id NOT IN (
           SELECT id FROM jobs WHERE status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
         )
         AND created_at < ?
       ))`
    : "";
  const prunableParams = safeTable === "job_observations"
    ? [new Date(Date.now() - JOB_OBSERVATION_PRUNE_GRACE_MS).toISOString()]
    : [];
  const victims = db.prepare(`
    SELECT id
    FROM ${safeTable}
    WHERE id NOT IN (
      SELECT id FROM ${safeTable}
      ORDER BY id DESC
      LIMIT ?
    )
    AND export_state = 'mirrored'
    ${prunablePredicate}
    ORDER BY id ASC
  `).all(safeLimit, ...prunableParams);
  const shouldSampleMemory = victims.length > 0 && (_pruneSampleCounter++ % 25 === 0);
  if (shouldSampleMemory) {
    recordMemorySample("db.telemetry_prune.before", {
      table: safeTable,
      victim_rows: victims.length,
      archive_rows: 0,
      tail_limit: safeLimit,
    });
  }
  // Delete only rows selected for this archival pass. A concurrent insert can
  // push another row out of the tail after selection; that row has not been
  // archived and must wait for the next pass.
  let changes = 0;
  for (let i = 0; i < victims.length; i += ARCHIVE_FETCH_CHUNK_SIZE) {
    const ids = victims.slice(i, i + ARCHIVE_FETCH_CHUNK_SIZE).map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    changes += db.prepare(`
      DELETE FROM ${safeTable}
      WHERE id IN (${placeholders}) AND export_state = 'mirrored' ${prunablePredicate}
    `).run(...ids, ...prunableParams).changes;
  }
  if (shouldSampleMemory) {
    recordMemorySample("db.telemetry_prune.after", {
      table: safeTable,
      pruned_rows: changes,
      archive_failed: false,
      tail_limit: safeLimit,
    });
  }
  return changes;
}
