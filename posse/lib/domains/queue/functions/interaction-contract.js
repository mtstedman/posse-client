import { JOB_TYPE_ROLE_REGISTRY } from "../../../catalog/provider.js";
import { WORK_ITEM_ACTION_PROTOCOL } from "../../../catalog/bridge.js";
import { FAILED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import {
  canonicalHumanGateAction,
  humanInputChoiceFromAnswer,
  humanInputChoicesForPayload,
} from "../../../catalog/human-input.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../catalog/native-tools.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { scrubSecrets } from "../../../shared/telemetry/classes/logging/secret-scrub.js";
import { now, runImmediateTransaction } from "./common.js";
import { jobHasLiveLeaseAt } from "./lease-state.js";
import { createOperatorNudge } from "./agent-interactions.js";
import { logEvent } from "./events.js";
import { getHumanGate } from "./human-gates.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";

const ACTION_PROTOCOL = WORK_ITEM_ACTION_PROTOCOL;
const ACTION_METADATA_KEY = "work_item_action";
const QUESTION_CAPABILITY = "question.answer";
const MAX_QUESTIONS = 20;
const MAX_NUDGES = 64;
const MAX_FEEDBACK = 64;
const MAX_PROMPT_CHARS = 2000;
const MAX_CONTEXT_CHARS = 1000;
const MAX_FEEDBACK_SUMMARY_CHARS = 180;
const MAX_FEEDBACK_DETAIL_CHARS = 360;
const MAX_NUDGE_BODY_CHARS = 4000;
const MAX_ACTION_ID_BYTES = 128;

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const FAILED_JOB_STATUS_SET = new Set(FAILED_JOB_STATUSES);
const OPEN_GATE_STATUS_SET = new Set(["queued", "waiting_on_human", "waiting_on_review"]);
const CURRENT_GATE_STATUSES = Object.freeze([
  "queued", "waiting_on_human", "waiting_on_review", "running", "assessing",
]);
const CURRENT_GATE_STATUSES_SQL = `(${CURRENT_GATE_STATUSES.map((status) => `'${status}'`).join(", ")})`;
const LIVE_OWNER_DELIVERY_HANDLERS = new Set(["scope", "review", "human_input", "one_shot"]);
const FEEDBACK_PHASES = new Set([
  "reading", "planning", "editing", "testing", "verifying", "blocked", "finalizing", "handoff",
]);
const FEEDBACK_STATUSES = new Set(["running", "blocked", "waiting", "verifying", "done"]);

const REVIEW_KIND_BY_TYPE = new Map([
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

const HANDLER_BY_KIND = new Map([
  ["plan_approval", "plan"],
  ["file_scope_approval", "scope"],
  ["assessment_review", "review"],
  ["assessment_transport_recovery", "review"],
  ["assessment_retry_limit", "review"],
  ["pipeline_head_recovery", "review"],
  ["blocked_recovery", "human_input"],
  ["partial_work_recovery", "human_input"],
  ["dead_letter_recovery", "human_input"],
  ["one_shot_file_scope", "one_shot"],
  ["push_offer", "git_push"],
]);

const CHOICE_COPY = Object.freeze({
  approve: ["Approve", "Allow the exact requested transition."],
  reject: ["Reject", "Reject the exact requested transition."],
  pass: ["Pass", "Accept the current work as passing."],
  fail: ["Fail", "Mark the current work as failed."],
  skip: ["Skip", "Skip this work and continue where policy permits."],
  replan: ["Replan", "Return the Work Item to its planning path."],
  retry: ["Retry", "Retry through the canonical owner transition."],
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

function parseJsonObject(value) {
  if (!value) return {};
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function scalarLength(value) {
  return Array.from(String(value ?? "")).length;
}

function normalizedObservedAt(value) {
  if (value == null || String(value).trim() === "") return now();
  const time = Date.parse(String(value));
  if (!Number.isFinite(time)) throw new TypeError("observed_at must be an RFC3339 timestamp");
  return new Date(time).toISOString();
}

function isExpired(expiresAt, observedAt) {
  if (!expiresAt) return false;
  const expiry = Date.parse(String(expiresAt));
  const observation = Date.parse(String(observedAt));
  return Number.isFinite(expiry) && Number.isFinite(observation) && expiry <= observation;
}

function boundedText(value, maxChars) {
  const scrubbed = scrubSecrets(String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim());
  return Array.from(scrubbed).slice(0, maxChars).join("");
}

function safeReason(value, fallback = null) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 80);
  return text || fallback;
}

function positiveId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function interactionRowId(value) {
  const match = String(value ?? "").trim().match(/^(?:interaction:)?([1-9]\d*)$/);
  return match ? positiveId(match[1]) : null;
}

function validActionId(value) {
  const text = String(value ?? "").trim();
  return /^[\x21-\x7E]+$/.test(text) && Buffer.byteLength(text, "utf8") <= MAX_ACTION_ID_BYTES;
}

function actionTarget({ workItemId, jobId, questionId = null, choiceId = null, agentCallId = null } = {}) {
  if (questionId != null) {
    return {
      work_item_id: String(workItemId),
      job_id: String(jobId),
      question_id: String(questionId),
      choice_id: String(choiceId),
    };
  }
  return {
    work_item_id: String(workItemId),
    job_id: String(jobId),
    agent_call_id: agentCallId == null ? null : String(agentCallId),
  };
}

function sameTarget(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function baseActionResult({ actionId, actionKind, target, outcome, observedAt = now(), safeReasonCode = null } = {}) {
  return {
    protocol: ACTION_PROTOCOL,
    action_id: actionId,
    action_kind: actionKind,
    target,
    outcome,
    safe_reason: safeReasonCode,
    observed_at: observedAt,
  };
}

function parseStoredAction(row) {
  const metadata = parseJsonObject(row?.metadata_json);
  const action = metadata[ACTION_METADATA_KEY];
  return action && typeof action === "object" && !Array.isArray(action) ? action : null;
}

function findActionById(db, actionId) {
  const row = db.prepare(`
    SELECT *
    FROM agent_interactions
    WHERE json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.action_id') = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(actionId);
  return row ? { row, action: parseStoredAction(row) } : null;
}

function insertActionReservation(db, {
  actionId,
  actionKind,
  target,
  handler = null,
  descriptor = null,
  workItemId,
  jobId,
  source,
  author,
  observedAt,
} = {}) {
  const metadata = {
    [ACTION_METADATA_KEY]: {
      version: 1,
      action_id: actionId,
      action_kind: actionKind,
      target,
      handler,
      descriptor,
      state: "reserved",
      reserved_at: observedAt,
      result: null,
    },
  };
  const info = db.prepare(`
    INSERT INTO agent_interactions (
      work_item_id, job_id, direction, kind, blocking_policy, status,
      source, author, metadata_json, ack_state, created_at, updated_at
    ) VALUES (?, ?, 'user_to_agent', 'approval', 'none', 'active', ?, ?, ?, 'not_applicable', ?, ?)
  `).run(
    workItemId,
    jobId,
    boundedText(source || "bossy", 80) || "bossy",
    boundedText(author || "operator", 120) || "operator",
    JSON.stringify(metadata),
    observedAt,
    observedAt,
  );
  const reservationId = Number(info.lastInsertRowid);
  notifyQueueStateChanged({
    reason: "human_answer_reserved",
    jobId,
    workItemId,
  });
  return reservationId;
}

function completeReservedAction(db, reservationId, result) {
  const row = db.prepare(`SELECT work_item_id, job_id, metadata_json FROM agent_interactions WHERE id = ?`).get(reservationId);
  if (!row) return false;
  const metadata = parseJsonObject(row?.metadata_json);
  const action = metadata[ACTION_METADATA_KEY] || {};
  metadata[ACTION_METADATA_KEY] = {
    ...action,
    state: "complete",
    completed_at: result.observed_at,
    result,
  };
  db.prepare(`
    UPDATE agent_interactions
    SET status = 'applied', metadata_json = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(metadata), result.observed_at, reservationId);
  notifyQueueStateChanged({
    reason: "human_answer_completed",
    jobId: row.job_id,
    workItemId: row.work_item_id,
  });
  return true;
}

function actionReplayOrConflict(existing, target, { actionId, actionKind } = {}) {
  if (!existing?.action) return null;
  if (existing.action.action_kind !== actionKind || !sameTarget(existing.action.target, target)) {
    const conflict = baseActionResult({
      actionId,
      actionKind,
      target,
      outcome: "conflict",
      safeReasonCode: "action_id_reused",
    });
    if (actionKind === "question.answer") {
      return { ...conflict, question_state: "closed", result_event_id: null };
    }
    if (actionKind === "agent.nudge") {
      return {
        ...conflict,
        interaction_id: null,
        superseded_interaction_id: null,
        result_event_id: null,
      };
    }
    return conflict;
  }
  if (existing.action.state === "complete" && existing.action.result) return existing.action.result;
  return {
    ...baseActionResult({
      actionId,
      actionKind,
      target,
      outcome: "pending",
      observedAt: existing.action.reserved_at || now(),
    }),
    ...(actionKind === "question.answer" ? { question_state: "pending", result_event_id: null } : {}),
    ...(actionKind === "agent.nudge" ? {
      interaction_id: existing.action.interaction_id || null,
      superseded_interaction_id: existing.action.superseded_interaction_id || null,
      result_event_id: null,
    } : {}),
  };
}

function nudgeActionResult(baseArgs, {
  interactionId = null,
  supersededInteractionId = null,
  resultEventId: eventId = null,
} = {}) {
  return {
    ...baseActionResult(baseArgs),
    interaction_id: interactionId,
    superseded_interaction_id: supersededInteractionId,
    result_event_id: eventId,
  };
}

function choiceDanger(choiceId) {
  if (["fail", "revert"].includes(choiceId)) return "destructive";
  if (["reject", "skip", "replan", "cancel", "decline"].includes(choiceId)) return "caution";
  return "normal";
}

function choiceRecord(choiceId, overrides = {}) {
  const [defaultLabel, defaultConsequence] = CHOICE_COPY[choiceId] || [choiceId, "Run the exact owner transition."];
  const danger = overrides.danger || choiceDanger(choiceId);
  return {
    choice_id: choiceId,
    label: boundedText(overrides.label || defaultLabel, 160),
    consequence: boundedText(overrides.consequence || overrides.description || defaultConsequence, 400),
    danger,
    requires_confirmation: overrides.requires_confirmation === true || danger === "destructive",
  };
}

function typedKindForGate(payload) {
  const explicit = String(payload?.question_kind || "").trim();
  if (Object.hasOwn(WORK_ITEM_QUESTION_CHOICE_IDS, explicit)) return explicit;
  if (payload?.subtype === "plan_approval") return "plan_approval";
  if (payload?.subtype === "push_offer") return "push_offer";
  if (payload?.subtype === "oneshot_scope_selection" || payload?.review_type === "oneshot_scope_selection") {
    return "one_shot_file_scope";
  }
  if (Array.isArray(payload?.file_requests) && payload.file_requests.length > 0) return "file_scope_approval";
  return REVIEW_KIND_BY_TYPE.get(String(payload?.review_type || "")) || "legacy_unstructured";
}

function normalizedCandidateId(value) {
  const id = String(value ?? "").trim();
  return /^candidate:sha256:[0-9a-f]{64}$/.test(id) ? id : null;
}

function choiceIdFromEntry(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return String(entry.choice_id ?? entry.value ?? entry.id ?? "").trim();
}

function validChoiceEntries(kind, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const ids = entries.map(choiceIdFromEntry);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return false;
  if (kind === "one_shot_file_scope") {
    if (ids.length < 3 || ids.at(-2) !== "plan" || ids.at(-1) !== "cancel") return false;
    return ids.slice(0, -2).every((id) => normalizedCandidateId(id));
  }
  const allowed = WORK_ITEM_QUESTION_CHOICE_IDS[kind] || [];
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

function gateChoiceRecords(kind, payload) {
  if (kind === "legacy_unstructured") return [];
  if (kind === "one_shot_file_scope") {
    const options = Array.isArray(payload?.selector?.options) ? payload.selector.options : [];
    if (options.length > 32 || !validChoiceEntries(kind, options)) return [];
    return options.map((option) => choiceRecord(choiceIdFromEntry(option), option));
  }

  const explicit = Array.isArray(payload?.choices) ? payload.choices : null;
  if (!explicit || explicit.length === 0) {
    return liveOwnerDeliveryHandler(HANDLER_BY_KIND.get(kind))
      ? (WORK_ITEM_QUESTION_CHOICE_IDS[kind] || []).map((choiceId) => choiceRecord(choiceId))
      : [];
  }
  if (!validChoiceEntries(kind, explicit)) return [];
  return explicit.map((entry) => choiceRecord(choiceIdFromEntry(entry), entry));
}

function gateQuestionState(job) {
  if (OPEN_GATE_STATUS_SET.has(job.status)) return "open";
  if (["running", "assessing"].includes(job.status)) return "pending";
  if (job.status === "succeeded") return "answered";
  if (FAILED_JOB_STATUS_SET.has(job.status)) return "rejected";
  if (job.status === "canceled") return "closed";
  return "closed";
}

function liveOwnerDeliveryHandler(handler) {
  return LIVE_OWNER_DELIVERY_HANDLERS.has(handler);
}

function observedGateQuestionState(job, observedAt, { allowLiveOwnerDelivery = false } = {}) {
  const state = gateQuestionState(job);
  if (state !== "open" || !jobHasLiveLeaseAt(job, observedAt)) return state;
  return allowLiveOwnerDelivery ? "open" : "pending";
}

function gateQuestionGeneration(jobId) {
  return String(getHumanGate(jobId)?.generation || 1);
}

function hasPendingQuestionAction(db, questionId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM agent_interactions
    WHERE kind = 'approval' AND status = 'active'
      AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.action_kind') = 'question.answer'
      AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.state') IN ('reserved', 'delivered')
      AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.target.question_id') = ?
    LIMIT 1
  `).get(questionId));
}

function pendingQuestionAction(db, questionId) {
  const row = db.prepare(`
    SELECT *
    FROM agent_interactions
    WHERE kind = 'approval' AND status = 'active'
      AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.action_kind') = 'question.answer'
      AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.state') IN ('reserved', 'delivered')
      AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.target.question_id') = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(questionId);
  return row ? { row, action: parseStoredAction(row) } : null;
}

function currentGateQuestionCount(db, workItemId, observedAt) {
  const rows = db.prepare(`
    SELECT payload_json
    FROM jobs
    WHERE work_item_id = ? AND job_type = 'human_input'
      AND status IN ${CURRENT_GATE_STATUSES_SQL}
      AND (
        json_extract(payload_json, '$.expires_at') IS NULL
        OR julianday(json_extract(payload_json, '$.expires_at')) IS NULL
        OR julianday(json_extract(payload_json, '$.expires_at')) > julianday(?)
      )
  `).all(workItemId, observedAt);
  return rows.reduce((count, row) => {
    const payload = parseJsonObject(row.payload_json);
    const choices = gateChoiceRecords(typedKindForGate(payload), payload);
    const questions = Array.isArray(payload.questions) && payload.questions.length > 0
      ? payload.questions
      : [payload.prompt || "Human input requested"];
    return count + (choices.length > 0 ? 1 : questions.length);
  }, 0);
}

function currentDurableQuestionCount(db, workItemId, observedAt) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM agent_interactions
    WHERE work_item_id = ? AND direction = 'agent_to_user' AND kind = 'question'
      AND status = 'active'
      AND (
        expires_at IS NULL
        OR julianday(expires_at) IS NULL
        OR julianday(expires_at) > julianday(?)
      )
  `).get(workItemId, observedAt);
  return Number(row?.count || 0);
}

function answerForGate(db, jobId, questionIndex) {
  const row = db.prepare(`
    SELECT metadata_json, created_at
    FROM agent_interactions
    WHERE job_id = ? AND kind = 'approval' AND status = 'applied'
    ORDER BY id DESC
  `).all(jobId).find((candidate) => {
    const action = parseStoredAction(candidate);
    return action?.action_kind === "question.answer"
      && action?.target?.question_id === `gate:${jobId}:${questionIndex}`
      && action?.result?.outcome === "accepted";
  });
  const action = parseStoredAction(row);
  return action ? {
    choice_id: action.target.choice_id,
    answered_at: action.result?.observed_at || row.created_at,
    result_event_id: action.result?.result_event_id || null,
  } : null;
}

function projectGateQuestions(db, workItemId, observedAt, limit = MAX_QUESTIONS) {
  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE work_item_id = ? AND job_type = 'human_input'
      AND status IN ${CURRENT_GATE_STATUSES_SQL}
      AND (
        json_extract(payload_json, '$.expires_at') IS NULL
        OR julianday(json_extract(payload_json, '$.expires_at')) IS NULL
        OR julianday(json_extract(payload_json, '$.expires_at')) > julianday(?)
      )
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(workItemId, observedAt, limit);
  const out = [];
  for (const job of jobs) {
    const payload = parseJsonObject(job.payload_json);
    const kind = typedKindForGate(payload);
    const choices = gateChoiceRecords(kind, payload);
    const handler = HANDLER_BY_KIND.get(kind) || null;
    const rawQuestions = Array.isArray(payload.questions) && payload.questions.length > 0
      ? payload.questions
      : [payload.prompt || job.title || "Human input requested"];
    const questions = choices.length > 0 && rawQuestions.length > 1
      ? [rawQuestions.join("\n\n")]
      : rawQuestions;
    for (let index = 0; index < questions.length && out.length < limit; index += 1) {
      const questionId = `gate:${job.id}:${index}`;
      const ownerState = observedGateQuestionState(job, observedAt, {
        allowLiveOwnerDelivery: liveOwnerDeliveryHandler(handler),
      });
      const state = hasPendingQuestionAction(db, questionId) ? "pending" : ownerState;
      const actionable = state === "open" && choices.length > 0 && handler != null;
      out.push({
        question_id: questionId,
        work_item_id: String(job.work_item_id),
        job_id: String(job.id),
        attempt_id: null,
        agent_call_id: null,
        kind: actionable || kind !== "legacy_unstructured" ? kind : "legacy_unstructured",
        input_kind: actionable || choices.length > 0 ? "single_choice" : "informational",
        prompt_summary: boundedText(questions[index], MAX_PROMPT_CHARS),
        context_summary: boundedText(payload.context || payload.prompt || "", MAX_CONTEXT_CHARS) || null,
        state,
        opened_at: job.created_at,
        expires_at: payload.expires_at || null,
        generation: gateQuestionGeneration(job.id),
        choices: actionable || state !== "open" ? choices : [],
        capability: actionable ? QUESTION_CAPABILITY : null,
        answer: answerForGate(db, job.id, index),
        unavailable_reason: actionable || state !== "open" ? null : "unstructured_choices",
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

function durableQuestionChoices(metadata) {
  const kind = String(metadata.question_kind || metadata.kind || "").trim();
  if (!Object.hasOwn(WORK_ITEM_QUESTION_CHOICE_IDS, kind)) return { kind: "legacy_unstructured", choices: [] };
  const raw = Array.isArray(metadata.choices) ? metadata.choices : [];
  if (raw.length > 32 || !validChoiceEntries(kind, raw)) return { kind, choices: [] };
  return { kind, choices: raw.map((entry) => choiceRecord(choiceIdFromEntry(entry), entry)) };
}

function projectDurableQuestions(db, workItemId, observedAt, limit = MAX_QUESTIONS) {
  if (limit <= 0) return [];
  const rows = db.prepare(`
    SELECT * FROM agent_interactions
    WHERE work_item_id = ? AND direction = 'agent_to_user' AND kind = 'question'
      AND status = 'active'
      AND (
        expires_at IS NULL
        OR julianday(expires_at) IS NULL
        OR julianday(expires_at) > julianday(?)
      )
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(workItemId, observedAt, limit);
  return rows.map((row) => {
    const metadata = parseJsonObject(row.metadata_json);
    const normalized = durableQuestionChoices(metadata);
    const questionId = `interaction:${row.id}`;
    const state = hasPendingQuestionAction(db, questionId) ? "pending" : "open";
    const answerRow = db.prepare(`
      SELECT * FROM agent_interactions
      WHERE parent_id = ? AND kind = 'answer'
      ORDER BY id DESC LIMIT 1
    `).get(row.id);
    const answerMetadata = parseJsonObject(answerRow?.metadata_json);
    const actionable = state === "open" && normalized.choices.length > 0;
    return {
      question_id: questionId,
      work_item_id: String(row.work_item_id),
      job_id: String(row.job_id),
      attempt_id: row.attempt_id == null ? null : String(row.attempt_id),
      agent_call_id: row.agent_call_id == null ? null : String(row.agent_call_id),
      kind: normalized.kind,
      input_kind: actionable ? "single_choice" : "informational",
      prompt_summary: boundedText(row.body, MAX_PROMPT_CHARS),
      context_summary: boundedText(metadata.context_summary || metadata.context || "", MAX_CONTEXT_CHARS) || null,
      state,
      opened_at: row.created_at,
      expires_at: row.expires_at || null,
      generation: String(metadata.question_generation || row.id),
      choices: normalized.choices,
      capability: actionable ? QUESTION_CAPABILITY : null,
      answer: answerRow ? {
        choice_id: String(answerMetadata.choice_id || answerRow.body || ""),
        answered_at: answerRow.created_at,
        result_event_id: answerMetadata.result_event_id || null,
      } : null,
      unavailable_reason: actionable || state !== "open" ? null : "unstructured_choices",
    };
  });
}

function nudgeState(row, observedAt) {
  if (row.status === "superseded") return "superseded";
  if (row.status === "expired") return "expired";
  if (row.ack_state === "acknowledged" && row.ack_decision) return row.ack_decision;
  if (row.status === "active" && isExpired(row.expires_at, observedAt)) return "expired";
  const lifecycle = parseJsonObject(row.metadata_json).nudge_lifecycle || {};
  if (row.first_applied_at || lifecycle.retrieved_at) return "retrieved";
  if (lifecycle.signaled_at) return "signaled";
  return "queued";
}

function projectNudges(db, workItemId, observedAt) {
  const rows = db.prepare(`
    SELECT ai.*, j.status AS job_status,
      (SELECT COUNT(*) FROM agent_interaction_applications aia WHERE aia.interaction_id = ai.id) AS application_count
    FROM agent_interactions ai
    LEFT JOIN jobs j ON j.id = ai.job_id
    WHERE ai.work_item_id = ? AND ai.direction = 'user_to_agent' AND ai.kind = 'nudge'
    ORDER BY ai.created_at DESC, ai.id DESC
    LIMIT ?
  `).all(workItemId, MAX_NUDGES);
  return rows.map((row) => {
    const metadata = parseJsonObject(row.metadata_json);
    const lifecycle = metadata.nudge_lifecycle || {};
    const action = metadata[ACTION_METADATA_KEY] || {};
    const state = nudgeState(row, observedAt);
    const active = state !== "expired"
      && !TERMINAL_JOB_STATUS_SET.has(row.job_status)
      && row.status === "active"
      && row.ack_state === "pending"
      && !row.ack_decision;
    const summary = boundedText(row.body, 500);
    const deliveryCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(0, Math.floor(Number(lifecycle.delivery_count || row.application_count || 0))),
    );
    const acknowledgement = row.ack_state === "acknowledged" && row.ack_decision
      ? {
          decision: row.ack_decision,
          reason: row.ack_decision === "accepted" ? null : boundedText(row.ack_reason || "", 500) || null,
          acknowledged_at: row.acknowledged_at || null,
        }
      : null;
    return {
      interaction_id: `interaction:${row.id}`,
      work_item_id: String(row.work_item_id),
      job_id: String(row.job_id),
      attempt_id: row.attempt_id == null ? null : String(row.attempt_id),
      agent_call_id: row.agent_call_id == null ? null : String(row.agent_call_id),
      body_summary: summary,
      state,
      queued_at: row.created_at,
      signaled_at: lifecycle.signaled_at || null,
      retrieved_at: lifecycle.retrieved_at || row.first_applied_at || null,
      last_retrieved_at: lifecycle.last_retrieved_at || row.last_applied_at || null,
      delivery_count: deliveryCount,
      acknowledgement,
      supersedes_interaction_id: action.replaces_interaction_id ? `interaction:${action.replaces_interaction_id}` : null,
      superseded_by_interaction_id: lifecycle.superseded_by ? `interaction:${lifecycle.superseded_by}` : null,
      expires_at: row.expires_at || null,
      capability: active ? "agent.nudge" : null,
    };
  }).reverse();
}

function projectAgentFeedback(db, workItemId) {
  const rows = db.prepare(`
    SELECT ai.*, j.job_type,
      ac.role AS agent_role, ac.provider AS agent_provider, ac.model_name AS agent_model
    FROM agent_interactions ai
    LEFT JOIN jobs j ON j.id = ai.job_id
    LEFT JOIN agent_calls ac ON ac.id = ai.agent_call_id
    WHERE ai.work_item_id = ? AND ai.direction = 'agent_to_user' AND ai.kind = 'activity'
    ORDER BY ai.created_at DESC, ai.id DESC
    LIMIT ?
  `).all(workItemId, MAX_FEEDBACK);
  const projected = [];
  for (const row of rows.reverse()) {
    const metadata = parseJsonObject(row.metadata_json);
    const phase = String(metadata.phase || "").trim();
    const status = String(metadata.status || metadata.action || "").trim();
    const summary = boundedText(row.body, MAX_FEEDBACK_SUMMARY_CHARS);
    const detail = boundedText(metadata.detail || "", MAX_FEEDBACK_DETAIL_CHARS) || null;
    if (!FEEDBACK_PHASES.has(phase) || !FEEDBACK_STATUSES.has(status) || !summary) continue;
    const role = String(row.agent_role || JOB_TYPE_ROLE_REGISTRY[row.job_type]?.worker || row.job_type || "").trim();
    if (!role) continue;
    projected.push({
      interaction_id: `interaction:${row.id}`,
      work_item_id: String(row.work_item_id),
      job_id: String(row.job_id),
      attempt_id: row.attempt_id == null ? null : String(row.attempt_id),
      agent_call_id: row.agent_call_id == null ? null : String(row.agent_call_id),
      role: boundedText(role, 80),
      phase,
      status,
      summary,
      detail,
      provider: boundedText(metadata.provider || row.agent_provider || "", 80) || null,
      model: boundedText(metadata.model || row.agent_model || "", 120) || null,
      occurred_at: row.created_at,
    });
  }
  return projected;
}

export function projectWorkItemInteractions({ work_item_id, observed_at = null } = {}) {
  const workItemId = positiveId(work_item_id);
  if (!workItemId) throw new TypeError("projectWorkItemInteractions requires work_item_id");
  const observedAt = normalizedObservedAt(observed_at);
  const db = getDb();
  const gateTotal = currentGateQuestionCount(db, workItemId, observedAt);
  const durableTotal = currentDurableQuestionCount(db, workItemId, observedAt);
  const questionsTotal = gateTotal + durableTotal;
  const gates = projectGateQuestions(db, workItemId, observedAt);
  const durable = projectDurableQuestions(db, workItemId, observedAt);
  const questions = [...gates, ...durable]
    .sort((left, right) => {
      if (left.opened_at !== right.opened_at) return left.opened_at < right.opened_at ? -1 : 1;
      if (left.question_id === right.question_id) return 0;
      return left.question_id < right.question_id ? -1 : 1;
    })
    .slice(0, MAX_QUESTIONS);
  return {
    questions,
    questions_total: questionsTotal,
    questions_truncated: questionsTotal > questions.length,
    nudges: projectNudges(db, workItemId, observedAt),
    agent_feedback: projectAgentFeedback(db, workItemId),
  };
}

function locateQuestion(db, { workItemId, jobId, questionId } = {}) {
  const gateMatch = String(questionId).match(/^gate:([1-9]\d*):(0|[1-9]\d*)$/);
  if (gateMatch) {
    if (positiveId(gateMatch[1]) !== jobId) return null;
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    if (!job || job.work_item_id !== workItemId || job.job_type !== "human_input") return null;
    const payload = parseJsonObject(job.payload_json);
    const rawQuestions = Array.isArray(payload.questions) && payload.questions.length > 0
      ? payload.questions : [payload.prompt || job.title || "Human input requested"];
    const kind = typedKindForGate(payload);
    const choices = gateChoiceRecords(kind, payload);
    const questions = choices.length > 0 && rawQuestions.length > 1
      ? [rawQuestions.join("\n\n")]
      : rawQuestions;
    const questionIndex = Number(gateMatch[2]);
    if (!Number.isSafeInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) return null;
    const observedAt = now();
    const handler = HANDLER_BY_KIND.get(kind) || null;
    const liveOwner = jobHasLiveLeaseAt(job, observedAt);
    const ownerState = observedGateQuestionState(job, observedAt, {
      allowLiveOwnerDelivery: liveOwnerDeliveryHandler(handler),
    });
    const state = isExpired(payload.expires_at, observedAt) && ["open", "pending"].includes(ownerState)
      ? "expired" : ownerState;
    return {
      type: "gate",
      job,
      kind,
      choices,
      state,
      generation: gateQuestionGeneration(job.id),
      handler,
      live_owner: liveOwner,
      owner_delivery: liveOwner && liveOwnerDeliveryHandler(handler),
      payload,
    };
  }

  const interactionId = interactionRowId(questionId);
  if (!String(questionId).startsWith("interaction:") || !interactionId) return null;
  const row = db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(interactionId);
  if (!row || row.kind !== "question" || row.work_item_id !== workItemId || row.job_id !== jobId) return null;
  const metadata = parseJsonObject(row.metadata_json);
  const normalized = durableQuestionChoices(metadata);
  return {
    type: "interaction",
    row,
    kind: normalized.kind,
    choices: normalized.choices,
    state: row.status === "active" && isExpired(row.expires_at, now()) ? "expired"
      : row.status === "active" ? "open" : row.status === "answered" ? "answered" : "closed",
    generation: String(metadata.question_generation || row.id),
    handler: normalized.choices.length > 0 ? "human_input" : null,
  };
}

function questionStateAfterTransition(db, questionId, fallback = "pending") {
  const gateMatch = String(questionId).match(/^gate:([1-9]\d*):/);
  if (gateMatch) {
    const job = db.prepare(`SELECT status, lease_token, lease_expires_at FROM jobs WHERE id = ?`).get(Number(gateMatch[1]));
    return job ? observedGateQuestionState(job, now()) : "closed";
  }
  const interactionId = interactionRowId(questionId);
  const row = interactionId ? db.prepare(`SELECT status FROM agent_interactions WHERE id = ?`).get(interactionId) : null;
  if (!row) return "closed";
  if (row.status === "answered") return "answered";
  if (row.status === "active") return fallback;
  return "closed";
}

function transitionSucceeded(result) {
  if (result?.ok === true) return true;
  return ["accepted", "succeeded", "queued"].includes(String(result?.outcome || ""));
}

function resultEventId(result) {
  const raw = result?.result_event_id ?? result?.event_id ?? null;
  if (raw == null) return null;
  const text = String(raw);
  if (/^event:[1-9]\d*$/.test(text)) return text;
  const id = positiveId(text);
  return id ? `event:${id}` : null;
}

function storedGitPushCompletion(db, action) {
  if (action?.handler !== "git_push") return null;
  const jobId = positiveId(action.target?.job_id);
  const job = jobId ? db.prepare(`SELECT status, result_json FROM jobs WHERE id = ?`).get(jobId) : null;
  if (!job) return { state: "closed", accepted: false, safeReasonCode: "question_not_found" };
  const ownerResult = parseJsonObject(job.result_json);
  const choiceId = action.target?.choice_id;
  if (choiceId === "decline" && job.status === "canceled" && ownerResult.declined === true) {
    return { state: "closed", accepted: true, safeReasonCode: null };
  }
  if (choiceId === "push" && job.status === "succeeded"
    && (ownerResult.pushed === true || ownerResult.already_up_to_date === true)) {
    return { state: "answered", accepted: true, safeReasonCode: null };
  }
  if (OPEN_GATE_STATUS_SET.has(job.status)) {
    return { state: observedGateQuestionState(job, now()), accepted: null, safeReasonCode: null };
  }
  return { state: observedGateQuestionState(job, now()), accepted: false, safeReasonCode: "question_closed" };
}

function storedHumanGateCompletion(db, action) {
  if (!liveOwnerDeliveryHandler(action?.handler)) return null;
  const jobId = positiveId(action.target?.job_id);
  if (!jobId) return { state: "closed", accepted: false, safeReasonCode: "question_not_found" };
  const row = db.prepare(`
    SELECT j.status, j.lease_token, j.lease_expires_at,
      hg.gate_state, hg.generation, hg.resolution_action, hg.resolution_error
    FROM jobs j
    LEFT JOIN human_gates hg ON hg.gate_job_id = j.id
    WHERE j.id = ?
  `).get(jobId);
  if (!row) return { state: "closed", accepted: false, safeReasonCode: "question_not_found" };
  if (row.gate_state === "resolved") {
    const selected = canonicalHumanGateAction(
      action.descriptor?.owner_action || action.target?.choice_id,
    );
    const resolved = canonicalHumanGateAction(row.resolution_action);
    return selected && selected === resolved
      ? { state: "answered", accepted: true, safeReasonCode: null }
      : { state: "closed", accepted: false, safeReasonCode: "question_answer_lost_race" };
  }
  if (row.gate_state === "superseded" || TERMINAL_JOB_STATUS_SET.has(row.status)) {
    return {
      state: gateQuestionState(row),
      accepted: false,
      safeReasonCode: safeReason(row.resolution_error, "question_closed"),
    };
  }
  return {
    state: jobHasLiveLeaseAt(row, now()) ? "pending" : gateQuestionState(row),
    accepted: null,
    safeReasonCode: jobHasLiveLeaseAt(row, now()) ? "owner_delivery_pending" : "owner_unavailable",
  };
}

function reconcileReservedQuestionAction(db, existing, target, { actionId } = {}) {
  const replay = actionReplayOrConflict(existing, target, { actionId, actionKind: "question.answer" });
  if (!existing?.action || replay?.outcome !== "pending") return { replay };
  const completion = storedHumanGateCompletion(db, existing.action)
    || storedGitPushCompletion(db, existing.action);
  if (!completion) return { replay };
  if (completion.accepted != null) {
    const observedAt = now();
    const result = {
      ...baseActionResult({
        actionId,
        actionKind: "question.answer",
        target,
        outcome: completion.accepted ? "accepted" : "gate_closed",
        observedAt,
        safeReasonCode: completion.safeReasonCode,
      }),
      question_state: completion.state,
      result_event_id: null,
    };
    completeReservedAction(db, existing.row.id, result);
    return { replay: result };
  }
  if (liveOwnerDeliveryHandler(existing.action.handler)) {
    if (existing.action.state === "delivered" && completion.safeReasonCode === "owner_unavailable") {
      const observedAt = now();
      const result = {
        ...baseActionResult({
          actionId,
          actionKind: "question.answer",
          target,
          outcome: "rejected",
          observedAt,
          safeReasonCode: "owner_lost_after_delivery",
        }),
        question_state: completion.state,
        result_event_id: null,
      };
      completeReservedAction(db, existing.row.id, result);
      return { replay: result };
    }
    return {
      replay: {
        ...replay,
        safe_reason: completion.safeReasonCode,
        retryable: completion.safeReasonCode === "owner_unavailable",
      },
    };
  }
  const descriptor = existing.action.descriptor;
  if (!descriptor || descriptor.handler !== "git_push") return { replay };
  return { reservationId: existing.row.id, descriptor };
}

export async function answerWorkItemQuestionChoice(args = {}, { executeTransition } = {}) {
  if (typeof executeTransition !== "function") {
    throw new TypeError("answerWorkItemQuestionChoice requires executeTransition");
  }
  const actionId = String(args.action_id ?? "").trim();
  const workItemId = positiveId(args.work_item_id);
  const jobId = positiveId(args.job_id);
  const questionId = String(args.question_id ?? "").trim();
  const choiceId = String(args.choice_id ?? "").trim();
  const generation = String(args.question_generation ?? "").trim();
  const target = actionTarget({ workItemId: workItemId || args.work_item_id, jobId: jobId || args.job_id, questionId, choiceId });
  if (!validActionId(actionId)) {
    return {
      ...baseActionResult({ actionId, actionKind: "question.answer", target, outcome: "rejected", safeReasonCode: "invalid_action_id" }),
      question_state: "open",
      result_event_id: null,
    };
  }
  if (!workItemId || !jobId || !questionId || !generation || !choiceId) {
    return {
      ...baseActionResult({ actionId, actionKind: "question.answer", target, outcome: "target_not_found", safeReasonCode: "invalid_target" }),
      question_state: "closed",
      result_event_id: null,
    };
  }

  const db = getDb();
  const reserved = runImmediateTransaction(db, () => {
    const existing = findActionById(db, actionId);
    if (existing) return reconcileReservedQuestionAction(db, existing, target, { actionId });
    const question = locateQuestion(db, { workItemId, jobId, questionId });
    if (!question) {
      return { result: {
        ...baseActionResult({ actionId, actionKind: "question.answer", target, outcome: "target_not_found", safeReasonCode: "question_not_found" }),
        question_state: "closed",
        result_event_id: null,
      } };
    }
    if (question.generation !== generation) {
      return { result: {
        ...baseActionResult({ actionId, actionKind: "question.answer", target, outcome: "stale_generation", safeReasonCode: "question_generation_changed" }),
        question_state: question.state,
        result_event_id: null,
      } };
    }
    if (question.state !== "open") {
      const pending = question.state === "pending";
      return { result: {
        ...baseActionResult({
          actionId,
          actionKind: "question.answer",
          target,
          outcome: pending ? "pending" : "gate_closed",
          safeReasonCode: pending ? "question_resolution_in_progress" : "question_closed",
        }),
        question_state: question.state,
        result_event_id: null,
      } };
    }
    if (!question.handler || question.choices.length === 0) {
      return { result: {
        ...baseActionResult({ actionId, actionKind: "question.answer", target, outcome: "capability_lost", safeReasonCode: "question_not_actionable" }),
        question_state: question.state,
        result_event_id: null,
      } };
    }
    if (!question.choices.some((choice) => choice.choice_id === choiceId)) {
      return { result: {
        ...baseActionResult({ actionId, actionKind: "question.answer", target, outcome: "invalid_choice", safeReasonCode: "choice_not_allowed" }),
        question_state: question.state,
        result_event_id: null,
      } };
    }
    const competing = pendingQuestionAction(db, questionId);
    if (competing) {
      return { result: {
        ...baseActionResult({
          actionId,
          actionKind: "question.answer",
          target,
          outcome: "pending",
          safeReasonCode: "question_resolution_in_progress",
        }),
        question_state: "pending",
        result_event_id: null,
      } };
    }
    const observedAt = now();
    const descriptor = {
      handler: question.handler,
      work_item_id: String(workItemId),
      job_id: String(jobId),
      question_id: questionId,
      question_generation: generation,
      choice_id: choiceId,
      ...(question.handler === "git_push" ? { decline: choiceId === "decline" } : {}),
      ...(question.owner_delivery ? {
        owner_action: canonicalHumanGateAction(
          humanInputChoiceFromAnswer(choiceId, humanInputChoicesForPayload(question.payload)) || choiceId,
        ),
      } : {}),
    };
    const reservationId = insertActionReservation(db, {
      actionId,
      actionKind: "question.answer",
      target,
      handler: question.handler,
      descriptor,
      workItemId,
      jobId,
      source: args.source,
      author: args.author,
      observedAt,
    });
    return {
      reservationId,
      descriptor,
      ownerDeliveryPending: question.owner_delivery === true,
    };
  });

  if (reserved.replay) return reserved.replay;
  if (reserved.result) return reserved.result;
  if (reserved.ownerDeliveryPending) {
    return {
      ...baseActionResult({
        actionId,
        actionKind: "question.answer",
        target,
        outcome: "pending",
        safeReasonCode: "owner_delivery_pending",
      }),
      question_state: "pending",
      result_event_id: null,
      retryable: true,
    };
  }

  let transitionResult;
  let transitionError = null;
  try {
    transitionResult = await executeTransition(reserved.descriptor);
  } catch {
    transitionError = "transition_failed";
  }
  const accepted = !transitionError && transitionSucceeded(transitionResult);
  const observedAt = now();
  const result = {
    ...baseActionResult({
      actionId,
      actionKind: "question.answer",
      target,
      outcome: accepted ? "accepted" : "rejected",
      observedAt,
      safeReasonCode: accepted ? null : safeReason(transitionError || transitionResult?.reason || transitionResult?.code, "transition_rejected"),
    }),
    question_state: questionStateAfterTransition(db, questionId, accepted ? "answered" : "open"),
    result_event_id: resultEventId(transitionResult),
  };
  runImmediateTransaction(db, () => completeReservedAction(db, reserved.reservationId, result));
  try {
    logEvent({
      work_item_id: workItemId,
      job_id: jobId,
      event_type: EVENT_TYPES.AGENT_QUESTION_ANSWERED,
      actor_type: EVENT_ACTORS.HUMAN,
      actor_id: boundedText(args.author || "operator", 120),
      message: accepted ? `Structured question ${questionId} answered` : `Structured question ${questionId} transition rejected`,
      event_json: { action_id: actionId, question_id: questionId, choice_id: choiceId, outcome: result.outcome },
    });
  } catch { /* the reserved durable result remains authoritative */ }
  return result;
}

function ownerDeliveryDescriptor(row) {
  const action = parseStoredAction(row);
  const descriptor = action?.descriptor;
  if (
    row?.status !== "active"
    || action?.action_kind !== "question.answer"
    || action?.state !== "reserved"
    || !descriptor
    || !liveOwnerDeliveryHandler(descriptor.handler)
  ) return null;
  const jobId = positiveId(descriptor.job_id);
  const workItemId = positiveId(descriptor.work_item_id);
  const questionId = String(descriptor.question_id || "");
  const questionMatch = questionId.match(/^gate:([1-9]\d*):(0|[1-9]\d*)$/);
  const questionGeneration = String(descriptor.question_generation || "");
  const choiceId = String(descriptor.choice_id || "");
  if (
    !jobId
    || !workItemId
    || !questionMatch
    || positiveId(questionMatch[1]) !== jobId
    || !questionGeneration
    || !choiceId
    || Number(row.job_id) !== jobId
    || Number(row.work_item_id) !== workItemId
    || !sameTarget(action.target, actionTarget({
      workItemId,
      jobId,
      questionId,
      choiceId,
    }))
  ) return null;
  return {
    reservation_id: Number(row.id),
    action_id: String(action.action_id || ""),
    handler: descriptor.handler,
    work_item_id: String(workItemId),
    job_id: String(jobId),
    question_id: questionId,
    question_index: Number(questionMatch[2]),
    question_generation: questionGeneration,
    choice_id: choiceId,
  };
}

/**
 * Narrow owner-side read for the attended-run relay. This intentionally omits
 * lease tokens and free-form answer text; the Display contributes its private
 * in-memory lease token only after an exact prompt match.
 */
export function listReservedHumanAnswerDeliveries({ limit = 32 } = {}) {
  const db = getDb();
  reconcileAbandonedHumanAnswerDeliveries();
  const boundedLimit = Math.max(1, Math.min(128, Number(limit) || 32));
  const observedAt = now();
  const rows = db.prepare(`
    SELECT ai.*, j.status AS job_status, j.lease_token AS job_lease_token,
      j.lease_expires_at AS job_lease_expires_at,
      hg.gate_state, hg.generation AS gate_generation
    FROM agent_interactions ai
    JOIN jobs j ON j.id = ai.job_id
    JOIN human_gates hg ON hg.gate_job_id = j.id
    WHERE ai.kind = 'approval' AND ai.status = 'active'
      AND json_extract(ai.metadata_json, '$.${ACTION_METADATA_KEY}.action_kind') = 'question.answer'
      AND json_extract(ai.metadata_json, '$.${ACTION_METADATA_KEY}.state') = 'reserved'
      AND j.job_type = 'human_input' AND j.status = 'waiting_on_human'
      AND j.lease_token IS NOT NULL
      AND j.lease_expires_at IS NOT NULL
      AND julianday(j.lease_expires_at) > julianday(?)
      AND hg.gate_state = 'open'
    ORDER BY ai.created_at ASC, ai.id ASC
    LIMIT ?
  `).all(observedAt, boundedLimit);
  const deliveries = [];
  for (const row of rows) {
    if (!jobHasLiveLeaseAt({
      status: row.job_status,
      lease_token: row.job_lease_token,
      lease_expires_at: row.job_lease_expires_at,
    }, observedAt)) continue;
    const descriptor = ownerDeliveryDescriptor(row);
    if (!descriptor || descriptor.question_generation !== String(row.gate_generation || 1)) continue;
    deliveries.push({
      ...descriptor,
      gate_generation: String(row.gate_generation || 1),
    });
  }
  return deliveries;
}

export function reconcileAbandonedHumanAnswerDeliveries() {
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const rows = db.prepare(`
      SELECT ai.*
      FROM agent_interactions ai
      JOIN jobs j ON j.id = ai.job_id
      WHERE ai.kind = 'approval' AND ai.status = 'active'
        AND json_extract(ai.metadata_json, '$.${ACTION_METADATA_KEY}.action_kind') = 'question.answer'
        AND json_extract(ai.metadata_json, '$.${ACTION_METADATA_KEY}.state') = 'delivered'
        AND (
          j.lease_token IS NULL
          OR j.lease_expires_at IS NULL
          OR julianday(j.lease_expires_at) <= julianday(?)
        )
      ORDER BY ai.id ASC
    `).all(now());
    let reconciled = 0;
    for (const row of rows) {
      const action = parseStoredAction(row);
      if (!action?.action_id || !action.target) continue;
      const outcome = reconcileReservedQuestionAction(db, {
        row,
        action,
      }, action.target, { actionId: action.action_id });
      if (outcome.replay?.outcome !== "pending") reconciled += 1;
    }
    return reconciled;
  });
}

export function markHumanAnswerDelivery({
  reservation_id,
  job_id,
  question_generation,
  lease_token,
} = {}) {
  const reservationId = positiveId(reservation_id);
  const jobId = positiveId(job_id);
  const leaseToken = String(lease_token || "");
  if (!reservationId || !jobId || !leaseToken) return { ok: false, reason: "invalid_delivery_identity" };
  const db = getDb();
  return runImmediateTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(reservationId);
    const descriptor = ownerDeliveryDescriptor(row);
    if (!descriptor || positiveId(descriptor.job_id) !== jobId) {
      return { ok: false, reason: "reservation_not_pending" };
    }
    if (descriptor.question_generation !== String(question_generation || "")) {
      return { ok: false, reason: "stale_generation" };
    }
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    const gate = db.prepare(`SELECT gate_state, generation FROM human_gates WHERE gate_job_id = ?`).get(jobId);
    if (
      !job
      || job.status !== "waiting_on_human"
      || job.lease_token !== leaseToken
      || !jobHasLiveLeaseAt(job, now())
    ) return { ok: false, reason: "stale_owner_lease" };
    if (gate?.gate_state !== "open" || String(gate.generation || 1) !== descriptor.question_generation) {
      return { ok: false, reason: "stale_generation" };
    }
    const metadata = parseJsonObject(row.metadata_json);
    const action = metadata[ACTION_METADATA_KEY];
    const deliveredAt = now();
    metadata[ACTION_METADATA_KEY] = {
      ...action,
      state: "delivered",
      delivered_at: deliveredAt,
      delivery_count: Math.max(0, Number(action.delivery_count || 0)) + 1,
    };
    const updated = db.prepare(`
      UPDATE agent_interactions
      SET metadata_json = ?, first_applied_at = COALESCE(first_applied_at, ?),
          last_applied_at = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
        AND json_extract(metadata_json, '$.${ACTION_METADATA_KEY}.state') = 'reserved'
    `).run(JSON.stringify(metadata), deliveredAt, deliveredAt, deliveredAt, reservationId);
    if (updated.changes !== 1) return { ok: false, reason: "delivery_raced" };
    notifyQueueStateChanged({
      reason: "human_answer_delivered",
      jobId,
      workItemId: row.work_item_id,
    });
    return { ok: true, delivered_at: deliveredAt };
  });
}

