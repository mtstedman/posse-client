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

  let totalCost = 0;
  let totalInput = 0;
  let totalCachedInput = 0;
  let totalBillableInput = 0;
  let totalOutput = 0;
  let totalTurns = 0;
  let outputTruncatedCalls = 0;
  const sourceCounts = {};
  let unknownCostCalls = 0;
  let exactCostCalls = 0;
  let estimatedCostCalls = 0;
  let exactUsageCalls = 0;
  let inexactUsageCalls = 0;
  const childBreakdowns = new Map();
  for (const raw of rows) {
    const usageSegments = segmentsByCall.get(Number(raw.id)) || [];
    const call = enrichCall(raw, db, usageSegments);
    accumulateChildBreakdown(childBreakdowns, call, usageSegments);
    if (Number.isFinite(call.resolved_cost_usd)) totalCost += call.resolved_cost_usd;
    totalInput += call.input_tokens || 0;
    totalCachedInput += call.cached_input_tokens || 0;
    totalBillableInput += call.billable_input_tokens || 0;
    totalOutput += call.output_tokens || 0;
    totalTurns += call.turns_used || 0;
    if (call.output_truncated) outputTruncatedCalls += 1;
    sourceCounts[call.cost_source] = (sourceCounts[call.cost_source] || 0) + 1;
    if (call.cost_precision === "exact") exactCostCalls += 1;
    else if (call.cost_precision === "estimated") estimatedCostCalls += 1;
    else unknownCostCalls += 1;
    if (call.exact_usage === true) exactUsageCalls += 1;
    else if (call.exact_usage === false) inexactUsageCalls += 1;
  }

  const rollupCostPrecision = costPrecision({
    callCount: rows.length,
    exactCostCalls,
    estimatedCostCalls,
    unknownCostCalls,
  });
  return {
    wiId: Number(wiId),
    totalCostUsd: exposedCostUsd(totalCost, rollupCostPrecision),
    knownCostUsd: totalCost,
    costPrecision: rollupCostPrecision,
    inputTokens: totalInput,
    cachedInputTokens: totalCachedInput,
    uncachedInputTokens: Math.max(0, totalInput - totalCachedInput),
    billableInputTokens: totalBillableInput,
    billableTokens: inexactUsageCalls > 0 ? null : totalBillableInput + totalOutput,
    outputTokens: totalOutput,
    turnsUsed: totalTurns,
    outputTruncatedCalls,
    cacheDiscountRatio: inexactUsageCalls > 0 ? null : aggregateCacheDiscountRatio(totalInput, totalBillableInput),
    costPer1kOutputTokensUsd: inexactUsageCalls > 0 ? null : costPer1kOutputTokens(totalCost, totalOutput),
    callCount: rows.length,
    costSourceCounts: sourceCounts,
    unknownCostCalls,
    exactCostCalls,
    estimatedCostCalls,
    exactUsageCalls,
    inexactUsageCalls,
    exactUsageCoverage: exactUsageCalls + inexactUsageCalls > 0
      ? exactUsageCalls / (exactUsageCalls + inexactUsageCalls)
      : null,
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
  let grandCost = 0;
  let totalInput = 0;
  let totalCachedInput = 0;
  let totalBillableInput = 0;
  let totalOutput = 0;
  const childBreakdowns = new Map();
  for (const raw of rows) {
    const usageSegments = segmentsByCall.get(Number(raw.id)) || [];
    const call = enrichCall(raw, db, usageSegments);
    accumulateChildBreakdown(childBreakdowns, call, usageSegments);
    const key = keyFn(call);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        callCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        billableInputTokens: 0,
        outputTokens: 0,
        turnsUsed: 0,
        outputTruncatedCalls: 0,
        costUsd: 0,
        unknownCostCalls: 0,
        exactCostCalls: 0,
        estimatedCostCalls: 0,
        exactUsageCalls: 0,
        inexactUsageCalls: 0,
      });
    }
    const entry = groups.get(key);
    entry.callCount += 1;
    entry.inputTokens += call.input_tokens || 0;
    entry.cachedInputTokens += call.cached_input_tokens || 0;
    entry.billableInputTokens += call.billable_input_tokens || 0;
    entry.outputTokens += call.output_tokens || 0;
    entry.turnsUsed += call.turns_used || 0;
    if (call.output_truncated) entry.outputTruncatedCalls += 1;
    if (Number.isFinite(call.resolved_cost_usd)) entry.costUsd += call.resolved_cost_usd;
    if (call.cost_precision === "exact") entry.exactCostCalls += 1;
    else if (call.cost_precision === "estimated") entry.estimatedCostCalls += 1;
    else entry.unknownCostCalls += 1;
    if (call.exact_usage === true) entry.exactUsageCalls += 1;
    else if (call.exact_usage === false) entry.inexactUsageCalls += 1;
    if (Number.isFinite(call.resolved_cost_usd)) grandCost += call.resolved_cost_usd;
    totalInput += call.input_tokens || 0;
    totalCachedInput += call.cached_input_tokens || 0;
    totalBillableInput += call.billable_input_tokens || 0;
    totalOutput += call.output_tokens || 0;
  }

  const out = [...groups.values()].sort((a, b) => b.costUsd - a.costUsd);
  const children = finalizeChildBreakdowns(childBreakdowns);
  for (const entry of out) {
    entry.knownCostUsd = entry.costUsd;
    entry.costPrecision = costPrecision(entry);
    entry.costUsd = exposedCostUsd(entry.knownCostUsd, entry.costPrecision);
    entry.uncachedInputTokens = Math.max(0, entry.inputTokens - entry.cachedInputTokens);
    entry.billableTokens = entry.inexactUsageCalls > 0 ? null : entry.billableInputTokens + entry.outputTokens;
    entry.cacheDiscountRatio = entry.inexactUsageCalls > 0
      ? null
      : aggregateCacheDiscountRatio(entry.inputTokens, entry.billableInputTokens);
    entry.costPer1kOutputTokensUsd = entry.inexactUsageCalls > 0
      ? null
      : costPer1kOutputTokens(entry.knownCostUsd, entry.outputTokens);
    entry.exactUsageCoverage = entry.exactUsageCalls + entry.inexactUsageCalls > 0
      ? entry.exactUsageCalls / (entry.exactUsageCalls + entry.inexactUsageCalls)
      : null;
    if (groupBy === "role") {
      entry.children = children.filter((child) => child.parentRole === entry.key);
    }
  }
  const totalCallCount = rows.length;
  const totalUnknownCostCalls = out.reduce((acc, entry) => acc + entry.unknownCostCalls, 0);
  const totalExactCostCalls = out.reduce((acc, entry) => acc + entry.exactCostCalls, 0);
  const totalEstimatedCostCalls = out.reduce((acc, entry) => acc + entry.estimatedCostCalls, 0);
  const rollupCostPrecision = costPrecision({
    callCount: totalCallCount,
    exactCostCalls: totalExactCostCalls,
    estimatedCostCalls: totalEstimatedCostCalls,
    unknownCostCalls: totalUnknownCostCalls,
  });
  return {
    groupBy,
    totalCostUsd: exposedCostUsd(grandCost, rollupCostPrecision),
    knownCostUsd: grandCost,
    costPrecision: rollupCostPrecision,
    inputTokens: totalInput,
    cachedInputTokens: totalCachedInput,
    uncachedInputTokens: Math.max(0, totalInput - totalCachedInput),
    billableInputTokens: totalBillableInput,
    billableTokens: out.some((entry) => entry.inexactUsageCalls > 0)
      ? null
      : totalBillableInput + totalOutput,
    outputTokens: totalOutput,
    turnsUsed: out.reduce((acc, entry) => acc + (entry.turnsUsed || 0), 0),
    outputTruncatedCalls: out.reduce((acc, entry) => acc + (entry.outputTruncatedCalls || 0), 0),
    unknownCostCalls: totalUnknownCostCalls,
    exactCostCalls: totalExactCostCalls,
    estimatedCostCalls: totalEstimatedCostCalls,
    exactUsageCalls: out.reduce((acc, entry) => acc + entry.exactUsageCalls, 0),
    inexactUsageCalls: out.reduce((acc, entry) => acc + entry.inexactUsageCalls, 0),
    exactUsageCoverage: (() => {
      const exact = out.reduce((acc, entry) => acc + entry.exactUsageCalls, 0);
      const inexact = out.reduce((acc, entry) => acc + entry.inexactUsageCalls, 0);
      return exact + inexact > 0 ? exact / (exact + inexact) : null;
    })(),
    cacheDiscountRatio: out.some((entry) => entry.inexactUsageCalls > 0)
      ? null
      : aggregateCacheDiscountRatio(totalInput, totalBillableInput),
    costPer1kOutputTokensUsd: out.some((entry) => entry.inexactUsageCalls > 0)
      ? null
      : costPer1kOutputTokens(grandCost, totalOutput),
    children,
    groups: out,
  };
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
  for (const raw of rows) {
    if (raw.work_item_id == null) continue;
    const call = enrichCall(raw, db, segmentsByCall.get(Number(raw.id)) || []);
    let entry = byWi.get(call.work_item_id);
    if (!entry) {
      entry = {
        wiId: call.work_item_id,
        callCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        billableInputTokens: 0,
        outputTokens: 0,
        turnsUsed: 0,
        outputTruncatedCalls: 0,
        totalCostUsd: 0,
        unknownCostCalls: 0,
        exactCostCalls: 0,
        estimatedCostCalls: 0,
        exactUsageCalls: 0,
        inexactUsageCalls: 0,
      };
      byWi.set(call.work_item_id, entry);
    }
    entry.callCount += 1;
    entry.inputTokens += call.input_tokens || 0;
    entry.cachedInputTokens += call.cached_input_tokens || 0;
    entry.billableInputTokens += call.billable_input_tokens || 0;
    entry.outputTokens += call.output_tokens || 0;
    entry.turnsUsed += call.turns_used || 0;
    if (call.output_truncated) entry.outputTruncatedCalls += 1;
    if (Number.isFinite(call.resolved_cost_usd)) entry.totalCostUsd += call.resolved_cost_usd;
    if (call.cost_precision === "exact") entry.exactCostCalls += 1;
    else if (call.cost_precision === "estimated") entry.estimatedCostCalls += 1;
    else entry.unknownCostCalls += 1;
    if (call.exact_usage === true) entry.exactUsageCalls += 1;
    else if (call.exact_usage === false) entry.inexactUsageCalls += 1;
  }

  const enriched = [...byWi.values()];
  for (const entry of enriched) {
    entry.knownCostUsd = entry.totalCostUsd;
    entry.costPrecision = costPrecision(entry);
    entry.totalCostUsd = exposedCostUsd(entry.knownCostUsd, entry.costPrecision);
    entry.uncachedInputTokens = Math.max(0, entry.inputTokens - entry.cachedInputTokens);
    entry.billableTokens = entry.inexactUsageCalls > 0 ? null : entry.billableInputTokens + entry.outputTokens;
    entry.cacheDiscountRatio = entry.inexactUsageCalls > 0
      ? null
      : aggregateCacheDiscountRatio(entry.inputTokens, entry.billableInputTokens);
    entry.costPer1kOutputTokensUsd = entry.inexactUsageCalls > 0
      ? null
      : costPer1kOutputTokens(entry.knownCostUsd, entry.outputTokens);
    entry.exactUsageCoverage = entry.exactUsageCalls + entry.inexactUsageCalls > 0
      ? entry.exactUsageCalls / (entry.exactUsageCalls + entry.inexactUsageCalls)
      : null;
  }
  enriched.sort((a, b) => b.knownCostUsd - a.knownCostUsd);
  const trimmed = enriched.slice(0, limit);
  const grandCost = enriched.reduce((acc, e) => acc + e.knownCostUsd, 0);
  const totalInput = enriched.reduce((acc, e) => acc + e.inputTokens, 0);
  const totalCachedInput = enriched.reduce((acc, e) => acc + e.cachedInputTokens, 0);
  const totalBillableInput = enriched.reduce((acc, e) => acc + e.billableInputTokens, 0);
  const totalOutput = enriched.reduce((acc, e) => acc + e.outputTokens, 0);
  const totalCallCount = enriched.reduce((acc, entry) => acc + entry.callCount, 0);
  const totalUnknownCostCalls = enriched.reduce((acc, entry) => acc + entry.unknownCostCalls, 0);
  const totalExactCostCalls = enriched.reduce((acc, entry) => acc + entry.exactCostCalls, 0);
  const totalEstimatedCostCalls = enriched.reduce((acc, entry) => acc + entry.estimatedCostCalls, 0);
  const rollupCostPrecision = costPrecision({
    callCount: totalCallCount,
    exactCostCalls: totalExactCostCalls,
    estimatedCostCalls: totalEstimatedCostCalls,
    unknownCostCalls: totalUnknownCostCalls,
  });
  return {
    totalCostUsd: exposedCostUsd(grandCost, rollupCostPrecision),
    knownCostUsd: grandCost,
    costPrecision: rollupCostPrecision,
    inputTokens: totalInput,
    cachedInputTokens: totalCachedInput,
    uncachedInputTokens: Math.max(0, totalInput - totalCachedInput),
    billableInputTokens: totalBillableInput,
    billableTokens: enriched.some((entry) => entry.inexactUsageCalls > 0)
      ? null
      : totalBillableInput + totalOutput,
    outputTokens: totalOutput,
    turnsUsed: enriched.reduce((acc, e) => acc + (e.turnsUsed || 0), 0),
    outputTruncatedCalls: enriched.reduce((acc, e) => acc + (e.outputTruncatedCalls || 0), 0),
    unknownCostCalls: totalUnknownCostCalls,
    exactCostCalls: totalExactCostCalls,
    estimatedCostCalls: totalEstimatedCostCalls,
    exactUsageCalls: enriched.reduce((acc, entry) => acc + entry.exactUsageCalls, 0),
    inexactUsageCalls: enriched.reduce((acc, entry) => acc + entry.inexactUsageCalls, 0),
    exactUsageCoverage: (() => {
      const exact = enriched.reduce((acc, entry) => acc + entry.exactUsageCalls, 0);
      const inexact = enriched.reduce((acc, entry) => acc + entry.inexactUsageCalls, 0);
      return exact + inexact > 0 ? exact / (exact + inexact) : null;
    })(),
    cacheDiscountRatio: enriched.some((entry) => entry.inexactUsageCalls > 0)
      ? null
      : aggregateCacheDiscountRatio(totalInput, totalBillableInput),
    costPer1kOutputTokensUsd: enriched.some((entry) => entry.inexactUsageCalls > 0)
      ? null
      : costPer1kOutputTokens(grandCost, totalOutput),
    workItems: trimmed,
    truncated: enriched.length > limit,
  };
}
