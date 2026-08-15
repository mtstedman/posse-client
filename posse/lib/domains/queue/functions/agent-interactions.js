// Durable operator/agent interaction channel used by Monitor Agents.
//
// A nudge is durable guidance scoped to a job. Feedback pending before a
// provider starts is included in its prompt and recorded as delivered. New
// feedback that arrives mid-run is delivered through the live tool channel
// and must be explicitly acknowledged by the agent.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { OPERATOR_FEEDBACK_DELIVERY_PROTOCOL } from "../../../catalog/operator-feedback.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { logAgentActivity, logEvent } from "./events.js";
import { now, runImmediateTransaction } from "./common.js";
import { notifyQueueStateChanged } from "./wakeups.js";

const USER_TO_AGENT = "user_to_agent";
const AGENT_TO_USER = "agent_to_user";

const ACTIVE_STATUSES = new Set(["active"]);
const USER_GUIDANCE_KINDS = new Set(["nudge", "answer", "scope_request", "status_request"]);
const ACK_DECISIONS = new Set(["accepted", "rejected", "deferred"]);
const AGENT_FEEDBACK_PHASES = new Set([
  "reading", "planning", "editing", "testing", "verifying", "blocked", "finalizing", "handoff",
]);
const AGENT_FEEDBACK_STATUSES = new Set(["running", "blocked", "waiting", "verifying", "done"]);
const AGENT_FEEDBACK_SUMMARY_MAX_CHARS = 180;
const AGENT_FEEDBACK_DETAIL_MAX_CHARS = 360;

// Identical consecutive activity pings within this window are coalesced into the
// most recent row instead of inserting a new interaction + event + wakeup.
const ACTIVITY_COALESCE_WINDOW_MS = 3000;

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInt(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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

function metadataObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function activityProtocolState(metadata = {}) {
  const raw = String(metadata.status || metadata.action || "running").trim().toLowerCase();
  if (["done", "complete", "completed", "succeeded", "success"].includes(raw)) {
    return { kind: "result", status: "succeeded" };
  }
  if (["failed", "failure", "error"].includes(raw)) return { kind: "error", status: "failed" };
  if (["canceled", "cancelled"].includes(raw)) return { kind: "result", status: "canceled" };
  if (["blocked", "waiting"].includes(raw)) return { kind: "progress", status: "waiting" };
  return { kind: "progress", status: "running" };
}

function scalarLength(value) {
  return Array.from(String(value ?? "")).length;
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    work_item_id: row.work_item_id == null ? null : Number(row.work_item_id),
    job_id: row.job_id == null ? null : Number(row.job_id),
    attempt_id: row.attempt_id == null ? null : Number(row.attempt_id),
    agent_call_id: row.agent_call_id == null ? null : Number(row.agent_call_id),
    parent_id: row.parent_id == null ? null : Number(row.parent_id),
  };
}

function guidanceEventType(kind) {
  if (kind === "nudge") return EVENT_TYPES.OPERATOR_NUDGE_CREATED;
  if (kind === "question") return EVENT_TYPES.AGENT_QUESTION_CREATED;
  if (kind === "answer") return EVENT_TYPES.AGENT_QUESTION_ANSWERED;
  return EVENT_TYPES.AGENT_INTERACTION_CREATED;
}

function applicationEventType(kind) {
  if (kind === "nudge") return EVENT_TYPES.OPERATOR_NUDGE_APPLIED;
  return EVENT_TYPES.AGENT_INTERACTION_APPLIED;
}

function interactionLabel(row) {
  if (row.kind === "nudge") return "nudge";
  if (row.kind === "answer") return "answer";
  if (row.kind === "scope_request") return "scope";
  if (row.kind === "status_request") return "status";
  return row.kind || "guidance";
}

function formatGuidanceRows(rows) {
  const usable = (rows || [])
    .filter((row) => row && row.direction === USER_TO_AGENT && USER_GUIDANCE_KINDS.has(row.kind))
    .filter((row) => ACTIVE_STATUSES.has(row.status) || row.status === "answered")
    .filter((row) => normalizeText(row.body));

  if (usable.length === 0) return "";

  const lines = usable.map((row) => {
    const label = interactionLabel(row);
    const source = row.source ? ` from ${row.source}` : "";
    return `- [${label} #${row.id}${source}] ${normalizeText(row.body)}`;
  });

  return [
    "OPERATOR GUIDANCE (available at startup; apply before continuing):",
    "These startup items are already recorded as delivered. Mid-run feedback is attached directly to a later tool result and must be acknowledged there.",
    ...lines,
    "",
  ].join("\n");
}

