import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getIntSetting } from "../../../domains/queue/functions/settings.js";
import { recordMemorySample } from "./memory.js";
import { appendRunTelemetry, getRunTelemetryEpoch, getRunTelemetryStartedAt } from "./run-telemetry.js";

export const DEFAULT_DB_TELEMETRY_TAIL_LIMIT = 20;
const _mirroredRowIds = new Map([
  ["events", new Map()],
  ["job_observations", new Map()],
]);
let _pruneSampleCounter = 0;
const ARCHIVE_FETCH_CHUNK_SIZE = 250;

function mirroredSetFor(tableName) {
  const byEpoch = _mirroredRowIds.get(tableName);
  if (!byEpoch) return null;
  const epoch = getRunTelemetryEpoch();
  for (const staleEpoch of byEpoch.keys()) {
    if (staleEpoch !== epoch) byEpoch.delete(staleEpoch);
  }
  let set = byEpoch.get(epoch);
  if (!set) {
    set = new Set();
    byEpoch.set(epoch, set);
  }
  return set;
}

export function markTelemetryRowsMirrored(tableName, ids = []) {
  const safeTable = String(tableName || "");
  const target = mirroredSetFor(safeTable);
  if (!target) return;
  for (const id of ids) {
    const numeric = Number(id || 0);
    if (Number.isFinite(numeric) && numeric > 0) target.add(numeric);
  }
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

function isCurrentRunTelemetryRow(row) {
  const rowMs = Date.parse(row?.created_at || row?.t || "");
  const runMs = Date.parse(getRunTelemetryStartedAt());
  if (!Number.isFinite(rowMs) || !Number.isFinite(runMs)) return true;
  return rowMs >= runMs;
}

function fetchRowsById(db, safeTable, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += ARCHIVE_FETCH_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ARCHIVE_FETCH_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(...db.prepare(`
      SELECT *
      FROM ${safeTable}
      WHERE id IN (${placeholders})
      ORDER BY id ASC
    `).all(...chunk));
  }
  return rows;
}

export function pruneTelemetryTableToTail(db, tableName, limit = getDbTelemetryTailLimit()) {
  const safeTable = String(tableName || "");
  if (!["events", "job_observations"].includes(safeTable)) {
    throw new Error(`Unsupported telemetry tail table: ${safeTable}`);
  }
  const safeLimit = Math.max(0, Number.parseInt(String(limit ?? 0), 10) || 0);
  if (safeLimit === 0) return 0;
  const archiveStream = safeTable === "events" ? "events" : "observations";
  const mirroredIds = mirroredSetFor(safeTable);
  const victims = db.prepare(`
    SELECT id, created_at
    FROM ${safeTable}
    WHERE id NOT IN (
      SELECT id FROM ${safeTable}
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `).all(safeLimit);
  const shouldSampleMemory = victims.length > 0 && (_pruneSampleCounter++ % 25 === 0);
  if (shouldSampleMemory) {
    recordMemorySample("db.telemetry_prune.before", {
      table: safeTable,
      victim_rows: victims.length,
      archive_rows: victims.filter((row) => !mirroredIds?.has(Number(row.id || 0)) && isCurrentRunTelemetryRow(row)).length,
      tail_limit: safeLimit,
    });
  }
  const archiveIds = victims
    .filter((row) => !mirroredIds?.has(Number(row.id || 0)) && isCurrentRunTelemetryRow(row))
    .map((row) => Number(row.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  let archiveFailed = false;
  for (const row of fetchRowsById(db, safeTable, archiveIds)) {
    if (mirroredIds?.has(Number(row.id || 0))) continue;
    if (appendRunTelemetry(archiveStream, { archived_from_db: true, ...row })) {
      markTelemetryRowsMirrored(safeTable, [row.id]);
    } else {
      archiveFailed = true;
    }
  }
  if (archiveFailed) {
    if (shouldSampleMemory) {
      recordMemorySample("db.telemetry_prune.after", {
        table: safeTable,
        pruned_rows: 0,
        archive_failed: true,
        tail_limit: safeLimit,
      });
    }
    return 0;
  }
  const changes = db.prepare(`
    DELETE FROM ${safeTable}
    WHERE id NOT IN (
      SELECT id FROM ${safeTable}
      ORDER BY id DESC
      LIMIT ?
    )
  `).run(safeLimit).changes;
  if (shouldSampleMemory) {
    recordMemorySample("db.telemetry_prune.after", {
      table: safeTable,
      pruned_rows: changes,
      archive_failed: archiveFailed,
      tail_limit: safeLimit,
    });
  }
  for (const row of victims) mirroredIds?.delete(Number(row.id || 0));
  return changes;
}
