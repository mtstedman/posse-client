import { getDb } from "../../../shared/storage/functions/index.js";
import {
  WORK_ITEM_STATS_PROTOCOL,
  commonEnvelope,
  resolveRangeRequest,
  validateRepositoryBinding,
} from "./work-item-feed.js";

const METRIC_DEFINITIONS = Object.freeze({
  work_items_completed: ["count", "v1:first_completed_terminal_in_effective_window"],
  work_items_failed: ["count", "v1:first_failed_terminal_in_effective_window"],
  work_items_canceled: ["count", "v1:first_canceled_terminal_in_effective_window"],
  jobs_retried: ["count", "v1:attempt_ordinal_gt_one_started_in_effective_window"],
  duration_ms_p50: ["milliseconds", "v1:nearest_rank_work_item_elapsed_p50"],
  duration_ms_p95: ["milliseconds", "v1:nearest_rank_work_item_elapsed_p95"],
  input_tokens: ["tokens", "v1:canonical_completed_agent_calls"],
  output_tokens: ["tokens", "v1:canonical_completed_agent_calls"],
  cost_usd: ["usd", "v1:canonical_completed_agent_call_cost"],
});

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(percentileValue * sorted.length));
  return sorted[rank - 1];
}

function metric(metricId, value, completeness = "complete") {
  const [unit, definition] = METRIC_DEFINITIONS[metricId];
  return { metric_id: metricId, value: finiteOrNull(value), unit, definition, completeness };
}

function terminalWorkItems(db, startAt, endAt) {
  return db.prepare(`
    SELECT
      wi.id,
      transitions.outcome AS status,
      wi.started_at,
      transitions.occurred_at AS completed_at,
      transitions.source
    FROM work_item_terminal_transitions transitions
    JOIN work_items wi ON wi.id = transitions.work_item_id
    WHERE transitions.occurred_at >= ?
      AND transitions.occurred_at < ?
    ORDER BY transitions.occurred_at, wi.id, transitions.outcome
  `).all(startAt, endAt);
}

function retryCount(db, startAt, endAt) {
  try {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM job_attempts
      WHERE attempt_number > 1
        AND started_at >= ?
        AND started_at < ?
    `).get(startAt, endAt)?.count || 0);
  } catch {
    return 0;
  }
}

function completedCalls(db, startAt, endAt) {
  try {
    return db.prepare(`
      SELECT input_tokens, output_tokens, cost_estimate_usd
      FROM agent_calls
      WHERE finished_at IS NOT NULL
        AND finished_at >= ?
        AND finished_at < ?
      ORDER BY id
    `).all(startAt, endAt);
  } catch {
    return [];
  }
}

function callTotal(rows, field) {
  const known = rows.map((row) => row[field]).filter((value) => value != null && Number.isFinite(Number(value)));
  const partial = known.length !== rows.length;
  return {
    value: known.length > 0 || rows.length === 0
      ? known.reduce((sum, value) => sum + Number(value), 0)
      : null,
    completeness: partial ? "partial" : "complete",
  };
}

function agentOutcomes(db, startAt, endAt) {
  const rows = db.prepare(`
    SELECT
      jobs.job_type AS role,
      SUM(CASE WHEN transitions.outcome = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN transitions.outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN transitions.outcome = 'canceled' THEN 1 ELSE 0 END) AS canceled,
      SUM(CASE WHEN transitions.source = 'legacy_current' THEN 1 ELSE 0 END) AS legacy_rows
    FROM job_terminal_transitions transitions
    JOIN jobs ON jobs.id = transitions.job_id
    WHERE transitions.occurred_at >= ?
      AND transitions.occurred_at < ?
    GROUP BY jobs.job_type
    ORDER BY jobs.job_type
    LIMIT 32
  `).all(startAt, endAt);
  return {
    rows: rows.map((row) => ({
      role: String(row.role),
      succeeded: Number(row.succeeded || 0),
      failed: Number(row.failed || 0),
      canceled: Number(row.canceled || 0),
      completeness: Number(row.legacy_rows || 0) > 0 ? "partial" : "complete",
    })),
    hasLegacy: rows.some((row) => Number(row.legacy_rows || 0) > 0),
  };
}

export function projectWorkItemStats(args = {}, context = {}) {
  const binding = validateRepositoryBinding(args, context);
  if (!binding.ok) return binding;
  const db = context.db || getDb();
  const range = resolveRangeRequest(args.timeframe, context, { projectDir: binding.repoPath, db });
  if (!range.ok) return { ok: false, reason: range.reason };
  const { start_at: startAt, end_at: endAt } = range.effective;
  const workItems = terminalWorkItems(db, startAt, endAt);
  const durations = workItems
    .map((row) => Date.parse(row.completed_at) - Date.parse(row.started_at || ""))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const calls = completedCalls(db, startAt, endAt);
  const inputTokens = callTotal(calls, "input_tokens");
  const outputTokens = callTotal(calls, "output_tokens");
  const cost = callTotal(calls, "cost_estimate_usd");
  const outcomes = agentOutcomes(db, startAt, endAt);
  const partialReasons = [...range.partialReasons];
  const hasLegacyWorkItemTransition = workItems.some((row) => row.source === "legacy_current");
  const hasMissingDuration = durations.length !== workItems.length;
  if (hasLegacyWorkItemTransition || outcomes.hasLegacy) partialReasons.push("legacy_transition_backfill");
  if (hasMissingDuration) partialReasons.push("duration_unavailable");
  if (inputTokens.completeness === "partial" || outputTokens.completeness === "partial") {
    partialReasons.push("usage_unavailable");
  }
  if (cost.completeness === "partial") partialReasons.push("cost_unavailable");
  const metrics = [
    metric("work_items_completed", workItems.filter((row) => row.status === "completed").length, hasLegacyWorkItemTransition ? "partial" : "complete"),
    metric("work_items_failed", workItems.filter((row) => row.status === "failed").length, hasLegacyWorkItemTransition ? "partial" : "complete"),
    metric("work_items_canceled", workItems.filter((row) => row.status === "canceled").length, hasLegacyWorkItemTransition ? "partial" : "complete"),
    metric("jobs_retried", retryCount(db, startAt, endAt)),
    metric("duration_ms_p50", percentile(durations, 0.50), hasMissingDuration || hasLegacyWorkItemTransition ? "partial" : "complete"),
    metric("duration_ms_p95", percentile(durations, 0.95), hasMissingDuration || hasLegacyWorkItemTransition ? "partial" : "complete"),
    metric("input_tokens", inputTokens.value, inputTokens.completeness),
    metric("output_tokens", outputTokens.value, outputTokens.completeness),
    metric("cost_usd", cost.value, cost.completeness),
  ];
  return {
    ...commonEnvelope(WORK_ITEM_STATS_PROTOCOL, binding.repoPath, context, db),
    requested: range.requested,
    effective: range.effective,
    completeness: partialReasons.length > 0 ? "partial" : "complete",
    partial_reasons: [...new Set(partialReasons)],
    retention: { ...range.retention, beginning_reached: true },
    metrics,
    agent_outcomes: outcomes.rows,
  };
}

export const __testNearestRank = percentile;
