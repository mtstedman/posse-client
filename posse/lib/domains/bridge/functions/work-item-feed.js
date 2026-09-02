import crypto from "node:crypto";
import path from "node:path";

import {
  WORK_ITEM_ACTION_PROTOCOL,
  WORK_ITEM_BOUNDS,
  WORK_ITEM_FEED_EVENT_PROTOCOL,
  WORK_ITEM_HISTORY_PROTOCOL,
  WORK_ITEM_OVERVIEW_PROTOCOL,
  WORK_ITEM_STATS_PROTOCOL,
} from "../../../catalog/bridge.js";
import { FAILED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  listRunTelemetryFiles,
  readRunTelemetryEntries,
} from "../../../shared/telemetry/functions/run-telemetry.js";
import { getSetting } from "../../queue/functions/settings.js";
import { jobHasLiveLeaseAt } from "../../queue/functions/lease-state.js";
import { redactBridgeValue } from "./redaction.js";

export {
  WORK_ITEM_ACTION_PROTOCOL,
  WORK_ITEM_BOUNDS,
  WORK_ITEM_FEED_EVENT_PROTOCOL,
  WORK_ITEM_HISTORY_PROTOCOL,
  WORK_ITEM_OVERVIEW_PROTOCOL,
  WORK_ITEM_STATS_PROTOCOL,
} from "../../../catalog/bridge.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_RANGE_ID = "30d";
const RANGE_DAYS = Object.freeze([
  ["7d", "7 days", 7],
  ["30d", "30 days", 30],
  ["90d", "90 days", 90],
]);
const KNOWN_FEED_KINDS = new Set([
  "comment", "chat", "question", "answer", "nudge", "agent_update",
  "work_item_state", "lane_state", "handoff", "completion", "action",
  "error", "runtime_batch", "unknown",
]);
const AGENT_FEEDBACK_PHASES = new Set([
  "reading", "planning", "editing", "testing", "verifying", "blocked", "finalizing", "handoff",
]);
const AGENT_FEEDBACK_STATUSES = new Set(["running", "blocked", "waiting", "verifying", "done"]);
const TERMINAL_FEEDBACK_JOB_STATUSES = new Set(TERMINAL_JOB_STATUSES);
const FAILED_JOB_STATUS_SET = new Set(FAILED_JOB_STATUSES);
const QUESTION_STATES = new Set(["open", "pending", "answered", "rejected", "expired", "superseded", "closed"]);
const QUESTION_KINDS = new Set([
  "plan_approval", "file_scope_approval", "assessment_review",
  "assessment_transport_recovery", "assessment_retry_limit", "blocked_recovery",
  "partial_work_recovery", "dead_letter_recovery", "pipeline_head_recovery",
  "one_shot_file_scope", "push_offer", "legacy_unstructured",
]);
const LIVE_OWNER_DELIVERY_QUESTION_KINDS = new Set([
  "file_scope_approval", "assessment_review", "assessment_transport_recovery",
  "assessment_retry_limit", "blocked_recovery", "partial_work_recovery",
  "dead_letter_recovery", "pipeline_head_recovery", "one_shot_file_scope",
]);
const NUDGE_STATES = new Set([
  "queued", "signaled", "retrieved", "accepted", "rejected", "deferred", "superseded", "expired",
]);
const ACKNOWLEDGEMENT_DECISIONS = new Set(["accepted", "rejected", "deferred"]);
const QUESTION_CHOICE_IDS = Object.freeze({
  plan_approval: ["approve", "reject"],
  file_scope_approval: ["approve", "reject"],
  assessment_review: ["pass", "fail", "skip", "replan"],
  assessment_transport_recovery: ["retry", "pass", "fail", "skip", "replan"],
  assessment_retry_limit: ["pass", "fail", "skip", "replan"],
  blocked_recovery: ["retry", "skip", "replan", "explicit_waiver", "fail"],
  partial_work_recovery: ["extend", "commit", "revert"],
  dead_letter_recovery: ["retry", "retry:claude", "retry:openai", "retry:codex", "retry:grok", "skip", "fail"],
  pipeline_head_recovery: ["pass", "fail", "skip", "replan"],
  one_shot_file_scope: ["plan", "cancel"],
  push_offer: ["push", "decline"],
  legacy_unstructured: [],
});
const QUESTION_KIND_BY_REVIEW_TYPE = new Map([
  ["needs_review", "assessment_review"],
  ["assessment_parse_error", "assessment_review"],
  ["assessment_evidence_missing", "assessment_transport_recovery"],
  ["unknown_verdict", "assessment_review"],
  ["replan_limit", "assessment_review"],
  ["assessment_transport_error", "assessment_transport_recovery"],
  ["assessment_retry_limit", "assessment_retry_limit"],
  ["blocked_recovery", "blocked_recovery"],
  ["partial_work_recovery", "partial_work_recovery"],
  ["dead_letter_recovery", "dead_letter_recovery"],
  ["stall_exhausted_recovery", "dead_letter_recovery"],
  ["research_dead_letter_recovery", "pipeline_head_recovery"],
  ["oneshot_dead_letter_recovery", "pipeline_head_recovery"],
  ["scope_expansion_request", "file_scope_approval"],
]);
const QUESTION_CHOICE_COPY = Object.freeze({
  approve: ["Approve", "Allow the exact requested transition."],
  reject: ["Reject", "Reject the exact requested transition."],
  pass: ["Pass", "Accept the current work as passing."],
  fail: ["Fail", "Mark the current work as failed."],
  skip: ["Skip", "Skip this work and continue where policy permits."],
  replan: ["Replan", "Return the Work Item to its planning path."],
  retry: ["Retry", "Retry through the canonical owner transition."],
  explicit_waiver: ["Explicit waiver", "Accept the current work while recording that deterministic verification did not pass."],
  "retry:claude": ["Retry with Claude", "Retry through the Claude provider path."],
  "retry:openai": ["Retry with OpenAI", "Retry through the OpenAI provider path."],
  "retry:codex": ["Retry with Codex", "Retry through the Codex provider path."],
  "retry:grok": ["Retry with Grok", "Retry through the Grok provider path."],
  extend: ["Extend", "Resume partial work with an extended turn budget."],
  commit: ["Commit", "Commit the bounded partial output for assessment."],
  revert: ["Revert", "Discard the bounded partial output."],
  plan: ["Use planned flow", "Create a plan instead of a one-shot edit."],
  cancel: ["Cancel request", "Stop without creating a continuation job."],
  push: ["Push", "Run the repository-aware canonical push gate."],
  decline: ["Decline", "Close this push offer without pushing."],
});

