// Pure runtime limits for the bundled local generation models. These budgets
// reserve context for the embedded tool protocol, bounded tool results, and a
// final answer; they are intentionally lower than each model's native maximum.

export const QWEN_LOCAL_MODEL_ID = "qwen2.5-coder-3b-instruct";
// Retained identity for rejecting old selections; Gemma is not an active profile.
export const GEMMA_LOCAL_MODEL_ID = "gemma-2-2b-it";

// General writing and conversation profiles: pinned GGUF files run by the
// native llama.cpp engine, with GPU offload where the machine has one.
export const GEMMA4_12B_LOCAL_MODEL_ID = "gemma-4-12b-it";
export const GEMMA4_31B_LOCAL_MODEL_ID = "gemma-4-31b-it";
export const MISTRAL_SMALL_LOCAL_MODEL_ID = "mistral-small-3.2-24b-instruct";

const X64_PLATFORMS = Object.freeze(["linux-x64", "win32-x64"]);
const GGUF_PLATFORMS = Object.freeze(["linux-x64", "linux-arm64", "win32-x64", "darwin-arm64"]);

// `directory` and `installedFile` locate the installed profile under the model
// root; `sampling` is the vendor-recommended setting for prose (absent: greedy).
const ggufProfile = ({ profileId, shorthand, installedFile, sampling }) => Object.freeze({
  profileId,
  shorthand,
  engine: "llama.cpp",
  installedFile,
  platforms: GGUF_PLATFORMS,
  contextTokens: 32_768,
  remoteMaxPromptChars: 96_000,
  remoteMaxContextChars: 64_000,
  maxOutputTokens: 8_192,
  maxToolTurns: 8,
  maxToolResultChars: 24_000,
  sampling: Object.freeze(sampling),
});

export const LOCAL_MODEL_PROFILES = Object.freeze({
  [QWEN_LOCAL_MODEL_ID]: Object.freeze({
    profileId: "qwen2.5-coder-3b-instruct-int4-cpu",
    shorthand: "qwen-code",
    engine: "onnxruntime-genai",
    directory: "qwen2.5-coder-3b-instruct-int4-cpu",
    installedFile: ".posse-model-package.json",
    platforms: X64_PLATFORMS,
    contextTokens: 32_768,
    remoteMaxPromptChars: 48_000,
    remoteMaxContextChars: 32_000,
    maxOutputTokens: 1_024,
    maxToolTurns: 4,
    maxToolResultChars: 6_000,
  }),
  [GEMMA4_31B_LOCAL_MODEL_ID]: Object.freeze({
    ...ggufProfile({ profileId: "gemma-4-31b-it-qat-q4_0", shorthand: "gemma-31b",
      installedFile: "gemma-4-31B_q4_0-it.gguf", sampling: { temperature: 1, topP: 0.95, topK: 64 } }),
    directory: GEMMA4_31B_LOCAL_MODEL_ID,
  }),
  [MISTRAL_SMALL_LOCAL_MODEL_ID]: Object.freeze({
    ...ggufProfile({ profileId: "mistral-small-3.2-24b-instruct-q4_k_m", shorthand: "mistral-small",
      installedFile: "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf", sampling: { temperature: 0.15, topP: 0.95, topK: 64 } }),
    directory: MISTRAL_SMALL_LOCAL_MODEL_ID,
  }),
  [GEMMA4_12B_LOCAL_MODEL_ID]: Object.freeze({
    ...ggufProfile({ profileId: "gemma-4-12b-it-qat-q4_0", shorthand: "gemma-12b",
      installedFile: "gemma-4-12b-it-qat-q4_0.gguf", sampling: { temperature: 1, topP: 0.95, topK: 64 } }),
    directory: GEMMA4_12B_LOCAL_MODEL_ID,
  }),
});

export const LOCAL_MODEL_IDS = Object.freeze(Object.keys(LOCAL_MODEL_PROFILES));

/** Canonical model ID for a model ID or its CLI shorthand; null when unknown. */
export function resolveLocalModelId(name) {
  const value = String(name || "").trim().toLowerCase();
  return LOCAL_MODEL_IDS.find(id => id === value || LOCAL_MODEL_PROFILES[id].shorthand === value) || null;
}

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
    directory: LOCAL_MODEL_PROFILES[QWEN_LOCAL_MODEL_ID].directory,
    formats: Object.freeze(["text", "json"]), platforms: X64_PLATFORMS,
    installation: "signed-package", downloadBytes: 2_009_844_281 }),
  ...[
    [GEMMA4_12B_LOCAL_MODEL_ID, 6_975_879_296, "6.50 GiB model download; about 10 GiB of RAM or VRAM", "https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf"],
    [MISTRAL_SMALL_LOCAL_MODEL_ID, 14_333_922_848, "13.35 GiB model download; about 18 GiB of RAM or VRAM", "https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506"],
    [GEMMA4_31B_LOCAL_MODEL_ID, 17_651_001_568, "16.44 GiB model download; about 22 GiB of RAM or VRAM", "https://huggingface.co/google/gemma-4-31B-it-qat-q4_0-gguf"],
  ].map(([modelId, downloadBytes, requirements, licenseUrl]) => Object.freeze({
    slug: LOCAL_MODEL_PROFILES[modelId].shorthand, modelId, kind: "text",
    directory: LOCAL_MODEL_PROFILES[modelId].directory,
    formats: Object.freeze(["text", "json"]), platforms: GGUF_PLATFORMS, installation: "pinned-files", downloadBytes,
    requirements: `${requirements}; runs on a GPU when one is available, otherwise CPU`, licenseUrl,
  })),
  Object.freeze({ slug: "qwen-image", modelId: QWEN_IMAGE_MODEL_ID, kind: "image",
    directory: QWEN_IMAGE_MODEL_ID, formats: Object.freeze(["png", "json"]),
    platforms: Object.freeze(["linux-x64", "linux-arm64", "win32-x64", "darwin-arm64"]), installation: "pinned-files",
    downloadBytes: 19_337_692_230,
    requirements: "x64: AVX2, FMA, F16C; ARM64: NEON; approximately 19 GiB RAM for the tested 384x384 profile" }),
  Object.freeze({ slug: "minimax-h3", modelId: MINIMAX_H3_MODEL_ID, kind: "video",
    directory: MINIMAX_H3_MODEL_ID, formats: Object.freeze(["avi", "json"]),
    platforms: Object.freeze(["linux-x64", "linux-arm64", "win32-x64", "darwin-arm64"]), installation: "pinned-files",
    downloadBytes: 35_451_792_232,
    requirements: "33.02 GiB model download; additional RAM for inference; x64: AVX2, FMA, F16C; ARM64: NEON",
    licenseUrl: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE" }),
]);

// The operator's default local model for each kind of work. A blank setting
// means automatic: the first installed candidate, or none when nothing is
// installed. `code` and `text` both draw on text models; they differ in which
// one is preferred.
const defaultModel = (kind, label, candidates) => Object.freeze({
  kind, key: `posse_local_default_${kind}_model`, label, candidates: Object.freeze(candidates),
});
export const LOCAL_DEFAULT_MODELS = Object.freeze([
  defaultModel("text", "Default writing model", ["gemma-31b", "mistral-small", "gemma-12b", "qwen-code"]),
  defaultModel("code", "Default code model", ["qwen-code", "gemma-31b", "mistral-small", "gemma-12b"]),
  defaultModel("image", "Default image model", ["qwen-image"]),
  defaultModel("video", "Default video model", ["minimax-h3"]),
]);
