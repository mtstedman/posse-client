import {
  getEvents,
  getEventsByWorkItem,
  getEventsByWorkItemSinceId,
  getEventsSinceId,
  getHeadEventId,
  getHumanGate,
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
import { composeInstanceStatus } from "./instance-status.js";
import { ONESHOT_SCOPE_SELECTION_SUBTYPE } from "../../../catalog/job.js";
import { BRIDGE_OPEN_GATE_STATUSES } from "../../../catalog/bridge.js";
import { bridgeGateAnswerContract, bridgeGateKindForJob } from "./gate-contract.js";
import { buildReviewBrief } from "./review-brief.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_GATE_OPTIONS = 20;
const MAX_GATE_OPTION_VALUE_CHARS = 128;
const MAX_GATE_OPTION_LABEL_CHARS = 200;
const MAX_UNMERGED_WORK_ITEMS = 20;
const OPEN_GATE_STATUSES = new Set(BRIDGE_OPEN_GATE_STATUSES);
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
    return null;
  }
}

function boundedText(value, maxChars = MAX_SUMMARY_CHARS) {
  if (value == null) return null;
  return String(value).slice(0, maxChars);
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Project a work-item row onto the public control protocol. Never spread a
 * database row here: columns such as `source`, descriptions, metadata, and
 * future raw fields are intentionally outside the remote-control boundary.
 */
export function projectBridgeWorkItem(row, activeJobs = 0) {
  if (!row) return null;
  return {
    id: finiteNumber(row.id, 0),
    title: boundedText(row.title, MAX_SUMMARY_CHARS) || "",
    status: String(row.status || ""),
    priority: String(row.priority || "normal"),
    active_job_count: Math.max(0, finiteNumber(activeJobs, 0)),
  };
}

/**
 * Project a job row onto the fields understood by Pocket Posse. Payloads,
 * results, logs, and provider output remain local even after redaction because
 * the relay's contract is summaries/ids/status only.
 */
export function projectBridgeJob(row) {
  if (!row) return null;
  return {
    id: finiteNumber(row.id, 0),
    work_item_id: row.work_item_id == null ? null : finiteNumber(row.work_item_id, null),
    job_type: String(row.job_type || ""),
    title: boundedText(row.title, MAX_SUMMARY_CHARS) || "",
    status: String(row.status || ""),
    provider: row.provider == null ? null : boundedText(row.provider, 200),
    model_name: row.model_name == null ? null : boundedText(row.model_name, 300),
  };
}

/**
 * Project persisted event rows to audit-style metadata. The nested event JSON
 * is deliberately excluded; even a redacted object can contain prohibited
 * source-shaped keys and is not consumed by the phone.
 */
export function projectBridgeEventRecord(row) {
  if (!row) return null;
  const eventType = String(row.event_type || "");
  return {
    id: finiteNumber(row.id, 0),
    work_item_id: row.work_item_id == null ? null : finiteNumber(row.work_item_id, null),
    job_id: row.job_id == null ? null : finiteNumber(row.job_id, null),
    attempt_id: row.attempt_id == null ? null : finiteNumber(row.attempt_id, null),
    event_type: eventType,
    actor_type: row.actor_type == null ? null : boundedText(row.actor_type, 100),
    actor_id: row.actor_id == null ? null : boundedText(row.actor_id, 200),
    message: boundedText(row.message, MAX_SUMMARY_CHARS) || "",
    created_at: row.created_at == null ? null : String(row.created_at),
  };
}

function projectSelectorOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .slice(0, MAX_GATE_OPTIONS)
    .map((option) => {
      if (!option || typeof option !== "object") return null;
      const value = boundedText(option.value, MAX_GATE_OPTION_VALUE_CHARS);
      const label = boundedText(option.label, MAX_GATE_OPTION_LABEL_CHARS);
      if (!value || !label) return null;
      return { value, label };
    })
    .filter(Boolean);
}

function projectSelector(selector) {
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return null;
  const projected = {};
  if (selector.status != null) projected.status = boundedText(selector.status, 80);
  const options = projectSelectorOptions(selector.options);
  if (options.length > 0) projected.options = options;
  return Object.keys(projected).length > 0 ? projected : null;
}

function projectUnmergedWorkItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_UNMERGED_WORK_ITEMS).map((item) => ({
    wi_id: item?.wi_id == null ? null : finiteNumber(item.wi_id, null),
    title: boundedText(item?.title, 240) || "",
    branch: boundedText(item?.branch, 240) || "",
  }));
}

/**
 * Strict allowlist for kind-specific gate details. This keeps push metadata
 * and one-shot selector choices useful without tunnelling arbitrary job
 * payloads through a field named `payload`.
 */
export function projectBridgeGateDetail(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const detail = {};
  for (const key of ["subtype", "review_type", "remote", "push_branch", "target_branch"]) {
    if (payload[key] != null) detail[key] = boundedText(payload[key], 240);
  }
  for (const key of ["ahead_count", "merged_count"]) {
    if (payload[key] != null) detail[key] = finiteNumber(payload[key], null);
  }
  if (typeof payload.working_tree_dirty === "boolean") {
    detail.working_tree_dirty = payload.working_tree_dirty;
  }
  const unmerged = projectUnmergedWorkItems(payload.unmerged_wis);
  if (unmerged.length > 0) detail.unmerged_wis = unmerged;
  const selector = projectSelector(payload.selector);
  if (selector) detail.selector = selector;
  const oneshotScope = projectSelector(payload.oneshot_scope);
  if (oneshotScope) detail.oneshot_scope = oneshotScope;
  return Object.keys(detail).length > 0 ? detail : null;
}