export function normalizeRepositoryPath(value = process.cwd(), platform = process.platform) {
  let normalized = path.resolve(String(value || process.cwd())).replaceAll("\\", "/");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

export function validateRepositoryBinding(args = {}, context = {}) {
  const expected = normalizeRepositoryPath(context.projectDir || process.cwd());
  const supplied = typeof args.repo_path === "string" && args.repo_path.trim()
    ? normalizeRepositoryPath(args.repo_path)
    : null;
  if (!supplied) return { ok: false, reason: "missing_repo_path", repoPath: expected };
  if (supplied !== expected) return { ok: false, reason: "repository_mismatch", repoPath: expected };
  return { ok: true, repoPath: expected };
}

export function safeText(value, maxChars, { nullable = true } = {}) {
  if (value == null) return nullable ? null : "";
  const redacted = redactBridgeValue(String(value));
  const text = String(redacted)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!text) return nullable ? null : "";
  return Array.from(text).slice(0, maxChars).join("");
}

export function parseJsonObject(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function exactText(value, maxBytes, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  if (pattern && !pattern.test(value)) return null;
  return value;
}

function utcTimestamp(value, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function choiceIdFromEntry(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  return String(entry.choice_id ?? entry.value ?? entry.id ?? "").trim();
}

function choiceDanger(choiceId) {
  if (["fail", "revert"].includes(choiceId)) return "destructive";
  if (["reject", "skip", "replan", "cancel", "decline"].includes(choiceId)) return "caution";
  return "normal";
}

function storedChoiceRecord(entry) {
  const choiceId = choiceIdFromEntry(entry);
  if (!choiceId) return null;
  const overrides = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const [defaultLabel, defaultConsequence] = QUESTION_CHOICE_COPY[choiceId]
    || [choiceId, "Run the exact owner transition."];
  const danger = overrides.danger || choiceDanger(choiceId);
  return {
    choice_id: choiceId,
    label: safeText(overrides.label || defaultLabel, 160, { nullable: false }),
    consequence: safeText(overrides.consequence || overrides.description || defaultConsequence, 400, { nullable: false }),
    danger,
    requires_confirmation: overrides.requires_confirmation === true || danger === "destructive",
  };
}

function validStoredChoiceEntries(kind, entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 32) return false;
  const ids = entries.map(choiceIdFromEntry);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
  if (kind === "one_shot_file_scope") {
    if (ids.length < 3 || ids.at(-2) !== "plan" || ids.at(-1) !== "cancel") return false;
    return ids.slice(0, -2).every((id) => /^candidate:sha256:[0-9a-f]{64}$/.test(id));
  }
  const allowed = QUESTION_CHOICE_IDS[kind] || [];
  if (kind === "dead_letter_recovery") {
    let previous = -1;
    return ids.every((id) => {
      const index = allowed.indexOf(id);
      if (index <= previous) return false;
      previous = index;
      return true;
    });
  }
  return ids.length === allowed.length && ids.every((id, index) => id === allowed[index]);
}

function storedQuestionKind(payload) {
  const explicit = String(payload?.question_kind || "").trim();
  if (QUESTION_KINDS.has(explicit)) return explicit;
  if (payload?.subtype === "plan_approval") return "plan_approval";
  if (payload?.subtype === "push_offer") return "push_offer";
  if (payload?.subtype === "oneshot_scope_selection" || payload?.review_type === "oneshot_scope_selection") {
    return "one_shot_file_scope";
  }
  if (Array.isArray(payload?.file_requests) && payload.file_requests.length > 0) return "file_scope_approval";
  return QUESTION_KIND_BY_REVIEW_TYPE.get(String(payload?.review_type || "")) || "legacy_unstructured";
}

function storedQuestionChoices(kind, payload) {
  if (kind === "legacy_unstructured") return [];
  const entries = kind === "one_shot_file_scope"
    ? payload?.selector?.options
    : payload?.choices;
  if ((!Array.isArray(entries) || entries.length === 0) && LIVE_OWNER_DELIVERY_QUESTION_KINDS.has(kind)) {
    return (QUESTION_CHOICE_IDS[kind] || []).map(storedChoiceRecord).filter(Boolean);
  }
  if (!validStoredChoiceEntries(kind, entries)) return [];
  return entries.map(storedChoiceRecord).filter(Boolean);
}

function questionStateForJob(job) {
  if (["queued", "waiting_on_human", "waiting_on_review"].includes(job?.status)) return "open";
  if (["running", "assessing"].includes(job?.status)) return "pending";
  if (job?.status === "succeeded") return "answered";
  if (FAILED_JOB_STATUS_SET.has(job?.status)) return "rejected";
  return "closed";
}

function observedQuestionStateForJob(job, observedAt = new Date().toISOString(), {
  allowLiveOwnerDelivery = false,
} = {}) {
  const state = questionStateForJob(job);
  if (state !== "open" || !jobHasLiveLeaseAt(job, observedAt)) return state;
  return allowLiveOwnerDelivery ? "open" : "pending";
}

function storedQuestionAction(db, questionId) {
  try {
    return db.prepare(`
      SELECT * FROM agent_interactions
      WHERE kind = 'approval'
        AND json_extract(metadata_json, '$.work_item_action.action_kind') = 'question.answer'
        AND json_extract(metadata_json, '$.work_item_action.target.question_id') = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(questionId) || null;
  } catch {
    return null;
  }
}

function actionMetadata(row) {
  const action = parseJsonObject(row?.metadata_json).work_item_action;
  return action && typeof action === "object" && !Array.isArray(action) ? action : null;
}

function questionAnswerFromAction(actionRow, fallbackEventId = null) {
  const action = actionMetadata(actionRow);
  if (!action || action.result?.outcome !== "accepted") return null;
  const choiceId = exactText(String(action.target?.choice_id || ""), 128);
  const answeredAt = utcTimestamp(action.result?.observed_at || actionRow.created_at);
  const resultEventId = action.result?.result_event_id == null
    ? fallbackEventId
    : exactText(String(action.result.result_event_id), 256, /^(?:event|archive):[^\s]+$/);
  if (!choiceId || answeredAt === undefined || (action.result?.result_event_id != null && !resultEventId)) return null;
  return { choice_id: choiceId, answered_at: answeredAt, result_event_id: resultEventId };
}

function structuredRelationship(relationships, kinds, targetId) {
  return Array.isArray(relationships) && relationships.some((entry) => (
    kinds.includes(entry?.kind) && entry?.target_id === targetId
  ));
}

function sanitizeChoiceRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const choiceId = exactText(value.choice_id, 128);
  const label = safeText(value.label, 160, { nullable: false });
  const consequence = safeText(value.consequence, 400, { nullable: false });
  if (!choiceId || !label || !consequence || !["normal", "caution", "destructive"].includes(value.danger)
    || typeof value.requires_confirmation !== "boolean") return null;
  return {
    choice_id: choiceId,
    label,
    consequence,
    danger: value.danger,
    requires_confirmation: value.requires_confirmation,
  };
}

export function sanitizeQuestionRecord(value, event = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const questionId = exactText(value.question_id, 256, /^(?:gate:[1-9]\d*:(?:0|[1-9]\d*)|interaction:[1-9]\d*)$/);
  const workItemId = exactText(value.work_item_id, 128);
  const jobId = exactText(value.job_id, 128);
  const attemptId = value.attempt_id == null ? null : exactText(value.attempt_id, 128);
  const agentCallId = value.agent_call_id == null ? null : exactText(value.agent_call_id, 128);
  const promptSummary = safeText(value.prompt_summary, 2000, { nullable: false });
  const contextSummary = safeText(value.context_summary, 1000);
  const openedAt = utcTimestamp(value.opened_at);
  const expiresAt = utcTimestamp(value.expires_at, { nullable: true });
  const generation = exactText(value.generation, 128, /^(?:0|[1-9]\d*)$/);
  if (!questionId || !workItemId || !jobId || (value.attempt_id != null && !attemptId)
    || (value.agent_call_id != null && !agentCallId) || !QUESTION_KINDS.has(value.kind)
    || !["single_choice", "informational"].includes(value.input_kind) || !promptSummary
    || !QUESTION_STATES.has(value.state) || openedAt === undefined || expiresAt === undefined || !generation
    || !Array.isArray(value.choices) || value.choices.length > 32) return null;
  const choices = value.choices.map(sanitizeChoiceRecord);
  if (choices.some((choice) => !choice) || new Set(choices.map((choice) => choice.choice_id)).size !== choices.length) return null;
  const capability = value.capability == null ? null : value.capability === "question.answer" ? value.capability : undefined;
  if (capability === undefined) return null;
  let answer = null;
  if (value.answer != null) {
    if (typeof value.answer !== "object" || Array.isArray(value.answer)) return null;
    const choiceId = exactText(value.answer.choice_id, 128);
    const answeredAt = utcTimestamp(value.answer.answered_at);
    const resultEventId = value.answer.result_event_id == null
      ? null
      : exactText(value.answer.result_event_id, 256, /^(?:event|archive):[^\s]+$/);
    if (!choiceId || answeredAt === undefined || (value.answer.result_event_id != null && !resultEventId)) return null;
    answer = { choice_id: choiceId, answered_at: answeredAt, result_event_id: resultEventId };
  }
  if (answer && !choices.some((choice) => choice.choice_id === answer.choice_id)) return null;
  const unavailableReason = value.unavailable_reason == null ? null : safeText(value.unavailable_reason, 80);
  const normalized = {
    question_id: questionId,
    work_item_id: workItemId,
    job_id: jobId,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    kind: value.kind,
    input_kind: value.input_kind,
    prompt_summary: promptSummary,
    context_summary: contextSummary,
    state: value.state,
    opened_at: openedAt,
    expires_at: expiresAt,
    generation,
    choices,
    capability,
    answer,
    unavailable_reason: unavailableReason,
  };
  const eventKind = event.event_kind;
  if (!["question", "answer"].includes(eventKind)) return null;
  if (workItemId !== event.work_item_id || jobId !== event.job_id
    || attemptId !== (event.attempt_id ?? null) || agentCallId !== (event.agent_call_id ?? null)
    || !structuredRelationship(event.relationships, ["question", "answers_question"], questionId)) return null;
  const canAnswer = eventKind === "question" && normalized.state === "open"
    && normalized.input_kind === "single_choice" && normalized.choices.length > 0
    && normalized.capability === "question.answer";
  const advertisesAnswer = event.actionable === true && event.capabilities?.includes("question.answer");
  if (canAnswer !== advertisesAnswer) return null;
  if (eventKind === "answer" && (!answer || !["answered", "rejected", "closed"].includes(normalized.state)
    || normalized.capability != null || event.actionable !== false || event.capabilities?.includes("question.answer"))) return null;
  return normalized;
}

export function sanitizeNudgeRecord(value, event = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const interactionId = exactText(value.interaction_id, 256, /^interaction:[1-9]\d*$/);
  const workItemId = exactText(value.work_item_id, 128);
  const jobId = exactText(value.job_id, 128);
  const attemptId = value.attempt_id == null ? null : exactText(value.attempt_id, 128);
  const agentCallId = value.agent_call_id == null ? null : exactText(value.agent_call_id, 128);
  const bodySummary = safeText(value.body_summary, 500, { nullable: false });
  const queuedAt = utcTimestamp(value.queued_at);
  const signaledAt = utcTimestamp(value.signaled_at, { nullable: true });
  const retrievedAt = utcTimestamp(value.retrieved_at, { nullable: true });
  const lastRetrievedAt = utcTimestamp(value.last_retrieved_at, { nullable: true });
  const expiresAt = utcTimestamp(value.expires_at, { nullable: true });
  const supersedes = value.supersedes_interaction_id == null ? null
    : exactText(value.supersedes_interaction_id, 256, /^interaction:[1-9]\d*$/);
  const supersededBy = value.superseded_by_interaction_id == null ? null
    : exactText(value.superseded_by_interaction_id, 256, /^interaction:[1-9]\d*$/);
  const deliveryCount = Number(value.delivery_count);
  if (!interactionId || !workItemId || !jobId || (value.attempt_id != null && !attemptId)
    || (value.agent_call_id != null && !agentCallId) || !bodySummary || !NUDGE_STATES.has(value.state)
    || queuedAt === undefined || signaledAt === undefined || retrievedAt === undefined
    || lastRetrievedAt === undefined || expiresAt === undefined
    || (value.supersedes_interaction_id != null && !supersedes)
    || (value.superseded_by_interaction_id != null && !supersededBy)
    || !Number.isSafeInteger(deliveryCount) || deliveryCount < 0) return null;
  let acknowledgement = null;
  if (value.acknowledgement != null) {
    const ack = value.acknowledgement;
    if (typeof ack !== "object" || Array.isArray(ack) || !ACKNOWLEDGEMENT_DECISIONS.has(ack.decision)) return null;
    const reason = ack.reason == null ? null : safeText(ack.reason, 500);
    const acknowledgedAt = utcTimestamp(ack.acknowledged_at);
    if (acknowledgedAt === undefined || (ack.decision === "accepted" ? reason != null : !reason)) return null;
    acknowledgement = { decision: ack.decision, reason, acknowledged_at: acknowledgedAt };
  }
  const capability = value.capability == null ? null : value.capability === "agent.nudge" ? value.capability : undefined;
  const acknowledgementState = ACKNOWLEDGEMENT_DECISIONS.has(value.state);
  if (acknowledgementState !== (acknowledgement != null)
    || (acknowledgement && acknowledgement.decision !== value.state)
    || (capability != null && (!["queued", "signaled", "retrieved"].includes(value.state) || acknowledgement))) return null;
  if (capability === undefined || event.event_kind !== "nudge" || event.state !== value.state
    || workItemId !== event.work_item_id || jobId !== event.job_id
    || attemptId !== (event.attempt_id ?? null) || agentCallId !== (event.agent_call_id ?? null)
    || !structuredRelationship(event.relationships, ["interaction"], interactionId)
    || (supersedes && !structuredRelationship(event.relationships, ["supersedes"], supersedes))) return null;
  const canNudge = capability === "agent.nudge";
  const advertisesNudge = event.actionable === true && event.capabilities?.includes("agent.nudge");
  if (canNudge !== advertisesNudge) return null;
  return {
    interaction_id: interactionId,
    work_item_id: workItemId,
    job_id: jobId,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    body_summary: bodySummary,
    state: value.state,
    queued_at: queuedAt,
    signaled_at: signaledAt,
    retrieved_at: retrievedAt,
    last_retrieved_at: lastRetrievedAt,
    delivery_count: deliveryCount,
    acknowledgement,
    supersedes_interaction_id: supersedes,
    superseded_by_interaction_id: supersededBy,
    expires_at: expiresAt,
    capability,
  };
}

export function positiveBound(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, parsed));
}

export function decimalId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? String(number) : null;
}

export function observedAt(context = {}) {
  const candidate = context.observedAt || context.observed_at;
  const parsed = Date.parse(candidate || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function tableHasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

export function ownerGeneration(db = getDb()) {
  let generation = 0;
  try {
    generation = Math.max(generation, Number(db.prepare("SELECT COALESCE(MAX(id), 0) AS value FROM events").get()?.value || 0));
  } catch { /* minimal fixtures */ }
  for (const table of ["work_items", "jobs"]) {
    if (!tableHasColumn(db, table, "bridge_change_seq")) continue;
    try {
      generation = Math.max(generation, Number(db.prepare(`SELECT COALESCE(MAX(bridge_change_seq), 0) AS value FROM ${table}`).get()?.value || 0));
    } catch { /* minimal fixtures */ }
  }
  return String(Math.max(0, generation));
}

export function commonEnvelope(protocol, repoPath, context = {}, db = getDb()) {
  return {
    protocol,
    repo_path: normalizeRepositoryPath(repoPath),
    instance_id: String(context.instanceId || context.instance_id || "local"),
    owner_generation: ownerGeneration(db),
    observed_at: observedAt(context),
  };
}

function retentionDays(projectDir) {
  let raw = null;
  try { raw = getSetting(SETTING_KEYS.RETENTION_DAYS, { projectDir }); } catch { raw = null; }
  if (raw == null || String(raw).trim() === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function earliestRetainedEvent(db) {
  let database = null;
  try {
    database = db.prepare("SELECT id, created_at FROM events ORDER BY created_at, id LIMIT 1").get() || null;
  } catch {
    database = null;
  }
  const archive = readRunTelemetryEntries("events", {
    limit: 1,
    order: "asc",
    currentEpochOnly: false,
    predicate: (row) => Number(row?.id || 0) > 0 && Number.isFinite(Date.parse(row?.created_at || row?.t || "")),
  })[0] || null;
  const candidates = [database, archive && { id: archive.id, created_at: archive.created_at || archive.t }]
    .filter(Boolean)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id));
  return candidates[0] || null;
}

export function retentionInfo({ db = getDb(), projectDir = process.cwd(), beginningReached = false } = {}) {
  const days = retentionDays(projectDir);
  const earliest = earliestRetainedEvent(db);
  const hasArchive = listRunTelemetryFiles("events").length > 0;
  const epochHash = crypto.createHash("sha256")
    .update(`posse-retention-v1\0${days}\0${earliest?.id || ""}\0${earliest?.created_at || ""}\0${hasArchive}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return {
    basis: days === 0 ? "indefinite" : hasArchive ? "mixed" : "finite_days",
    configured_days: days,
    retention_epoch: `retention:${epochHash}`,
    earliest_retained_event_id: earliest ? `event:${earliest.id}` : null,
    earliest_retained_time: earliest?.created_at || null,
    older_pruned: days > 0 && !!earliest,
    beginning_reached: Boolean(beginningReached),
    source_tiers: hasArchive ? ["database", "run_archive"] : ["database"],
  };
}

export function historyRanges(context = {}) {
  const endMs = Date.parse(observedAt(context));
  const presets = RANGE_DAYS.map(([rangeId, label, days]) => ({
    range_id: rangeId,
    label,
    start_at: new Date(endMs - days * DAY_MS).toISOString(),
    end_at: new Date(endMs).toISOString(),
    is_default: rangeId === DEFAULT_RANGE_ID,
  }));
  return {
    presets,
    custom: { enabled: true, min_duration_ms: 60_000, max_duration_ms: 365 * DAY_MS },
    default_range_id: DEFAULT_RANGE_ID,
  };
}

export function resolveRangeRequest(request, context = {}, { projectDir = process.cwd(), db = getDb() } = {}) {
  const ranges = historyRanges(context);
  const input = request && typeof request === "object" ? request : null;
  let requested;
  if (input?.kind === "preset") {
    const preset = ranges.presets.find((entry) => entry.range_id === String(input.range_id || ""));
    if (!preset) return { ok: false, reason: "invalid_range" };
    requested = {
      kind: "preset",
      range_id: preset.range_id,
      start_at: preset.start_at,
      end_at: preset.end_at,
    };
  } else if (input?.kind === "custom") {
    if (typeof input.start_at !== "string" || typeof input.end_at !== "string"
      || !input.start_at.endsWith("Z") || !input.end_at.endsWith("Z")) {
      return { ok: false, reason: "invalid_range" };
    }
    const startMs = Date.parse(input.start_at || "");
    const endMs = Date.parse(input.end_at || "");
    const duration = endMs - startMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || duration < 60_000 || duration > 365 * DAY_MS) {
      return { ok: false, reason: "invalid_range" };
    }
    requested = {
      kind: "custom",
      range_id: null,
      start_at: new Date(startMs).toISOString(),
      end_at: new Date(endMs).toISOString(),
    };
  } else {
    return { ok: false, reason: "invalid_range" };
  }

  const retention = retentionInfo({ db, projectDir });
  let effectiveStartMs = Date.parse(requested.start_at);
  const requestedEndMs = Date.parse(requested.end_at);
  const partialReasons = [];
  if (retention.configured_days > 0) {
    const cutoff = Date.parse(observedAt(context)) - retention.configured_days * DAY_MS;
    if (effectiveStartMs < cutoff) {
      effectiveStartMs = cutoff;
      partialReasons.push("retention_clipped");
    }
  }
  return {
    ok: true,
    requested,
    effective: {
      start_at: new Date(Math.min(effectiveStartMs, requestedEndMs)).toISOString(),
      end_at: requested.end_at,
    },
    retention,
    partialReasons,
    ranges,
  };
}

function canonicalEventKind(row, event) {
  if (KNOWN_FEED_KINDS.has(event.event_kind)) return event.event_kind;
  const type = String(row.event_type || "");
  if (type === "agent.activity" || type.startsWith("agent_feedback.")) return "agent_update";
  if ((type.includes("question") && type.includes("answered"))
    || (event.question_id && event.choice_id)) return "answer";
  if (type.includes("question") || type.endsWith("gate_created")) return "question";
  if (type.startsWith("operator_nudge.")) return "nudge";
  if (type === "work_item.status_changed") return "work_item_state";
  if (type.startsWith("file_lane.") || type.startsWith("scheduler.file_lane_")) return "lane_state";
  if (type.includes("handoff")) return "handoff";
  if (type === "work_item.canceled" || type === "work_item.iteration_finished") return "completion";
  if (type === "bridge.command_mutation") return "action";
  if (type.includes("error") || type.includes("failed")) return "error";
  return "unknown";
}

function eventSummary(kind, row, event) {
  if (typeof event.summary === "string" && event.summary.trim()) {
    return safeText(event.summary, WORK_ITEM_BOUNDS.FEED_SUMMARY_CHARS, { nullable: false });
  }
  const summaries = {
    comment: "Comment published.",
    chat: "Agent conversation message.",
    question: "Operator input requested.",
    answer: "Operator choice recorded.",
    nudge: "Operator guidance state changed.",
    agent_update: "Agent status updated.",
    work_item_state: "Work Item state changed.",
    lane_state: "File-lane state changed.",
    handoff: "Agent handoff recorded.",
    completion: "Work Item or job completed.",
    action: "Mediated action completed.",
    error: "Operational failure recorded.",
    runtime_batch: "Runtime events grouped.",
    unknown: "Unsupported owner event.",
  };
  return summaries[kind] || summaries.unknown;
}

function normalizedRelationships(event) {
  if (!Array.isArray(event.relationships)) return [];
  return event.relationships.slice(0, 16).map((entry) => ({
    kind: safeText(entry?.kind, 80, { nullable: false }),
    target_id: safeText(entry?.target_id, 256, { nullable: false }),
  })).filter((entry) => entry.kind && entry.target_id);
}

function statusForAgentUpdate(event) {
  const raw = String(event.status || "unknown");
  if (raw === "succeeded") return "done";
  if (raw === "failed") return "failed";
  if (raw === "canceled") return "canceled";
  return raw;
}

function projectedAgentActivity(row, event, db) {
  const interactionId = Number(event.interaction_id ?? row.actor_id);
  if (!Number.isSafeInteger(interactionId) || interactionId <= 0) return null;
  let activity;
  try {
    activity = db.prepare(`
      SELECT
        ai.*, jobs.job_type, jobs.status AS job_status,
        calls.role AS call_role, calls.provider AS call_provider, calls.model_name AS call_model
      FROM agent_interactions ai
      LEFT JOIN jobs ON jobs.id = ai.job_id
      LEFT JOIN agent_calls calls ON calls.id = ai.agent_call_id
      WHERE ai.id = ? AND ai.kind = 'activity' AND ai.direction = 'agent_to_user'
    `).get(interactionId);
  } catch {
    return null;
  }
  if (!activity) return null;
  const metadata = parseJsonObject(activity.metadata_json);
  const phase = String(metadata.phase || "");
  const status = String(metadata.status || metadata.action || "");
  const summary = safeText(activity.body, 180, { nullable: false });
  if (!AGENT_FEEDBACK_PHASES.has(phase) || !AGENT_FEEDBACK_STATUSES.has(status) || !summary) return null;
  const capabilities = ["work_item.agent.open"];
  if (!TERMINAL_FEEDBACK_JOB_STATUSES.has(activity.job_status)) capabilities.push("agent.nudge");
  return {
    summary,
    detail: safeText(metadata.detail, 360),
    state: status,
    role: safeText(activity.call_role || activity.job_type || row.actor_type, 80),
    origin: safeText(activity.source || "agent_feedback", 80),
    attempt_id: decimalId(activity.attempt_id),
    agent_call_id: decimalId(activity.agent_call_id),
    relationships: [{ kind: "interaction", target_id: `interaction:${interactionId}` }],
    capabilities,
    actionable: capabilities.length > 0,
  };
}

function questionIdentityFromEvent(row, event, kind) {
  const explicit = String(event.question_id || "").trim();
  if (/^(?:gate:[1-9]\d*:(?:0|[1-9]\d*)|interaction:[1-9]\d*)$/.test(explicit)) return explicit;
  const interactionId = Number(kind === "answer" ? event.parent_id : event.interaction_id);
  if (Number.isSafeInteger(interactionId) && interactionId > 0) return `interaction:${interactionId}`;
  const jobId = Number(row.job_id);
  const index = Number(event.question_index ?? 0);
  if (Number.isSafeInteger(jobId) && jobId > 0 && Number.isSafeInteger(index) && index >= 0) {
    return `gate:${jobId}:${index}`;
  }
  return null;
}

function projectedGateQuestion(row, event, db, questionId, kind) {
  const match = /^gate:([1-9]\d*):(0|[1-9]\d*)$/.exec(questionId);
  if (!match || Number(match[1]) !== Number(row.job_id)) return null;
  let job;
  try { job = db.prepare("SELECT * FROM jobs WHERE id = ? AND work_item_id = ?").get(Number(match[1]), row.work_item_id); } catch { return null; }
  if (!job || job.job_type !== "human_input") return null;
  const payload = parseJsonObject(job.payload_json);
  const rawQuestions = Array.isArray(payload.questions) && payload.questions.length > 0
    ? payload.questions
    : [payload.prompt || job.title || "Human input requested"];
  const questionKind = storedQuestionKind(payload);
  const choices = storedQuestionChoices(questionKind, payload);
  const questions = choices.length > 0 && rawQuestions.length > 1
    ? [rawQuestions.join("\n\n")]
    : rawQuestions;
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index) || index < 0 || index >= questions.length) return null;
  const actionRow = storedQuestionAction(db, questionId);
  const action = actionMetadata(actionRow);
  let state = observedQuestionStateForJob(job, new Date().toISOString(), {
    allowLiveOwnerDelivery: LIVE_OWNER_DELIVERY_QUESTION_KINDS.has(questionKind),
  });
  if (["reserved", "delivered"].includes(action?.state)) state = "pending";
  if (kind === "answer") state = action?.result?.question_state
    || (event.outcome === "accepted" ? "answered" : "rejected");
  const fallbackEventId = kind === "answer" ? `event:${row.id}` : null;
  let answer = questionAnswerFromAction(actionRow, fallbackEventId);
  if (kind === "answer" && !answer) {
    const choiceId = exactText(String(event.choice_id || ""), 128);
    if (!choiceId) return null;
    answer = { choice_id: choiceId, answered_at: row.created_at, result_event_id: fallbackEventId };
  }
  const actionable = kind === "question" && state === "open" && choices.length > 0 && questionKind !== "legacy_unstructured";
  const attemptId = decimalId(row.attempt_id);
  const agentCallId = decimalId(event.agent_call_id);
  const question = {
    question_id: questionId,
    work_item_id: String(job.work_item_id),
    job_id: String(job.id),
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    kind: questionKind,
    input_kind: choices.length > 0 ? "single_choice" : "informational",
    prompt_summary: safeText(questions[index], 2000, { nullable: false }),
    context_summary: safeText(payload.context || payload.prompt, 1000),
    state,
    opened_at: job.created_at,
    expires_at: payload.expires_at || null,
    generation: String(
      action?.descriptor?.question_generation
      ?? db.prepare("SELECT generation FROM human_gates WHERE gate_job_id = ?").get(job.id)?.generation
      ?? 1
    ),
    choices,
    capability: actionable ? "question.answer" : null,
    answer,
    unavailable_reason: actionable || state !== "open" ? null : "unstructured_choices",
  };
  return {
    summary: question.prompt_summary,
    detail: question.context_summary,
    state,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    relationships: [{ kind: kind === "answer" ? "answers_question" : "question", target_id: questionId }],
    capabilities: actionable ? ["question.answer"] : [],
    actionable,
    question,
  };
}