function selectActiveGuidance(db, { job_id, nowIso }) {
  return db.prepare(`
    SELECT *
    FROM agent_interactions
    WHERE job_id = ?
      AND direction = 'user_to_agent'
      AND kind IN ('nudge','answer','scope_request','status_request')
      AND status IN ('active','answered')
      AND blocking_policy IN ('checkpoint','wait')
      AND (ack_state = 'pending' OR (ack_state = 'acknowledged' AND ack_decision IS NULL))
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at ASC, id ASC
  `).all(job_id, nowIso).map(normalizeRow);
}

function selectPendingOperatorFeedback(db, { job_id, nowIso, limit = 20 }) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));
  return db.prepare(`
    SELECT *
    FROM agent_interactions
    WHERE job_id = ?
      AND direction = 'user_to_agent'
      AND kind IN ('nudge','answer','scope_request','status_request')
      AND status IN ('active','answered')
      AND blocking_policy IN ('checkpoint','wait')
      AND ack_state = 'pending'
      AND ack_decision IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(job_id, nowIso, safeLimit).map(normalizeRow);
}

function feedbackToolPayload(row) {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source || null,
    author: row.author || null,
    body: row.body || "",
    created_at: row.created_at || null,
    work_item_id: row.work_item_id,
    job_id: row.job_id,
  };
}

function retrievedMetadataJson(row, retrievedAt) {
  const metadata = metadataObject(row.metadata_json);
  const lifecycle = metadata.nudge_lifecycle || {};
  metadata.nudge_lifecycle = {
    ...lifecycle,
    retrieved_at: lifecycle.retrieved_at || retrievedAt,
    last_retrieved_at: retrievedAt,
    delivery_count: Math.max(0, Number(lifecycle.delivery_count) || 0) + 1,
  };
  return JSON.stringify(metadata);
}

export function createAgentInteraction({
  work_item_id = null,
  job_id = null,
  attempt_id = null,
  agent_call_id = null,
  parent_id = null,
  direction,
  kind,
  blocking_policy = "none",
  status = "active",
  source = null,
  author = null,
  body = null,
  metadata_json = null,
  ack_state = "pending",
  expires_at = null,
} = {}) {
  const normalizedBody = normalizeText(body);
  if (!direction) throw new Error("createAgentInteraction requires direction");
  if (!kind) throw new Error("createAgentInteraction requires kind");
  if ((kind === "nudge" || kind === "question" || kind === "answer") && !normalizedBody) {
    throw new Error(`createAgentInteraction requires body for ${kind}`);
  }

  const db = getDb();
  const createdAt = now();
  const info = db.prepare(`
    INSERT INTO agent_interactions (
      work_item_id, job_id, attempt_id, agent_call_id, parent_id,
      direction, kind, blocking_policy, status, source, author, body,
      metadata_json, ack_state, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizePositiveInt(work_item_id),
    normalizePositiveInt(job_id),
    normalizePositiveInt(attempt_id),
    normalizePositiveInt(agent_call_id),
    normalizePositiveInt(parent_id),
    direction,
    kind,
    blocking_policy,
    status,
    source == null ? null : String(source),
    author == null ? null : String(author),
    normalizedBody || null,
    normalizeJsonText(metadata_json),
    ack_state,
    expires_at == null ? null : String(expires_at),
    createdAt,
    createdAt,
  );
  const row = normalizeRow(db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(info.lastInsertRowid));

  if (kind === "activity" && direction === AGENT_TO_USER) {
    const metadata = metadataObject(metadata_json);
    const protocolState = activityProtocolState(metadata);
    logAgentActivity({
      work_item_id: row.work_item_id,
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      role: metadata.role || EVENT_ACTORS.WORKER,
      actor_id: String(row.id),
      kind: protocolState.kind,
      status: protocolState.status,
      phase: metadata.phase || null,
      summary: normalizedBody,
      detail: metadata.detail || null,
      agent_call_id: row.agent_call_id,
      provider: metadata.provider || null,
      model: metadata.model || null,
    });
  } else {
    logEvent({
      work_item_id: row.work_item_id,
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      event_type: guidanceEventType(kind),
      actor_type: direction === AGENT_TO_USER ? EVENT_ACTORS.WORKER : EVENT_ACTORS.HUMAN,
      message: `${kind} #${row.id}: ${normalizedBody.slice(0, 200)}`,
      event_json: {
        interaction_id: row.id,
        direction,
        kind,
        blocking_policy,
        status,
        source,
        parent_id: row.parent_id,
      },
    });
  }
  notifyQueueStateChanged({ reason: "agent_interaction_created", jobId: row.job_id, workItemId: row.work_item_id });
  return row;
}

