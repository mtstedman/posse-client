import path from "node:path";

import { FAILED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { BRIDGE_NON_AGENT_JOB_TYPES } from "../../../catalog/bridge.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  fileLaneId,
  listActiveFileLocks,
  listFileLaneWaits,
} from "../../queue/functions/file-locks.js";
import { projectWorkItemInteractions } from "./work-item-actions.js";
import {
  WORK_ITEM_BOUNDS,
  WORK_ITEM_OVERVIEW_PROTOCOL,
  commonEnvelope,
  decimalId,
  historyRanges,
  parseJsonObject,
  positiveBound,
  safeText,
  validateRepositoryBinding,
} from "./work-item-feed.js";

const TERMINAL_WORK_ITEM_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const TERMINAL_JOB_SET = new Set(TERMINAL_JOB_STATUSES);
const FAILED_JOB_SET = new Set(FAILED_JOB_STATUSES);
const PRODUCTIVE_JOB_TYPES = new Set(["delegate", "dev", "assess", "fix", "summarize", "artificer", "promote"]);
const PLANNING_JOB_TYPES = new Set(["plan"]);
const RESEARCH_JOB_TYPES = new Set(["research", "preflight"]);
const CURRENT_AGENT_EXCLUDED_JOB_TYPES = new Set(BRIDGE_NON_AGENT_JOB_TYPES);

function workItemState(status) {
  const mapped = {
    complete: "completed",
    waiting_on_human: "needs_input",
    waiting_on_review: "review",
    planned: "planning",
  };
  return mapped[status] || status || "queued";
}

export function projectWorkItemPhase(workItem, jobs = []) {
  if (TERMINAL_WORK_ITEM_SET.has(workItem?.status)) return "terminal";
  if (workItem?.status === "waiting_on_review") return "review";
  const nonterminal = jobs.filter((job) => !TERMINAL_JOB_SET.has(job.status));
  const inheritedGatePhase = nonterminal
    .filter((job) => job.job_type === "human_input")
    .map((job) => parseJsonObject(job.payload_json).owner_phase)
    .find((phase) => ["research", "planning", "dispatched", "review"].includes(phase));
  if (nonterminal.some((job) => PRODUCTIVE_JOB_TYPES.has(job.job_type))) return "dispatched";
  if (nonterminal.some((job) => PLANNING_JOB_TYPES.has(job.job_type))) return "planning";
  if (nonterminal.some((job) => RESEARCH_JOB_TYPES.has(job.job_type))) return "research";
  if (inheritedGatePhase) return inheritedGatePhase;
  return "queued";
}

function metadataForWorkItem(workItem) {
  return parseJsonObject(workItem?.metadata_json);
}

function activeAgentJobs(jobs) {
  return jobs.filter((job) => !TERMINAL_JOB_SET.has(job.status) && !CURRENT_AGENT_EXCLUDED_JOB_TYPES.has(job.job_type));
}

function agentJobs(jobs) {
  return jobs.filter((job) => !CURRENT_AGENT_EXCLUDED_JOB_TYPES.has(job.job_type));
}

function summaryRow(workItem, jobs, group, canonicalIndex, queuePosition, isPrimary) {
  const metadata = metadataForWorkItem(workItem);
  const currentJobs = activeAgentJobs(jobs);
  return {
    work_item_id: String(workItem.id),
    canonical_index: canonicalIndex,
    group,
    title: safeText(workItem.title, 200, { nullable: false }),
    objective_summary: safeText(metadata.objective_summary || workItem.description, 500),
    state: group === "queued" ? "queued" : workItemState(workItem.status),
    phase: group === "queued" ? "queued" : projectWorkItemPhase(workItem, jobs),
    state_since: workItem.updated_at || workItem.created_at || null,
    queue_position: group === "queued" ? queuePosition : null,
    progress_summary: safeText(metadata.progress_summary, 300),
    progress_percent: Number.isFinite(Number(metadata.progress_percent))
      ? Math.max(0, Math.min(100, Number(metadata.progress_percent)))
      : null,
    active_agent_count: currentJobs.length,
    needs_input: workItem.status === "waiting_on_human" || jobs.some((job) => job.status === "waiting_on_human"),
    has_failure: workItem.status === "failed" || jobs.some((job) => FAILED_JOB_SET.has(job.status)),
    is_primary: Boolean(isPrimary),
  };
}