function projectedInteractionQuestion(row, event, db, questionId, kind) {
  const match = /^interaction:([1-9]\d*)$/.exec(questionId);
  if (!match) return null;
  let questionRow;
  try {
    questionRow = db.prepare(`
      SELECT * FROM agent_interactions
      WHERE id = ? AND kind = 'question' AND direction = 'agent_to_user'
    `).get(Number(match[1]));
  } catch {
    return null;
  }
  if (!questionRow || Number(questionRow.work_item_id) !== Number(row.work_item_id)
    || Number(questionRow.job_id) !== Number(row.job_id)) return null;
  const metadata = parseJsonObject(questionRow.metadata_json);
  const questionKind = QUESTION_KINDS.has(String(metadata.question_kind || metadata.kind || ""))
    ? String(metadata.question_kind || metadata.kind)
    : "legacy_unstructured";
  const choices = validStoredChoiceEntries(questionKind, metadata.choices)
    ? metadata.choices.map(storedChoiceRecord).filter(Boolean)
    : [];
  const actionRow = storedQuestionAction(db, questionId);
  const action = actionMetadata(actionRow);
  let answerRow = null;
  try {
    answerRow = db.prepare(`
      SELECT * FROM agent_interactions
      WHERE parent_id = ? AND kind = 'answer'
      ORDER BY id DESC LIMIT 1
    `).get(questionRow.id) || null;
  } catch { answerRow = null; }
  const answerMetadata = parseJsonObject(answerRow?.metadata_json);
  let answer = questionAnswerFromAction(actionRow, kind === "answer" ? `event:${row.id}` : null);
  if (!answer && answerRow) {
    const choiceId = exactText(String(answerMetadata.choice_id || answerRow.body || ""), 128);
    if (choiceId) answer = {
      choice_id: choiceId,
      answered_at: answerRow.created_at,
      result_event_id: answerMetadata.result_event_id || (kind === "answer" ? `event:${row.id}` : null),
    };
  }
  if (kind === "answer" && !answer) {
    const choiceId = exactText(String(event.choice_id || ""), 128);
    if (!choiceId) return null;
    answer = { choice_id: choiceId, answered_at: row.created_at, result_event_id: `event:${row.id}` };
  }
  let state = questionRow.status === "active" ? "open"
    : questionRow.status === "answered" ? "answered"
      : QUESTION_STATES.has(questionRow.status) ? questionRow.status : "closed";
  if (["reserved", "delivered"].includes(action?.state)) state = "pending";
  if (answer) state = "answered";
  if (kind === "answer" && event.outcome && event.outcome !== "accepted") state = "rejected";
  const actionable = kind === "question" && state === "open" && choices.length > 0 && questionKind !== "legacy_unstructured";
  const attemptId = decimalId(questionRow.attempt_id);
  const agentCallId = decimalId(questionRow.agent_call_id);
  const question = {
    question_id: questionId,
    work_item_id: String(questionRow.work_item_id),
    job_id: String(questionRow.job_id),
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    kind: questionKind,
    input_kind: choices.length > 0 ? "single_choice" : "informational",
    prompt_summary: safeText(questionRow.body, 2000, { nullable: false }),
    context_summary: safeText(metadata.context_summary || metadata.context, 1000),
    state,
    opened_at: questionRow.created_at,
    expires_at: questionRow.expires_at || null,
    generation: String(action?.descriptor?.question_generation ?? metadata.question_generation ?? questionRow.id),
    choices,
    capability: actionable ? "question.answer" : null,
    answer,
    unavailable_reason: actionable || state !== "open" ? null : "unstructured_choices",
  };
  return {
    summary: question.prompt_summary,
    detail: question.context_summary,
    state,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    relationships: [{ kind: kind === "answer" ? "answers_question" : "question", target_id: questionId }],
    capabilities: actionable ? ["question.answer"] : [],
    actionable,
    question,
  };
}

