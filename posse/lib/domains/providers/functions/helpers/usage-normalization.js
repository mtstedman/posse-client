function usageNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstUsageNumber(...values) {
  for (const value of values) {
    const n = usageNumber(value);
    if (n != null) return n;
  }
  return null;
}

export function normalizeProviderUsage(providerName, usage = {}, { stderrTokens = {} } = {}) {
  const provider = String(providerName || "").toLowerCase();
  const inputDetails = usage?.input_tokens_details || usage?.prompt_tokens_details || {};
  const outputDetails = usage?.output_tokens_details || usage?.completion_tokens_details || {};

  if (provider === "claude") {
    const regularInput = usageNumber(usage?.input_tokens) ?? null;
    const cacheCreationInput = usageNumber(usage?.cache_creation_input_tokens) ?? 0;
    const cacheReadInput = usageNumber(usage?.cache_read_input_tokens) ?? 0;
    const usageInput = [regularInput, cacheCreationInput, cacheReadInput]
      .reduce((sum, value) => (value == null ? sum : sum + value), 0);
    const hasUsageInput = (
      usage?.input_tokens != null
      || usage?.cache_creation_input_tokens != null
      || usage?.cache_read_input_tokens != null
    );
    return {
      inputTokens: hasUsageInput ? usageInput : (usageNumber(stderrTokens?.input) ?? null),
      outputTokens: usageNumber(usage?.output_tokens) ?? usageNumber(stderrTokens?.output) ?? null,
      cacheCreationInputTokens: cacheCreationInput || null,
      cacheReadInputTokens: cacheReadInput || null,
      cachedInputTokens: cacheReadInput || null,
      reasoningOutputTokens: firstUsageNumber(outputDetails.reasoning_tokens, usage?.reasoning_tokens),
    };
  }

  return {
    inputTokens: firstUsageNumber(
      usage?.input_tokens,
      usage?.prompt_tokens,
      usage?.total_input_tokens,
      usage?.total_prompt_tokens,
    ),
    outputTokens: firstUsageNumber(
      usage?.output_tokens,
      usage?.completion_tokens,
      usage?.total_output_tokens,
      usage?.total_completion_tokens,
    ),
    cachedInputTokens: firstUsageNumber(
      inputDetails.cached_tokens,
      usage?.cached_input_tokens,
      usage?.cache_read_input_tokens,
    ),
    cacheCreationInputTokens: firstUsageNumber(usage?.cache_creation_input_tokens),
    cacheReadInputTokens: firstUsageNumber(usage?.cache_read_input_tokens),
    reasoningOutputTokens: firstUsageNumber(
      outputDetails.reasoning_tokens,
      usage?.reasoning_tokens,
    ),
  };
}
