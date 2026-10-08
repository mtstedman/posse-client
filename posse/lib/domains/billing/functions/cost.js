// lib/cost.js
//
// Cost aggregator for agent_calls. Reads token counts per call, resolves a
// per-call USD cost via lib/pricing.js, and groups the results by work item,
// role, provider, or tier. The cost_estimate_usd column on agent_calls is
// preferred when present (provider-authoritative); otherwise we estimate on
// the fly with token × rate math.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  listUsageSegmentsForAgentCalls,
  resolveCanonicalCallAccounting,
} from "./usage-segments.js";
import {
  accountingRoleForAgentCall,
  attributeAgentCallParents,
  childKindForAgentCall,
  firstRequestInputTokens,
  isAttributedChildAgentCall,
} from "./child-attribution.js";

const GROUP_FIELDS = Object.freeze({
  provider: (call) => call.provider || "unknown",
  role: (call) => accountingRoleForAgentCall(call),
  tier: (call) => call.model_tier || "unknown",
  model: (call) => `${call.provider || "?"}:${call.model_name || "unknown"}`,
  wi: (call) => (call.work_item_id == null ? "unknown" : `WI#${call.work_item_id}`),
});

function buildWhere({ wiId = null, since = null } = {}) {
  const clauses = [];
  const params = [];
  if (wiId != null) {
    clauses.push(`work_item_id = ?`);
    params.push(Number(wiId));
  }
  if (since != null && String(since).trim()) {
    clauses.push(`created_at >= ?`);
    params.push(String(since).trim());
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function enrichCall(call, db = getDb(), usageSegments = null) {
  const accounting = resolveCanonicalCallAccounting(call, { db, usageSegments });
  const inputTokens = accounting.inputTokens;
  const outputTokens = accounting.outputTokens;
  const cachedInputTokens = accounting.cachedInputTokens;
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const turnsUsed = Math.max(0, Number(call.turns_used) || 0);
  return {
    ...call,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: uncachedInputTokens,
    billable_input_tokens: accounting.billableInputTokens,
    billable_tokens: accounting.billableTokens,
    cache_discount_ratio: accounting.billableInputTokens == null
      ? null
      : aggregateCacheDiscountRatio(inputTokens, accounting.billableInputTokens),
    resolved_cost_usd: accounting.costUsd,
    cost_source: accounting.costSource,
    cost_precision: accounting.costPrecision,
    accounting_precision: accounting.precision,
    exact_usage: accounting.exact,
    turns_used: turnsUsed,
    output_truncated: Number(call.output_truncated) === 1,
  };
}

function preloadUsageSegments(rows, db) {
  return listUsageSegmentsForAgentCalls(rows.map((row) => row.id), { db });
}

function preloadParentAncestors(rows, db) {
  const known = new Map(rows
    .map((row) => [Number(row?.id), row])
    .filter(([id]) => Number.isInteger(id) && id > 0));
  let pending = [...new Set(rows
    .map((row) => Number(row?.parent_agent_call_id))
    .filter((id) => Number.isInteger(id) && id > 0 && !known.has(id)))];
  while (pending.length > 0) {
    const nextPending = [];
    for (let offset = 0; offset < pending.length; offset += 500) {
      const chunk = pending.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const parents = db.prepare(`
        SELECT id, parent_agent_call_id, child_kind, role
        FROM agent_calls
        WHERE id IN (${placeholders})
      `).all(...chunk);
      for (const parent of parents) {
        const id = Number(parent.id);
        if (known.has(id)) continue;
        known.set(id, parent);
        const ancestorId = Number(parent.parent_agent_call_id);
        if (Number.isInteger(ancestorId) && ancestorId > 0 && !known.has(ancestorId)) {
          nextPending.push(ancestorId);
        }
      }
    }
    pending = [...new Set(nextPending)];
  }
  const rowIds = new Set(rows.map((row) => Number(row?.id)));
  return [...known.values()].filter((row) => !rowIds.has(Number(row.id)));
}

function attributeCostRows(rows, db) {
  return attributeAgentCallParents(rows, {
    ancestors: preloadParentAncestors(rows, db),
  });
}

function costPrecision({ callCount, exactCostCalls, estimatedCostCalls, unknownCostCalls }) {
  if (callCount > 0 && unknownCostCalls === callCount) return "unknown";
  if (unknownCostCalls > 0) return "partial";
  if (estimatedCostCalls > 0) return "estimated";
  return "exact";
}

function exposedCostUsd(knownCostUsd, precision) {
  return precision === "unknown" ? null : knownCostUsd;
}

function costPer1kOutputTokens(costUsd, outputTokens) {
  const cost = Number(costUsd);
  const output = Number(outputTokens);
  return Number.isFinite(cost) && Number.isFinite(output) && output > 0
    ? cost / (output / 1000)
    : null;
}

function aggregateCacheDiscountRatio(inputTokens, billableInputTokens) {
  const input = Number(inputTokens) || 0;
  if (input <= 0) return null;
  const billable = Math.max(0, Number(billableInputTokens) || 0);
  return Math.max(0, Math.min(1, 1 - (billable / input)));
}

function newCostAccumulator(costKey = "costUsd") {
  return {
    callCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    billableInputTokens: 0,
    billableInputUnknownCalls: 0,
    billableTokens: 0,
    outputTokens: 0,
    turnsUsed: 0,
    outputTruncatedCalls: 0,
    [costKey]: 0,
    unknownCostCalls: 0,
    exactCostCalls: 0,
    estimatedCostCalls: 0,
    exactUsageCalls: 0,
    inexactUsageCalls: 0,
  };
}

function accumulateCostCall(entry, call, costKey = "costUsd") {
  entry.callCount += 1;
  entry.inputTokens += call.input_tokens || 0;
  entry.cachedInputTokens += call.cached_input_tokens || 0;
  entry.billableInputTokens += call.billable_input_tokens || 0;
  if (!Number.isFinite(call.billable_input_tokens)) entry.billableInputUnknownCalls += 1;
  entry.billableTokens += call.billable_tokens || 0;
  entry.outputTokens += call.output_tokens || 0;
  entry.turnsUsed += call.turns_used || 0;
  if (call.output_truncated) entry.outputTruncatedCalls += 1;
  if (Number.isFinite(call.resolved_cost_usd)) entry[costKey] += call.resolved_cost_usd;
  if (call.cost_precision === "exact") entry.exactCostCalls += 1;
  else if (call.cost_precision === "estimated") entry.estimatedCostCalls += 1;
  else entry.unknownCostCalls += 1;
  if (call.exact_usage === true) entry.exactUsageCalls += 1;
  else if (call.exact_usage === false) entry.inexactUsageCalls += 1;
}

function finalizeCostAccumulator(entry, costKey = "costUsd") {
  entry.knownCostUsd = entry[costKey];
  entry.costPrecision = costPrecision(entry);
  entry[costKey] = exposedCostUsd(entry.knownCostUsd, entry.costPrecision);
  entry.uncachedInputTokens = Math.max(0, entry.inputTokens - entry.cachedInputTokens);
  entry.billableInputKnownTokens = entry.billableInputTokens;
  entry.billableInputComplete = entry.billableInputUnknownCalls === 0;
  entry.billableTokens = entry.inexactUsageCalls > 0 ? null : entry.billableTokens;
  entry.cacheDiscountRatio = entry.inexactUsageCalls > 0
    ? null
    : aggregateCacheDiscountRatio(entry.inputTokens, entry.billableInputTokens);
  entry.costPer1kOutputTokensUsd = entry.inexactUsageCalls > 0
    ? null
    : costPer1kOutputTokens(entry.knownCostUsd, entry.outputTokens);
  entry.exactUsageCoverage = entry.exactUsageCalls + entry.inexactUsageCalls > 0
    ? entry.exactUsageCalls / (entry.exactUsageCalls + entry.inexactUsageCalls)
    : null;
  return entry;
}

function accumulateChildBreakdown(byKey, call, usageSegments = []) {
  if (!isAttributedChildAgentCall(call)) return;
  const parentRole = accountingRoleForAgentCall(call);
  const kind = childKindForAgentCall(call) || "unknown";
  const key = `${parentRole}\u0000${kind}`;
  let entry = byKey.get(key);
  if (!entry) {
    entry = {
      parentRole,
      kind,
      callCount: 0,
      calls: 0,
      billableTokens: 0,
      billableUnknownCalls: 0,
      knownCostUsd: 0,
      exactCostCalls: 0,
      estimatedCostCalls: 0,
      unknownCostCalls: 0,
      spinupTokens: 0,
      spinupUnknownCalls: 0,
    };
    byKey.set(key, entry);
  }
  entry.callCount += 1;
  entry.calls += 1;
  if (Number.isFinite(call.billable_tokens)) entry.billableTokens += call.billable_tokens;
  else entry.billableUnknownCalls += 1;
  if (Number.isFinite(call.resolved_cost_usd)) entry.knownCostUsd += call.resolved_cost_usd;
  if (call.cost_precision === "exact") entry.exactCostCalls += 1;
  else if (call.cost_precision === "estimated") entry.estimatedCostCalls += 1;
  else entry.unknownCostCalls += 1;
  const spinup = firstRequestInputTokens(usageSegments, call);
  if (spinup == null) entry.spinupUnknownCalls += 1;
  else entry.spinupTokens += spinup;
}

function finalizeChildBreakdowns(byKey) {
  return [...byKey.values()]
    .map((entry) => {
      const precision = costPrecision(entry);
      return {
        parentRole: entry.parentRole,
        kind: entry.kind,
        calls: entry.calls,
        billableTokens: entry.billableUnknownCalls > 0 ? null : entry.billableTokens,
        billableUnknownCalls: entry.billableUnknownCalls,
        costUsd: exposedCostUsd(entry.knownCostUsd, precision),
        knownCostUsd: entry.knownCostUsd,
        costPrecision: precision,
        unknownCostCalls: entry.unknownCostCalls,
        spinupTokens: entry.spinupUnknownCalls > 0 ? null : entry.spinupTokens,
        measuredSpinupTokens: entry.spinupTokens,
        spinupUnknownCalls: entry.spinupUnknownCalls,
      };
    })
    .sort((left, right) => left.parentRole.localeCompare(right.parentRole)
      || left.kind.localeCompare(right.kind));
}

/**
 * Total cost for a single work item.
 * `totalCostUsd` is null when every call is unknown and otherwise contains the
 * known subtotal. `costPrecision` distinguishes exact, estimated, partial, and
 * unknown rollups; partial rollups also expose their unknown contribution count.
 * Pass `db` to compute on an alternate handle (the bridge ChangeStream uses
 * its readonly connection instead of the shared write handle).
 */
export function workItemCost(wiId, { since = null, db = null } = {}) {
  if (wiId == null) return null;
  if (!db) db = getDb();
  const { where, params } = buildWhere({ wiId, since });
  const rawRows = db.prepare(`
    SELECT id, work_item_id, job_id, parent_agent_call_id, child_kind,
           role, provider, model_tier, model_name,
           input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
           cost_estimate_usd, billing_precision, exact_billable_input_tokens,
           long_context_tier_input_tokens, provider_request_duration_ms,
           usage_segment_count, status, turns_used, output_truncated
    FROM agent_calls
    ${where}
  `).all(...params);
  const rows = attributeCostRows(rawRows, db);
  const segmentsByCall = preloadUsageSegments(rows, db);

  const totals = newCostAccumulator("totalCostUsd");
  const sourceCounts = {};
  const childBreakdowns = new Map();
  for (const raw of rows) {
    const usageSegments = segmentsByCall.get(Number(raw.id)) || [];
    const call = enrichCall(raw, db, usageSegments);
    accumulateChildBreakdown(childBreakdowns, call, usageSegments);
    accumulateCostCall(totals, call, "totalCostUsd");
    sourceCounts[call.cost_source] = (sourceCounts[call.cost_source] || 0) + 1;
  }
  finalizeCostAccumulator(totals, "totalCostUsd");
  return {
    wiId: Number(wiId),
    ...totals,
    costSourceCounts: sourceCounts,
    children: finalizeChildBreakdowns(childBreakdowns),
  };
}

/**
 * Aggregate cost grouped by one of `provider`, `role`, `tier`, `model`, or `wi`.
 * Returns an array sorted by cost descending.
 */
export function aggregateCost({ groupBy = "provider", wiId = null, since = null } = {}) {
  const keyFn = GROUP_FIELDS[groupBy] || GROUP_FIELDS.provider;
  const db = getDb();
  const { where, params } = buildWhere({ wiId, since });
  const rawRows = db.prepare(`
    SELECT id, work_item_id, job_id, parent_agent_call_id, child_kind,
           role, provider, model_tier, model_name,
           input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
           cost_estimate_usd, billing_precision, exact_billable_input_tokens,
           long_context_tier_input_tokens, provider_request_duration_ms,
           usage_segment_count, status, turns_used, output_truncated
    FROM agent_calls
    ${where}
  `).all(...params);
  const rows = attributeCostRows(rawRows, db);
  const segmentsByCall = preloadUsageSegments(rows, db);

  const groups = new Map();
  const grand = newCostAccumulator("totalCostUsd");
  const childBreakdowns = new Map();
  for (const raw of rows) {
    const usageSegments = segmentsByCall.get(Number(raw.id)) || [];
    const call = enrichCall(raw, db, usageSegments);
    accumulateChildBreakdown(childBreakdowns, call, usageSegments);
    const key = keyFn(call);
    if (!groups.has(key)) groups.set(key, { key, ...newCostAccumulator() });
    accumulateCostCall(groups.get(key), call);
    accumulateCostCall(grand, call, "totalCostUsd");
  }

  const out = [...groups.values()].sort((a, b) => b.costUsd - a.costUsd);
  const children = finalizeChildBreakdowns(childBreakdowns);
  for (const entry of out) {
    finalizeCostAccumulator(entry);
    if (groupBy === "role") {
      entry.children = children.filter((child) => child.parentRole === entry.key);
    }
  }
  finalizeCostAccumulator(grand, "totalCostUsd");
  // The grouped report has historically omitted callCount at the top level.
  delete grand.callCount;
  return { groupBy, ...grand, children, groups: out };
}

/**
 * Cross-WI summary for the `posse cost` no-arg case: top N most expensive
 * work items by total cost, plus grand totals.
 */
export function topWorkItemCosts({ since = null, limit = 20 } = {}) {
  const db = getDb();
  const { where, params } = buildWhere({ since });
  // Single scan: per-call cost needs the JS-side pricing resolution, so we
  // fetch every matching row once and group by work item here rather than
  // re-querying agent_calls per work item.
  const rows = db.prepare(`
    SELECT id, work_item_id, job_id, role, provider, model_tier, model_name,
           input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens,
           cost_estimate_usd, billing_precision, exact_billable_input_tokens,
           long_context_tier_input_tokens, provider_request_duration_ms,
           usage_segment_count, status, turns_used, output_truncated
    FROM agent_calls
    ${where}
  `).all(...params);
  const segmentsByCall = preloadUsageSegments(rows, db);

  const byWi = new Map();
  const grand = newCostAccumulator("totalCostUsd");
  for (const raw of rows) {
    if (raw.work_item_id == null) continue;
    const call = enrichCall(raw, db, segmentsByCall.get(Number(raw.id)) || []);
    let entry = byWi.get(call.work_item_id);
    if (!entry) {
      entry = { wiId: call.work_item_id, ...newCostAccumulator("totalCostUsd") };
      byWi.set(call.work_item_id, entry);
    }
    accumulateCostCall(entry, call, "totalCostUsd");
    accumulateCostCall(grand, call, "totalCostUsd");
  }

  const enriched = [...byWi.values()];
  for (const entry of enriched) finalizeCostAccumulator(entry, "totalCostUsd");
  enriched.sort((a, b) => b.knownCostUsd - a.knownCostUsd);
  finalizeCostAccumulator(grand, "totalCostUsd");
  // The cross-WI report has historically omitted callCount at the top level.
  delete grand.callCount;
  return {
    ...grand,
    workItems: enriched.slice(0, limit),
    truncated: enriched.length > limit,
  };
}