// Retire any other active nudges for a job so the requeue path injects a single
// authoritative guidance set ("latest correction wins") rather than an
// ever-growing stack that can never leave the 'active' status.
function supersedePriorActiveNudges({ jobId, exceptId } = {}) {
  const normalizedJobId = normalizePositiveInt(jobId);
  if (!normalizedJobId) return [];
  const keepId = normalizePositiveInt(exceptId, 0);
  const db = getDb();
  const priors = db.prepare(`
    SELECT id, work_item_id, job_id
    FROM agent_interactions
    WHERE job_id = ?
      AND id != ?
      AND direction = 'user_to_agent'
      AND kind = 'nudge'
      AND status = 'active'
  `).all(normalizedJobId, keepId).map(normalizeRow);
  if (priors.length === 0) return [];

  const nowIso = now();
  const update = db.prepare(`
    UPDATE agent_interactions
    SET status = 'superseded', updated_at = ?
    WHERE id = ?
  `);
  for (const prior of priors) {
    update.run(nowIso, prior.id);
    logEvent({
      work_item_id: prior.work_item_id,
      job_id: prior.job_id,
      event_type: EVENT_TYPES.OPERATOR_NUDGE_EXPIRED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: `Nudge #${prior.id} superseded by #${keepId}`,
      event_json: { interaction_id: prior.id, reason: "superseded", superseded_by: keepId },
    });
  }
  notifyQueueStateChanged({
    reason: "operator_nudge_superseded",
    jobId: normalizedJobId,
    workItemId: priors[0]?.work_item_id ?? null,
  });
  return priors;
}

// Operator paste can be arbitrarily large; the nudge body is delivered
// verbatim into tool payloads, so cap it the same way agent activity is.
const OPERATOR_NUDGE_BODY_MAX_CHARS = 4000;

export function createOperatorNudge({
  work_item_id = null,
  job_id,
  agent_call_id = null,
  body,
  source = "terminal",
  author = "operator",
  metadata_json = null,
  expires_at = null,
} = {}) {
  const boundedBody = normalizeText(body);
  if (!boundedBody) throw new Error("createOperatorNudge requires body");
  if (scalarLength(boundedBody) > OPERATOR_NUDGE_BODY_MAX_CHARS) {
    throw new Error(`createOperatorNudge body exceeds ${OPERATOR_NUDGE_BODY_MAX_CHARS} characters`);
  }
  // Insert + supersede atomically: a concurrent result delivery in the gap
  // would attach BOTH the old and new guidance ("latest correction
  // wins" briefly violated), and a crash mid-supersede leaves two actives.
  const row = runImmediateTransaction(getDb(), () => {
    const created = createAgentInteraction({
      work_item_id,
      job_id,
      agent_call_id,
      direction: USER_TO_AGENT,
      kind: "nudge",
      blocking_policy: "checkpoint",
      status: "active",
      source,
      author,
      body: boundedBody,
      metadata_json,
      expires_at,
    });
    supersedePriorActiveNudges({ jobId: created.job_id, exceptId: created.id });
    return created;
  });
  return row;
}

export function createAgentQuestion({
  work_item_id = null,
  job_id,
  attempt_id = null,
  agent_call_id = null,
  body,
  source = "agent",
  author = "agent",
  metadata_json = null,
  expires_at = null,
} = {}) {
  return createAgentInteraction({
    work_item_id,
    job_id,
    attempt_id,
    agent_call_id,
    direction: AGENT_TO_USER,
    kind: "question",
    blocking_policy: "wait",
    status: "active",
    source,
    author,
    body,
    metadata_json,
    expires_at,
  });
}

