// Pure provider/model economics used by billing and live admission controls.
// Keep thresholds here so pricing, the MCP owner, and reporting cannot drift.

const OPENAI_LONG_CONTEXT_THRESHOLD = 272_000;

const MODEL_ECONOMICS = Object.freeze([
  Object.freeze({
    providers: Object.freeze(["openai", "codex"]),
    model: /^gpt-5\.(4|5)(?:-|$)/,
    exclude: /^gpt-5\.(4|5)-(mini|nano)(?:-|$)/,
    longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD,
    inputRateMultiplier: 2,
    cachedInputRateMultiplier: 2,
    outputRateMultiplier: 1.5,
    // Admission begins before the billing boundary, with room for estimator
    // error and one bounded result envelope.
    admissionHeadroomTokens: 16_384,
  }),
]);

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/\[[^\]]+\]$/, "");
}

export function providerModelEconomics(provider, modelName) {
  const providerKey = normalized(provider);
  const modelKey = normalized(modelName);
  for (const rule of MODEL_ECONOMICS) {
    if (!rule.providers.includes(providerKey)) continue;
    if (!rule.model.test(modelKey) || rule.exclude.test(modelKey)) continue;
    return rule;
  }
  return null;
}

export function providerLongContextThreshold(provider, modelName) {
  return providerModelEconomics(provider, modelName)?.longContextThresholdTokens ?? null;
}

export function providerLongContextRateMultipliers(provider, modelName, requestInputTokens) {
  const rule = providerModelEconomics(provider, modelName);
  if (!rule || Math.max(0, Number(requestInputTokens) || 0) <= rule.longContextThresholdTokens) {
    return Object.freeze({ input: 1, cachedInput: 1, output: 1, active: false });
  }
  return Object.freeze({
    input: rule.inputRateMultiplier,
    cachedInput: rule.cachedInputRateMultiplier,
    output: rule.outputRateMultiplier,
    active: true,
  });
}

export function providerContextAdmissionBoundary(provider, modelName) {
  const rule = providerModelEconomics(provider, modelName);
  if (!rule) return null;
  return Math.max(0, rule.longContextThresholdTokens - rule.admissionHeadroomTokens);
}

export { OPENAI_LONG_CONTEXT_THRESHOLD };