function projectedQuestion(row, event, db, kind) {
  const questionId = questionIdentityFromEvent(row, event, kind);
  if (!questionId) return null;
  return questionId.startsWith("gate:")
    ? projectedGateQuestion(row, event, db, questionId, kind)
    : projectedInteractionQuestion(row, event, db, questionId, kind);
}

function projectedNudge(row, event, db) {
  const interactionId = Number(event.interaction_id);
  if (!Number.isSafeInteger(interactionId) || interactionId <= 0) return null;
  let nudge;
  try {
    nudge = db.prepare(`
      SELECT ai.*, jobs.status AS job_status,
        (SELECT COUNT(*) FROM agent_interaction_applications applications WHERE applications.interaction_id = ai.id) AS application_count
      FROM agent_interactions ai
      LEFT JOIN jobs ON jobs.id = ai.job_id
      WHERE ai.id = ? AND ai.kind = 'nudge' AND ai.direction = 'user_to_agent'
    `).get(interactionId);
  } catch {
    return null;
  }
  if (!nudge) return null;
  const metadata = parseJsonObject(nudge.metadata_json);
  const lifecycle = metadata.nudge_lifecycle || {};
  let state = "queued";
  if (nudge.status === "superseded") state = "superseded";
  else if (nudge.status === "expired") state = "expired";
  else if (nudge.ack_state === "acknowledged" && nudge.ack_decision) state = nudge.ack_decision;
  else if (nudge.first_applied_at || lifecycle.retrieved_at) state = "retrieved";
  else if (lifecycle.signaled_at) state = "signaled";
  const eligible = nudge.status === "active" && nudge.ack_state === "pending" && !nudge.ack_decision
    && !TERMINAL_FEEDBACK_JOB_STATUSES.has(nudge.job_status) && state !== "expired";
  const capabilities = eligible
    ? ["agent.nudge"]
    : [];
  const acknowledgement = nudge.ack_state === "acknowledged" && nudge.ack_decision
    ? {
        decision: nudge.ack_decision,
        reason: nudge.ack_decision === "accepted" ? null : safeText(nudge.ack_reason, 500),
        acknowledged_at: nudge.acknowledged_at || null,
      }
    : null;
  const supersedesInteractionId = metadata.work_item_action?.replaces_interaction_id
    ? `interaction:${metadata.work_item_action.replaces_interaction_id}`
    : null;
  const supersededByInteractionId = lifecycle.superseded_by
    ? `interaction:${lifecycle.superseded_by}`
    : null;
  const attemptId = decimalId(nudge.attempt_id);
  const agentCallId = decimalId(nudge.agent_call_id);
  const nudgeRecord = {
    interaction_id: `interaction:${interactionId}`,
    work_item_id: String(nudge.work_item_id),
    job_id: String(nudge.job_id),
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    body_summary: safeText(nudge.body, WORK_ITEM_BOUNDS.FEED_SUMMARY_CHARS, { nullable: false }),
    state,
    queued_at: nudge.created_at,
    signaled_at: lifecycle.signaled_at || null,
    retrieved_at: lifecycle.retrieved_at || nudge.first_applied_at || null,
    last_retrieved_at: lifecycle.last_retrieved_at || nudge.last_applied_at || null,
    delivery_count: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(
      lifecycle.delivery_count || nudge.application_count || 0,
    )))),
    acknowledgement,
    supersedes_interaction_id: supersedesInteractionId,
    superseded_by_interaction_id: supersededByInteractionId,
    expires_at: nudge.expires_at || null,
    capability: eligible ? "agent.nudge" : null,
  };
  return {
    summary: nudgeRecord.body_summary,
    detail: null,
    state,
    role: "human",
    origin: safeText(nudge.source || "operator", 80),
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    relationships: [
      { kind: "interaction", target_id: `interaction:${interactionId}` },
      ...(supersedesInteractionId
        ? [{ kind: "supersedes", target_id: supersedesInteractionId }]
        : []),
    ],
    capabilities,
    actionable: capabilities.length > 0,
    nudge: nudgeRecord,
  };
}