export function recordAgentActivity({
  work_item_id = null,
  job_id,
  attempt_id = null,
  agent_call_id = null,
  phase = null,
  action = null,
  status = null,
  body = null,
  role = null,
  detail = null,
  provider = null,
  model = null,
  source = "agent",
  metadata_json = null,
} = {}) {
  const phaseText = normalizeText(phase);
  const actionText = normalizeText(action);
  const statusText = normalizeText(status || action || "running");
  const bodyText = normalizeText(body) || [phaseText, actionText || statusText].filter(Boolean).join(": ");
  const detailText = normalizeText(detail);
  const typedFeedback = new Set(["agent_feedback", "embedded_tool", "mcp_tool"]).has(normalizeText(source));
  if (typedFeedback && !AGENT_FEEDBACK_PHASES.has(phaseText)) {
    throw new Error("recordAgentActivity requires a valid phase");
  }
  if (typedFeedback && !AGENT_FEEDBACK_STATUSES.has(statusText)) {
    throw new Error("recordAgentActivity requires a valid status");
  }
  if (!bodyText) throw new Error("recordAgentActivity requires phase, action, or body");
  if (typedFeedback && scalarLength(bodyText) > AGENT_FEEDBACK_SUMMARY_MAX_CHARS) {
    throw new Error(`recordAgentActivity summary must be 1..${AGENT_FEEDBACK_SUMMARY_MAX_CHARS} characters`);
  }
  if (scalarLength(detailText) > AGENT_FEEDBACK_DETAIL_MAX_CHARS) {
    throw new Error(`recordAgentActivity detail exceeds ${AGENT_FEEDBACK_DETAIL_MAX_CHARS} characters`);
  }
  const activityBody = bodyText.slice(0, 500);
  const suppliedMetadata = metadataObject(metadata_json);
  const activityMetadata = {
    ...suppliedMetadata,
    phase: phaseText || null,
    action: actionText || statusText || null,
    status: statusText || null,
    role: normalizeText(role) || normalizeText(suppliedMetadata.role) || null,
    detail: detailText || null,
    provider: normalizeText(provider) || normalizeText(suppliedMetadata.provider) || null,
    model: normalizeText(model) || normalizeText(suppliedMetadata.model) || null,
  };

  // Coalesce a chatty agent re-sending the same update: a repeated identical
  // protocol event within the window returns the existing row instead of
  // spending another insert + event + scheduler wakeup. Body text alone is not
  // enough: a terminal result may intentionally reuse its progress summary.
  const activityJobId = normalizePositiveInt(job_id);
  if (activityJobId) {
    const recent = normalizeRow(getDb().prepare(`
      SELECT *
      FROM agent_interactions
      WHERE job_id = ? AND direction = 'agent_to_user' AND kind = 'activity'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(activityJobId));
    const recentMetadata = metadataObject(recent?.metadata_json);
    const recentProtocolState = activityProtocolState(recentMetadata);
    const nextProtocolState = activityProtocolState(activityMetadata);
    const sameProtocolEvent = recent
      && recent.body === activityBody
      && normalizePositiveInt(recent.attempt_id) === normalizePositiveInt(attempt_id)
      && normalizePositiveInt(recent.agent_call_id) === normalizePositiveInt(agent_call_id)
      && normalizeText(recent.source) === normalizeText(source)
      && normalizeText(recentMetadata.phase) === normalizeText(activityMetadata.phase)
      && normalizeText(recentMetadata.role) === normalizeText(activityMetadata.role)
      && normalizeText(recentMetadata.detail) === normalizeText(activityMetadata.detail)
      && normalizeText(recentMetadata.provider) === normalizeText(activityMetadata.provider)
      && normalizeText(recentMetadata.model) === normalizeText(activityMetadata.model)
      // Raw action/status too, not just the bucketed protocol state: distinct
      // transitions inside one bucket (e.g. running -> verifying) are real
      // protocol events and must not coalesce.
      && normalizeText(recentMetadata.action) === normalizeText(activityMetadata.action)
      && normalizeText(recentMetadata.status) === normalizeText(activityMetadata.status)
      && recentProtocolState.kind === nextProtocolState.kind
      && recentProtocolState.status === nextProtocolState.status;
    if (sameProtocolEvent) {
      const ageMs = Date.now() - Date.parse(recent.created_at || "");
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ACTIVITY_COALESCE_WINDOW_MS) {
        return recent;
      }
    }
  }

  return createAgentInteraction({
    work_item_id,
    job_id,
    attempt_id,
    agent_call_id,
    direction: AGENT_TO_USER,
    kind: "activity",
    blocking_policy: "none",
    status: "applied",
    source,
    author: "agent",
    body: activityBody,
    metadata_json: activityMetadata,
    ack_state: "not_applicable",
  });
}

export function answerAgentQuestion({
  question_id,
  body,
  source = "terminal",
  author = "operator",
} = {}) {
  const db = getDb();
  const question = normalizeRow(db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(normalizePositiveInt(question_id, 0)));
  if (!question || question.kind !== "question") return null;
  const answer = createAgentInteraction({
    work_item_id: question.work_item_id,
    job_id: question.job_id,
    parent_id: question.id,
    direction: USER_TO_AGENT,
    kind: "answer",
    blocking_policy: "checkpoint",
    status: "active",
    source,
    author,
    body,
    metadata_json: { question_id: question.id },
  });
  db.prepare(`
    UPDATE agent_interactions
    SET status = 'answered', answered_at = ?, updated_at = ?
    WHERE id = ?
  `).run(now(), now(), question.id);
  notifyQueueStateChanged({ reason: "agent_question_answered", jobId: question.job_id, workItemId: question.work_item_id });
  return answer;
}

export function applyActiveAgentInteractionsForAttempt({
  job_id,
  attempt_id = null,
  agent_call_id = null,
  limit = 20,
  first_delivery_only = false,
} = {}) {
  const jobId = normalizePositiveInt(job_id);
  if (!jobId) return [];
  const attemptId = normalizePositiveInt(attempt_id);
  const agentCallId = normalizePositiveInt(agent_call_id);
  const db = getDb();
  const nowIso = now();

  if (!attemptId) {
    const candidates = selectPendingOperatorFeedback(db, { job_id: jobId, nowIso, limit });
    if (candidates.length > 0) {
      const update = db.prepare(`
        UPDATE agent_interactions
        SET first_applied_at = COALESCE(first_applied_at, ?),
            last_applied_at = ?,
            updated_at = ?
        WHERE id = ?
      `);
      const updateMetadata = db.prepare(`
        UPDATE agent_interactions SET metadata_json = ? WHERE id = ?
      `);
      for (const row of candidates) {
        update.run(nowIso, nowIso, nowIso, row.id);
        updateMetadata.run(retrievedMetadataJson(row, nowIso), row.id);
      }
    }
    return candidates;
  }

  const applied = runImmediateTransaction(db, () => {
    let candidates = selectPendingOperatorFeedback(db, {
      job_id: jobId,
      nowIso,
      // Direct delivery must advance past already-delivered, unacknowledged
      // items when more than one result-sized batch is pending.
      limit: first_delivery_only ? 100 : limit,
    });
    if (first_delivery_only) {
      const alreadyDelivered = new Set(db.prepare(`
        SELECT interaction_id
        FROM agent_interaction_applications
        WHERE attempt_id = ?
      `).all(attemptId).map((row) => Number(row.interaction_id)));
      const safeLimit = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));
      candidates = candidates
        .filter((row) => !alreadyDelivered.has(row.id))
        .slice(0, safeLimit);
    }
    const insert = db.prepare(`
      INSERT OR IGNORE INTO agent_interaction_applications (
        interaction_id, work_item_id, job_id, attempt_id, agent_call_id, applied_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, 'included')
    `);
    const update = db.prepare(`
      UPDATE agent_interactions
      SET first_applied_at = COALESCE(first_applied_at, ?),
          last_applied_at = ?,
          updated_at = ?
      WHERE id = ?
    `);
    const updateMetadata = db.prepare(`
      UPDATE agent_interactions SET metadata_json = ? WHERE id = ?
    `);
    const rows = [];
    for (const row of candidates) {
      // The application row is a delivery AUDIT, not a delivery gate: an item
      // stays recoverable until it is acknowledged. Direct delivery filters
      // this audit state separately so normal tool results get one copy while
      // the internal recovery getter can still re-read an unacked item.
      const info = insert.run(row.id, row.work_item_id, row.job_id, attemptId, agentCallId, nowIso);
      update.run(nowIso, nowIso, nowIso, row.id);
      updateMetadata.run(retrievedMetadataJson(row, nowIso), row.id);
      rows.push({ row, firstDelivery: info.changes > 0 });
    }
    return rows;
  });

  for (const { row, firstDelivery } of applied) {
    if (!firstDelivery) continue;
    logEvent({
      work_item_id: row.work_item_id,
      job_id: row.job_id,
      attempt_id: attemptId,
      event_type: applicationEventType(row.kind),
      actor_type: EVENT_ACTORS.WORKER,
      message: `Delivered ${interactionLabel(row)} #${row.id} to attempt #${attemptId}`,
      event_json: {
        interaction_id: row.id,
        kind: row.kind,
        agent_call_id: agentCallId,
        live_channel: true,
      },
    });
  }
  if (applied.some((entry) => entry.firstDelivery)) {
    notifyQueueStateChanged({ reason: "agent_interactions_applied", jobId, workItemId: applied[0]?.row?.work_item_id ?? null });
  }
  return applied
    .filter((entry) => !first_delivery_only || entry.firstDelivery)
    .map((entry) => entry.row);
}

