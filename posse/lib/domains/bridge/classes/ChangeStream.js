import { EventEmitter } from "node:events";

import Database from "better-sqlite3";

import {
  BRIDGE_EVENT_KINDS,
  BRIDGE_FRAME_TYPES,
  BRIDGE_PROTOCOL_VERSION,
} from "../../../catalog/bridge.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { EVENT_TYPES } from "../../../catalog/event.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { redactBridgeValue } from "../functions/redaction.js";

const DEFAULT_REPLAY_LIMIT = 1000;
const DEFAULT_TAIL_LIMIT = 100;
const MAX_TAIL_LIMIT = 500;
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const OPEN_GATE_STATUSES = new Set(["queued", "waiting_on_human"]);

function boundedLimit(value, fallback = DEFAULT_TAIL_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_TAIL_LIMIT, parsed));
}

function parseJsonField(text) {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text) };
  }
}

function eventKindForEventType(eventType) {
  if (eventType === EVENT_TYPES.PLAN_APPROVAL_GATE_CREATED) return BRIDGE_EVENT_KINDS.GATE_OPENED;
  if (eventType === EVENT_TYPES.PLAN_APPROVED || eventType === EVENT_TYPES.PLAN_REJECTED) {
    return BRIDGE_EVENT_KINDS.GATE_CLOSED;
  }
  return null;
}

function resolutionForEventType(eventType) {
  if (eventType === EVENT_TYPES.PLAN_APPROVED) return "approved";
  if (eventType === EVENT_TYPES.PLAN_REJECTED) return "rejected";
  return "answered";
}

function resolutionForJob(job) {
  if (job.status === "succeeded") return "answered";
  if (job.status === "failed") return "rejected";
  if (job.status === "canceled" || job.status === "dead_letter") return "abandoned";
  return "answered";
}

function gateKindForJob(job, payload = {}) {
  if (payload?.subtype === "plan_approval") return "plan";
  if (payload?.review_type) return "review";
  if (job?.status === "waiting_on_review") return "review";
  return "human_input";
}

function promptFromGatePayload(payload) {
  if (Array.isArray(payload?.questions) && payload.questions.length > 0) {
    return payload.questions.map((question) => String(question || "").trim()).filter(Boolean).join("\n\n");
  }
  if (typeof payload?.prompt === "string" && payload.prompt.trim()) return payload.prompt.trim();
  return null;
}

function gatePayloadForJob(job) {
  const payload = parseJsonField(job.payload_json) || {};
  return {
    job_id: Number(job.id),
    work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
    kind: gateKindForJob(job, payload),
    title: job.title || "",
    prompt: promptFromGatePayload(payload),
    opened_at: job.updated_at || job.created_at || null,
    status: job.status,
    payload: redactBridgeValue(payload),
  };
}

function gateClosedPayloadForJob(job) {
  return {
    job_id: Number(job.id),
    work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
    resolution: resolutionForJob(job),
    closed_at: job.updated_at || new Date().toISOString(),
  };
}

function payloadForDbEvent(row) {
  const event = parseJsonField(row.event_json);
  const redactedEvent = redactBridgeValue(event);
  const kind = eventKindForEventType(row.event_type);
  if (kind === BRIDGE_EVENT_KINDS.GATE_OPENED) {
    return {
      job_id: Number(event?.gate_job_id || row.job_id || 0) || null,
      work_item_id: row.work_item_id == null ? null : Number(row.work_item_id),
      kind: "plan",
      title: row.message || "Plan approval",
      prompt: null,
      opened_at: row.created_at || null,
      event: redactedEvent,
    };
  }
  if (kind === BRIDGE_EVENT_KINDS.GATE_CLOSED) {
    return {
      job_id: row.job_id == null ? null : Number(row.job_id),
      work_item_id: row.work_item_id == null ? null : Number(row.work_item_id),
      resolution: resolutionForEventType(row.event_type),
      closed_at: row.created_at || null,
      event: redactedEvent,
    };
  }
  return {
    ...row,
    event: redactedEvent,
  };
}

