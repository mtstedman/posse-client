import { PROVIDER_CAPABILITIES } from "../../../../catalog/provider-capabilities.js";
// Provider selection stays in Node; execution uses the common Rust API loop.
import { nativeApiMetadata } from "../shared/native-api-metadata.js";
export { extractJson } from "../../../../shared/format/functions/json.js";

export const capabilities = PROVIDER_CAPABILITIES["anthropic"];
export const { MODEL_TIERS, getModelTierConfig, getCredentialEnvVars, hasCredentials, escalateTier, callProvider, callAgentTurn, supportsAgentTranscript, tripRateLimit, getRateLimitState, isCircuitOpen, parseErrorBackoff } = nativeApiMetadata("anthropic", "ANTHROPIC_API_KEY");