function latestCallsByJob(db, workItemId) {
  const rows = db.prepare(`
    SELECT ac.*
    FROM agent_calls ac
    JOIN (
      SELECT job_id, MAX(id) AS id
      FROM agent_calls
      WHERE work_item_id = ? AND job_id IS NOT NULL
      GROUP BY job_id
    ) latest ON latest.id = ac.id
    ORDER BY ac.id
  `).all(workItemId);
  return new Map(rows.map((row) => [Number(row.job_id), row]));
}

function feedbackByJob(projected) {
  const byJob = new Map();
  for (const feedback of projected?.agent_feedback || []) {
    const id = Number(feedback.job_id);
    if (!Number.isInteger(id)) continue;
    const previous = byJob.get(id);
    if (!previous || String(previous.occurred_at || "") <= String(feedback.occurred_at || "")) byJob.set(id, feedback);
  }
  return byJob;
}

function nudgeByJob(projected) {
  const byJob = new Map();
  for (const nudge of projected?.nudges || []) {
    const id = Number(nudge.job_id);
    if (!Number.isInteger(id)) continue;
    if (!["accepted", "rejected", "deferred", "superseded", "expired"].includes(nudge.state || nudge.status)) {
      byJob.set(id, nudge);
    }
  }
  return byJob;
}

function agentState(job, hasLaneWait) {
  if (hasLaneWait) return "waiting_for_lane";
  const mapped = {
    queued: "queued",
    leased: "active",
    running: "active",
    awaiting_assessment: "active",
    blocked: "waiting",
    waiting_on_human: "needs_input",
    waiting_on_review: "review",
    succeeded: "finished",
    failed: "failed",
    dead_letter: "failed",
    canceled: "offline",
  };
  return mapped[job.status] || "offline";
}

function agentStatus(job, feedback, hasLaneWait) {
  if (job.status === "succeeded") return "done";
  if (FAILED_JOB_SET.has(job.status)) return "failed";
  if (job.status === "canceled") return "canceled";
  if (feedback?.status) return feedback.status;
  if (hasLaneWait) return "waiting";
  if (["leased", "running"].includes(job.status)) return "running";
  if (job.status === "awaiting_assessment" || job.status === "waiting_on_review") return "verifying";
  if (["blocked", "waiting_on_human", "queued"].includes(job.status)) return "waiting";
  return "unknown";
}

function laneLabel(lockPath) {
  const normalized = String(lockPath || "").replaceAll("\\", "/");
  if (!normalized || normalized === "*") return "repository write scope";
  return safeText(path.posix.basename(normalized), 160, { nullable: false });
}

function projectLanes(workItemId) {
  const locks = listActiveFileLocks();
  const waits = listFileLaneWaits({ workItemId });
  const lanes = new Map();
  for (const lock of [...locks.work_items, ...locks.jobs]) {
    if (Number(lock.work_item_id) !== Number(workItemId)) continue;
    const laneId = fileLaneId(lock.path, lock.lock_kind);
    if (!laneId) continue;
    const current = lanes.get(laneId) || {
      lane_id: laneId,
      label: laneLabel(lock.path),
      state: "held",
      holder_job_id: decimalId(lock.job_id),
      waiter_job_ids: [],
      updated_at: lock.acquired_at || null,
    };
    if (!current.holder_job_id) current.holder_job_id = decimalId(lock.job_id);
    lanes.set(laneId, current);
  }
  for (const wait of waits) {
    const current = lanes.get(wait.lane_id) || {
      lane_id: wait.lane_id,
      label: laneLabel(wait.path),
      state: "available",
      holder_job_id: decimalId(wait.holder_job_id),
      waiter_job_ids: [],
      updated_at: wait.updated_at || null,
    };
    if (!current.waiter_job_ids.includes(String(wait.waiter_job_id))) {
      current.waiter_job_ids.push(String(wait.waiter_job_id));
    }
    current.waiter_job_ids = current.waiter_job_ids.slice(0, WORK_ITEM_BOUNDS.WAITERS);
    current.state = "waiting";
    current.updated_at = wait.updated_at || current.updated_at;
    lanes.set(wait.lane_id, current);
  }
  return [...lanes.values()].sort((a, b) => a.lane_id.localeCompare(b.lane_id));
}

