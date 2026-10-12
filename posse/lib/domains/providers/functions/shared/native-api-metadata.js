import { readModelSetting } from "./setting-read.js";
import "../../../queue/functions/index.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { selectExecutionModel } from "./model-selection.js";
import { escalateModelTier } from "./turns.js";
import { classifyProviderError } from "./api-resilience.js";
import { providerRuntimeState } from "../../classes/runtime-state-singleton.js";
import { callNativeApiProvider, callNativeApiAgentTurn } from "./native-api.js";
import { providerDispatchPromptFieldSupportedSync } from "../../../../shared/native/functions/engagement-client.js";

// Selection and cross-provider scheduling remain Node responsibilities.
export function nativeApiMetadata(provider, credential) {
  const defaults = getProviderTierDefaults(provider);
  const MODEL_TIERS = Object.fromEntries([
    ["cheap", "$ CHEAP", "dim", "low"], ["standard", "STANDARD", "cyan", "medium"], ["strong", "STRONG", "magenta", "high"],
  ].map(([tier, label, color, effort]) => [tier, { model: defaults[tier].model, thinking: false, label, color, effort }]));
  const setting = readModelSetting;
  const getModelTierConfig = (tier = "standard") => {
    const key = tier in MODEL_TIERS ? tier : "standard";
    return { ...MODEL_TIERS[key], model: setting(`${provider}_model_${key}`) || MODEL_TIERS[key].model };
  };
  const select = options => ({ ...options, modelName: selectExecutionModel({
    jobModelName: options.modelName, globalModelOverride: setting(`${provider}_model`),
    tierModel: getModelTierConfig(options.modelTier).model,
  }) });
  return {
    MODEL_TIERS, getModelTierConfig,
    getCredentialEnvVars: () => [credential], hasCredentials: () => !!process.env[credential],
    escalateTier: escalateModelTier,
    callProvider: (prompt, options = {}) => callNativeApiProvider(provider, prompt, select(options)),
    callAgentTurn: (prompt, options = {}) => callNativeApiAgentTurn(provider, prompt, select(options)),
    supportsAgentTranscript: () => providerDispatchPromptFieldSupportedSync(provider, "transcript"),
    // This is the orchestrator's routing pause, not the native transport breaker.
    tripRateLimit: (seconds, reason = "") => providerRuntimeState.tripRateLimit(provider, seconds, reason),
    getRateLimitState: () => providerRuntimeState.getRateLimitState(provider),
    isCircuitOpen: () => providerRuntimeState.getRateLimitState(provider).blocked,
    parseErrorBackoff: error => classifyProviderError(error, { defaultBackoffSec: 15 }),
  };
}