export function projectFeedEvent(row, { db = getDb() } = {}) {
  if (!row || !decimalId(row.id) || !row.created_at) return null;
  const occurredMs = Date.parse(row.created_at);
  if (!Number.isFinite(occurredMs)) return null;
  const event = parseJsonObject(row.event_json);
  if (event.protocol === WORK_ITEM_FEED_EVENT_PROTOCOL && event.event && typeof event.event === "object") {
    return sanitizeProjectedFeedEvent(event.event, { durableId: `event:${row.id}` });
  }
  if (String(row.event_type || "").startsWith("operator_nudge.") && row.event_type !== "operator_nudge.created") {
    return null;
  }
  const kind = canonicalEventKind(row, event);
  const workItemId = decimalId(row.work_item_id);
  if (kind !== "runtime_batch" && workItemId == null) return null;
  const activity = kind === "agent_update" ? projectedAgentActivity(row, event, db) : null;
  const nudge = kind === "nudge" ? projectedNudge(row, event, db) : null;
  const question = ["question", "answer"].includes(kind) ? projectedQuestion(row, event, db, kind) : null;
  const semantic = activity || nudge || question;
  const semanticEvent = semantic ? { ...event, ...semantic } : event;
  const state = semantic?.state
    || (kind === "agent_update" ? statusForAgentUpdate(event) : safeText(event.state, 80) || "unknown");
  const capabilities = Array.isArray(semanticEvent.capabilities)
    ? semanticEvent.capabilities.slice(0, 16).map((value) => safeText(value, 128, { nullable: false })).filter(Boolean)
    : [];
  return sanitizeProjectedFeedEvent({
    event_id: `event:${row.id}`,
    event_kind: kind,
    occurred_at: new Date(occurredMs).toISOString(),
    order_key: String(row.id).padStart(20, "0"),
    work_item_id: workItemId,
    job_id: decimalId(row.job_id),
    attempt_id: semantic?.attempt_id || decimalId(row.attempt_id),
    agent_call_id: semantic?.agent_call_id || decimalId(event.agent_call_id),
    role: safeText(semanticEvent.role || row.actor_type, 80),
    origin: safeText(semanticEvent.origin || semanticEvent.source || row.actor_type, 80),
    state,
    summary: eventSummary(kind, row, semanticEvent),
    detail: safeText(semanticEvent.detail, WORK_ITEM_BOUNDS.FEED_DETAIL_CHARS),
    relationships: normalizedRelationships(semanticEvent),
    capabilities,
    actionable: semanticEvent.actionable === true && kind !== "unknown",
    group_key: safeText(event.group_key, 128),
    group_count: Number.isInteger(event.group_count) && event.group_count > 0 ? event.group_count : null,
    question: kind === "question" || kind === "answer" ? semanticEvent.question || null : null,
    nudge: kind === "nudge" ? semanticEvent.nudge || null : null,
  }, { durableId: `event:${row.id}` });
}

