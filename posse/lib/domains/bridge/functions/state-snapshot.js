import {
  getEvents,
  getEventsByWorkItem,
  getEventsByWorkItemSinceId,
  getEventsSinceId,
  getHeadEventId,
  getJob,
  getWorkItem,
  listJobs,
  listJobsByWorkItem,
  listWorkItems,
} from "../../queue/functions/index.js";
import {
  TERMINAL_JOB_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
} from "../../queue/functions/common.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { shouldIncludeWorkItemInApprovalQueue } from "../../queue/functions/reviewable.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { redactBridgeValue } from "./redaction.js";
import { composeInstanceStatus } from "./instance-status.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const OPEN_GATE_STATUSES = new Set(["queued", "waiting_on_human"]);
const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

function parseJsonField(text) {
  if (text == null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text) };
  }
}

function normalizeWorkItem(row) {
  if (!row) return null;
  const { metadata_json: _metadataJson, ...safeRow } = row;
  return {
    ...safeRow,
    metadata: redactBridgeValue(parseJsonField(row.metadata_json)),
  };
}

function normalizeJob(row) {
  if (!row) return null;
  const { payload_json: _payloadJson, result_json: _resultJson, ...safeRow } = row;
  return {
    ...safeRow,
    payload: redactBridgeValue(parseJobPayload(row)),
    result: redactBridgeValue(parseJsonField(row.result_json)),
  };
}

function normalizeEvent(row) {
  if (!row) return null;
  const { event_json: _eventJson, ...safeRow } = row;
  return {
    ...safeRow,
    event: redactBridgeValue(parseJsonField(row.event_json)),
  };
}