function projectAgents(db, workItemId, jobs, projectedInteractions, lanes) {
  const latestCalls = latestCallsByJob(db, workItemId);
  const feedback = feedbackByJob(projectedInteractions);
  const nudges = nudgeByJob(projectedInteractions);
  const laneByWaiter = new Map();
  const laneByHolder = new Map();
  for (const lane of lanes) {
    if (lane.holder_job_id) laneByHolder.set(Number(lane.holder_job_id), lane);
    for (const waiter of lane.waiter_job_ids) laneByWaiter.set(Number(waiter), lane);
  }
  return agentJobs(jobs).map((job) => {
    const call = latestCalls.get(Number(job.id)) || null;
    const update = feedback.get(Number(job.id)) || null;
    const waitingLane = laneByWaiter.get(Number(job.id));
    const heldLane = laneByHolder.get(Number(job.id));
    const activeNudge = nudges.get(Number(job.id));
    const enabled = !TERMINAL_JOB_SET.has(job.status);
    return {
      job_id: String(job.id),
      work_item_id: String(workItemId),
      attempt_id: decimalId(call?.attempt_id),
      agent_call_id: decimalId(call?.id),
      role: safeText(call?.role || job.job_type, 80, { nullable: false }),
      display_name: safeText(call?.role || job.job_type, 120, { nullable: false }),
      state: agentState(job, !!waitingLane),
      phase: update?.phase || "unknown",
      status: agentStatus(job, update, !!waitingLane),
      summary: safeText(update?.summary, 180),
      state_since: job.started_at || job.updated_at || job.created_at || null,
      updated_at: update?.occurred_at || job.updated_at || null,
      provider: safeText(call?.provider || job.provider, 80),
      model: safeText(call?.model_name || job.model_name, 120),
      lane_id: waitingLane?.lane_id || heldLane?.lane_id || null,
      lane_state: waitingLane ? "waiting" : heldLane ? "held" : "none",
      nudge: {
        enabled,
        max_chars: 4000,
        replace_interaction_id: enabled && activeNudge?.interaction_id ? String(activeNudge.interaction_id) : null,
        unavailable_reason: enabled ? null : "job_terminal",
      },
    };
  });
}

function liveStats(db, workItem, jobs, agents, lanes, context) {
  const calls = db.prepare(`
    SELECT input_tokens, output_tokens, cost_estimate_usd
    FROM agent_calls
    WHERE work_item_id = ?
    ORDER BY id
  `).all(workItem.id);
  const totals = (field) => {
    const known = calls.map((row) => row[field]).filter((value) => value != null && Number.isFinite(Number(value)));
    if (known.length === 0 && calls.length > 0) return null;
    return known.reduce((sum, value) => sum + Number(value), 0);
  };
  const partialReasons = [];
  if (calls.some((row) => row.input_tokens == null || row.output_tokens == null)) partialReasons.push("usage_unavailable");
  if (calls.some((row) => row.cost_estimate_usd == null)) partialReasons.push("cost_unavailable");
  const metadata = metadataForWorkItem(workItem);
  const observedMs = Date.parse(context.observedAt || context.observed_at || new Date().toISOString());
  const startMs = Date.parse(workItem.started_at || "");
  const terminalMs = TERMINAL_WORK_ITEM_SET.has(workItem.status) ? Date.parse(workItem.completed_at || "") : observedMs;
  const currentAttempt = db.prepare(`
    SELECT MAX(ja.attempt_number) AS ordinal
    FROM job_attempts ja
    JOIN jobs j ON j.id = ja.job_id
    WHERE j.work_item_id = ?
  `).get(workItem.id)?.ordinal;
  return {
    elapsed_ms: Number.isFinite(startMs) && Number.isFinite(terminalMs) ? Math.max(0, terminalMs - startMs) : null,
    current_attempt: currentAttempt == null ? null : Number(currentAttempt),
    agents_active: activeAgentJobs(jobs).length,
    agents_finished: jobs.filter((job) => (
      TERMINAL_JOB_SET.has(job.status) && !CURRENT_AGENT_EXCLUDED_JOB_TYPES.has(job.job_type)
    )).length,
    lanes_held: lanes.filter((lane) => lane.holder_job_id).length,
    lanes_waiting: lanes.reduce((sum, lane) => sum + lane.waiter_job_ids.length, 0),
    input_tokens: totals("input_tokens"),
    output_tokens: totals("output_tokens"),
    cost_usd: totals("cost_estimate_usd"),
    progress_summary: safeText(metadata.progress_summary, 300),
    progress_percent: Number.isFinite(Number(metadata.progress_percent))
      ? Math.max(0, Math.min(100, Number(metadata.progress_percent)))
      : null,
    metrics_observed_at: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : new Date().toISOString(),
    completeness: partialReasons.length > 0 ? "partial" : "complete",
    partial_reasons: partialReasons,
  };
}

