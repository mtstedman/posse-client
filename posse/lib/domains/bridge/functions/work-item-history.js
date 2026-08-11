import crypto from "node:crypto";

import { getDb } from "../../../shared/storage/functions/index.js";
import { queryRetainedEventRows } from "../../queue/functions/events.js";
import {
  WORK_ITEM_BOUNDS,
  WORK_ITEM_HISTORY_PROTOCOL,
  commonEnvelope,
  decimalId,
  observedAt,
  projectFeedEvent,
  resolveRangeRequest,
  retentionInfo,
  validateRepositoryBinding,
} from "./work-item-feed.js";

const FEED_KINDS = new Set([
  "comment", "chat", "question", "answer", "nudge", "agent_update",
  "work_item_state", "lane_state", "handoff", "completion", "action",
  "error", "runtime_batch", "unknown",
]);

function queryIdentity(args, repoPath, range, retentionEpoch) {
  return JSON.stringify({
    repo_path: repoPath,
    work_item_id: args.work_item_id == null ? null : String(args.work_item_id),
    job_id: args.job_id == null ? null : String(args.job_id),
    event_kinds: Array.isArray(args.event_kinds) ? [...args.event_kinds].map(String).sort() : [],
    actionable: typeof args.actionable === "boolean" ? args.actionable : null,
    requested: range.requested,
    retention_epoch: retentionEpoch,
  });
}

function queryHash(identity) {
  return crypto.createHash("sha256").update(identity, "utf8").digest("base64url").slice(0, 24);
}

function encodeCursor({ anchor, direction, identity }) {
  const payload = Buffer.from(JSON.stringify({ v: 1, a: anchor, d: direction, h: queryHash(identity) }), "utf8")
    .toString("base64url");
  const signature = crypto.createHash("sha256")
    .update(`posse-history-cursor-v1\0${payload}\0${identity}`, "utf8")
    .digest("base64url")
    .slice(0, 24);
  return `${payload}.${signature}`;
}

function decodeCursor(cursor, identity) {
  const text = String(cursor || "");
  if (!text || Buffer.byteLength(text, "utf8") > 512) return null;
  const [payload, signature, extra] = text.split(".");
  if (!payload || !signature || extra != null) return null;
  const expected = crypto.createHash("sha256")
    .update(`posse-history-cursor-v1\0${payload}\0${identity}`, "utf8")
    .digest("base64url")
    .slice(0, 24);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed?.h !== queryHash(identity)) return null;
    const anchor = Number(parsed.a);
    if (!Number.isInteger(anchor) || anchor <= 0 || !["older", "newer"].includes(parsed.d)) return null;
    return { anchor, direction: parsed.d };
  } catch {
    return null;
  }
}

function numericFilter(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
}

function strictLimit(value, fallback, maximum) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
}

function eventTypePredicate(kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) return { sql: "", params: [] };
  const clauses = [];
  const params = [];
  const addLike = (pattern) => { clauses.push("event_type LIKE ?"); params.push(pattern); };
  for (const kind of kinds) {
    switch (kind) {
      case "agent_update": clauses.push("event_type = 'agent.activity'"); break;
      case "question": clauses.push("(event_type LIKE '%question%' AND event_type NOT LIKE '%answered%')"); break;
      case "answer": clauses.push("(event_type LIKE '%question%answered%' OR json_extract(event_json, '$.event_kind') = 'answer')"); break;
      case "nudge": clauses.push("event_type = 'operator_nudge.created'"); break;
      case "work_item_state": clauses.push("event_type = 'work_item.status_changed'"); break;
      case "lane_state": clauses.push("(event_type LIKE 'file_lane.%' OR event_type LIKE 'scheduler.file_lane_%')"); break;
      case "handoff": addLike("%handoff%"); break;
      case "completion": clauses.push("event_type IN ('work_item.canceled','work_item.iteration_finished')"); break;
      case "action": clauses.push("event_type = 'bridge.command_mutation'"); break;
      case "error": clauses.push("(event_type LIKE '%error%' OR event_type LIKE '%failed%')"); break;
      case "comment": clauses.push("json_extract(event_json, '$.event_kind') = 'comment'"); break;
      case "chat": clauses.push("json_extract(event_json, '$.event_kind') = 'chat'"); break;
      case "runtime_batch": clauses.push("json_extract(event_json, '$.event_kind') = 'runtime_batch'"); break;
      case "unknown": clauses.push("json_extract(event_json, '$.event_kind') = 'unknown'"); break;
      default: break;
    }
  }
  return clauses.length > 0 ? { sql: ` AND (${clauses.join(" OR ")})`, params } : { sql: "", params: [] };
}

