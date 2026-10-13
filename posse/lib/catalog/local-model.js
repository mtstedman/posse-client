// Pure runtime limits for the bundled local generation models. These budgets
// reserve context for the embedded tool protocol, bounded tool results, and a
// final answer; they are intentionally lower than each model's native maximum.

export const QWEN_LOCAL_MODEL_ID = "qwen2.5-coder-3b-instruct";
// Retained identity for rejecting old selections; Gemma is not an active profile.
export const GEMMA_LOCAL_MODEL_ID = "gemma-2-2b-it";

export const LOCAL_MODEL_PROFILES = Object.freeze({
  [QWEN_LOCAL_MODEL_ID]: Object.freeze({
    profileId: "qwen2.5-coder-3b-instruct-int4-cpu",
    shorthand: "qwen-code",
    contextTokens: 32_768,
    remoteMaxPromptChars: 48_000,
    remoteMaxContextChars: 32_000,
    maxOutputTokens: 1_024,
    maxToolTurns: 4,
    maxToolResultChars: 6_000,
  }),
});

export const LOCAL_MODEL_IDS = Object.freeze(Object.keys(LOCAL_MODEL_PROFILES));

export function localModelIdForTier(_tier = "standard") {
  return QWEN_LOCAL_MODEL_ID;
}

export function localModelProfile(modelId = null, tier = "standard") {
  const selected = LOCAL_MODEL_PROFILES[String(modelId || "").trim()]
    ? String(modelId).trim()
    : localModelIdForTier(tier);
  return { modelId: selected, ...LOCAL_MODEL_PROFILES[selected] };
}