export async function projectWorkItemOverview(args = {}, context = {}) {
  const binding = validateRepositoryBinding(args, context);
  if (!binding.ok) return binding;
  const db = context.db || getDb();
  const activeLimit = positiveBound(args.active_limit, 50, WORK_ITEM_BOUNDS.ACTIVE);
  const queuedLimit = positiveBound(args.queued_limit, 50, WORK_ITEM_BOUNDS.QUEUED);
  const workItems = db.prepare("SELECT * FROM work_items ORDER BY created_at, id").all();
  const jobs = db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all();
  const jobsByWorkItem = new Map();
  for (const job of jobs) {
    const list = jobsByWorkItem.get(Number(job.work_item_id)) || [];
    list.push(job);
    jobsByWorkItem.set(Number(job.work_item_id), list);
  }
  const live = workItems.filter((row) => !TERMINAL_WORK_ITEM_SET.has(row.status));
  const activeItems = live.filter((row) => row.status !== "queued");
  const queuedItems = live.filter((row) => row.status === "queued");
  const primary = activeItems[0] || queuedItems[0] || null;
  const requestedSelection = String(args.selected_work_item_id ?? "").trim();
  const selectedWorkItem = live.find((row) => String(row.id) === requestedSelection) || primary;
  const active = activeItems.slice(0, activeLimit).map((row, index) => summaryRow(
    row,
    jobsByWorkItem.get(Number(row.id)) || [],
    "active",
    index,
    null,
    Number(row.id) === Number(primary?.id),
  ));
  const queued = queuedItems.slice(0, queuedLimit).map((row, index) => summaryRow(
    row,
    jobsByWorkItem.get(Number(row.id)) || [],
    "queued",
    index,
    index + 1,
    Number(row.id) === Number(primary?.id),
  ));
  let selected = null;
  if (selectedWorkItem) {
    const selectedJobs = jobsByWorkItem.get(Number(selectedWorkItem.id)) || [];
    const interactions = await projectWorkItemInteractions({
      work_item_id: String(selectedWorkItem.id),
      observed_at: context.observedAt || context.observed_at,
    }, context);
    const lanes = projectLanes(selectedWorkItem.id);
    const agentsAll = projectAgents(db, selectedWorkItem.id, selectedJobs, interactions, lanes);
    const agents = agentsAll.slice(0, WORK_ITEM_BOUNDS.AGENTS);
    const questionsAll = Array.isArray(interactions?.questions) ? interactions.questions : [];
    const questionsTotal = Number(interactions?.questions_total);
    const questionsTruncated = interactions?.questions_truncated;
    if (questionsAll.length > WORK_ITEM_BOUNDS.QUESTIONS
      || !Number.isSafeInteger(questionsTotal)
      || questionsTotal < questionsAll.length
      || typeof questionsTruncated !== "boolean"
      || questionsTruncated !== (questionsTotal > questionsAll.length)) {
      throw new Error("Lane A interaction projection returned invalid question totals");
    }
    const questions = questionsAll;
    const latestIds = db.prepare(`
      SELECT id FROM events
      WHERE work_item_id = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(selectedWorkItem.id).map((row) => `event:${row.id}`);
    selected = {
      work_item_id: String(selectedWorkItem.id),
      owner_generation: commonEnvelope(WORK_ITEM_OVERVIEW_PROTOCOL, binding.repoPath, context, db).owner_generation,
      live_stats: liveStats(db, selectedWorkItem, selectedJobs, agentsAll, lanes, context),
      agents,
      agents_total: agentsAll.length,
      agents_truncated: agentsAll.length > agents.length,
      lanes: lanes.slice(0, WORK_ITEM_BOUNDS.LANES),
      lanes_total: lanes.length,
      lanes_truncated: lanes.length > WORK_ITEM_BOUNDS.LANES,
      questions,
      questions_total: questionsTotal,
      questions_truncated: questionsTruncated,
      latest_event_ids: latestIds,
      capabilities: ["question.answer", "agent.nudge"],
    };
  }
  return {
    ...commonEnvelope(WORK_ITEM_OVERVIEW_PROTOCOL, binding.repoPath, context, db),
    primary_work_item_id: primary ? String(primary.id) : null,
    active_total: activeItems.length,
    queued_total: queuedItems.length,
    active_truncated: activeItems.length > active.length,
    queued_truncated: queuedItems.length > queued.length,
    active,
    queued,
    selected,
    capabilities: ["work_items.history", "work_items.stats", "work_items.tail", "question.answer", "agent.nudge"],
    history_ranges: historyRanges(context),
  };
}
