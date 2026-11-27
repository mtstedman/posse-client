// Builders for posse.agent_conversation.v1 entries (§3.1). Every builder
// takes rows already read by the projection and returns one entry with the
// fields common to every kind plus its own bounded fields. Text passes the
// bridge redaction; wire keys avoid relay-prohibited names (`origin`, never
// `source`).
import {
  AGENT_CONVERSATION_BOUNDS as BOUNDS,
  AGENT_CONVERSATION_ENTRY_KIND as KIND,
  AGENT_CONVERSATION_GROUP_CLOSER as CLOSER,
  AGENT_CONVERSATION_REPLACEABLE_NUDGE_STATES,
  AGENT_CONVERSATION_TIER,
  AGENT_CONVERSATION_CHOICE_ID_CHARS as CHOICE_ID_CHARS,
  AGENT_CONVERSATION_TOKEN_CHARS as TOKEN_CHARS,
} from "../../../catalog/agent-conversation.js";
import { JOB_TYPE_ROLE_REGISTRY } from "../../../catalog/provider.js";
import { CHOICE_COPY } from "../../../catalog/work-item-interaction-copy.js";
import { humanGateActionAcceptsFeedback, humanInputChoiceFeedback } from "../../../catalog/human-input.js";
import { promptFromGatePayload } from "../../bridge/functions/gate-prompt.js";
import { nudgeState } from "../../queue/functions/interaction-contract.js";
import { projectGateQuestionContract, sanitizeChoiceRecord } from "../../bridge/functions/gate-question.js";
import { boundedText, renderCallItem } from "./tool-call-tiers.js";
import { isTerminalJob, parseConversationObject } from "./tool-group-store.js";