function normalizeJobPayload(row) {
  return {
    ...row,
    payload: redactBridgeValue(parseJsonField(row.payload_json)),
    result: redactBridgeValue(parseJsonField(row.result_json)),
  };
}

function normalizeWorkItemPayload(row) {
  return {
    ...row,
    metadata: redactBridgeValue(parseJsonField(row.metadata_json)),
  };
}

function stripBridgeFrame(frame) {
  const { v, type, ...rest } = frame;
  return rest;
}

export function createBridgeEventFrame(kind, payload, {
  instanceId = null,
  eventId = 0,
  ts = new Date().toISOString(),
} = {}) {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: BRIDGE_FRAME_TYPES.EVENT,
    instance_id: instanceId,
    event_id: Number(eventId || 0),
    kind,
    payload,
    ts,
  };
}

export class ChangeStream extends EventEmitter {
  constructor({
    dbPath = getRuntimeDbPath(),
    pollMs = 500,
    instanceId = null,
    replayLimit = DEFAULT_REPLAY_LIMIT,
  } = {}) {
    super();
    this.dbPath = dbPath;
    this.pollMs = Math.max(50, Number(pollMs) || 500);
    this.instanceId = instanceId;
    this.replayLimit = Math.max(1, Number(replayLimit) || DEFAULT_REPLAY_LIMIT);
    this.db = null;
    this.timer = null;
    this.eventId = 0;
    this.dbEventCursor = 0;
    this.workItemCursor = { updatedAt: "", id: 0 };
    this.jobCursor = { updatedAt: "", id: 0 };
    this.useBridgeChangeSeq = false;
    this.gateStatusByJobId = new Map();
    this.replay = [];
  }

  start() {
    if (this.timer) return;
    this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
    this.db.pragma("busy_timeout = 10000");
    this.dbEventCursor = Number(this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get()?.id || 0);
    this.useBridgeChangeSeq = this.hasBridgeChangeTracking();
    this.workItemCursor = this.useBridgeChangeSeq
      ? { seq: this.readBridgeChangeCursor("work_items") }
      : this.readUpdatedCursor("work_items");
    this.jobCursor = this.useBridgeChangeSeq
      ? { seq: this.readBridgeChangeCursor("jobs") }
      : this.readUpdatedCursor("jobs");
    this.seedGateStatuses();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  tableHasColumn(tableName, columnName) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    return rows.some((row) => row.name === columnName);
  }

  hasBridgeChangeTracking() {
    return (
      this.tableHasColumn("work_items", "bridge_change_seq") &&
      this.tableHasColumn("jobs", "bridge_change_seq")
    );
  }