function applyOperatorGuidanceToPrompt({
  job_id,
  attempt_id,
  agent_call_id = null,
} = {}) {
  const jobId = normalizePositiveInt(job_id);
  const attemptId = normalizePositiveInt(attempt_id);
  if (!jobId || !attemptId) return [];
  const agentCallId = normalizePositiveInt(agent_call_id);
  const db = getDb();
  const nowIso = now();

  const applied = runImmediateTransaction(db, () => {
    // Select and acknowledge in the same transaction so feedback arriving
    // during prompt assembly cannot be consumed without appearing in the
    // returned prompt text.
    const active = selectActiveGuidance(db, { job_id: jobId, nowIso });
    const insert = db.prepare(`
      INSERT OR IGNORE INTO agent_interaction_applications (
        interaction_id, work_item_id, job_id, attempt_id, agent_call_id, applied_at, result
      ) VALUES (?, ?, ?, ?, ?, ?, 'included')
    `);
    const update = db.prepare(`
      UPDATE agent_interactions
      SET ack_state = CASE WHEN ack_state = 'pending' THEN 'acknowledged' ELSE ack_state END,
          acknowledged_at = CASE
            WHEN ack_state = 'pending' THEN COALESCE(acknowledged_at, ?)
            ELSE acknowledged_at
          END,
          first_applied_at = COALESCE(first_applied_at, ?),
          last_applied_at = ?,
          updated_at = ?
      WHERE id = ?
    `);
    return active.map((row) => {
      const info = insert.run(row.id, row.work_item_id, row.job_id, attemptId, agentCallId, nowIso);
      update.run(nowIso, nowIso, nowIso, nowIso, row.id);
      return { row, firstDelivery: info.changes > 0 };
    });
  });

  for (const { row, firstDelivery } of applied) {
    if (!firstDelivery) continue;
    logEvent({
      work_item_id: row.work_item_id,
      job_id: row.job_id,
      attempt_id: attemptId,
      event_type: applicationEventType(row.kind),
      actor_type: EVENT_ACTORS.WORKER,
      message: `Included ${interactionLabel(row)} #${row.id} in startup prompt for attempt #${attemptId}`,
      event_json: {
        interaction_id: row.id,
        kind: row.kind,
        agent_call_id: agentCallId,
        prompt_delivery: true,
      },
    });
  }
  if (applied.some((entry) => entry.firstDelivery)) {
    notifyQueueStateChanged({ reason: "agent_interactions_applied", jobId, workItemId: applied[0]?.row?.work_item_id ?? null });
  }
  return applied.map((entry) => entry.row);
}