function hasSinceCursor(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeLatestEvents(rows) {
  return rows
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(projectBridgeEventRecord);
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

function isReadyOneshotScopeSelection(payload = {}) {
  const isScopeSelection = payload?.subtype === ONESHOT_SCOPE_SELECTION_SUBTYPE
    || payload?.review_type === ONESHOT_SCOPE_SELECTION_SUBTYPE;
  if (!isScopeSelection) return true;
  return payload?.selector?.status === "ready" || payload?.oneshot_scope?.status === "ready";
}

function gateRetryChain(originalJobId) {
  const lineage = [];
  const seen = new Set();
  let cursor = originalJobId ? getJob(originalJobId) : null;
  while (cursor && lineage.length < 8 && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    lineage.unshift({
      job_id: Number(cursor.id),
      job_type: cursor.job_type,
      title: boundedText(cursor.title, 100) || "",
    });
    cursor = cursor.parent_job_id ? getJob(cursor.parent_job_id) : null;
  }
  return lineage;
}

export function normalizeGate(job) {
  if (!job || job.job_type !== "human_input") return null;
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload
    : parseJobPayload(job);
  const contract = getHumanGate(job.id);
  const originalJobId = contract?.original_job_id == null
    ? null
    : Number(contract.original_job_id);
  const createdMs = Date.parse(job.created_at || job.updated_at || "");
  const kind = bridgeGateKindForJob(job, payload);
  // Review gates carry a bounded files-changed + assessor-verdict brief so
  // an operator can judge the work from the phone without any raw code
  // crossing the relay. Other gate kinds skip the git lookup entirely.
  let reviewBrief = null;
  if (kind === "review") {
    try {
      reviewBrief = buildReviewBrief(job);
    } catch { /* a brief is advisory; never break the gate list */ }
  }
  return {
    job_id: Number(job.id),
    work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
    kind,
    title: job.title || "",
    prompt: promptFromGatePayload(payload),
    opened_at: job.updated_at || job.created_at || null,
    status: job.status,
    ...(reviewBrief ? { review_brief: reviewBrief } : {}),
    identity: {
      work_item_id: job.work_item_id == null ? null : Number(job.work_item_id),
      original_job_id: originalJobId,
      gate_job_id: Number(job.id),
      gate_kind: contract?.gate_kind || payload.gate_kind || payload.review_type || payload.subtype || "clarification",
      gate_generation: Number(contract?.generation || 1),
      gate_state: contract?.gate_state || "open",
      age_ms: Number.isFinite(createdMs) ? Math.max(0, Date.now() - createdMs) : null,
      retry_chain: gateRetryChain(originalJobId),
    },
    ...bridgeGateAnswerContract(payload),
    payload: projectBridgeGateDetail(payload),
  };
}

function isOpenGateJob(job) {
  if (job?.job_type !== "human_input" || !OPEN_GATE_STATUSES.has(job.status)) return false;
  const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? job.payload
    : parseJobPayload(job);
  return isReadyOneshotScopeSelection(payload);
}

function summarizeWorkItem(wi) {
  const rawJobs = listJobsByWorkItem(wi.id);
  return projectBridgeWorkItem(wi, activeJobCount(rawJobs));
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
    jobs: capped.map(projectBridgeJob),
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
  const rawJobs = listJobsByWorkItem(workItemId);
  const jobs = rawJobs.map(projectBridgeJob);
  return {
    work_item: projectBridgeWorkItem(wi, activeJobCount(rawJobs)),
    jobs,
    open_gates: rawJobs.filter(isOpenGateJob).map(normalizeGate).filter(Boolean),
    events: getEventsByWorkItem(workItemId, boundedLimit(eventLimit, 50)).map(projectBridgeEventRecord),
    reviewable: shouldIncludeWorkItemInApprovalQueue(wi, rawJobs),
  };
}

export function getJobState(jobId) {
  const job = getJob(jobId);
  return projectBridgeJob(job);
}

export function tailEvents({ workItemId = null, sinceId = null, limit = DEFAULT_LIMIT } = {}) {
  const capped = boundedLimit(limit);
  const hasSince = hasSinceCursor(sinceId);
  if (workItemId != null) {
    if (hasSince) return getEventsByWorkItemSinceId(workItemId, sinceId, capped).map(projectBridgeEventRecord);
    return normalizeLatestEvents(getEventsByWorkItem(workItemId, capped));
  }
  if (hasSince) return getEventsSinceId(sinceId, capped).map(projectBridgeEventRecord);
  return normalizeLatestEvents(getEvents(null, capped));
}

export function tailEventsEnvelope({
  workItemId = null,
  work_item_id = null,
  sinceEventId = null,
  since_event_id = null,
  sinceId = null,
  since_id = null,
  headId = null,
  head_id = null,
  bridgeEpoch = null,
  expectedBridgeEpoch = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  if (
    expectedBridgeEpoch != null &&
    bridgeEpoch != null &&
    String(expectedBridgeEpoch) !== String(bridgeEpoch)
  ) {
    return {
      ok: false,
      reason: "bridge_epoch_changed",
      bridge_epoch: String(bridgeEpoch),
      head_event_id: getHeadEventId(),
    };
  }
  const liveHead = getHeadEventId();
  const requestedHead = headId ?? head_id;
  const fixedHead = requestedHead == null || requestedHead === ""
    ? liveHead
    : Math.min(liveHead, Math.max(0, Number(requestedHead) || 0));
  const since = sinceEventId ?? since_event_id ?? sinceId ?? since_id ?? 0;
  const capped = boundedLimit(limit);
  const candidates = tailEvents({
    workItemId: workItemId ?? work_item_id,
    sinceId: since,
    limit: Math.min(MAX_LIMIT, capped + 1),
  }).filter((event) => Number(event.id) <= fixedHead);
  const events = candidates.slice(0, capped);
  const nextEventId = Number(events.at(-1)?.id ?? since ?? 0) || 0;
  let hasMore = candidates.length > events.length;
  if (!hasMore && events.length === capped && nextEventId < fixedHead) {
    hasMore = tailEvents({
      workItemId: workItemId ?? work_item_id,
      sinceId: nextEventId,
      limit: 1,
    }).some((event) => Number(event.id) <= fixedHead);
  }
  return {
    events,
    ...(bridgeEpoch ? { bridge_epoch: String(bridgeEpoch) } : {}),
    head_event_id: fixedHead,
    live_head_event_id: liveHead,
    next_event_id: nextEventId,
    has_more: hasMore,
    replay_complete: !hasMore,
  };
}

export function collectStateSnapshot({
  limit = DEFAULT_LIMIT,
  headEventId = 0,
  bridgeEpoch = null,
} = {}) {
  const capped = boundedLimit(limit);
  const workItems = listWorkItems().slice(0, capped).map(summarizeWorkItem);
  const activeJobs = listJobs().filter((job) => !TERMINAL_JOB_STATUS_SET.has(job.status));
  const jobs = activeJobs.slice(0, capped).map(projectBridgeJob);
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
    ...(bridgeEpoch ? { bridge_epoch: String(bridgeEpoch) } : {}),
    work_items: workItems,
    jobs,
    open_gates: openGates,
    instance_status: instanceStatus,
  };
}