function baseQuery(args, range) {
  const where = ["created_at >= ?", "created_at < ?"];
  const params = [range.effective.start_at, range.effective.end_at];
  const workItemId = numericFilter(args.work_item_id);
  const jobId = numericFilter(args.job_id);
  if (Number.isNaN(workItemId) || Number.isNaN(jobId)) return { ok: false, reason: "invalid_identity" };
  if (jobId != null && workItemId == null) return { ok: false, reason: "invalid_identity" };
  if (workItemId != null) { where.push("work_item_id = ?"); params.push(workItemId); }
  if (jobId != null) { where.push("job_id = ?"); params.push(jobId); }
  if (typeof args.actionable === "boolean") {
    where.push("COALESCE(json_extract(event_json, '$.actionable'), 0) = ?");
    params.push(args.actionable ? 1 : 0);
  }
  const kindPredicate = eventTypePredicate(args.event_kinds);
  return {
    ok: true,
    sql: `${where.join(" AND ")}${kindPredicate.sql}`,
    params: [...params, ...kindPredicate.params],
  };
}

function retainedRowMatches(row, args, range) {
  const occurredMs = Date.parse(row?.created_at || "");
  if (!Number.isFinite(occurredMs)) return false;
  if (occurredMs < Date.parse(range.effective.start_at) || occurredMs >= Date.parse(range.effective.end_at)) return false;
  const workItemId = numericFilter(args.work_item_id);
  const jobId = numericFilter(args.job_id);
  if (workItemId != null && Number(row.work_item_id) !== workItemId) return false;
  if (jobId != null && Number(row.job_id) !== jobId) return false;
  const event = projectFeedEvent(row);
  if (!event) return false;
  if (Array.isArray(args.event_kinds) && args.event_kinds.length > 0 && !args.event_kinds.includes(event.event_kind)) return false;
  if (typeof args.actionable === "boolean" && event.actionable !== args.actionable) return false;
  return true;
}

function retainedFileRows(args, range, { direction, anchor = null, limit }) {
  return queryRetainedEventRows({
    order: direction === "newer" ? "asc" : "desc",
    limit,
    predicate: (row) => {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) return false;
      if (anchor != null && (direction === "older" ? id >= anchor : id <= anchor)) return false;
      return retainedRowMatches(row, args, range);
    },
  });
}

function mergeRowsByEventId(rows, { direction, limit }) {
  const byId = new Map();
  for (const row of rows) {
    const id = Number(row?.id);
    if (Number.isInteger(id) && id > 0) byId.set(id, row);
  }
  return [...byId.values()]
    .sort((a, b) => direction === "newer" ? Number(a.id) - Number(b.id) : Number(b.id) - Number(a.id))
    .slice(0, limit);
}

function hasRetainedRow(args, range, predicate) {
  return queryRetainedEventRows({
    order: "asc",
    limit: 1,
    predicate: (row) => retainedRowMatches(row, args, range) && predicate(row),
  }).length > 0;
}

function invalidCursorEnvelope(envelope, range, limit) {
  return {
    ...envelope,
    mode: "page",
    requested: range.requested,
    effective: range.effective,
    completeness: "unavailable",
    partial_reasons: ["cursor_invalid"],
    retention: { ...range.retention, beginning_reached: false },
    events: [],
    page: {
      limit,
      has_older: false,
      has_newer: false,
      older_cursor: null,
      newer_cursor: null,
      cursor_valid: false,
    },
    safe_reason: "cursor_invalid",
  };
}

