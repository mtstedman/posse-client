import { estimateTokensFromChars } from "../../../settings/functions/context-compaction.js";

export function defaultResolveCallCostEstimate(stats) {
  const candidates = [
    stats?.costUsd,
    stats?.cost_usd,
    stats?.estimatedCostUsd,
    stats?.totalCostUsd,
    stats?.total_cost_usd,
  ];
  for (const value of candidates) {
    if (value == null || String(value).trim() === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

export function nonNegativeTokenCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : null;
}

function providerUsageStatus(stats, { measured, unavailable } = {}) {
  if (unavailable) return "unavailable_after_terminal_stop";
  if (measured && stats.usagePartialAfterStop === true) return "measured_partial_after_terminal_stop";
  if (stats.usageEstimated === true || stats.usageCapturePrecision === "unknown") return "estimated";
  if (!measured) return "unavailable";
  return stats.tokenUsageSource === "codex_rollout"
    ? "measured_codex_rollout"
    : "measured";
}

export function buildAccountingStats(stats, {
  inputTokens,
  outputTokens,
  outputChars,
  durationMs = stats.durationMs,
  exitCode,
  providerUsageStatus: usageStatus,
  providerName,
  modelTier,
  modelName,
  resolvedMaxOutputTokens,
  outputTruncated = stats.outputTruncated === true,
  outputLimitReason = stats.outputLimitReason || null,
  providerStopCode = null,
  // The cache counters that belong with inputTokens/outputTokens. An exact
  // terminal lower bound takes all four from the segment sums.
  cachedInputTokens = stats.cachedInputTokens,
  cacheCreationInputTokens = stats.cacheCreationInputTokens,
} = {}) {
  const measured = inputTokens != null && outputTokens != null;
  return {
    ...stats,
    inputTokens,
    outputTokens,
    cachedInputTokens: measured ? (cachedInputTokens ?? null) : null,
    cacheCreationInputTokens: measured ? (cacheCreationInputTokens ?? null) : null,
    reasoningOutputTokens: measured ? (stats.reasoningOutputTokens ?? null) : null,
    outputChars,
    durationMs,
    exitCode,
    providerUsageStatus: usageStatus,
    ...(providerStopCode ? { providerStopCode } : {}),
    provider: providerName,
    modelTier,
    modelName: stats.modelName || modelName,
    maxOutputTokens: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
    outputTruncated,
    outputLimitReason,
  };
}

export function completionAccountingFields({
  stats,
  accountingStats,
  segmentSummary,
  providerUsageMeasured,
  providerUsageStatus: usageStatus,
  resolvedMaxTurns,
  resolvedMaxOutputTokens,
  opts,
  resolveCallCostEstimate,
} = {}) {
  const aggregateEstimateAvailable = providerUsageMeasured
    && segmentSummary.precision === "aggregate_only";
  return {
    input_tokens: accountingStats.inputTokens,
    output_tokens: accountingStats.outputTokens,
    reasoning_output_tokens: accountingStats.reasoningOutputTokens,
    cached_input_tokens: accountingStats.cachedInputTokens,
    cache_creation_input_tokens: accountingStats.cacheCreationInputTokens,
    turns_used: stats.numTurns ?? null,
    max_turns_configured: stats.maxTurns ?? resolvedMaxTurns,
    max_output_tokens_configured: stats.maxOutputTokens ?? resolvedMaxOutputTokens,
    output_truncated: accountingStats.outputTruncated,
    output_limit_reason: accountingStats.outputLimitReason,
    duration_ms: accountingStats.durationMs,
    exit_code: accountingStats.exitCode,
    atlas_method: opts.disableAtlas ? null : (stats.atlasMethod || opts.atlasMethod || null),
    atlas_prefetch_status: opts.disableAtlas ? null : (opts.atlasPrefetchStatus || null),
    cost_estimate_usd: segmentSummary.exact
      ? segmentSummary.costUsd
      : aggregateEstimateAvailable
        ? resolveCallCostEstimate(accountingStats)
        : null,
    provider_usage_status: usageStatus,
    billing_precision: segmentSummary.precision,
    exact_billable_input_tokens: segmentSummary.exact ? segmentSummary.billableInputTokens : null,
    long_context_tier_input_tokens: segmentSummary.longContextTierInputTokens,
    // Provider time measured by the usage segments only. The call's wall time
    // is already duration_ms; copying it here would hide that no segment
    // measured its request.
    provider_request_duration_ms: segmentSummary.durationMs ?? null,
    usage_segment_count: segmentSummary.requestCount,
    skills: opts.skillsAttached || null,
    session_handle: stats.sessionHandle || stats.responseId || null,
  };
}

export function contextPressureMetrics({ stats = {}, promptChars = 0, requestContextInputTokens = null } = {}) {
  const inputTokens = nonNegativeTokenCount(stats.inputTokens);
  const outputTokens = nonNegativeTokenCount(stats.outputTokens);
  const cachedInputTokens = nonNegativeTokenCount(stats.cachedInputTokens) || 0;
  const cacheCreationInputTokens = nonNegativeTokenCount(stats.cacheCreationInputTokens) || 0;
  const promptEstimateTokens = estimateTokensFromChars(promptChars);
  // Pressure is a property of one request's context window. stats.inputTokens
  // is billed input summed over every request of the call (1.1M over 21 Codex
  // requests in the 2026-10-01 run), so the largest single request is used
  // whenever it is known; the cumulative figure stays for the cache ratios.
  const peakRequestTokens = [requestContextInputTokens, stats.longContextInputTokens]
    .map((value) => (value == null ? null : nonNegativeTokenCount(value)))
    .find((value) => value != null && value > 0) ?? null;
  const billedInputTokens = inputTokens ?? promptEstimateTokens;
  const observedInputTokens = peakRequestTokens ?? billedInputTokens;
  const uncachedInputTokensApprox = Math.max(0, billedInputTokens - cachedInputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    promptEstimateTokens,
    requestContextInputTokens: peakRequestTokens,
    observedInputTokens,
    observedInputBasis: peakRequestTokens != null
      ? "request_peak"
      : inputTokens != null ? "cumulative_input" : "prompt_estimate",
    observedInputTokensEstimated: peakRequestTokens == null && inputTokens == null,
    uncachedInputTokensApprox,
    cachedInputRatio: billedInputTokens > 0 ? cachedInputTokens / billedInputTokens : null,
  };
}

export function resolveProviderAccounting(deps, {
  agentCallId,
  providerName,
  modelTier,
  modelName,
  stats,
  terminalUsageUnavailable = false,
  missingUsagePrecision = "unknown",
}) {
  const providerUsageMeasured = !terminalUsageUnavailable
    && stats.inputTokens != null
    && stats.outputTokens != null
    && stats.usageEstimated !== true
    && stats.usageCapturePrecision !== "unknown";
  const captureIncomplete = terminalUsageUnavailable
    || stats.usageCapturePrecision === "incomplete"
    || (!providerUsageMeasured && missingUsagePrecision === "incomplete");
  let usageStatus = providerUsageStatus(stats, {
    measured: providerUsageMeasured,
    unavailable: terminalUsageUnavailable,
  });
  const expectedTotals = providerUsageMeasured ? {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cachedInputTokens: stats.cachedInputTokens,
    cacheCreationInputTokens: stats.cacheCreationInputTokens,
  } : null;
  let segmentSummary = deps.summarizeUsageSegments(agentCallId, {
    modelTier,
    expectedTotals,
  });
  // Completed request segments remain exact even when a terminal stop may
  // have prevented a later request from reporting. The call is a measured
  // lower bound; its status carries that qualification separately.
  const exactTerminalLowerBound = (terminalUsageUnavailable || stats.usagePartialAfterStop === true)
    && segmentSummary.exact === true;
  if (exactTerminalLowerBound) usageStatus = "measured_lower_bound";
  else if (captureIncomplete) {
    deps.markUsageSegmentsIncomplete(agentCallId);
    segmentSummary = deps.summarizeUsageSegments(agentCallId, { modelTier, expectedTotals });
  }
  if (!providerUsageMeasured && segmentSummary.requestCount === 0) {
    segmentSummary = {
      ...segmentSummary,
      exact: false,
      precision: captureIncomplete ? "incomplete" : missingUsagePrecision,
      costUsd: null,
      billableInputTokens: null,
    };
  }
  if (providerUsageMeasured && segmentSummary.requestCount === 0) {
    deps.recordUsageSegment({
      agentCallId,
      requestOrdinal: 1,
      provider: providerName,
      modelName: stats.modelName || modelName,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cachedInputTokens: stats.cachedInputTokens,
      cacheCreationInputTokens: stats.cacheCreationInputTokens,
      cacheCreation5mTokens: stats.cacheCreation5mTokens ?? null,
      cacheCreation1hTokens: stats.cacheCreation1hTokens ?? null,
      requestContextInputTokens: stats.longContextInputTokens ?? stats.inputTokens,
      durationMs: stats.durationMs,
      usageSource: "aggregate_only",
      precision: captureIncomplete ? "incomplete" : "aggregate_only",
    });
    segmentSummary = deps.summarizeUsageSegments(agentCallId, {
      modelTier,
      expectedTotals,
    });
  }
  if (captureIncomplete && !exactTerminalLowerBound && !segmentSummary.exact) {
    segmentSummary = {
      ...segmentSummary,
      precision: "incomplete",
      costUsd: null,
      billableInputTokens: null,
    };
  }
  return {
    providerUsageMeasured,
    providerUsageStatus: usageStatus,
    segmentSummary,
    accountingInputTokens: exactTerminalLowerBound ? segmentSummary.inputTokens
      : providerUsageMeasured ? stats.inputTokens : null,
    accountingOutputTokens: exactTerminalLowerBound ? segmentSummary.outputTokens
      : providerUsageMeasured ? stats.outputTokens : null,
    // The cache counters follow the same source as input/output, so a
    // lower-bound row prices its segment-sum input with the cache split
    // those segments measured instead of stale or absent terminal stats.
    accountingCachedInputTokens: exactTerminalLowerBound ? segmentSummary.cachedInputTokens
      : providerUsageMeasured ? (stats.cachedInputTokens ?? null) : null,
    accountingCacheCreationInputTokens: exactTerminalLowerBound ? segmentSummary.cacheCreationInputTokens
      : providerUsageMeasured ? (stats.cacheCreationInputTokens ?? null) : null,
  };
}