export function sanitizeProjectedFeedEvent(value, { durableId = null } = {}) {
  const event = value && typeof value === "object" ? value : {};
  const kind = KNOWN_FEED_KINDS.has(event.event_kind) ? event.event_kind : "unknown";
  const occurredMs = Date.parse(event.occurred_at || "");
  if (!Number.isFinite(occurredMs)) return null;
  if (durableId != null && event.event_id !== durableId) return null;
  const eventId = durableId || safeText(event.event_id, 256, { nullable: false });
  const orderKey = safeText(event.order_key, 256, { nullable: false });
  const workItemId = safeText(event.work_item_id, 128);
  const summary = safeText(event.summary, WORK_ITEM_BOUNDS.FEED_SUMMARY_CHARS, { nullable: false });
  if (!eventId || !orderKey || !summary || (kind !== "runtime_batch" && !workItemId)) return null;
  if (!Array.isArray(event.relationships) || event.relationships.length > 16) return null;
  const relationships = normalizedRelationships(event);
  if (relationships.length !== event.relationships.length) return null;
  const capabilities = Array.isArray(event.capabilities)
    ? event.capabilities.slice(0, 16).map((entry) => safeText(entry, 128, { nullable: false })).filter(Boolean)
    : [];
  if (capabilities.length !== (Array.isArray(event.capabilities) ? event.capabilities.length : 0)
    || new Set(capabilities).size !== capabilities.length) return null;
  const normalized = {
    event_id: eventId,
    event_kind: kind,
    occurred_at: new Date(occurredMs).toISOString(),
    order_key: orderKey,
    work_item_id: workItemId,
    job_id: safeText(event.job_id, 128),
    attempt_id: safeText(event.attempt_id, 128),
    agent_call_id: safeText(event.agent_call_id, 128),
    role: safeText(event.role, 80),
    // Wire name is `origin`, not `source`: the relay's source policy rejects
    // any payload containing a key named `source`, which silently broke every
    // events.tail replay that included a feed event (2026-08-11..15). Durable
    // rows written before the rename still carry `source`; accept both.
    origin: safeText(event.origin ?? event.source, 80),
    state: safeText(event.state, 80) || "unknown",
    summary,
    detail: safeText(event.detail, WORK_ITEM_BOUNDS.FEED_DETAIL_CHARS),
    relationships,
    capabilities,
    actionable: event.actionable === true && kind !== "unknown",
    group_key: safeText(event.group_key, 128),
    group_count: Number.isInteger(event.group_count) && event.group_count > 0 ? event.group_count : null,
    question: null,
    nudge: null,
  };
  if (!Object.hasOwn(event, "question") || !Object.hasOwn(event, "nudge")) return null;
  if (kind === "unknown" && (event.actionable === true || capabilities.length > 0
    || event.question != null || event.nudge != null)) return null;
  if (["question", "answer"].includes(kind)) {
    if (event.nudge != null) return null;
    normalized.question = sanitizeQuestionRecord(event.question, normalized);
    if (!normalized.question) return null;
  } else if (kind === "nudge") {
    if (event.question != null) return null;
    normalized.nudge = sanitizeNudgeRecord(event.nudge, normalized);
    if (!normalized.nudge) return null;
  } else if (event.question != null || event.nudge != null) {
    return null;
  }
  return normalized;
}

