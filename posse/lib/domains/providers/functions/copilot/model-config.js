import { getSetting } from "../../../queue/functions/index.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { escalateModelTier, getMaxTurnsForProvider } from "../shared/turns.js";

export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("copilot").cheap.model,
    label: "$ CHEAP",
    color: "dim",
  },
  standard: {
    model: getProviderTierDefaults("copilot").standard.model,
    label: "STANDARD",
    color: "cyan",
  },
  strong: {
    model: getProviderTierDefaults("copilot").strong.model,
    label: "STRONG",
    color: "magenta",
  },
};

export function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

export function getModelOverride() {
  return readModelSetting("copilot_model") || null;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`copilot_model_${key}`) || base.model,
  };
}

export function getMaxTurns(role, modelTier = "standard", complexity = null, filesToModifyCount = null, deepthink = false) {
  return getMaxTurnsForProvider("copilot", { role, modelTier, complexity, filesToModifyCount, deepthink });
}

export function escalateTier(currentTier, attemptCount = 1, options = {}) {
  const tier = String(currentTier || "standard").toLowerCase();
  return escalateModelTier(tier, attemptCount, options);
}
