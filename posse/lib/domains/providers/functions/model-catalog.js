// lib/provider/model-catalog.js
//
// Provider-specific model defaults and selectable model options. Pure enum
// data (provider identifiers, tier names, labels) lives in `lib/catalog/`
// and is re-exported here for backward compatibility; the tier-to-model
// defaults and helpers below stay co-located with the routing logic that
// uses them.
//
// Text models and image models are intentionally split to prevent cross-use.

import { PROVIDER_OPTIONS, PROVIDER_LABELS } from "../../../catalog/provider.js";
import { MODEL_TIERS } from "../../../catalog/model.js";

export { PROVIDER_OPTIONS, PROVIDER_LABELS, MODEL_TIERS };

const MODEL_TIER_DEFAULTS = Object.freeze({
  claude: Object.freeze({
    cheap: Object.freeze({ model: "haiku" }),
    // null means "provider default" (Claude's default maps to Sonnet).
    standard: Object.freeze({ model: null }),
    strong: Object.freeze({ model: "opus" }),
  }),
  openai: Object.freeze({
    cheap: Object.freeze({ model: "gpt-4.1-mini" }),
    standard: Object.freeze({ model: "gpt-4.1" }),
    strong: Object.freeze({ model: "gpt-4.1" }),
  }),
  codex: Object.freeze({
    cheap: Object.freeze({ model: "gpt-5.3-codex" }),
    standard: Object.freeze({ model: "gpt-5.4" }),
    strong: Object.freeze({ model: "gpt-5.4" }),
  }),
  grok: Object.freeze({
    cheap: Object.freeze({ model: "grok-3-mini" }),
    standard: Object.freeze({ model: "grok-code-fast-1" }),
    strong: Object.freeze({ model: "grok-4" }),
  }),
  // GitHub Copilot CLI. Tier-to-model mapping follows the same shape as
  // other providers, but pricing is subscription quota (premium requests),
  // not per-token — quota-aware routing lives in Phase 5.
  copilot: Object.freeze({
    cheap: Object.freeze({ model: "claude-sonnet-4.5" }),
    standard: Object.freeze({ model: "gpt-5.4" }),
    strong: Object.freeze({ model: "gpt-5.4" }),
  }),
});

const DEFAULT_TIER_MODEL_FALLBACK = Object.freeze({
  claude: Object.freeze({
    cheap: "haiku",
    standard: "sonnet",
    strong: "opus",
  }),
});

export function getProviderTierDefaults(provider) {
  const key = String(provider || "").trim().toLowerCase();
  return MODEL_TIER_DEFAULTS[key] || {};
}

export function getDefaultTierModel(provider, tier) {
  const providerKey = String(provider || "").trim().toLowerCase();
  const providerDefaults = getProviderTierDefaults(providerKey);
  const tierKey = String(tier || "standard").trim().toLowerCase();
  const direct = providerDefaults?.[tierKey]?.model;
  if (direct != null && String(direct).trim() !== "") return direct;
  return DEFAULT_TIER_MODEL_FALLBACK?.[providerKey]?.[tierKey] || null;
}