export function projectWorkItemHistory(args = {}, context = {}) {
  const binding = validateRepositoryBinding(args, context);
  if (!binding.ok) return binding;
  if (args.event_kinds != null && !Array.isArray(args.event_kinds)) {
    return { ok: false, reason: "invalid_event_kinds" };
  }
  if (Array.isArray(args.event_kinds) && (
    args.event_kinds.length > 16
    || new Set(args.event_kinds.map(String)).size !== args.event_kinds.length
    || args.event_kinds.some((kind) => !FEED_KINDS.has(String(kind)))
  )) {
    return { ok: false, reason: "invalid_event_kinds" };
  }
  if (args.actionable != null && typeof args.actionable !== "boolean") {
    return { ok: false, reason: "invalid_actionable" };
  }
  const db = context.db || getDb();
  const range = resolveRangeRequest(args.timeframe, context, { projectDir: binding.repoPath, db });
  if (!range.ok) return { ok: false, reason: range.reason };
  const limit = strictLimit(args.limit, 50, WORK_ITEM_BOUNDS.HISTORY_PAGE);
  if (limit == null) return { ok: false, reason: "invalid_limit" };
  const query = baseQuery(args, range);
  if (!query.ok) return { ok: false, reason: query.reason };
  if (args.job_id != null) {
    const matching = db.prepare("SELECT 1 FROM jobs WHERE id = ? AND work_item_id = ?").get(Number(args.job_id), Number(args.work_item_id));
    if (!matching) return { ok: false, reason: "target_not_found" };
  }
  const identity = queryIdentity(args, binding.repoPath, range, range.retention.retention_epoch);
  let direction = "older";
  let anchor = null;
  if (args.cursor != null) {
    if (!args.direction || !["older", "newer"].includes(args.direction)) {
      return invalidCursorEnvelope(commonEnvelope(WORK_ITEM_HISTORY_PROTOCOL, binding.repoPath, context, db), range, limit);
    }
    const decoded = decodeCursor(args.cursor, identity);
    if (!decoded || decoded.direction !== args.direction) {
      return invalidCursorEnvelope(commonEnvelope(WORK_ITEM_HISTORY_PROTOCOL, binding.repoPath, context, db), range, limit);
    }
    direction = decoded.direction;
    anchor = decoded.anchor;
    const anchorExists = db.prepare(`SELECT 1 FROM events WHERE id = ? AND ${query.sql}`).get(anchor, ...query.params)
      || hasRetainedRow(args, range, (row) => Number(row.id) === anchor);
    if (!anchorExists) {
      return invalidCursorEnvelope(commonEnvelope(WORK_ITEM_HISTORY_PROTOCOL, binding.repoPath, context, db), range, limit);
    }
  }

  const comparator = anchor == null ? "" : direction === "older" ? " AND id < ?" : " AND id > ?";
  const order = direction === "newer" ? "ASC" : "DESC";
  const databaseRows = db.prepare(`
    SELECT * FROM events
    WHERE ${query.sql}${comparator}
    ORDER BY id ${order}
    LIMIT ?
  `).all(...query.params, ...(anchor == null ? [] : [anchor]), limit + 1);
  const fileRows = retainedFileRows(args, range, { direction, anchor, limit: limit + 1 });
  const rows = mergeRowsByEventId([...databaseRows, ...fileRows], { direction, limit: limit + 1 });
  const selected = rows.slice(0, limit);
  const projected = selected.map(projectFeedEvent).filter(Boolean).sort((a, b) => (
    a.occurred_at.localeCompare(b.occurred_at)
    || a.order_key.localeCompare(b.order_key)
    || a.event_id.localeCompare(b.event_id)
  ));
  const firstId = selected.length > 0 ? Math.min(...selected.map((row) => Number(row.id))) : null;
  const lastId = selected.length > 0 ? Math.max(...selected.map((row) => Number(row.id))) : null;
  const hasOlder = firstId != null
    ? !!db.prepare(`SELECT 1 FROM events WHERE ${query.sql} AND id < ? LIMIT 1`).get(...query.params, firstId)
      || hasRetainedRow(args, range, (row) => Number(row.id) < firstId)
    : false;
  const hasNewer = lastId != null
    ? !!db.prepare(`SELECT 1 FROM events WHERE ${query.sql} AND id > ? LIMIT 1`).get(...query.params, lastId)
      || hasRetainedRow(args, range, (row) => Number(row.id) > lastId)
    : false;
  const partialReasons = [...range.partialReasons];
  return {
    ...commonEnvelope(WORK_ITEM_HISTORY_PROTOCOL, binding.repoPath, context, db),
    mode: "page",
    requested: range.requested,
    effective: range.effective,
    completeness: partialReasons.length > 0 ? "partial" : "complete",
    partial_reasons: partialReasons,
    retention: { ...range.retention, beginning_reached: !hasOlder },
    events: projected,
    page: {
      limit,
      has_older: hasOlder,
      has_newer: hasNewer,
      older_cursor: hasOlder && firstId != null ? encodeCursor({ anchor: firstId, direction: "older", identity }) : null,
      newer_cursor: hasNewer && lastId != null ? encodeCursor({ anchor: lastId, direction: "newer", identity }) : null,
      cursor_valid: true,
    },
  };
}