export function completeDeliveredHumanAnswerReservation({
  reservation_id,
  job_id,
  accepted = false,
  reason = null,
  author = "operator",
} = {}) {
  const reservationId = positiveId(reservation_id);
  const jobId = positiveId(job_id);
  if (!reservationId || !jobId) return { ok: false, reason: "invalid_delivery_identity" };
  const db = getDb();
  const settled = runImmediateTransaction(db, () => {
    const row = db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(reservationId);
    const action = parseStoredAction(row);
    if (!row || Number(row.job_id) !== jobId || action?.action_kind !== "question.answer") {
      return { ok: false, reason: "reservation_not_found" };
    }
    if (action.state === "complete" && action.result) return { ok: true, idempotent: true, result: action.result };
    if (row.status !== "active" || action.state !== "delivered") {
      return { ok: false, reason: "reservation_not_delivered" };
    }
    const observedAt = now();
    const result = {
      ...baseActionResult({
        actionId: action.action_id,
        actionKind: "question.answer",
        target: action.target,
        outcome: accepted ? "accepted" : "rejected",
        observedAt,
        safeReasonCode: accepted ? null : safeReason(reason, "transition_rejected"),
      }),
      question_state: accepted ? "answered" : questionStateAfterTransition(
        db,
        action.target?.question_id,
        "open",
      ),
      result_event_id: null,
    };
    completeReservedAction(db, reservationId, result);
    return {
      ok: true,
      idempotent: false,
      result,
      work_item_id: row.work_item_id,
      choice_id: action.target?.choice_id || null,
    };
  });
  if (settled.ok && !settled.idempotent) {
    try {
      logEvent({
        work_item_id: settled.work_item_id,
        job_id: jobId,
        event_type: EVENT_TYPES.AGENT_QUESTION_ANSWERED,
        actor_type: EVENT_ACTORS.HUMAN,
        actor_id: boundedText(author, 120),
        message: accepted
          ? `Reserved human answer applied by the owning run for job #${jobId}`
          : `Reserved human answer rejected by the owning run for job #${jobId}`,
        event_json: {
          reservation_id: reservationId,
          choice_id: settled.choice_id,
          outcome: settled.result?.outcome,
          safe_reason: settled.result?.safe_reason,
        },
      });
    } catch { /* the durable reservation result remains authoritative */ }
  }
  return settled;
}

