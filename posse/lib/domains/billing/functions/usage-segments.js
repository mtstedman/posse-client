import { getDb } from "../../../shared/storage/functions/index.js";
import { providerLongContextRateMultipliers } from "../../../catalog/provider-economics.js";
import { estimateBillableInputTokens, estimateCallCost } from "./pricing.js";

const SOURCES = new Set(["live", "rollout_recovered", "aggregate_only"]);
const PRECISIONS = new Set(["exact", "recovered_exact", "aggregate_only", "incomplete"]);

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

function positiveOrdinal(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

// Cache counters are subsets of the input counter. Every place that reports or
// compares call-level counters must apply the same containment so a single row
// cannot present one `cached` value to the aggregate match test and a different
// one to the surfaces that display it.
function clampCallCounters({
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  cacheCreationInputTokens = 0,
} = {}) {
  const input = count(inputTokens);
  const cached = Math.min(input, count(cachedInputTokens));
  return {
    inputTokens: input,
    outputTokens: count(outputTokens),
    cachedInputTokens: cached,
    cacheCreationInputTokens: Math.min(
      Math.max(0, input - cached),
      count(cacheCreationInputTokens),
    ),
  };
}

export function normalizeUsageSegment(segment = {}) {
  const agentCallId = Number(segment.agentCallId ?? segment.agent_call_id);
  const requestOrdinal = positiveOrdinal(segment.requestOrdinal ?? segment.request_ordinal);
  const provider = String(segment.provider || "").trim().toLowerCase();
  const modelName = String(segment.modelName ?? segment.model_name ?? "").trim();
  if (!Number.isInteger(agentCallId) || agentCallId <= 0) throw new Error("usage segment requires agentCallId");
  if (requestOrdinal == null) throw new Error("usage segment requires a positive requestOrdinal");
  if (!provider || !modelName) throw new Error("usage segment requires provider and modelName");
  const usageSource = SOURCES.has(segment.usageSource ?? segment.usage_source)
    ? (segment.usageSource ?? segment.usage_source)
    : "live";
  const precision = PRECISIONS.has(segment.precision)
    ? segment.precision
    : (usageSource === "rollout_recovered" ? "recovered_exact" : "exact");
  return {
    agentCallId,
    requestOrdinal,
    provider,
    modelName,
    inputTokens: count(segment.inputTokens ?? segment.input_tokens),
    cachedInputTokens: count(segment.cachedInputTokens ?? segment.cached_input_tokens),
    cacheCreationInputTokens: count(segment.cacheCreationInputTokens ?? segment.cache_creation_input_tokens),
    outputTokens: count(segment.outputTokens ?? segment.output_tokens),
    requestContextInputTokens: count(
      segment.requestContextInputTokens
      ?? segment.request_context_input_tokens
      ?? segment.inputTokens
      ?? segment.input_tokens,
    ),
    durationMs: segment.durationMs == null && segment.duration_ms == null
      ? null
      : count(segment.durationMs ?? segment.duration_ms),
    usageSource,
    precision,
  };
}

// Idempotent across live/recovery replay. A live exact record wins over a
// recovered copy; neither can be downgraded by aggregate/incomplete data.
export function recordUsageSegment(segment, { db = getDb() } = {}) {
  const row = normalizeUsageSegment(segment);
  db.prepare(`
    INSERT INTO provider_usage_segments (
      agent_call_id, request_ordinal, provider, model_name,
      input_tokens, cached_input_tokens, cache_creation_input_tokens,
      output_tokens, request_context_input_tokens, duration_ms,
      usage_source, precision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_call_id, request_ordinal) DO UPDATE SET
      provider = excluded.provider,
      model_name = excluded.model_name,
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      output_tokens = excluded.output_tokens,
      request_context_input_tokens = excluded.request_context_input_tokens,
      duration_ms = COALESCE(excluded.duration_ms, provider_usage_segments.duration_ms),
      usage_source = excluded.usage_source,
      precision = excluded.precision,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE CASE excluded.precision
      WHEN 'exact' THEN 4 WHEN 'recovered_exact' THEN 3
      WHEN 'aggregate_only' THEN 2 ELSE 1 END
      >= CASE provider_usage_segments.precision
      WHEN 'exact' THEN 4 WHEN 'recovered_exact' THEN 3
      WHEN 'aggregate_only' THEN 2 ELSE 1 END
  `).run(
    row.agentCallId, row.requestOrdinal, row.provider, row.modelName,
    row.inputTokens, row.cachedInputTokens, row.cacheCreationInputTokens,
    row.outputTokens, row.requestContextInputTokens, row.durationMs,
    row.usageSource, row.precision,
  );
  return db.prepare(`SELECT * FROM provider_usage_segments WHERE agent_call_id = ? AND request_ordinal = ?`)
    .get(row.agentCallId, row.requestOrdinal);
}

export function listUsageSegments(agentCallId, { db = getDb() } = {}) {
  try {
    return db.prepare(`SELECT * FROM provider_usage_segments WHERE agent_call_id = ? ORDER BY request_ordinal`)
      .all(agentCallId);
  } catch {
    return [];
  }
}

export function listUsageSegmentsForAgentCalls(agentCallIds, { db = getDb() } = {}) {
  const ids = [...new Set((agentCallIds || [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  const byAgentCallId = new Map(ids.map((id) => [id, []]));
  try {
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT * FROM provider_usage_segments
        WHERE agent_call_id IN (${placeholders})
        ORDER BY agent_call_id, request_ordinal
      `).all(...chunk);
      for (const row of rows) byAgentCallId.get(Number(row.agent_call_id))?.push(row);
    }
  } catch {
    // provider_usage_segments is absent in pre-migration/compatibility databases.
  }
  return byAgentCallId;
}

export function markUsageSegmentsIncomplete(agentCallId, { db = getDb() } = {}) {
  db.prepare(`
    UPDATE provider_usage_segments
    SET precision = 'incomplete', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE agent_call_id = ?
  `).run(agentCallId);
}

export function summarizeUsageSegments(agentCallId, {
  db = getDb(),
  modelTier = null,
  expectedTotals = null,
  usageSegments = null,
  queryExpectedTotals = true,
} = {}) {
  const segments = Array.isArray(usageSegments)
    ? usageSegments
    : listUsageSegments(agentCallId, { db });
  const exactSegmentState = segments.length > 0
    && segments.every((segment) => segment.precision === "exact" || segment.precision === "recovered_exact");
  const contiguous = segments.every((segment, index) => Number(segment.request_ordinal) === index + 1);
  let exact = exactSegmentState && contiguous;
  let mismatch = exactSegmentState && !contiguous;
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    longContextTierInputTokens: 0,
    durationMs: 0,
    billableInputTokens: exact ? 0 : null,
    costUsd: exact ? 0 : null,
  };
  let exactCostAvailable = exact;
  for (const segment of segments) {
    totals.inputTokens += count(segment.input_tokens);
    totals.cachedInputTokens += count(segment.cached_input_tokens);
    totals.cacheCreationInputTokens += count(segment.cache_creation_input_tokens);
    totals.outputTokens += count(segment.output_tokens);
    totals.durationMs += count(segment.duration_ms);
    const pricingInput = count(segment.request_context_input_tokens);
    if (providerLongContextRateMultipliers(
      segment.provider,
      segment.model_name,
      pricingInput,
    ).active) {
      totals.longContextTierInputTokens += count(segment.input_tokens);
    }
    if (exact) {
      const priced = estimateCallCost({
        provider: segment.provider,
        modelName: segment.model_name,
        modelTier,
        inputTokens: segment.input_tokens,
        outputTokens: segment.output_tokens,
        cachedInputTokens: segment.cached_input_tokens,
        cacheCreationInputTokens: segment.cache_creation_input_tokens,
        longContextInputTokens: pricingInput,
      });
      if (priced.source !== "none" && Number.isFinite(priced.costUsd)) totals.costUsd += priced.costUsd;
      else exactCostAvailable = false;
      totals.billableInputTokens += estimateBillableInputTokens({
        provider: segment.provider,
        modelName: segment.model_name,
        modelTier,
        inputTokens: segment.input_tokens,
        cachedInputTokens: segment.cached_input_tokens,
        cacheCreationInputTokens: segment.cache_creation_input_tokens,
        longContextInputTokens: pricingInput,
      }).billableInputTokens;
    }
  }
  if (!exactCostAvailable) totals.costUsd = null;
  let aggregate = expectedTotals;
  if (!aggregate && queryExpectedTotals) {
    try {
      const call = db.prepare(`
        SELECT input_tokens, output_tokens, cached_input_tokens, cache_creation_input_tokens
        FROM agent_calls WHERE id = ?
      `).get(agentCallId);
      if (call?.input_tokens != null && call?.output_tokens != null) aggregate = call;
    } catch { /* optional compatibility check */ }
  }
  // The reported segment counters and the aggregate they are matched against
  // are clamped identically, so the match test and every consumer that displays
  // the result read the same numbers.
  Object.assign(totals, clampCallCounters(totals));
  if (aggregate && segments.length > 0) {
    const expected = clampCallCounters({
      inputTokens: aggregate.inputTokens ?? aggregate.input_tokens,
      outputTokens: aggregate.outputTokens ?? aggregate.output_tokens,
      cachedInputTokens: aggregate.cachedInputTokens ?? aggregate.cached_input_tokens,
      cacheCreationInputTokens: aggregate.cacheCreationInputTokens ?? aggregate.cache_creation_input_tokens,
    });
    const aggregateMatches = totals.inputTokens === expected.inputTokens
      && totals.outputTokens === expected.outputTokens
      && totals.cachedInputTokens === expected.cachedInputTokens
      && totals.cacheCreationInputTokens === expected.cacheCreationInputTokens;
    mismatch ||= !aggregateMatches;
    exact &&= aggregateMatches;
    if (!exact) {
      totals.billableInputTokens = null;
      totals.costUsd = null;
    }
  }
  const incomplete = segments.some((segment) => segment.precision === "incomplete") || mismatch;
  return {
    agentCallId: Number(agentCallId),
    requestCount: segments.length,
    exact,
    precision: exact
      ? (segments.some((segment) => segment.precision === "recovered_exact") ? "recovered_exact" : "exact")
      : incomplete
        ? "incomplete"
        : segments.length > 0 || aggregate
          ? "aggregate_only"
          : "unknown",
    ...totals,
  };
}

function hasAggregateUsage(call = {}) {
  return (call.input_tokens ?? call.inputTokens) != null
    && (call.output_tokens ?? call.outputTokens) != null;
}

function estimatedAggregateCost(call, totals, longContextTierInputTokens = null) {
  const priced = estimateCallCost({
    provider: call.provider,
    modelName: call.model_name ?? call.modelName,
    modelTier: call.model_tier ?? call.modelTier,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens,
    knownCostUsd: call.cost_estimate_usd ?? call.costEstimateUsd,
    longContextInputTokens: longContextTierInputTokens,
  });
  return priced.source === "none" || !Number.isFinite(priced.costUsd)
    ? { costUsd: null, costSource: "none", costPrecision: "unknown" }
    : { costUsd: priced.costUsd, costSource: `aggregate:${priced.source}`, costPrecision: "estimated" };
}

export function resolveCanonicalCallAccounting(call = {}, {
  db = getDb(),
  usageSegments = null,
} = {}) {
  const {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
  } = clampCallCounters({
    inputTokens: call.input_tokens ?? call.inputTokens,
    outputTokens: call.output_tokens ?? call.outputTokens,
    cachedInputTokens: call.cached_input_tokens ?? call.cachedInputTokens,
    cacheCreationInputTokens: call.cache_creation_input_tokens ?? call.cacheCreationInputTokens,
  });
  const persistedLongContextTierInputTokens = call.long_context_tier_input_tokens
    ?? call.longContextTierInputTokens
    ?? null;
  const agentCallId = Number(call.id ?? call.agent_call_id ?? call.agentCallId) || null;
  const aggregateUsageAvailable = hasAggregateUsage(call);
  const segments = agentCallId
    ? summarizeUsageSegments(agentCallId, {
      db,
      modelTier: call.model_tier ?? call.modelTier,
      expectedTotals: aggregateUsageAvailable ? call : null,
      usageSegments,
      queryExpectedTotals: false,
    })
    : { requestCount: 0 };
  if (segments.requestCount > 0) {
    // ACC-1: incomplete segments cannot erase a complete provider aggregate.
    // Raw additive counters stay authoritative from the aggregate; only the
    // derived pricing quantities (exact price, billable tokens, and the
    // long-context tier split) stay unknown. With no aggregate to prefer the
    // segment sums remain the only known counters and are kept as they are.
    const aggregateOverridesIncompleteSegments = segments.precision === "incomplete"
      && aggregateUsageAvailable;
    // The long-context split is only knowable for the counters it was derived
    // from. When the aggregate replaces partial segment sums the split is
    // unknown; otherwise the segment-derived split describes exactly the
    // counters being reported. This single value is what pricing consumes and
    // what consumers display, so the row never carries two answers.
    const longContextTierInputTokens = aggregateOverridesIncompleteSegments
      ? null
      : segments.longContextTierInputTokens;
    const aggregateCost = segments.precision === "aggregate_only" && aggregateUsageAvailable
      ? estimatedAggregateCost(call, {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
      }, longContextTierInputTokens)
      : null;
    const costUsd = segments.exact ? segments.costUsd : aggregateCost?.costUsd ?? null;
    return {
      inputTokens: aggregateOverridesIncompleteSegments ? inputTokens : segments.inputTokens,
      outputTokens: aggregateOverridesIncompleteSegments ? outputTokens : segments.outputTokens,
      cachedInputTokens: aggregateOverridesIncompleteSegments
        ? cachedInputTokens
        : segments.cachedInputTokens,
      cacheCreationInputTokens: aggregateOverridesIncompleteSegments
        ? cacheCreationInputTokens
        : segments.cacheCreationInputTokens,
      billableInputTokens: segments.billableInputTokens,
      billableTokens: segments.exact ? segments.billableInputTokens + segments.outputTokens : null,
      costUsd,
      costSource: segments.exact
        ? `segments:${segments.precision}`
        : aggregateCost?.costSource ?? `segments:${segments.precision}`,
      costPrecision: segments.exact && costUsd != null
        ? "exact"
        : aggregateCost?.costPrecision ?? "unknown",
      precision: segments.precision,
      exact: segments.exact,
      requestCount: segments.requestCount,
      durationMs: segments.durationMs,
      longContextTierInputTokens,
    };
  }
  const persistedPrecision = String(call.billing_precision ?? call.billingPrecision ?? "").trim();
  if (persistedPrecision === "unknown"
    || persistedPrecision === "incomplete"
    || persistedPrecision === "exact"
    || persistedPrecision === "recovered_exact") {
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      billableInputTokens: null,
      billableTokens: null,
      costUsd: null,
      costSource: persistedPrecision === "unknown" ? "none" : `segments:${persistedPrecision}`,
      costPrecision: "unknown",
      precision: persistedPrecision === "unknown" ? "unknown" : "incomplete",
      exact: false,
      requestCount: count(call.usage_segment_count ?? call.usageSegmentCount),
      durationMs: call.provider_request_duration_ms ?? call.providerRequestDurationMs ?? null,
      // Same identity as the segment branch above: the counters reported here
      // are the aggregate columns, while the persisted long-context split was
      // derived from segment coverage that is no longer readable, so it cannot
      // be attributed to them.
      longContextTierInputTokens: null,
    };
  }
  const aggregateCost = aggregateUsageAvailable
    ? estimatedAggregateCost(call, {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
    }, persistedLongContextTierInputTokens)
    : { costUsd: null, costSource: "none", costPrecision: "unknown" };
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    billableInputTokens: null,
    billableTokens: null,
    costUsd: aggregateCost.costUsd,
    costSource: aggregateCost.costSource,
    costPrecision: aggregateCost.costPrecision,
    precision: aggregateUsageAvailable ? "aggregate_only" : "unknown",
    exact: false,
    requestCount: 0,
    durationMs: call.provider_request_duration_ms ?? call.providerRequestDurationMs ?? null,
    // No segment accounting was ever recorded for this row, so the persisted
    // column is call-scoped by construction and is both reported and priced.
    longContextTierInputTokens: persistedLongContextTierInputTokens,
  };
}