export function projectWorkItemTail(args = {}, context = {}) {
  const binding = validateRepositoryBinding(args, context);
  if (!binding.ok) return binding;
  const db = context.db || getDb();
  const limit = strictLimit(args.limit, 20, WORK_ITEM_BOUNDS.HISTORY_TAIL);
  if (limit == null) return { ok: false, reason: "invalid_limit" };
  const workItemId = numericFilter(args.work_item_id);
  if (Number.isNaN(workItemId)) return { ok: false, reason: "invalid_identity" };
  let afterId = 0;
  if (args.after_event_id != null && args.after_event_id !== "") {
    const match = /^event:(\d+)$/.exec(String(args.after_event_id));
    if (!match) return { ok: false, reason: "invalid_event_id" };
    afterId = Number(match[1]);
    if (!Number.isSafeInteger(afterId) || afterId <= 0) return { ok: false, reason: "invalid_event_id" };
  }
  const where = ["id > ?"];
  const params = [afterId];
  if (workItemId != null) { where.push("work_item_id = ?"); params.push(workItemId); }
  const databaseRows = db.prepare(`
    SELECT * FROM events
    WHERE ${where.join(" AND ")}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, limit);
  const fileRows = queryRetainedEventRows({
    order: "desc",
    limit,
    predicate: (row) => {
      if (Number(row.id || 0) <= afterId) return false;
      return workItemId == null || Number(row.work_item_id) === workItemId;
    },
  });
  const rows = mergeRowsByEventId([...databaseRows, ...fileRows], { direction: "older", limit }).reverse();
  const retention = retentionInfo({ db, projectDir: binding.repoPath, beginningReached: rows.length < limit });
  const now = observedAt(context);
  return {
    ...commonEnvelope(WORK_ITEM_HISTORY_PROTOCOL, binding.repoPath, context, db),
    mode: "tail",
    requested: { kind: "custom", range_id: null, start_at: retention.earliest_retained_time || now, end_at: now },
    effective: { start_at: retention.earliest_retained_time || now, end_at: now },
    completeness: "complete",
    partial_reasons: [],
    retention,
    events: rows.map(projectFeedEvent).filter(Boolean),
    page: {
      limit,
      has_older: false,
      has_newer: false,
      older_cursor: null,
      newer_cursor: null,
      cursor_valid: true,
    },
  };
}

export const __testEncodeHistoryCursor = encodeCursor;
export const __testDecodeHistoryCursor = decodeCursor;