export function replaceOperatorNudge(args = {}) {
  const actionId = String(args.action_id ?? "").trim();
  const workItemId = positiveId(args.work_item_id);
  const jobId = positiveId(args.job_id);
  const agentCallId = args.agent_call_id == null || String(args.agent_call_id).trim() === ""
    ? null : positiveId(args.agent_call_id);
  const body = String(args.body ?? "").trim();
  const target = actionTarget({
    workItemId: workItemId || args.work_item_id,
    jobId: jobId || args.job_id,
    agentCallId: agentCallId || null,
  });
  if (!validActionId(actionId)) {
    return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "rejected", safeReasonCode: "invalid_action_id" });
  }
  if (scalarLength(body) < 1 || scalarLength(body) > MAX_NUDGE_BODY_CHARS) {
    return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "invalid_body", safeReasonCode: "body_out_of_bounds" });
  }
  if (!workItemId || !jobId || (args.agent_call_id != null && agentCallId == null)) {
    return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "target_not_found", safeReasonCode: "invalid_target" });
  }

  const db = getDb();
  return runImmediateTransaction(db, () => {
    const existing = findActionById(db, actionId);
    if (existing) return actionReplayOrConflict(existing, target, { actionId, actionKind: "agent.nudge" });
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    if (!job || job.work_item_id !== workItemId) {
      return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "target_not_found", safeReasonCode: "job_not_found" });
    }
    if (TERMINAL_JOB_STATUS_SET.has(job.status)) {
      return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "capability_lost", safeReasonCode: "job_terminal" });
    }
    if (agentCallId != null) {
      const call = db.prepare(`SELECT * FROM agent_calls WHERE id = ?`).get(agentCallId);
      if (!call || call.job_id !== jobId || call.work_item_id !== workItemId || call.status !== "running") {
        return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "stale_agent_call", safeReasonCode: "agent_call_not_current" });
      }
    }
    const replaceId = args.replace_interaction_id == null ? null : interactionRowId(args.replace_interaction_id);
    let replaced = null;
    if (args.replace_interaction_id != null) {
      replaced = replaceId ? db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(replaceId) : null;
      if (!replaced
        || replaced.work_item_id !== workItemId
        || replaced.job_id !== jobId
        || replaced.kind !== "nudge"
        || replaced.direction !== "user_to_agent"
        || replaced.status !== "active"
        || replaced.ack_state !== "pending"
        || replaced.ack_decision != null) {
        return nudgeActionResult({ actionId, actionKind: "agent.nudge", target, outcome: "replacement_closed", safeReasonCode: "replacement_not_active" });
      }
    } else {
      replaced = db.prepare(`
        SELECT * FROM agent_interactions
        WHERE work_item_id = ? AND job_id = ? AND direction = 'user_to_agent'
          AND kind = 'nudge' AND status = 'active' AND ack_state = 'pending' AND ack_decision IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(workItemId, jobId) || null;
    }
    const observedAt = now();
    const metadata = {
      [ACTION_METADATA_KEY]: {
        version: 1,
        action_id: actionId,
        action_kind: "agent.nudge",
        target,
        state: "reserved",
        reserved_at: observedAt,
        replaces_interaction_id: replaced?.id || null,
        result: null,
      },
      nudge_lifecycle: {},
    };
    const row = createOperatorNudge({
      work_item_id: workItemId,
      job_id: jobId,
      agent_call_id: agentCallId,
      body,
      source: boundedText(args.source || "bossy", 80) || "bossy",
      author: boundedText(args.author || "operator", 120) || "operator",
      metadata_json: metadata,
    });
    if (replaced) {
      const replacedMetadata = parseJsonObject(replaced.metadata_json);
      replacedMetadata.nudge_lifecycle = {
        ...(replacedMetadata.nudge_lifecycle || {}),
        superseded_by: row.id,
        superseded_at: observedAt,
      };
      db.prepare(`UPDATE agent_interactions SET metadata_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(replacedMetadata), observedAt, replaced.id);
    }
    const result = nudgeActionResult(
      { actionId, actionKind: "agent.nudge", target, outcome: "queued", observedAt },
      {
        interactionId: `interaction:${row.id}`,
        supersededInteractionId: replaced ? `interaction:${replaced.id}` : null,
      },
    );
    const rowMetadata = parseJsonObject(row.metadata_json);
    rowMetadata[ACTION_METADATA_KEY] = {
      ...(rowMetadata[ACTION_METADATA_KEY] || {}),
      state: "complete",
      completed_at: observedAt,
      interaction_id: result.interaction_id,
      superseded_interaction_id: result.superseded_interaction_id,
      result,
    };
    db.prepare(`UPDATE agent_interactions SET metadata_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(rowMetadata), observedAt, row.id);
    return result;
  });
}