export function buildOperatorGuidanceForAttempt({
  job_id,
  attempt_id = null,
  agent_call_id = null,
} = {}) {
  const jobId = normalizePositiveInt(job_id);
  if (!jobId) return "";
  const attemptId = normalizePositiveInt(attempt_id);
  const rows = attemptId
    ? applyOperatorGuidanceToPrompt({ job_id: jobId, attempt_id: attemptId, agent_call_id })
    : selectActiveGuidance(getDb(), { job_id: jobId, nowIso: now() });
  return formatGuidanceRows(rows);
}

export function hasPendingOperatorFeedbackForJob(jobId) {
  const normalizedJobId = normalizePositiveInt(jobId);
  if (!normalizedJobId) return false;
  const row = getDb().prepare(`
    SELECT id
    FROM agent_interactions
    WHERE job_id = ?
      AND direction = 'user_to_agent'
      AND kind IN ('nudge','answer','scope_request','status_request')
      AND status IN ('active','answered')
      AND blocking_policy IN ('checkpoint','wait')
      AND ack_state = 'pending'
      AND ack_decision IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1
  `).get(normalizedJobId, now());
  return !!row;
}

export function countPendingOperatorFeedbackForJob(jobId) {
  const normalizedJobId = normalizePositiveInt(jobId);
  if (!normalizedJobId) return 0;
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM agent_interactions
    WHERE job_id = ?
      AND direction = 'user_to_agent'
      AND kind IN ('nudge','answer','scope_request','status_request')
      AND status IN ('active','answered')
      AND blocking_policy IN ('checkpoint','wait')
      AND ack_state = 'pending'
      AND ack_decision IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(normalizedJobId, now());
  return Number(row?.count || 0);
}

export function signalPendingOperatorFeedbackForJob(jobId) {
  const normalizedJobId = normalizePositiveInt(jobId);
  if (!normalizedJobId) return 0;
  const db = getDb();
  const signaledAt = now();
  return runImmediateTransaction(db, () => {
    const rows = selectPendingOperatorFeedback(db, { job_id: normalizedJobId, nowIso: signaledAt, limit: 100 });
    const update = db.prepare(`UPDATE agent_interactions SET metadata_json = ?, updated_at = ? WHERE id = ?`);
    for (const row of rows) {
      const metadata = metadataObject(row.metadata_json);
      metadata.nudge_lifecycle = {
        ...(metadata.nudge_lifecycle || {}),
        signaled_at: metadata.nudge_lifecycle?.signaled_at || signaledAt,
      };
      update.run(JSON.stringify(metadata), signaledAt, row.id);
    }
    return rows.length;
  });
}

