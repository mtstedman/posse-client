// lib/domains/providers/functions/codex/model-config.js

import { CODEX_OAUTH_SUPPORTED_MODELS, getProviderTierDefaults } from "../model-catalog.js";
import { getMaxTurnsForProvider } from "../shared/turns.js";
import { readModelSetting } from "./settings.js";

export const capabilities = Object.freeze({
  images: false,
  sessionResume: true,
  toolAttachment: "deterministic-bridge",
});

export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("codex").cheap.model,
    label: "$ CHEAP",
    color: "dim",
  },
  standard: {
    model: getProviderTierDefaults("codex").standard.model,
    label: "STANDARD",
    color: "cyan",
  },
  strong: {
    model: getProviderTierDefaults("codex").strong.model,
    label: "STRONG",
    color: "magenta",
  },
};

const OAUTH_SUPPORTED_MODELS = new Set(CODEX_OAUTH_SUPPORTED_MODELS);

function resolveOauthCompatibleModel(preferredModel) {
  const standardModel = getProviderTierDefaults("codex")?.standard?.model || "gpt-5.4";
  const preferred = String(preferredModel || "").trim();
  if (OAUTH_SUPPORTED_MODELS.has(preferred)) return preferred;

  const fallbackCandidates = [
    standardModel,
    getModelTierConfig("standard").model,
    getModelOverride(),
    getModelTierConfig("strong").model,
    ...CODEX_OAUTH_SUPPORTED_MODELS,
  ];
  for (const candidate of fallbackCandidates) {
    const normalized = String(candidate || "").trim();
    if (OAUTH_SUPPORTED_MODELS.has(normalized)) return normalized;
  }
  return standardModel;
}

export function getModelOverride() {
  return readModelSetting("codex_model") || null;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`codex_model_${key}`) || base.model,
  };
}

export function normalizeModelForAuthMode(modelName, authMode) {
  const model = String(modelName || "").trim();
  if (!model) return modelName;
  if (authMode !== "login" && authMode !== "oauth") return model;
  return resolveOauthCompatibleModel(model);
}

export function __testNormalizeModelForAuthMode(modelName, authMode) {
  return normalizeModelForAuthMode(modelName, authMode);
}

export function getMaxTurns(role, modelTier = "standard", complexity = null, filesToModifyCount = null, deepthink = false) {
  return getMaxTurnsForProvider("codex", { role, modelTier, complexity, filesToModifyCount, deepthink });
}
