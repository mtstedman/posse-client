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

// Operator CLI inventory. This does not widen agent/provider model selection.
export const QWEN_IMAGE_MODEL_ID = "qwen-image-2512";
export const MINIMAX_H3_MODEL_ID = "minimax-h3";
export const LOCAL_BRIDGE_MODELS = Object.freeze([
  Object.freeze({ slug: "qwen-code", modelId: QWEN_LOCAL_MODEL_ID, kind: "text",
    directory: LOCAL_MODEL_PROFILES[QWEN_LOCAL_MODEL_ID].profileId,
    formats: Object.freeze(["text", "json"]), platforms: Object.freeze(["linux-x64", "win32-x64"]),
    installation: "signed-package" }),
  Object.freeze({ slug: "qwen-image", modelId: QWEN_IMAGE_MODEL_ID, kind: "image",
    directory: QWEN_IMAGE_MODEL_ID, formats: Object.freeze(["png", "json"]),
    platforms: Object.freeze(["linux-x64", "linux-arm64", "win32-x64", "darwin-arm64"]), installation: "pinned-files",
    requirements: "x64: AVX2, FMA, F16C; ARM64: NEON; approximately 19 GiB RAM for the tested 384x384 profile" }),
  Object.freeze({ slug: "minimax-h3", modelId: MINIMAX_H3_MODEL_ID, kind: "video",
    directory: MINIMAX_H3_MODEL_ID, formats: Object.freeze(["avi", "json"]),
    platforms: Object.freeze(["linux-x64", "linux-arm64", "win32-x64", "darwin-arm64"]), installation: "pinned-files",
    requirements: "33.02 GiB model download; additional RAM for inference; x64: AVX2, FMA, F16C; ARM64: NEON",
    licenseUrl: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE" }),
]);