export function getOperatorFeedbackForJob({
  job_id,
  attempt_id = null,
  agent_call_id = null,
  limit = 20,
} = {}) {
  const delivered = applyActiveAgentInteractionsForAttempt({
    job_id,
    attempt_id,
    agent_call_id,
    limit,
  });
  return delivered.map(feedbackToolPayload);
}

/**
 * Claim feedback for automatic attachment to one tool result. Unlike the
 * recovery getter, this returns each pending item at most once per attempt so
 * parallel/batched tool results do not repeat the same operator message.
 */
export function takeOperatorFeedbackDeliveryForToolResult({
  job_id,
  attempt_id = null,
  agent_call_id = null,
  limit = 20,
} = {}) {
  const jobId = normalizePositiveInt(job_id);
  if (!jobId) return null;
  const attemptId = normalizePositiveInt(attempt_id);
  const feedback = applyActiveAgentInteractionsForAttempt({
    job_id: jobId,
    attempt_id: attemptId,
    agent_call_id,
    limit,
    first_delivery_only: true,
  }).map(feedbackToolPayload);
  if (feedback.length === 0) return null;
  return {
    protocol: OPERATOR_FEEDBACK_DELIVERY_PROTOCOL,
    delivery_id: `job:${jobId}/attempt:${attemptId || 0}/items:${feedback.map((item) => item.id).join(",")}`,
    acknowledgement_required: true,
    default_ack_decision: "accepted",
    ack_tool: "ack_operator_feedback",
    items: feedback,
  };
}

export function acknowledgeOperatorFeedback({
  interaction_id,
  job_id = null,
  attempt_id = null,
  agent_call_id = null,
  decision = "accepted",
  reason = "",
} = {}) {
  const id = normalizePositiveInt(interaction_id);
  if (!id) throw new Error("acknowledgeOperatorFeedback requires interaction_id");
  const normalizedDecision = normalizeText(decision || "accepted").toLowerCase();
  if (!ACK_DECISIONS.has(normalizedDecision)) {
    throw new Error("acknowledgeOperatorFeedback decision must be accepted, rejected, or deferred");
  }
  const normalizedReason = normalizeText(reason);
  if ((normalizedDecision === "rejected" || normalizedDecision === "deferred") && !normalizedReason) {
    throw new Error(`acknowledgeOperatorFeedback requires reason when decision is ${normalizedDecision}`);
  }
  if (scalarLength(normalizedReason) > 500) {
    throw new Error("acknowledgeOperatorFeedback reason exceeds 500 characters");
  }

  const db = getDb();
  const nowIso = now();
  // Read + guarded update in one immediate transaction: the first ack wins and
  // is immutable. A repeat ack (agent retry, coalesced double call, or a late
  // attempt trying to flip an earlier decision) must not rewrite the operator's
  // acknowledgement record nor re-fire events/wakes.
  const { row, acknowledgedNow } = runImmediateTransaction(db, () => {
    const current = normalizeRow(db.prepare(`
      SELECT *
      FROM agent_interactions
      WHERE id = ?
        AND direction = 'user_to_agent'
        AND kind IN ('nudge','answer','scope_request','status_request')
    `).get(id));
    if (!current) return { row: null, acknowledgedNow: false };
    const normalizedJobId = normalizePositiveInt(job_id);
    if (normalizedJobId && current.job_id !== normalizedJobId) {
      throw new Error(`operator feedback #${id} does not belong to job #${normalizedJobId}`);
    }
    const info = db.prepare(`
      UPDATE agent_interactions
      SET ack_state = 'acknowledged',
          ack_decision = ?,
          ack_reason = ?,
          acknowledged_at = ?,
          status = CASE WHEN status = 'active' THEN 'applied' ELSE status END,
          first_applied_at = COALESCE(first_applied_at, ?),
          last_applied_at = ?,
          updated_at = ?
      WHERE id = ? AND ack_state = 'pending'
    `).run(
      normalizedDecision,
      normalizedReason || null,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      id,
    );
    return { row: current, acknowledgedNow: info.changes > 0 };
  });
  if (!row) return null;
  if (!acknowledgedNow) {
    const existing = normalizeRow(db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(id));
    if (existing) existing.already_acknowledged = true;
    return existing;
  }

  logEvent({
    work_item_id: row.work_item_id,
    job_id: row.job_id,
    attempt_id: normalizePositiveInt(attempt_id),
    event_type: applicationEventType(row.kind),
    actor_type: EVENT_ACTORS.WORKER,
    message: `Acknowledged ${interactionLabel(row)} #${row.id} as ${normalizedDecision}${normalizedReason ? `: ${normalizedReason.slice(0, 160)}` : ""}`,
    event_json: {
      interaction_id: row.id,
      kind: row.kind,
      decision: normalizedDecision,
      reason: normalizedReason || null,
      agent_call_id: normalizePositiveInt(agent_call_id),
      live_channel: true,
    },
  });
  notifyQueueStateChanged({ reason: "operator_feedback_acknowledged", jobId: row.job_id, workItemId: row.work_item_id });
  return normalizeRow(db.prepare(`SELECT * FROM agent_interactions WHERE id = ?`).get(id));
}