  readBridgeChangeCursor(tableName) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(bridge_change_seq), 0) AS seq
      FROM ${tableName}
    `).get();
    return Number(row?.seq || 0);
  }

  readUpdatedCursor(tableName) {
    const row = this.db.prepare(`
      SELECT id, updated_at
      FROM ${tableName}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get();
    return {
      updatedAt: row?.updated_at || "",
      id: Number(row?.id || 0),
    };
  }

  seedGateStatuses() {
    this.gateStatusByJobId.clear();
    const rows = this.db.prepare(`
      SELECT id, status
      FROM jobs
      WHERE job_type = 'human_input'
    `).all();
    for (const row of rows) {
      this.gateStatusByJobId.set(Number(row.id), row.status);
    }
  }

  emitBridgeEvent(kind, payload) {
    this.eventId += 1;
    const frame = createBridgeEventFrame(kind, payload, {
      instanceId: this.instanceId,
      eventId: this.eventId,
    });
    this.replay.push(frame);
    if (this.replay.length > this.replayLimit) {
      this.replay.splice(0, this.replay.length - this.replayLimit);
    }
    this.emit("frame", frame);
    return frame;
  }

  snapshotFrame(payload) {
    return createBridgeEventFrame(BRIDGE_EVENT_KINDS.SNAPSHOT, payload, {
      instanceId: this.instanceId,
      eventId: 0,
    });
  }

  headEventId() {
    return this.eventId;
  }

  tailFrames({ sinceEventId = 0, limit = DEFAULT_TAIL_LIMIT } = {}) {
    const since = Number(sinceEventId || 0);
    const capped = boundedLimit(limit);
    return {
      events: this.replay
        .filter((frame) => Number(frame.event_id) > since)
        .slice(-capped)
        .map(stripBridgeFrame),
      head_event_id: this.headEventId(),
    };
  }

  poll() {
    if (!this.db) return;
    try {
      this.pollEvents();
      this.pollWorkItems();
      this.pollJobs();
    } catch (err) {
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.FAILED, {
        summary: err?.message || String(err),
      });
    }
  }

  pollEvents() {
    const rows = this.db.prepare(`
      SELECT *
      FROM events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 250
    `).all(this.dbEventCursor);
    for (const row of rows) {
      this.dbEventCursor = Math.max(this.dbEventCursor, Number(row.id));
      const kind = eventKindForEventType(row.event_type);
      if (kind) this.emitBridgeEvent(kind, payloadForDbEvent(row));
    }
  }

  pollWorkItems() {
    if (this.useBridgeChangeSeq) {
      this.pollWorkItemsByChangeSeq();
      return;
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM work_items
      WHERE updated_at > ?
         OR (updated_at = ? AND id > ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT 250
    `).all(this.workItemCursor.updatedAt, this.workItemCursor.updatedAt, this.workItemCursor.id);
    for (const row of rows) {
      this.workItemCursor = { updatedAt: row.updated_at || this.workItemCursor.updatedAt, id: Number(row.id) };
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.WORK_ITEM_UPDATED, normalizeWorkItemPayload(row));
    }
  }

  pollWorkItemsByChangeSeq() {
    const rows = this.db.prepare(`
      SELECT *
      FROM work_items
      WHERE bridge_change_seq > ?
      ORDER BY bridge_change_seq ASC, id ASC
      LIMIT 250
    `).all(this.workItemCursor.seq);
    for (const row of rows) {
      this.workItemCursor = { seq: Math.max(Number(this.workItemCursor.seq || 0), Number(row.bridge_change_seq || 0)) };
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.WORK_ITEM_UPDATED, normalizeWorkItemPayload(row));
    }
  }

  pollJobs() {
    if (this.useBridgeChangeSeq) {
      this.pollJobsByChangeSeq();
      return;
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE updated_at > ?
         OR (updated_at = ? AND id > ?)
      ORDER BY updated_at ASC, id ASC
      LIMIT 250
    `).all(this.jobCursor.updatedAt, this.jobCursor.updatedAt, this.jobCursor.id);
    for (const row of rows) {
      this.jobCursor = { updatedAt: row.updated_at || this.jobCursor.updatedAt, id: Number(row.id) };
      const jobPayload = normalizeJobPayload(row);
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.JOB_UPDATED, jobPayload);
      this.emitGateTransition(row);
    }
  }

  pollJobsByChangeSeq() {
    const rows = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE bridge_change_seq > ?
      ORDER BY bridge_change_seq ASC, id ASC
      LIMIT 250
    `).all(this.jobCursor.seq);
    for (const row of rows) {
      this.jobCursor = { seq: Math.max(Number(this.jobCursor.seq || 0), Number(row.bridge_change_seq || 0)) };
      const jobPayload = normalizeJobPayload(row);
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.JOB_UPDATED, jobPayload);
      this.emitGateTransition(row);
    }
  }

  emitGateTransition(row) {
    if (row.job_type !== "human_input") return;
    const jobId = Number(row.id);
    const previousStatus = this.gateStatusByJobId.get(jobId);
    const wasOpen = OPEN_GATE_STATUSES.has(previousStatus);
    const isOpen = OPEN_GATE_STATUSES.has(row.status);
    const wasTerminal = TERMINAL_JOB_STATUS_SET.has(previousStatus);
    const isTerminal = TERMINAL_JOB_STATUS_SET.has(row.status);

    if (isOpen && !wasOpen) {
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.GATE_OPENED, gatePayloadForJob(row));
    } else if (isTerminal && previousStatus !== undefined && !wasTerminal) {
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.GATE_CLOSED, gateClosedPayloadForJob(row));
    }
    this.gateStatusByJobId.set(jobId, row.status);
  }

  close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
