// Pure grouping of one job's tool calls under the agent messages that follow
// them (posse.agent_conversation.v1 §2). No I/O: callers load the rows.
//
// 1. Partition by (job, agent_call_id). A row without a call id joins the one
//    call of its job/attempt running when it started; otherwise it falls into
//    an unattributed (job, attempt) partition. A group never spans partitions.
// 2. Boundaries close a group, in time order: an agent_message of that call,
//    a gate opened while the (top-level) call ran, the call's end, or the
//    attempt's/job's end when the call row is missing.
// 3. A call belongs to the first boundary at or after its start; a call still
//    running when the agent comments folds under that comment. Provider
//    replays recorded at the end of the call land in the call_end group.
// 4. Members after the last boundary of a running call form the open group.
// 5. Messages, receipts and harness rows are excluded; read-not-found is
//    benign; commentary becomes `note` items; child calls become `subagent`
//    items in the parent group and keep their own partition.
import {
  AGENT_CONVERSATION_BENIGN_TOOL_TYPES,
  AGENT_CONVERSATION_BOUNDS as BOUNDS,
  AGENT_CONVERSATION_GROUP_CLOSER as CLOSER,
  AGENT_CONVERSATION_HARNESS_TOOL_SUFFIXES,
  AGENT_CONVERSATION_MESSAGE_TOOL_TYPES,
  AGENT_CONVERSATION_NON_CALL_TOOL_TYPES,
} from "../../../catalog/agent-conversation.js";
import { AGENT_COMMENTARY_OBSERVATION_TYPE, isInternalBackgroundObservationType } from "../../../catalog/observation.js";
import { boundedText, toolCallFacts } from "./tool-call-tiers.js";

