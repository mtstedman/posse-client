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
import { composeInstanceStatus } from "../functions/instance-status.js";
import { workItemCost } from "../../billing/functions/cost.js";

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
  if (payload?.subtype === "push_offer") return "push";
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
    instanceStatusMinIntervalMs = 2_000,
    jobProgressScanIntervalMs = 5_000,
    costScanIntervalMs = 30_000,
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
    // instance_status: emit on change, min interval apart.
    this.instanceStatusMinIntervalMs = Math.max(250, Number(instanceStatusMinIntervalMs) || 2_000);
    this.instanceStatusLastCheckAt = 0;
    this.instanceStatusLastJson = "";
    // job_progress: periodic scan of non-terminal jobs, per-job dedupe.
    this.jobProgressScanIntervalMs = Math.max(500, Number(jobProgressScanIntervalMs) || 5_000);
    this.jobProgressLastScanAt = 0;
    this.jobProgressLastByJobId = new Map();
    // cost_updated cadence: periodic recompute for active WIs + forced
    // recompute when a job lands in a terminal status.
    this.costScanIntervalMs = Math.max(1_000, Number(costScanIntervalMs) || 30_000);
    this.costLastScanAt = 0;
    this.costTotalsByWiId = new Map();
    this.costDirtyWiIds = new Set();
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
    // Terminal gates are not seeded: they can never reopen, so tracking them
    // would only grow the map for the daemon's lifetime. An untracked terminal
    // job that gets touched again emits nothing (gate_closed requires a known
    // previous status), which is the desired behavior.
    const rows = this.db.prepare(`
      SELECT id, status
      FROM jobs
      WHERE job_type = 'human_input'
    `).all();
    for (const row of rows) {
      if (TERMINAL_JOB_STATUS_SET.has(row.status)) continue;
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
      this.pollInstanceStatus();
      this.pollJobProgress();
      this.pollCosts();
    } catch (err) {
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.FAILED, {
        summary: err?.message || String(err),
      });
    }
  }

  pollInstanceStatus(nowMs = Date.now()) {
    if (nowMs - this.instanceStatusLastCheckAt < this.instanceStatusMinIntervalMs) return;
    this.instanceStatusLastCheckAt = nowMs;
    let status;
    try {
      status = composeInstanceStatus(this.db, { nowMs });
    } catch {
      return; // older DB without runtime_status — degrade silently
    }
    // Emit on change only; updated_at is excluded from the comparison so a
    // quiet instance doesn't re-emit an identical status every interval.
    const { updated_at: _ignored, ...comparable } = status;
    const json = JSON.stringify(comparable);
    if (json === this.instanceStatusLastJson) return;
    this.instanceStatusLastJson = json;
    this.emitBridgeEvent(BRIDGE_EVENT_KINDS.INSTANCE_STATUS, status);
  }

  pollJobProgress(nowMs = Date.now()) {
    if (nowMs - this.jobProgressLastScanAt < this.jobProgressScanIntervalMs) return;
    this.jobProgressLastScanAt = nowMs;
    const jobs = this.db.prepare(`
      SELECT id, work_item_id, job_type, status, title, provider, model_name,
             attempt_count, created_at, started_at, updated_at
      FROM jobs
      WHERE status IN ('running', 'leased', 'awaiting_assessment')
      LIMIT 100
    `).all();

    const liveIds = new Set();
    for (const job of jobs) {
      const jobId = Number(job.id);
      liveIds.add(jobId);
      let tokens = { tokens_in: null, tokens_out: null, last_activity_at: null };
      try {
        const row = this.db.prepare(`
          SELECT SUM(input_tokens) AS tokens_in,
                 SUM(output_tokens) AS tokens_out,
                 MAX(created_at) AS last_activity_at
          FROM agent_calls
          WHERE job_id = ?
        `).get(jobId);
        tokens = {
          tokens_in: row?.tokens_in == null ? null : Number(row.tokens_in),
          tokens_out: row?.tokens_out == null ? null : Number(row.tokens_out),
          last_activity_at: row?.last_activity_at || null,
        };
      } catch { /* agent_calls may be absent in minimal fixtures */ }

      const startedAtMs = Date.parse(job.started_at || job.created_at || "") || nowMs;
      // elapsed ticks every scan, so dedupe on the meaningful fields only.
      const dedupeKey = [job.status, job.attempt_count, tokens.tokens_in, tokens.tokens_out, tokens.last_activity_at].join("|");
      if (this.jobProgressLastByJobId.get(jobId) === dedupeKey) continue;
      this.jobProgressLastByJobId.set(jobId, dedupeKey);

      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.JOB_PROGRESS, {
        job_id: jobId,
        work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
        job_type: job.job_type,
        status: job.status,
        attempt_count: Number(job.attempt_count) || 0,
        provider: job.provider || null,
        model_name: job.model_name || null,
        started_at: job.started_at || job.created_at || null,
        elapsed_ms: Math.max(0, nowMs - startedAtMs),
        last_activity_at: tokens.last_activity_at,
        tokens_in: tokens.tokens_in,
        tokens_out: tokens.tokens_out,
      });
    }
    // Evict throttle entries for jobs that left the live set.
    for (const jobId of this.jobProgressLastByJobId.keys()) {
      if (!liveIds.has(jobId)) this.jobProgressLastByJobId.delete(jobId);
    }
  }

  pollCosts(nowMs = Date.now()) {
    const due = nowMs - this.costLastScanAt >= this.costScanIntervalMs;
    if (!due && this.costDirtyWiIds.size === 0) return;

    let wiIds;
    if (due) {
      this.costLastScanAt = nowMs;
      const rows = this.db.prepare(`
        SELECT DISTINCT work_item_id AS id
        FROM jobs
        WHERE status IN ('running', 'leased', 'awaiting_assessment', 'queued')
        LIMIT 100
      `).all();
      wiIds = new Set(rows.map((row) => Number(row.id)).filter(Boolean));
      for (const id of this.costDirtyWiIds) wiIds.add(id);
    } else {
      wiIds = new Set(this.costDirtyWiIds);
    }
    this.costDirtyWiIds.clear();

    for (const wiId of wiIds) {
      let cost;
      try {
        cost = workItemCost(wiId, { db: this.db });
      } catch {
        continue;
      }
      const total = Number(cost?.totalCostUsd ?? 0);
      if (!Number.isFinite(total)) continue;
      const previous = this.costTotalsByWiId.get(wiId) ?? 0;
      const delta = total - previous;
      if (Math.abs(delta) <= 0.001) continue;
      this.costTotalsByWiId.set(wiId, total);
      this.emitBridgeEvent(BRIDGE_EVENT_KINDS.COST_UPDATED, {
        work_item_id: wiId,
        usd_total: total,
        usd_delta: delta,
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
      this.markCostDirtyOnTerminal(row);
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
      this.markCostDirtyOnTerminal(row);
    }
  }

  markCostDirtyOnTerminal(row) {
    if (!TERMINAL_JOB_STATUS_SET.has(row.status)) return;
    const wiId = Number(row.work_item_id);
    if (Number.isInteger(wiId) && wiId > 0) this.costDirtyWiIds.add(wiId);
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
    // Evict terminal gates instead of tracking them forever — human-input
    // jobs never leave a terminal status, and this map lives as long as the
    // daemon does.
    if (isTerminal) {
      this.gateStatusByJobId.delete(jobId);
    } else {
      this.gateStatusByJobId.set(jobId, row.status);
    }
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
