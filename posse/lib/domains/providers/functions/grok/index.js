import { PROVIDER_CAPABILITIES } from "../../../../catalog/provider-capabilities.js";
// Provider selection stays in Node; execution uses the common Rust API loop.
import { nativeApiMetadata } from "../shared/native-api-metadata.js";
export { extractJson } from "../../../../shared/format/functions/json.js";
export { buildImageClient } from "./image-client.js";

export const capabilities = PROVIDER_CAPABILITIES["grok"];
export const { MODEL_TIERS, getModelTierConfig, getCredentialEnvVars, hasCredentials, escalateTier, callProvider, callAgentTurn, supportsAgentTranscript, tripRateLimit, getRateLimitState, isCircuitOpen, parseErrorBackoff } = nativeApiMetadata("grok", "XAI_API_KEY");
