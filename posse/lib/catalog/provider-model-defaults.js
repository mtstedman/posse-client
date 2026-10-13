// @ts-check
import { PROVIDER_LABELS } from "./provider.js";
// Built-in offline model fallbacks; a validated remote catalog remains authoritative.


export const MODEL_TIER_DEFAULTS = Object.freeze({
  claude: Object.freeze({
    cheap: Object.freeze({ model: "haiku" }),
    standard: Object.freeze({ model: "claude-sonnet-5-5" }),
    strong: Object.freeze({ model: "claude-opus-5-5" }),
  }),
  anthropic: Object.freeze({
    cheap: Object.freeze({ model: "claude-haiku-4-5" }),
    standard: Object.freeze({ model: "claude-sonnet-5-5" }),
    strong: Object.freeze({ model: "claude-opus-5-5" }),
  }),
  openai: Object.freeze({
    cheap: Object.freeze({ model: "gpt-6-luna" }),
    standard: Object.freeze({ model: "gpt-6.1-sol" }),
    strong: Object.freeze({ model: "gpt-6-astra" }),
  }),
  codex: Object.freeze({
    cheap: Object.freeze({ model: "gpt-6-luna" }),
    standard: Object.freeze({ model: "gpt-6.1-sol" }),
    strong: Object.freeze({ model: "gpt-6-astra" }),
  }),
  grok: Object.freeze({
    cheap: Object.freeze({ model: "grok-build-0.1" }),
    standard: Object.freeze({ model: "grok-build-0.1" }),
    strong: Object.freeze({ model: "grok-4.5" }),
  }),
  // GitHub Copilot CLI. Tier-to-model mapping follows the same shape as
  // other providers, but pricing is subscription quota (premium requests),
  // not per-token — quota-aware routing lives in Phase 5.
  copilot: Object.freeze({
    cheap: Object.freeze({ model: "claude-sonnet-4.5" }),
    standard: Object.freeze({ model: "gpt-5.4" }),
    strong: Object.freeze({ model: "gpt-5.4" }),
  }),
  "posse-local": Object.freeze({
    cheap: Object.freeze({ model: "qwen2.5-coder-3b-instruct" }),
    standard: Object.freeze({ model: "qwen2.5-coder-3b-instruct" }),
    strong: Object.freeze({ model: "qwen2.5-coder-3b-instruct" }),
  }),
});

export const DEFAULT_TIER_MODEL_FALLBACK = Object.freeze({
  claude: Object.freeze({
    cheap: "haiku",
    standard: "claude-sonnet-5-5",
    strong: "claude-opus-5-5",
  }),
});

export const TEXT_MODEL_CHOICES_INTERNAL = Object.freeze({
  claude: Object.freeze([
    "fable",
    "haiku",
    "sonnet",
    "opus",
    "best",
    "opusplan",
    "sonnet[1m]",
    "opus[1m]",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-8[1m]",
    "claude-opus-4-7",
    "claude-opus-4-7[1m]",
    "claude-opus-4-6",
    "claude-opus-4-6[1m]",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6[1m]",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
  ]),
  anthropic: Object.freeze([
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
  ]),
  openai: Object.freeze([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-5-mini",
    "gpt-5",
    "gpt-5-codex",
    "gpt-5.3",
    "gpt-5.3-pro",
    "gpt-5.3-codex",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-codex",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]),
  codex: Object.freeze([
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    // ChatGPT Pro research preview; OAuth-only (no API support).
    "gpt-5.3-codex-spark",
    // Retired for ChatGPT sign-in (2026-06); kept for validation/back-compat
    // and flagged deprecated in the remote catalog so it drops out of pickers.
    "gpt-5.3-codex",
  ]),
  grok: Object.freeze([
    "grok-3-mini",
    "grok-3",
    "grok-code-fast-1",
    "grok-code-fast",
    "grok-code-fast-1-0825",
    "grok-build-0.1",
    "grok-4",
    "grok-4-0709",
    "grok-4-fast-non-reasoning",
    "grok-4-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-4-1-fast-reasoning",
    "grok-4.20-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-0309-reasoning",
    "grok-4.5",
    "grok-4.3",
  ]),
  // Models the Copilot CLI accepts via `--model`. Verify against
  // `copilot --help` once installed; this list is a v1 best-effort
  // pulled from Copilot CLI changelog through 2026-02-27.
  copilot: Object.freeze([
    "claude-sonnet-4.5",
    "claude-sonnet-4-5",
    "gpt-5.4",
    "gpt-5",
    "gpt-5-mini",
  ]),
  "posse-local": Object.freeze([
    "qwen2.5-coder-3b-instruct",
  ]),
});

export const IMAGE_MODEL_CHOICES_INTERNAL = Object.freeze({
  openai: Object.freeze([
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-sunburst-2026-09-08",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-flare-2026-09-08",
    "gpt-image-2",
    "gpt-image-2-2026-04-21",
    "gpt-image-1.5",
    "gpt-image-1",
    "gpt-image-1-mini",
    "dall-e-3",
    "dall-e-2",
  ]),
  grok: Object.freeze([
    "grok-imagine-image-quality",
    "grok-imagine-image-quality-latest",
    "grok-imagine-image-quality-20260403",
    "grok-imagine-image-pro",
    "grok-imagine-image",
    "grok-imagine-image-2026-03-02",
  ]),
});

// Output formats each image-model family returns without a local conversion,
// matched by model-id prefix. gpt-image takes the format as a request
// parameter; the other families always return PNG.
export const IMAGE_MODEL_NATIVE_FORMATS = Object.freeze([
  Object.freeze({ prefix: "gpt-image", formats: Object.freeze(["png", "jpeg", "webp"]) }),
  Object.freeze({ prefix: "dall-e", formats: Object.freeze(["png"]) }),
  Object.freeze({ prefix: "grok-imagine", formats: Object.freeze(["png"]) }),
]);

export const TIER_LABELS = Object.freeze({
  cheap: "cheap",
  standard: "standard",
  strong: "strong",
});

export const CODEX_OAUTH_SUPPORTED_MODELS = Object.freeze([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  // OAuth-only model (no API path); usable solely under ChatGPT sign-in.
  "gpt-5.3-codex-spark",
]);

export const CODEX_VALIDATION_KNOWN_MODELS = Object.freeze([
  ...TEXT_MODEL_CHOICES_INTERNAL.codex,
]);

export const IMAGE_PROVIDER_OPTIONS = Object.freeze(Object.keys(IMAGE_MODEL_CHOICES_INTERNAL).map((value) => Object.freeze({ value, label: PROVIDER_LABELS[value] })));

export function getBuiltinDefaultTierModel(provider, tier) {
  return MODEL_TIER_DEFAULTS[provider]?.[tier]?.model ?? DEFAULT_TIER_MODEL_FALLBACK[provider]?.[tier] ?? null;
}