const TEXT_MODEL_CHOICES_INTERNAL = Object.freeze({
  claude: Object.freeze([
    "fable",
    "haiku",
    "sonnet",
    "opus",
    "best",
    "opusplan",
    "sonnet[1m]",
    "opus[1m]",
    "claude-fable-5",
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
  openai: Object.freeze([
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-5-mini",
    "gpt-5",
    "gpt-5-codex",
    "gpt-5.3",
    "gpt-5.3-pro",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5.4-codex",
  ]),
  codex: Object.freeze([
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
  ]),
  grok: Object.freeze([
    "grok-3-mini",
    "grok-3",
    "grok-code-fast-1",
    "grok-4",
    "grok-4-0709",
    "grok-4-fast-non-reasoning",
    "grok-4-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-4-1-fast-reasoning",
    "grok-4.20-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-4.20-0309-reasoning",
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
});

const IMAGE_MODEL_CHOICES_INTERNAL = Object.freeze({
  openai: Object.freeze([
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

export function getDefaultImageProvider() {
  return Object.keys(IMAGE_MODEL_CHOICES_INTERNAL)[0] || "openai";
}

export function getDefaultImageModel(provider = null) {
  const key = String(provider || getDefaultImageProvider()).trim().toLowerCase();
  const models = IMAGE_MODEL_CHOICES_INTERNAL[key] || [];
  if (models.length > 0) return models[0];
  return key === "grok" ? "grok-imagine-image-quality" : "gpt-image-1.5";
}

export function normalizeGrokImageModelName(model = null) {
  const raw = String(model || "").trim().toLowerCase();
  if (!raw) return getDefaultImageModel("grok");
  const suffixFixed = raw.replace(
    /^(grok-imagine-image(?:-(?:quality(?:-(?:latest|\d{8}))?|pro|\d{4}-\d{2}-\d{2}))?)(?:-image)+$/,
    "$1",
  );
  const validModels = IMAGE_MODEL_CHOICES_INTERNAL.grok || [];
  if (validModels.includes(suffixFixed)) return suffixFixed;
  return getDefaultImageModel("grok");
}

function asOption(value) {
  return Object.freeze({ value, label: value });
}

function buildModelOptionList(models, { includeDefault = false, defaultLabel = "(default: tier model)" } = {}) {
  const list = [];
  if (includeDefault) list.push({ value: "", label: defaultLabel });
  for (const model of models || []) list.push(asOption(model));
  return Object.freeze(list);
}

export const TEXT_MODEL_CHOICES_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(TEXT_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [provider, [...models]])
  )
);

export const IMAGE_MODEL_CHOICES_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(IMAGE_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [provider, [...models]])
  )
);

export const TEXT_MODEL_OPTIONS_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(TEXT_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [
      provider,
      buildModelOptionList(models, { includeDefault: true }),
    ])
  )
);

export const IMAGE_MODEL_OPTIONS_BY_PROVIDER = Object.freeze(
  Object.fromEntries(
    Object.entries(IMAGE_MODEL_CHOICES_INTERNAL).map(([provider, models]) => [
      provider,
      buildModelOptionList(models, { includeDefault: false }),
    ])
  )
);

export const IMAGE_PROVIDER_OPTIONS = Object.freeze(
  Object.keys(IMAGE_MODEL_CHOICES_INTERNAL).map((provider) => Object.freeze({ value: provider, label: provider }))
);

const TIER_LABELS = Object.freeze({
  cheap: "cheap",
  standard: "standard",
  strong: "strong",
});

function buildTextModelSettingDefs() {
  const defs = [];
  for (const provider of PROVIDER_OPTIONS) {
    for (const tier of MODEL_TIERS) {
      defs.push(Object.freeze({
        provider,
        key: `${provider}_model_${tier}`,
        label: `${PROVIDER_LABELS[provider]} ${tier} model`,
        description: `${TIER_LABELS[tier][0].toUpperCase()}${TIER_LABELS[tier].slice(1)} tier model for ${PROVIDER_LABELS[provider]}`,
        tier,
      }));
    }
  }
  return defs;
}

function buildImageModelSettingDefs() {
  const defs = [];
  for (const provider of Object.keys(IMAGE_MODEL_CHOICES_INTERNAL)) {
    defs.push(Object.freeze({
      provider,
      key: `${provider}_image_model`,
      label: `${PROVIDER_LABELS[provider]} image model`,
      description: `Image model for ${PROVIDER_LABELS[provider]} artifacts`,
      kind: "image",
    }));
  }
  return defs;
}

export const MODEL_SETTING_DEFS = Object.freeze([
  ...buildTextModelSettingDefs(),
  ...buildImageModelSettingDefs(),
]);

export const CODEX_OAUTH_SUPPORTED_MODELS = Object.freeze([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
]);

export const CODEX_VALIDATION_KNOWN_MODELS = Object.freeze([
  ...TEXT_MODEL_CHOICES_INTERNAL.codex,
]);
