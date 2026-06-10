// lib/cost.js
//
// Cost aggregator for agent_calls. Reads token counts per call, resolves a
// per-call USD cost via lib/pricing.js, and groups the results by work item,
// role, provider, or tier. The cost_estimate_usd column on agent_calls is
// preferred when present (provider-authoritative); otherwise we estimate on
// the fly with token × rate math.

import { getDb } from "../../../shared/storage/functions/index.js";
import { estimateCallCost } from "./pricing.js";

const GROUP_FIELDS = Object.freeze({
  provider: (call) => call.provider || "unknown",
  role: (call) => call.role || "unknown",
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

function enrichCall(call) {
  const inputTokens = Number(call.input_tokens) || 0;
  const outputTokens = Number(call.output_tokens) || 0;
  const cachedInputTokens = Number(call.cached_input_tokens) || 0;
  const est = estimateCallCost({
    provider: call.provider,
    modelName: call.model_name,
    modelTier: call.model_tier,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    knownCostUsd: call.cost_estimate_usd,
  });
  return {
    ...call,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    resolved_cost_usd: est.costUsd,
    cost_source: est.source,
  };
}

/**
 * Total cost for a single work item.
 * Returns { wiId, totalCostUsd, inputTokens, outputTokens, callCount, costSourceCounts, unknownCostCalls }.
 */
export function workItemCost(wiId, { since = null } = {}) {
  if (wiId == null) return null;
  const db = getDb();
  const { where, params } = buildWhere({ wiId, since });
  const rows = db.prepare(`
    SELECT work_item_id, job_id, role, provider, model_tier, model_name,
           input_tokens, output_tokens, cached_input_tokens, cost_estimate_usd, status
    FROM agent_calls
    ${where}
  `).all(...params);

  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const sourceCounts = {};
  let unknownCostCalls = 0;
  for (const raw of rows) {
    const call = enrichCall(raw);
    totalCost += call.resolved_cost_usd || 0;
    totalInput += call.input_tokens || 0;
    totalOutput += call.output_tokens || 0;
    sourceCounts[call.cost_source] = (sourceCounts[call.cost_source] || 0) + 1;
    if (call.cost_source === "none") unknownCostCalls += 1;
  }

  return {
    wiId: Number(wiId),
    totalCostUsd: totalCost,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    callCount: rows.length,
    costSourceCounts: sourceCounts,
    unknownCostCalls,
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
  const rows = db.prepare(`
    SELECT work_item_id, job_id, role, provider, model_tier, model_name,
           input_tokens, output_tokens, cached_input_tokens, cost_estimate_usd, status
    FROM agent_calls
    ${where}
  `).all(...params);

  const groups = new Map();
  let grandCost = 0;
  for (const raw of rows) {
    const call = enrichCall(raw);
    const key = keyFn(call);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unknownCostCalls: 0,
      });
    }
    const entry = groups.get(key);
    entry.callCount += 1;
    entry.inputTokens += call.input_tokens || 0;
    entry.outputTokens += call.output_tokens || 0;
    entry.costUsd += call.resolved_cost_usd || 0;
    if (call.cost_source === "none") entry.unknownCostCalls += 1;
    grandCost += call.resolved_cost_usd || 0;
  }

  const out = [...groups.values()].sort((a, b) => b.costUsd - a.costUsd);
  return {
    groupBy,
    totalCostUsd: grandCost,
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
  const rows = db.prepare(`
    SELECT DISTINCT work_item_id
    FROM agent_calls
    ${where}
  `).all(...params);

  const enriched = rows
    .filter((row) => row.work_item_id != null)
    .map((row) => {
      const wiCost = workItemCost(row.work_item_id, { since });
      return {
        wiId: row.work_item_id,
        callCount: wiCost.callCount,
        inputTokens: wiCost.inputTokens,
        outputTokens: wiCost.outputTokens,
        totalCostUsd: wiCost.totalCostUsd,
        unknownCostCalls: wiCost.unknownCostCalls,
      };
    });

  enriched.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  const trimmed = enriched.slice(0, limit);
  const grandCost = enriched.reduce((acc, e) => acc + e.totalCostUsd, 0);
  return {
    totalCostUsd: grandCost,
    workItems: trimmed,
    truncated: enriched.length > limit,
  };
}