function id(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iso(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** An enumerated token or id, whole or not at all. */
function token(value, maxChars = TOKEN_CHARS) {
  const text = value == null ? "" : String(value);
  return text && Array.from(text).length <= maxChars ? text : null;
}

function revOf(...values) {
  const times = values.flat().map((value) => (typeof value === "number" ? value : Date.parse(String(value ?? ""))))
    .filter((value) => Number.isFinite(value));
  return times.length ? Math.max(...times) : 0;
}

export function roleForJob(jobType) {
  return boundedText(JOB_TYPE_ROLE_REGISTRY[jobType]?.worker || jobType, BOUNDS.ROLE_CHARS);
}

function common({ kind, entryId, rev, occurredAt, workItemId, jobId = null, attemptId = null, agentCallId = null, parentAgentCallId = null, role = null, actor }) {
  const occurred = iso(occurredAt) || new Date(0).toISOString();
  return {
    entry_id: entryId,
    kind,
    rev: Math.max(0, Math.floor(Number(rev) || 0)),
    occurred_at: occurred,
    order_key: `${occurred}|${entryId}`,
    work_item_id: id(workItemId),
    job_id: id(jobId),
    attempt_id: id(attemptId),
    agent_call_id: id(agentCallId),
    parent_agent_call_id: id(parentAgentCallId),
    role: boundedText(role, BOUNDS.ROLE_CHARS),
    actor,
  };
}

/** Divider for one job attempt. Never carries agent_calls.activity text. */
export function jobMarkerEntry({ job, attempt, firstCall = null }) {
  const ended = attempt.finished_at != null && attempt.status !== "running";
  return {
    ...common({
      kind: KIND.JOB_MARKER,
      entryId: `job:${job.id}:${attempt.id}`,
      rev: revOf(attempt.started_at, attempt.finished_at, job.updated_at),
      occurredAt: attempt.started_at,
      workItemId: job.work_item_id,
      jobId: job.id,
      attemptId: attempt.id,
      role: attempt.worker_type || roleForJob(job.job_type),
      actor: "system",
    }),
    job_type: boundedText(job.job_type, BOUNDS.ROLE_CHARS),
    title: boundedText(job.title, BOUNDS.MARKER_TITLE_CHARS),
    status: boundedText(job.status, BOUNDS.ROLE_CHARS),
    provider: boundedText(firstCall?.provider || job.provider, BOUNDS.PROVIDER_CHARS),
    model: boundedText(attempt.model_name || firstCall?.model_name || job.model_name || firstCall?.model_tier || job.model_tier, BOUNDS.MODEL_CHARS),
    attempt_number: Number(attempt.attempt_number) || null,
    phase: ended ? "ended" : "started",
    outcome: ended ? boundedText(attempt.status, BOUNDS.ROLE_CHARS) : null,
  };
}

/** The agent's own typed agent_feedback message. */
export function agentMessageEntry({ row, toolGroupId = null }) {
  const metadata = parseConversationObject(row.metadata_json);
  return {
    ...common({
      kind: KIND.AGENT_MESSAGE,
      entryId: `msg:${row.id}`,
      rev: revOf(row.created_at, row.updated_at),
      occurredAt: row.created_at,
      workItemId: row.work_item_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      agentCallId: row.agent_call_id,
      parentAgentCallId: row.call_parent_agent_call_id,
      role: row.call_role || metadata.role || roleForJob(row.job_type),
      actor: "agent",
    }),
    phase: String(metadata.phase),
    status: String(metadata.status || metadata.action),
    summary: boundedText(row.body, BOUNDS.MESSAGE_SUMMARY_CHARS) || "",
    detail: boundedText(metadata.detail, BOUNDS.MESSAGE_DETAIL_CHARS),
    tool_group_id: toolGroupId,
    origin: boundedText(row.source || "agent_feedback", BOUNDS.ORIGIN_CHARS),
  };
}

function lifecycleTimes(lifecycle) {
  return Object.entries(lifecycle || {})
    .filter(([key]) => key.endsWith("_at"))
    .map(([, value]) => value);
}

/** The operator's nudge with its delivery receipt. */
export function operatorMessageEntry({ row, observedAt, supersededByFallback = null }) {
  const metadata = parseConversationObject(row.metadata_json);
  const lifecycle = metadata.nudge_lifecycle && typeof metadata.nudge_lifecycle === "object" ? metadata.nudge_lifecycle : {};
  const state = nudgeState(row, observedAt);
  const replaceable = AGENT_CONVERSATION_REPLACEABLE_NUDGE_STATES.has(state)
    && row.status === "active" && row.ack_state === "pending" && !row.ack_decision
    && !isTerminalJob({ status: row.job_status });
  let reason = null;
  if (["rejected", "deferred"].includes(state)) reason = boundedText(row.ack_reason, BOUNDS.DELIVERY_REASON_CHARS);
  else if (state === "expired") reason = row.first_applied_at || lifecycle.retrieved_at ? "delivered but unacknowledged" : "undelivered";
  const supersededBy = id(lifecycle.superseded_by) ?? (state === "superseded" ? id(supersededByFallback) : null);
  return {
    ...common({
      kind: KIND.OPERATOR_MESSAGE,
      entryId: `op:${row.id}`,
      rev: revOf(row.created_at, row.updated_at, row.acknowledged_at, row.first_applied_at, row.last_applied_at, lifecycleTimes(lifecycle)),
      occurredAt: row.created_at,
      workItemId: row.work_item_id,
      jobId: row.job_id,
      attemptId: row.attempt_id,
      agentCallId: row.agent_call_id,
      parentAgentCallId: row.call_parent_agent_call_id,
      actor: "operator",
    }),
    interaction_id: Number(row.id),
    body: boundedText(row.body, BOUNDS.OPERATOR_BODY_CHARS) || "",
    origin: boundedText(row.source || "operator", BOUNDS.ORIGIN_CHARS),
    author: boundedText(row.author || "operator", BOUNDS.OPERATOR_AUTHOR_CHARS),
    delivery: {
      state,
      retrieved_at: iso(lifecycle.retrieved_at || row.first_applied_at),
      delivered_with_tool: boundedText(lifecycle.delivered_with_tool, BOUNDS.DELIVERY_TOOL_CHARS),
      acknowledged_at: row.ack_state === "acknowledged" ? iso(row.acknowledged_at) : null,
      reason,
      superseded_by: supersededBy,
    },
    capability: replaceable ? "agent.nudge" : null,
  };
}

function answerText(gateJob, resolution, choiceIds = []) {
  const direct = [resolution.feedback, resolution.operator_feedback, resolution.operator_note]
    .find((value) => typeof value === "string" && value.trim());
  if (direct) return direct;
  const result = parseConversationObject(gateJob.result_json);
  const answers = Array.isArray(result.answers) ? result.answers : [];
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const metadata = answers[index]?.metadata;
    const text = metadata?.operator_feedback || metadata?.operator_note || metadata?.feedback;
    if (typeof text === "string" && text.trim()) return text;
  }
  // A note sent with the choice ("<choice>: note", ask or question.answer).
  if (choiceIds.length > 0) {
    const note = humanInputChoiceFeedback(resolution.answer, choiceIds)
      || humanInputChoiceFeedback(answers.at(-1)?.answer, choiceIds);
    if (note) return note;
  }
  return null;
}

/**
 * A gate the agent (or the system) opened, with the operator's answer as
 * their reply. `gateJob` carries human_gates columns as hg_*.
 */
export function gateEntry({ db, gateJob, observedAt, toolGroupId = null, originalJob = null, acceptedAction = null }) {
  const payload = parseConversationObject(gateJob.payload_json);
  // The feed's question contract for gate:<job>:0. A choice gate asks one
  // joined question there; a multi-question text gate is not answered inline.
  const contract = projectGateQuestionContract(db, {
    ...gateJob,
    human_gate_state: gateJob.hg_gate_state ?? null,
    human_gate_generation: gateJob.hg_generation ?? null,
  }, { questionIndex: 0, observedAt });
  if (!contract) return null;
  const choices = contract.choices
    .map(sanitizeChoiceRecord)
    .filter((choice) => choice && token(choice.choice_id, CHOICE_ID_CHARS))
    .slice(0, BOUNDS.GATE_CHOICES)
    // Whether question.answer may carry a feedback note with this choice.
    .map((choice) => ({ ...choice, accepts_feedback: humanGateActionAcceptsFeedback(contract.kind, choice.choice_id) }));
  const resolution = parseConversationObject(gateJob.hg_resolution_payload_json);
  const resolved = gateJob.hg_gate_state === "resolved" || contract.state === "answered";
  const choiceIds = new Set(choices.map((choice) => choice.choice_id));
  const resolvedChoice = gateJob.hg_resolution_action && choiceIds.has(gateJob.hg_resolution_action)
    ? gateJob.hg_resolution_action
    : acceptedAction?.choice_id && choiceIds.has(acceptedAction.choice_id) ? acceptedAction.choice_id : null;
  const freeText = choices.length === 0 && typeof resolution.answer === "string" ? resolution.answer : null;
  const operatorText = answerText(gateJob, resolution, [...choiceIds]) || freeText;
  const answered = resolved || acceptedAction != null;
  const choiceLabel = resolvedChoice
    ? choices.find((choice) => choice.choice_id === resolvedChoice)?.label || CHOICE_COPY[resolvedChoice]?.[0] || resolvedChoice
    : null;
  const answer = answered && (resolvedChoice || operatorText)
    ? {
        choice_id: token(resolvedChoice, CHOICE_ID_CHARS),
        label: boundedText(choiceLabel, BOUNDS.ANSWER_LABEL_CHARS),
        operator_text: boundedText(operatorText, BOUNDS.ANSWER_TEXT_CHARS),
        answered_at: iso(gateJob.hg_resolved_at || acceptedAction?.answered_at || gateJob.updated_at),
        origin: boundedText(resolution.source || acceptedAction?.origin || "operator", BOUNDS.ORIGIN_CHARS),
      }
    : null;
  const capability = contract.actionable && choices.length > 0 ? "question.answer" : null;
  const askingJobId = id(gateJob.hg_original_job_id);
  return {
    ...common({
      kind: KIND.GATE,
      entryId: `gate:${gateJob.id}`,
      rev: revOf(gateJob.created_at, gateJob.updated_at, gateJob.hg_created_at, gateJob.hg_updated_at, gateJob.hg_resolved_at, acceptedAction?.answered_at),
      occurredAt: gateJob.hg_created_at || gateJob.created_at,
      workItemId: gateJob.work_item_id,
      jobId: askingJobId ?? gateJob.id,
      role: originalJob ? roleForJob(originalJob.job_type) : null,
      actor: askingJobId ? "agent" : "system",
    }),
    gate_job_id: Number(gateJob.id),
    question_id: contract.question_id,
    gate_kind: token(contract.kind),
    title: boundedText(gateJob.title, BOUNDS.GATE_TITLE_CHARS),
    prompt_summary: boundedText(promptFromGatePayload(payload, { fallback: gateJob.title || "" }), BOUNDS.GATE_PROMPT_CHARS),
    state: contract.state,
    input_kind: contract.input_kind,
    choices,
    generation: token(contract.generation),
    capability,
    unavailable_reason: contract.unavailable_reason,
    answer,
    // Inline when question.answer applies; otherwise the gate screen while open.
    cta: capability ? "question.answer" : contract.state === "open" ? "open_gate" : null,
    tool_group_id: toolGroupId,
  };
}

function wireItem(item, tier) {
  if (item.type === "call") return renderCallItem(item, tier);
  // Items may come back from a persisted digest; re-apply the wire bounds.
  if (item.type === "note") return { type: "note", text: boundedText(item.text, BOUNDS.NOTE_CHARS) || "", at: item.at };
  return {
    type: "subagent",
    child_agent_call_id: item.child_agent_call_id,
    child_kind: token(item.child_kind),
    role: boundedText(item.role, BOUNDS.ROLE_CHARS),
    status: token(item.status),
    call_count: item.call_count,
    at: item.at,
  };
}

/** A tool group (live or persisted) rendered for one tier. */
export function toolGroupEntry({ group, tier = AGENT_CONVERSATION_TIER.REMOTE }) {
  const open = group.state === "open";
  return {
    ...common({
      kind: KIND.TOOL_GROUP,
      entryId: group.group_id,
      rev: group.rev,
      occurredAt: open ? group.last_at || group.first_at : group.closed_at,
      workItemId: group.work_item_id,
      jobId: group.job_id,
      attemptId: group.attempt_id,
      agentCallId: group.agent_call_id,
      parentAgentCallId: group.parent_agent_call_id,
      role: group.role,
      actor: "agent",
    }),
    group_id: group.group_id,
    state: group.state,
    closed_by: group.closed_by,
    closing_entry_id: group.closing_entry_id,
    retained: true,
    unattributed: group.unattributed === true,
    call_count: group.call_count,
    failed_count: group.failed_count,
    rejected_count: group.rejected_count,
    running_count: group.running_count,
    first_at: group.first_at,
    last_at: group.last_at,
    by_tool: group.by_tool.map((entry) => ({ tool: entry.tool, count: entry.count })),
    items: group.items.map((item) => wireItem(item, tier)),
    omitted_items: group.omitted_items,
  };
}

/** A finished job whose tool calls were neither snapshotted nor still live. */
export function unretainedToolGroupEntry({ job }) {
  const endedAt = job.finished_at || job.updated_at;
  const groupId = `tools:${job.id}:unretained`;
  return {
    ...common({
      kind: KIND.TOOL_GROUP,
      entryId: groupId,
      rev: revOf(endedAt),
      occurredAt: endedAt,
      workItemId: job.work_item_id,
      jobId: job.id,
      role: roleForJob(job.job_type),
      actor: "agent",
    }),
    group_id: groupId,
    state: "closed",
    closed_by: CLOSER.JOB_END,
    closing_entry_id: null,
    retained: false,
    unattributed: false,
    call_count: 0,
    failed_count: 0,
    rejected_count: 0,
    running_count: 0,
    first_at: null,
    last_at: null,
    by_tool: [],
    items: [],
    omitted_items: 0,
  };
}

function entryBytes(entry) {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/** Keep one entry within maxBytes by shedding its longest bounded parts. */
export function fitConversationEntry(entry, maxBytes = BOUNDS.ENTRY_BYTES) {
  if (entryBytes(entry) <= maxBytes) return entry;
  const next = structuredClone(entry);
  if (next.kind === KIND.TOOL_GROUP) {
    while (next.items.length > 0 && entryBytes(next) > maxBytes) {
      next.items.splice(Math.min(BOUNDS.GROUP_ITEMS_HEAD, next.items.length - 1), 1);
      next.omitted_items += 1;
    }
  }
  const shrink = (holder, key) => {
    while (typeof holder?.[key] === "string" && holder[key].length > 0 && entryBytes(next) > maxBytes) {
      const chars = Array.from(holder[key]);
      holder[key] = `${chars.slice(0, Math.max(0, Math.floor(chars.length * 0.8) - 1)).join("")}…`;
    }
  };
  if (next.kind === KIND.OPERATOR_MESSAGE) shrink(next, "body");
  if (next.kind === KIND.GATE) {
    shrink(next.answer, "operator_text");
    shrink(next, "prompt_summary");
  }
  return entryBytes(next) <= maxBytes ? next : null;
}