const STARTED_SUFFIX = ".started";
const CLOSER_RANK = Object.freeze({
  [CLOSER.AGENT_MESSAGE]: 0,
  [CLOSER.GATE]: 1,
  [CLOSER.CALL_END]: 2,
  [CLOSER.JOB_END]: 3,
});
const TERMINAL_CLOSERS = new Set([CLOSER.CALL_END, CLOSER.JOB_END]);

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function detailObject(row) {
  if (row?.detail && typeof row.detail === "object" && !Array.isArray(row.detail)) return row.detail;
  try {
    const parsed = JSON.parse(String(row?.detail_json ?? "null"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** True for observation types that never become conversation call items. */
export function isExcludedConversationToolType(type) {
  const text = String(type || "");
  const base = text.endsWith(STARTED_SUFFIX) ? text.slice(0, -STARTED_SUFFIX.length) : text;
  if (!base.startsWith("tool.")) return true;
  if (AGENT_CONVERSATION_MESSAGE_TOOL_TYPES.has(base)) return true;
  if (AGENT_CONVERSATION_NON_CALL_TOOL_TYPES.has(base)) return true;
  if (isInternalBackgroundObservationType(base) || isInternalBackgroundObservationType(text)) return true;
  return AGENT_CONVERSATION_HARNESS_TOOL_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function callOutcome(detail) {
  const outcome = String(detail?.outcome || "").trim().toLowerCase();
  if (["succeeded", "failed", "rejected"].includes(outcome)) return outcome;
  const status = String(detail?.status || "").trim().toLowerCase();
  if (["rejected", "denied", "cancelled", "canceled"].includes(status)) return "rejected";
  if (["failed", "error"].includes(status) || detail?.ok === false || detail?.error) return "failed";
  return "succeeded";
}

function childStatus(status) {
  if (status === "running") return "running";
  if (status === "succeeded") return "succeeded";
  return "failed";
}

// Pair `<type>.started` and `<type>` rows by detail.inv into invocations.
function invocationsFrom(rows) {
  const byInv = new Map();
  const singles = [];
  for (const row of rows) {
    const detail = detailObject(row);
    const inv = detail.inv == null ? null : String(detail.inv);
    const started = String(row.observation_type).endsWith(STARTED_SUFFIX);
    if (!inv) {
      if (!started) singles.push({ start: null, finish: { ...row, detail } });
      continue;
    }
    const entry = byInv.get(inv) || { start: null, finish: null };
    if (started) entry.start = entry.start || { ...row, detail };
    else entry.finish = entry.finish || { ...row, detail };
    byInv.set(inv, entry);
  }
  return [...byInv.values(), ...singles];
}

function invocationMember(invocation) {
  const { start, finish } = invocation;
  const primary = finish || start;
  const type = String(finish?.observation_type || String(start.observation_type).slice(0, -STARTED_SUFFIX.length));
  const detail = { ...(start?.detail || {}), ...(finish?.detail || {}) };
  if (type === "tool.agent_handoff" && finish && callOutcome(finish.detail) === "succeeded") return null;
  const facts = toolCallFacts({ observation_type: type, detail });
  if (!facts) return null;
  const durationMs = Number.isFinite(Number(finish?.detail?.duration_ms)) && finish?.detail?.duration_ms != null
    ? Math.max(0, Math.round(Number(finish.detail.duration_ms)))
    : null;
  const finishMs = finish ? timeMs(finish.created_at) : null;
  const startMs = start
    ? timeMs(start.created_at)
    : finishMs == null ? null : finishMs - (durationMs ?? 0);
  const replay = !detail.inv && durationMs == null
    && (detail.provider_call_id != null || detail.recovered_from_provider_rollout === true);
  const ids = [start?.id, finish?.id].map(positiveId).filter(Boolean);
  return {
    kind: "call",
    agentCallId: positiveId(detail.agent_call_id),
    attemptId: positiveId(primary.attempt_id),
    startMs,
    endMs: finishMs,
    firstId: ids.length ? Math.min(...ids) : null,
    lastId: ids.length ? Math.max(...ids) : null,
    replay,
    item: {
      type: "call",
      seq: ids.length ? Math.min(...ids) : 0,
      status: finish ? callOutcome(finish.detail) : "running",
      benign: AGENT_CONVERSATION_BENIGN_TOOL_TYPES.has(type),
      duration_ms: durationMs,
      at: iso(startMs),
      timing: replay ? "end_of_call" : "live",
      facts,
    },
  };
}

function noteMember(row) {
  const detail = detailObject(row);
  const text = boundedText(detail.text, BOUNDS.NOTE_CHARS);
  const atMs = timeMs(row.created_at);
  if (!text || atMs == null) return null;
  const id = positiveId(row.id);
  return {
    kind: "note",
    agentCallId: positiveId(detail.agent_call_id),
    attemptId: positiveId(row.attempt_id),
    startMs: atMs,
    endMs: atMs,
    firstId: id,
    lastId: id,
    replay: false,
    item: { type: "note", seq: id || 0, text, at: iso(atMs) },
  };
}

// Some writers (the embedded Atlas path) record no agent_call_id. Such a row
// belongs to the one agent call of its job (and attempt, when known) that was
// running when it started; with zero or several candidates, including a
// parent and its running child, it stays unattributed. The source rows are
// untouched, so research budgets and replay reconciliation, which key on
// detail.agent_call_id, count exactly what they counted before.
function soleRunningCall(member, calls) {
  if (member.startMs == null) return null;
  const candidates = calls.filter((call) => {
    if (member.attemptId != null && positiveId(call.attempt_id) != null && positiveId(call.attempt_id) !== member.attemptId) return false;
    const startMs = timeMs(call.started_at);
    const endMs = timeMs(call.finished_at);
    return startMs != null && startMs <= member.startMs && (endMs == null || member.startMs <= endMs);
  });
  return candidates.length === 1 ? Number(candidates[0].id) : null;
}

function partitionToken(member) {
  return member.agentCallId != null ? String(member.agentCallId) : `a${member.attemptId ?? 0}`;
}

function sortBoundaries(boundaries) {
  return boundaries.sort((left, right) => (left.atMs - right.atMs)
    || (CLOSER_RANK[left.closedBy] - CLOSER_RANK[right.closedBy])
    || String(left.closingEntryId).localeCompare(String(right.closingEntryId), "en", { numeric: true }));
}

function boundaryIndexFor(member, boundaries) {
  const closedPartition = boundaries.length > 0 && TERMINAL_CLOSERS.has(boundaries.at(-1).closedBy);
  if (member.replay && closedPartition) return boundaries.length - 1;
  const index = boundaries.findIndex((boundary) => boundary.atMs >= (member.startMs ?? Number.POSITIVE_INFINITY));
  if (index >= 0) return index;
  return closedPartition ? boundaries.length - 1 : boundaries.length;
}

function byToolCounts(calls) {
  const counts = new Map();
  for (const call of calls) counts.set(call.item.facts.tool, (counts.get(call.item.facts.tool) || 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))
    .slice(0, BOUNDS.GROUP_BY_TOOL)
    .map(([tool, count]) => ({ tool, count }));
}

function cappedItems(members) {
  const items = members.map((member) => member.item);
  if (items.length <= BOUNDS.GROUP_ITEMS) return { items, omitted: 0 };
  return {
    items: [...items.slice(0, BOUNDS.GROUP_ITEMS_HEAD), ...items.slice(-BOUNDS.GROUP_ITEMS_TAIL)],
    omitted: items.length - BOUNDS.GROUP_ITEMS_HEAD - BOUNDS.GROUP_ITEMS_TAIL,
  };
}

function buildGroup({ job, partition, seq, boundary, members }) {
  const ordered = [...members].sort((left, right) => ((left.startMs ?? 0) - (right.startMs ?? 0))
    || (left.item.seq - right.item.seq));
  const calls = ordered.filter((member) => member.kind === "call");
  const times = ordered.flatMap((member) => [member.startMs, member.endMs]).filter((value) => value != null);
  const ids = ordered.flatMap((member) => [member.firstId, member.lastId]).filter((value) => value != null);
  const { items, omitted } = cappedItems(ordered);
  const revCandidates = [...times, boundary?.atMs].filter((value) => value != null);
  return {
    group_id: `tools:${job.id}:${partition.token}:${seq}`,
    job_id: Number(job.id),
    work_item_id: positiveId(job.work_item_id),
    attempt_id: partition.attemptId,
    agent_call_id: partition.agentCallId,
    parent_agent_call_id: partition.parentAgentCallId,
    role: partition.role,
    partition_key: partition.token,
    unattributed: partition.agentCallId == null,
    group_seq: seq,
    state: boundary ? "closed" : "open",
    closed_by: boundary?.closedBy ?? null,
    closing_entry_id: boundary?.closingEntryId ?? null,
    closed_at: boundary ? iso(boundary.atMs) : null,
    first_observation_id: ids.length ? Math.min(...ids) : null,
    last_observation_id: ids.length ? Math.max(...ids) : null,
    first_at: times.length ? iso(Math.min(...times)) : null,
    last_at: times.length ? iso(Math.max(...times)) : null,
    call_count: calls.length,
    failed_count: calls.filter((call) => call.item.status === "failed" && !call.item.benign).length,
    rejected_count: calls.filter((call) => call.item.status === "rejected").length,
    running_count: calls.filter((call) => call.item.status === "running").length,
    member_count: ordered.length,
    by_tool: byToolCounts(calls),
    items,
    omitted_items: omitted,
    rev: revCandidates.length ? Math.max(...revCandidates) : 0,
  };
}

/**
 * Group one job's conversation tool rows.
 *
 * @param {{
 *   job: {id:number, work_item_id?:number|null, job_type?:string, status?:string, terminal?:boolean, ended_at?:string|null},
 *   calls?: Array<{id:number, attempt_id?:number|null, parent_agent_call_id?:number|null, child_kind?:string|null, role?:string|null, status?:string, started_at?:string, finished_at?:string|null}>,
 *   attempts?: Array<{id:number, started_at?:string, finished_at?:string|null}>,
 *   observations?: Array<{id?:number, attempt_id?:number|null, observation_type:string, detail?:object, detail_json?:string, created_at:string}>,
 *   messages?: Array<{id:number, agent_call_id?:number|null, attempt_id?:number|null, created_at:string}>,
 *   gates?: Array<{gate_job_id:number, created_at:string}>,
 * }} input
 */
export function groupJobConversation({
  job,
  calls = [],
  attempts = [],
  observations = [],
  messages = [],
  gates = [],
} = {}) {
  const callById = new Map(calls.map((call) => [Number(call.id), call]));
  const attemptById = new Map(attempts.map((attempt) => [Number(attempt.id), attempt]));
  const jobEndMs = job?.terminal ? timeMs(job.ended_at) : null;

  const toolRows = [];
  const noteRows = [];
  for (const row of observations) {
    const type = String(row?.observation_type || "");
    if (type === AGENT_COMMENTARY_OBSERVATION_TYPE) noteRows.push(row);
    else if (!isExcludedConversationToolType(type)) toolRows.push(row);
  }
  const members = [
    ...invocationsFrom(toolRows).map(invocationMember),
    ...noteRows.map(noteMember),
  ].filter(Boolean);
  for (const member of members) {
    if (member.agentCallId == null) member.agentCallId = soleRunningCall(member, calls);
  }

  const partitions = new Map();
  const partitionFor = (token, seed) => {
    if (!partitions.has(token)) partitions.set(token, { token, members: [], ...seed });
    return partitions.get(token);
  };
  for (const call of calls) {
    partitionFor(String(call.id), {
      agentCallId: Number(call.id),
      attemptId: positiveId(call.attempt_id),
      parentAgentCallId: positiveId(call.parent_agent_call_id),
      role: call.role || null,
      call,
    });
  }
  for (const member of members) {
    const token = partitionToken(member);
    const known = member.agentCallId != null ? callById.get(member.agentCallId) : null;
    partitionFor(token, {
      agentCallId: member.agentCallId,
      attemptId: known ? positiveId(known.attempt_id) : member.attemptId,
      parentAgentCallId: known ? positiveId(known.parent_agent_call_id) : null,
      role: known?.role || null,
      call: known || null,
    }).members.push(member);
  }
  // Child calls surface as one `subagent` item inside the parent's partition.
  for (const call of calls) {
    const parentId = positiveId(call.parent_agent_call_id);
    if (!parentId || !partitions.has(String(parentId))) continue;
    const startMs = timeMs(call.started_at);
    const ownCalls = partitions.get(String(call.id))?.members.filter((member) => member.kind === "call").length || 0;
    partitions.get(String(parentId)).members.push({
      kind: "subagent",
      agentCallId: parentId,
      attemptId: positiveId(call.attempt_id),
      startMs,
      endMs: timeMs(call.finished_at),
      firstId: null,
      lastId: null,
      replay: false,
      item: {
        type: "subagent",
        seq: 0,
        child_agent_call_id: Number(call.id),
        child_kind: call.child_kind || null,
        role: call.role || null,
        status: childStatus(call.status),
        call_count: ownCalls,
        at: iso(startMs),
      },
    });
  }

  const groups = [];
  const messageGroupIds = new Map();
  const gateGroupIds = new Map();
  for (const partition of partitions.values()) {
    const call = partition.call;
    const boundaries = [];
    for (const message of messages) {
      const messageCall = positiveId(message.agent_call_id);
      const belongs = partition.agentCallId != null
        ? messageCall === partition.agentCallId
        : messageCall == null && (positiveId(message.attempt_id) ?? null) === (partition.attemptId ?? null);
      const atMs = timeMs(message.created_at);
      if (belongs && atMs != null) {
        boundaries.push({ atMs, closedBy: CLOSER.AGENT_MESSAGE, closingEntryId: `msg:${message.id}`, messageId: Number(message.id) });
      }
    }
    const windowStart = call ? timeMs(call.started_at) : timeMs(attemptById.get(partition.attemptId)?.started_at);
    const windowEnd = call ? timeMs(call.finished_at) : timeMs(attemptById.get(partition.attemptId)?.finished_at);
    if (!partition.parentAgentCallId) {
      for (const gate of gates) {
        const atMs = timeMs(gate.created_at);
        if (atMs == null || windowStart == null || atMs < windowStart || (windowEnd != null && atMs > windowEnd)) continue;
        boundaries.push({ atMs, closedBy: CLOSER.GATE, closingEntryId: `gate:${gate.gate_job_id}`, gateJobId: Number(gate.gate_job_id) });
      }
    }
    if (call && call.status !== "running" && timeMs(call.finished_at) != null) {
      boundaries.push({ atMs: timeMs(call.finished_at), closedBy: CLOSER.CALL_END, closingEntryId: null });
    } else if (call && jobEndMs != null) {
      // A call row left running by a crash ends with its terminal job.
      boundaries.push({ atMs: jobEndMs, closedBy: CLOSER.JOB_END, closingEntryId: null });
    } else if (!call) {
      const endMs = timeMs(attemptById.get(partition.attemptId)?.finished_at) ?? jobEndMs;
      if (endMs != null) boundaries.push({ atMs: endMs, closedBy: CLOSER.JOB_END, closingEntryId: null });
    }
    sortBoundaries(boundaries);
    // Nothing closes after a terminal boundary.
    const terminalIndex = boundaries.findIndex((boundary) => TERMINAL_CLOSERS.has(boundary.closedBy));
    if (terminalIndex >= 0) boundaries.splice(terminalIndex + 1);

    const buckets = Array.from({ length: boundaries.length + 1 }, () => []);
    for (const member of partition.members) buckets[boundaryIndexFor(member, boundaries)].push(member);
    boundaries.forEach((boundary, seq) => {
      const group = buildGroup({ job, partition, seq, boundary, members: buckets[seq] });
      groups.push(group);
      if (boundary.messageId != null) messageGroupIds.set(boundary.messageId, group);
      if (boundary.gateJobId != null && !gateGroupIds.has(boundary.gateJobId)) gateGroupIds.set(boundary.gateJobId, group);
    });
    if (buckets[boundaries.length].length > 0) {
      groups.push(buildGroup({ job, partition, seq: boundaries.length, boundary: null, members: buckets[boundaries.length] }));
    }
  }
  groups.sort((left, right) => String(left.closed_at || left.last_at || "").localeCompare(String(right.closed_at || right.last_at || ""))
    || left.group_id.localeCompare(right.group_id, "en", { numeric: true }));
  return {
    groups,
    messageGroups: messageGroupIds,
    gateGroups: gateGroupIds,
    hasCallRows: members.some((member) => member.kind === "call"),
  };
}

/** A group worth showing: at least one call, note, or sub-agent. */
export function isVisibleToolGroup(group) {
  return Number(group?.member_count || 0) > 0;
}