export function createStreamFeedPayload(event, {
  producerEpoch,
  durable,
  durableEventId = null,
} = {}) {
  const epoch = String(producerEpoch || "").trim();
  if (!epoch || typeof durable !== "boolean") return null;
  const source = event && typeof event === "object" && !Array.isArray(event) ? event : null;
  if (!source) return null;

  if (durable) {
    const durableId = String(durableEventId || "").trim();
    if (!/^(?:event|archive):[^\s]+$/.test(durableId)) return null;
    if (source.event_id !== durableId) return null;
    const projected = sanitizeProjectedFeedEvent(source);
    if (!projected || projected.event_id !== durableId) return null;
    return {
      protocol: WORK_ITEM_FEED_EVENT_PROTOCOL,
      producer_epoch: epoch,
      durable_event_id: durableId,
      durable: true,
      event: projected,
    };
  }

  if (durableEventId != null || !Object.hasOwn(source, "event_id") || source.event_id !== null) return null;
  if (source.actionable !== false) return null;
  if (!Array.isArray(source.capabilities) || source.capabilities.length !== 0) return null;
  const projected = sanitizeProjectedFeedEvent({ ...source, event_id: "ephemeral-placeholder" });
  if (!projected) return null;
  projected.event_id = null;
  projected.actionable = false;
  projected.capabilities = [];
  return {
    protocol: WORK_ITEM_FEED_EVENT_PROTOCOL,
    producer_epoch: epoch,
    durable_event_id: null,
    durable: false,
    event: projected,
  };
}
