// Provider selection stays in Node; execution uses the common Rust API loop.
import { nativeApiMetadata } from "../shared/native-api-metadata.js";
import { MCP_TOOL_DEADLINE_MODES } from "../../../../catalog/provider.js";
export { extractJson } from "../../../../shared/format/functions/json.js";
export { buildImageClient } from "./image-client.js";

export const capabilities = Object.freeze({ images: true, sessionResume: false, toolAttachment: "function", mcpToolDeadline: MCP_TOOL_DEADLINE_MODES.IN_PROCESS });
export const { MODEL_TIERS, getModelTierConfig, getCredentialEnvVars, hasCredentials, getClaudeInfo, escalateTier, callProvider, callAgentTurn, supportsAgentTranscript, tripRateLimit, getRateLimitState, isCircuitOpen, parseErrorBackoff } = nativeApiMetadata("grok", "XAI_API_KEY");

export { __testSafePath, __testBuildScopePredicates, __testGetToolsForRole, __testInspectFile, __testResizeImage } from "../shared/native-api-metadata.js";
