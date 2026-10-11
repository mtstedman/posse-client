// lib/domains/providers/functions/codex/index.js
//
// Codex provider facade for Rust dispatch and usage discovery.

export {
  capabilities,
  MODEL_TIERS,
  getModelTierConfig,
  resolveExecutionModelName,
  __testNormalizeModelForAuthMode,
} from "./model-config.js";
export { hasCredentials, __testResolveCodexAuthMode } from "./auth.js";
export {
  discoverCodexCli,
  isReady,
  isReadyAsync,
  __testResolveWindowsPathCommand,
  __testIsProtectedWindowsAppCodexPath,
  __testIsExecutableCodexCli,
  __testPrioritizeCodexCandidatePaths,
  __testFindCodexNativeExecutableForShim,
  __testResolveCodexLaunchPath,
  __testSelectCodexCandidateFromProbes,
  __testFindWindowsStandaloneCodexExecutables,
  __testFindWindowsLegacyCodexExecutables,
  __testCodexLaunchNeedsResolution,
} from "./cli-discovery.js";
export {
  refreshUsageSummary,
  getUsageSummary,
  __testParseCodexStatusText,
  __testNormalizeCodexStatusSummary,
  __testNormalizeCodexRateLimitsResponse,
  __testFetchCodexStatusViaInteractive,
  __testFetchCodexRateLimitsViaAppServer,
  __testBuildCodexLocalUsageSummary,
  __testSetCodexUsageFetchers,
  __testResetCodexUsageState,
  __testGetCodexInteractiveUsageUnavailableReason,
} from "./usage.js";
export { buildWindowsSpawn as __testBuildCodexSpawn, terminateSpawnedProcess as __testTerminateSpawnedProcess } from "../shared/windows-spawn.js";
export { callProvider, buildCodexRuntimeContractBlock as __testBuildCodexRuntimeContractBlock } from "./call-provider.js";
export { buildCodexNativeMcpAttachmentAsync } from "./request-builders.js";
export { escalateTier, extractJson, getRateLimitState, isCodexResumeHandleExpiredError as __testIsCodexResumeHandleExpiredError, parseErrorBackoff, tripRateLimit } from "./errors.js";
