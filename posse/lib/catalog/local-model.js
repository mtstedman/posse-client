// Pure runtime limits for the bundled local generation models. These budgets
// reserve context for the embedded tool protocol, bounded tool results, and a
// final answer; they are intentionally lower than each model's native maximum.

export const QWEN_LOCAL_MODEL_ID = "qwen2.5-coder-3b-instruct";
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
  [GEMMA_LOCAL_MODEL_ID]: Object.freeze({
    profileId: "gemma-2-2b-it-int4-cpu",
    shorthand: "gemma-it",
    contextTokens: 8_192,
    remoteMaxPromptChars: 24_000,
    remoteMaxContextChars: 16_000,
    maxOutputTokens: 1_024,
    maxToolTurns: 3,
    maxToolResultChars: 1_000,
  }),
});

export const LOCAL_MODEL_IDS = Object.freeze(Object.keys(LOCAL_MODEL_PROFILES));

export function localModelIdForTier(tier = "standard") {
  return String(tier || "").trim().toLowerCase() === "strong"
    ? GEMMA_LOCAL_MODEL_ID
    : QWEN_LOCAL_MODEL_ID;
}

export function localModelProfile(modelId = null, tier = "standard") {
  const selected = LOCAL_MODEL_PROFILES[String(modelId || "").trim()]
    ? String(modelId).trim()
    : localModelIdForTier(tier);
  return { modelId: selected, ...LOCAL_MODEL_PROFILES[selected] };
}
