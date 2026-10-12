import { PROVIDER_CAPABILITIES } from "../../../../catalog/provider-capabilities.js";
// Provider selection stays in Node; execution uses the common Rust API loop.
import { nativeApiMetadata } from "../shared/native-api-metadata.js";
export { extractJson } from "../../../../shared/format/functions/json.js";
export { buildImageClient } from "./image-client.js";
export { getUsageSummary } from "./usage-summary.js";

export const capabilities = PROVIDER_CAPABILITIES["openai"];
export const { MODEL_TIERS, getModelTierConfig, getCredentialEnvVars, hasCredentials, escalateTier, callProvider, callAgentTurn, supportsAgentTranscript, tripRateLimit, getRateLimitState, isCircuitOpen, parseErrorBackoff } = nativeApiMetadata("openai", "OPENAI_API_KEY");