/**
 * Job-end reconciliation: any user_to_agent guidance still unacked when a job
 * reaches a terminal status can never be delivered — mark it expired and say
 * so, instead of leaving `ack_state='pending'` rows that render on no surface
 * while the operator believes the nudge landed.
 *
 * @param {{ job_id: number, reason?: string }} args
 * @returns {number} rows expired
 */
export function expireUnackedOperatorFeedbackForJob({ job_id, reason = "job_finalized" } = {}) {
  const jobId = normalizePositiveInt(job_id);
  if (!jobId) return 0;
  const db = getDb();
  const nowIso = now();
  const expired = runImmediateTransaction(db, () => {
    const rows = db.prepare(`
      SELECT id, work_item_id, job_id, kind
      FROM agent_interactions
      WHERE job_id = ?
        AND direction = 'user_to_agent'
        AND kind IN ('nudge','answer','scope_request','status_request')
        AND ack_state = 'pending'
        AND status IN ('active','answered')
    `).all(jobId).map(normalizeRow);
    if (rows.length === 0) return rows;
    const update = db.prepare(`
      UPDATE agent_interactions
      SET status = 'expired', updated_at = ?
      WHERE id = ? AND ack_state = 'pending'
    `);
    for (const row of rows) update.run(nowIso, row.id);
    return rows;
  });
  for (const row of expired) {
    logEvent({
      work_item_id: row.work_item_id,
      job_id: row.job_id,
      event_type: applicationEventType(row.kind),
      actor_type: EVENT_ACTORS.WORKER,
      message: `Undelivered ${interactionLabel(row)} #${row.id} expired: ${reason}`,
      event_json: {
        interaction_id: row.id,
        kind: row.kind,
        reason,
        expired: true,
        live_channel: true,
      },
    });
  }
  if (expired.length > 0) {
    notifyQueueStateChanged({ reason: "operator_feedback_expired", jobId, workItemId: expired[0]?.work_item_id ?? null });
  }
  return expired.length;
}

export function listAgentInteractions({
  job_id = null,
  work_item_id = null,
  agent_call_id = null,
  limit = 50,
} = {}) {
  const clauses = [];
  const params = [];
  if (job_id != null) {
    clauses.push("job_id = ?");
    params.push(normalizePositiveInt(job_id, 0));
  }
  if (work_item_id != null) {
    clauses.push("work_item_id = ?");
    params.push(normalizePositiveInt(work_item_id, 0));
  }
  if (agent_call_id != null) {
    clauses.push("agent_call_id = ?");
    params.push(normalizePositiveInt(agent_call_id, 0));
  }
  const safeLimit = Math.min(500, Math.max(1, Number.parseInt(String(limit), 10) || 50));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb().prepare(`
    SELECT *
    FROM agent_interactions
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params, safeLimit).map(normalizeRow);
}

export function listActiveAgentGuidanceForJob(jobId, { limit = 20 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));
  return getDb().prepare(`
    SELECT ai.*,
      (
        SELECT COUNT(*)
        FROM agent_interaction_applications aia
        WHERE aia.interaction_id = ai.id
      ) AS application_count
    FROM agent_interactions ai
    WHERE ai.job_id = ?
      AND ai.direction = 'user_to_agent'
      AND ai.status IN ('active','answered')
      AND (ai.expires_at IS NULL OR ai.expires_at > ?)
    ORDER BY ai.created_at DESC, ai.id DESC
    LIMIT ?
  `).all(normalizePositiveInt(jobId, 0), now(), safeLimit).map(normalizeRow);
}