function hasSinceCursor(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeLatestEvents(rows) {
  return rows
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(normalizeEvent);
}

function activeJobCount(jobs = []) {
  return jobs.filter((job) => !TERMINAL_JOB_STATUS_SET.has(job.status)).length;
}

function promptFromGatePayload(payload, fallback = null) {
  if (Array.isArray(payload?.questions) && payload.questions.length > 0) {
    return payload.questions.map((question) => String(question || "").trim()).filter(Boolean).join("\n\n");
  }
  if (typeof payload?.prompt === "string" && payload.prompt.trim()) return payload.prompt.trim();
  if (typeof payload?.response_prompt === "string" && payload.response_prompt.trim()) {
    return payload.response_prompt.trim();
  }
  return fallback;
}

function gateKindForJob(job, payload = {}) {
  if (payload?.subtype === "push_offer") return "push";
  if (payload?.subtype === "plan_approval") return "plan";
  if (payload?.review_type) return "review";
  if (job?.status === "waiting_on_review") return "review";
  return "human_input";
}

export function normalizeGate(job) {
  if (!job || job.job_type !== "human_input") return null;
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload
    : parseJobPayload(job);
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

function isOpenGateJob(job) {
  return job?.job_type === "human_input" && OPEN_GATE_STATUSES.has(job.status);
}

function summarizeWorkItem(wi) {
  const jobs = listJobsByWorkItem(wi.id).map(normalizeJob);
  return {
    ...normalizeWorkItem(wi),
    active_job_count: activeJobCount(jobs),
    jobs,
    open_gates: jobs.map(normalizeGate).filter(Boolean).filter((gate) => OPEN_GATE_STATUSES.has(gate.status)),
    reviewable: shouldIncludeWorkItemInApprovalQueue(wi, jobs),
  };
}

export function listQueueState({ status = null, limit = DEFAULT_LIMIT } = {}) {
  if (Array.isArray(status) && status.length === 0) {
    return { total: 0, shown: 0, work_items: [] };
  }
  const rows = status == null
    ? listWorkItems().filter((wi) => !TERMINAL_WORK_ITEM_STATUS_SET.has(wi.status))
    : listWorkItems(status);
  const capped = rows.slice(0, boundedLimit(limit));
  return {
    total: rows.length,
    shown: capped.length,
    work_items: capped.map(summarizeWorkItem),
  };
}

export function listJobsState({ work_item_id = null, workItemId = null, status = null, limit = DEFAULT_LIMIT } = {}) {
  const wiId = work_item_id ?? workItemId ?? null;
  let rows = wiId == null ? listJobs(status) : listJobsByWorkItem(wiId, status);
  if (status && Array.isArray(status) && status.length === 0) rows = [];
  const capped = rows.slice(0, boundedLimit(limit));
  return {
    jobs: capped.map(normalizeJob),
  };
}

export function listGatesState({ work_item_id = null, workItemId = null, limit = DEFAULT_LIMIT } = {}) {
  const wiId = work_item_id ?? workItemId ?? null;
  const rows = wiId == null ? listJobs() : listJobsByWorkItem(wiId);
  const gates = rows.filter(isOpenGateJob).map(normalizeGate).filter(Boolean);
  return {
    gates: gates.slice(0, boundedLimit(limit)),
  };
}

export function getWorkItemState(workItemId, { eventLimit = 50 } = {}) {
  const wi = getWorkItem(workItemId);
  if (!wi) return null;
  const jobs = listJobsByWorkItem(workItemId).map(normalizeJob);
  return {
    work_item: normalizeWorkItem(wi),
    jobs,
    open_gates: jobs.map(normalizeGate).filter(Boolean).filter((gate) => OPEN_GATE_STATUSES.has(gate.status)),
    events: getEventsByWorkItem(workItemId, boundedLimit(eventLimit, 50)).map(normalizeEvent),
    reviewable: shouldIncludeWorkItemInApprovalQueue(wi, jobs),
  };
}

export function getJobState(jobId) {
  const job = getJob(jobId);
  return normalizeJob(job);
}

export function tailEvents({ workItemId = null, sinceId = null, limit = DEFAULT_LIMIT } = {}) {
  const capped = boundedLimit(limit);
  const hasSince = hasSinceCursor(sinceId);
  if (workItemId != null) {
    if (hasSince) return getEventsByWorkItemSinceId(workItemId, sinceId, capped).map(normalizeEvent);
    return normalizeLatestEvents(getEventsByWorkItem(workItemId, capped));
  }
  if (hasSince) return getEventsSinceId(sinceId, capped).map(normalizeEvent);
  return normalizeLatestEvents(getEvents(null, capped));
}

export function tailEventsEnvelope({
  workItemId = null,
  work_item_id = null,
  sinceEventId = null,
  since_event_id = null,
  sinceId = null,
  since_id = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  return {
    events: tailEvents({
      workItemId: workItemId ?? work_item_id,
      sinceId: sinceEventId ?? since_event_id ?? sinceId ?? since_id,
      limit,
    }),
    head_event_id: getHeadEventId(),
  };
}

export function collectStateSnapshot({ limit = DEFAULT_LIMIT, eventLimit = 50, headEventId = 0 } = {}) {
  const capped = boundedLimit(limit);
  const workItems = listWorkItems().slice(0, capped).map(summarizeWorkItem);
  const activeJobs = listJobs().filter((job) => !TERMINAL_JOB_STATUS_SET.has(job.status));
  const jobs = activeJobs.slice(0, capped).map(normalizeJob);
  const pendingHumanInputJobs = activeJobs.filter(isOpenGateJob);
  const pendingHumanInput = pendingHumanInputJobs.slice(0, capped).map(normalizeJob);
  const pendingPlanGates = pendingHumanInputJobs
    .filter((job) => parseJobPayload(job)?.subtype === "plan_approval")
    .slice(0, capped)
    .map(normalizeJob);
  const openGates = activeJobs.filter(isOpenGateJob).slice(0, capped).map(normalizeGate).filter(Boolean);
  let instanceStatus = null;
  try {
    instanceStatus = composeInstanceStatus(getDb());
  } catch {
    // Older DB without runtime_status — snapshot simply omits it.
  }
  return {
    generated_at: new Date().toISOString(),
    head_event_id: Number(headEventId || 0),
    work_items: workItems,
    jobs,
    open_gates: openGates,
    events: tailEvents({ limit: eventLimit }),
    pending_human_input: pendingHumanInput,
    pending_plan_gates: pendingPlanGates,
    reviewable_work_items: workItems.filter((wi) => wi.reviewable),
    instance_status: instanceStatus,
  };
}
