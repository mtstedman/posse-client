import { getDb } from "../../../shared/storage/functions/index.js";
import { warnOnceForInvalidEventType } from "../../observability/functions/event-types.js";
import { markTelemetryRowsMirrored, pruneTelemetryTableToTail } from "../../../shared/telemetry/functions/db-tail.js";
import { appendRunTelemetry, readRunTelemetryEntries } from "../../../shared/telemetry/functions/run-telemetry.js";

function normalizeJsonText(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEventRow(row) {
  if (!row) return null;
  const id = Number(row.id || 0);
  return {
    id: Number.isFinite(id) && id > 0 ? id : null,
    work_item_id: row.work_item_id ?? null,
    job_id: row.job_id ?? null,
    attempt_id: row.attempt_id ?? null,
    event_type: row.event_type,
    actor_type: row.actor_type,
    actor_id: row.actor_id ?? null,
    message: row.message ?? null,
    event_json: row.event_json ?? null,
    created_at: row.created_at || row.t || null,
  };
}

function rowMatchesNumber(value, expected) {
  if (expected == null) return true;
  return Number(value) === Number(expected);
}

function eventSortValue(row) {
  if (row?.id != null) return Number(row.id);
  return Date.parse(row?.created_at || "") || 0;
}

function eventKey(row) {
  if (row?.id != null) return `id:${row.id}`;
  return [
    row?.created_at || "",
    row?.work_item_id ?? "",
    row?.job_id ?? "",
    row?.attempt_id ?? "",
    row?.event_type || "",
    row?.message || "",
  ].join("|");
}

function mergeEventRows(rows, order = "desc", limit = 100) {
  const deduped = new Map();
  for (const raw of rows || []) {
    const row = normalizeEventRow(raw);
    if (!row) continue;
    deduped.set(eventKey(row), row);
  }
  const sorted = [...deduped.values()].sort((a, b) => {
    const delta = eventSortValue(a) - eventSortValue(b);
    return order === "asc" ? delta : -delta;
  });
  return sorted.slice(0, Math.max(0, Number(limit) || 0));
}

function readEventFileRows({
  jobId = null,
  workItemId = null,
  eventType = null,
  sinceId = null,
  limit = 100,
  order = "desc",
} = {}) {
  const minId = sinceId == null ? null : Number(sinceId) || 0;
  return readRunTelemetryEntries("events", {
    limit,
    order,
    predicate: (entry) => {
      if (!rowMatchesNumber(entry.job_id, jobId)) return false;
      if (!rowMatchesNumber(entry.work_item_id, workItemId)) return false;
      if (eventType != null && String(entry.event_type || "") !== String(eventType)) return false;
      if (minId != null && Number(entry.id || 0) <= minId) return false;
      return true;
    },
  }).map(normalizeEventRow).filter(Boolean);
}

function appendEventFileRow(row) {
  return appendRunTelemetry("events", normalizeEventRow(row));
}

function insertEventRow(stmt, row) {
  const createdAt = row.created_at || nowIso();
  const info = stmt.run(
    row.work_item_id,
    row.job_id,
    row.attempt_id,
    row.event_type,
    row.actor_type,
    row.actor_id,
    row.message,
    row.event_json,
    createdAt,
  );
  return { ...row, id: Number(info.lastInsertRowid), created_at: createdAt };
}

// ── Event insert batching ────────────────────────────────────────────────
//
// During active runs every job emits 8-20 events (start, attempt, finish,
// stage transitions, etc.). Hundreds of separate INSERT transactions per
// minute have real overhead even in WAL mode. We coalesce inserts into
// a short queue that flushes every 100ms OR when the queue reaches the
// batch threshold, whichever fires first.
//
// Read-after-write semantics: callers that need an event visible before
// a subsequent query (very rare — usually only at shutdown / process
// exit) can call flushEventsNow() to drain synchronously. The process
// exit hook also drains the queue automatically.
//
// Crash-loss policy: process.on("exit") only fires on graceful shutdown.
// SIGKILL, OOM, and unhandled fatal errors will drop the pending batch
// (up to ~64 events or ~100ms of writes). This is intentional — adding
// signal handlers here would interfere with the orchestrator's own
// signal lifecycle, and the old synchronous-write path could also lose
// in-flight inserts on crash, so the practical durability difference is
// small. Top-level CLI shutdown paths call flushEventsNow() explicitly
// before closeLog/closeDb.

const EVENT_FLUSH_INTERVAL_MS = 100;
const EVENT_BATCH_FLUSH_AT = 64;
const _pendingEvents = [];
let _eventFlushTimer = null;
let _eventExitHookInstalled = false;

function _ensureEventExitHook() {
  if (_eventExitHookInstalled) return;
  _eventExitHookInstalled = true;
  process.on("exit", () => {
    try { flushEventsNow(); } catch { /* exit hook must not throw */ }
  });
}

function _scheduleEventFlush() {
  _ensureEventExitHook();
  if (_eventFlushTimer) return;
  _eventFlushTimer = setTimeout(() => {
    _eventFlushTimer = null;
    flushEventsNow();
  }, EVENT_FLUSH_INTERVAL_MS);
  _eventFlushTimer.unref?.();
}

/**
 * Drain the pending event queue into the DB in a single transaction.
 * Safe to call from any context (including process.on("exit")). Callers
 * that need an event to be visible to a subsequent SELECT in the same
 * tick should call this before the SELECT.
 */
export function flushEventsNow() {
  if (_pendingEvents.length === 0) return 0;
  const drain = _pendingEvents.splice(0, _pendingEvents.length);
  let db;
  try { db = getDb(); } catch { return 0; }
  const stmt = db.prepare(`
    INSERT INTO events (work_item_id, job_id, attempt_id, event_type, actor_type, actor_id, message, event_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let insertedRows = [];
  let mirroredAllRows = true;
  const mirroredIds = [];
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insertedRows.push(insertEventRow(stmt, row));
    }
  });
  try {
    insertMany(drain);
  } catch {
    insertedRows = [];
    // Fall back to one-at-a-time so a single bad row doesn't lose the
    // whole batch. Inserts that still fail are dropped (observability
    // must not break the run).
    for (const row of drain) {
      try {
        const inserted = insertEventRow(stmt, row);
        insertedRows.push(inserted);
      } catch { /* drop this one event */ }
    }
  }
  for (const row of insertedRows) {
    try {
      if (appendEventFileRow(row)) mirroredIds.push(row.id);
      else mirroredAllRows = false;
    } catch {
      mirroredAllRows = false;
    }
  }
  markTelemetryRowsMirrored("events", mirroredIds);
  if (mirroredAllRows) {
    try { pruneTelemetryTableToTail(db, "events"); } catch { /* telemetry pruning is best effort */ }
  }
  return drain.length;
}

/**
 * @param {{
 *   work_item_id?: any,
 *   job_id?: any,
 *   attempt_id?: any,
 *   event_type?: string,
 *   actor_type?: string,
 *   actor_id?: any,
 *   message?: string | null,
 *   event_json?: any,
 * }} [args]
 */
export function logEvent({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  event_type,
  actor_type,
  actor_id = null,
  message = null,
  event_json = null,
} = {}) {
  // Light-touch advisory: warn once per process for event_type values that
  // fall outside the registered namespaces. The write still proceeds so
  // existing freeform callers are not broken. See observability/event-types.js.
  warnOnceForInvalidEventType(event_type);
  _pendingEvents.push({
    work_item_id,
    job_id,
    attempt_id,
    event_type,
    actor_type,
    actor_id,
    message,
    event_json: normalizeJsonText(event_json),
    created_at: nowIso(),
  });
  if (_pendingEvents.length >= EVENT_BATCH_FLUSH_AT) {
    // Install the exit hook even on the threshold-flush path so a burst
    // of events at startup can't bypass durable-on-exit semantics.
    _ensureEventExitHook();
    if (_eventFlushTimer) {
      clearTimeout(_eventFlushTimer);
      _eventFlushTimer = null;
    }
    flushEventsNow();
  } else {
    _scheduleEventFlush();
  }
}

/**
 * Test-only: drop pending events without flushing. Used by harnesses
 * that recreate the DB between cases.
 */
export function _discardPendingEventsForTests() {
  _pendingEvents.length = 0;
  if (_eventFlushTimer) {
    clearTimeout(_eventFlushTimer);
    _eventFlushTimer = null;
  }
}

export function getEvents(jobId = null, limit = 100) {
  // Drain pending inserts so the caller sees the same state they wrote.
  flushEventsNow();
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const fileRows = readEventFileRows({ jobId, limit: cappedLimit, order: "desc" });
  let dbRows;
  if (jobId) {
    dbRows = db.prepare(`SELECT * FROM events WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(jobId, cappedLimit);
  } else {
    dbRows = db.prepare(`SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?`).all(cappedLimit);
  }
  return mergeEventRows([...fileRows, ...dbRows], "desc", cappedLimit);
}

export function getEventsByWorkItem(workItemId, limit = 100) {
  flushEventsNow();
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  // Historical snapshot only. This intentionally returns the latest rows for a
  // work item and may include events you've already seen in prior polls.
  // For streaming/tailing monitors, prefer getEventsByWorkItemSinceId(...).
  const fileRows = readEventFileRows({ workItemId, limit: cappedLimit, order: "desc" });
  const dbRows = db.prepare(`SELECT * FROM events WHERE work_item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(workItemId, cappedLimit);
  return mergeEventRows([...fileRows, ...dbRows], "desc", cappedLimit);
}

/**
 * Cursor-safe event query for monitors.
 * Returns only events with id > sinceId in ascending id order.
 */
export function getEventsByWorkItemSinceId(workItemId, sinceId = 0, limit = 100) {
  flushEventsNow();
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const fileRows = readEventFileRows({ workItemId, sinceId, limit: cappedLimit, order: "asc" });
  const dbRows = db.prepare(`
    SELECT * FROM events
    WHERE work_item_id = ?
      AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(workItemId, Number(sinceId) || 0, cappedLimit);
  return mergeEventRows([...fileRows, ...dbRows], "asc", cappedLimit);
}

/**
 * Cursor-safe global event query for monitors.
 * Returns only events with id > sinceId in ascending id order.
 */
export function getEventsSinceId(sinceId = 0, limit = 100) {
  flushEventsNow();
  const db = getDb();
  const cappedLimit = Math.max(0, Number(limit) || 0);
  const fileRows = readEventFileRows({ sinceId, limit: cappedLimit, order: "asc" });
  const dbRows = db.prepare(`
    SELECT * FROM events
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(Number(sinceId) || 0, cappedLimit);
  return mergeEventRows([...fileRows, ...dbRows], "asc", cappedLimit);
}

export function getHeadEventId() {
  flushEventsNow();
  const db = getDb();
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get();
  const fileHead = readEventFileRows({ limit: 1, order: "desc" })[0]?.id || 0;
  return Math.max(Number(row?.id || 0), Number(fileHead || 0));
}

export function countEventsByType(workItemId, eventType) {
  flushEventsNow();
  const db = getDb();
  const ids = new Set();
  const fallbackKeys = new Set();
  for (const row of db.prepare(`SELECT id, created_at, message FROM events WHERE work_item_id = ? AND event_type = ?`).all(workItemId, eventType)) {
    if (row.id != null) ids.add(Number(row.id));
    else fallbackKeys.add(`${row.created_at || ""}|${row.message || ""}`);
  }
  for (const row of readEventFileRows({ workItemId, eventType, limit: null, order: "asc" })) {
    if (row.id != null) ids.add(Number(row.id));
    else fallbackKeys.add(`${row.created_at || ""}|${row.message || ""}`);
  }
  return ids.size + fallbackKeys.size;
}
