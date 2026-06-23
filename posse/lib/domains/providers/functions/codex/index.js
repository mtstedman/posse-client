// lib/domains/providers/functions/codex/index.js
//
// Native Codex CLI provider facade for the posse orchestrator.

export { __testBuildCodexRoleGuardBlock, __testBuildCodexWebToolsOverrides, __testBuildShellDisciplineBlock } from "./prompt-blocks.js";
export { capabilities, MODEL_TIERS, getModelTierConfig, __testNormalizeModelForAuthMode } from "./model-config.js";
export { hasCredentials, __testResolveCodexAuthMode } from "./auth.js";
export {
  discoverCodexCli,
  getClaudeInfo,
  isReady,
  isReadyAsync,
  __testResolveWindowsPathCommand,
  __testIsProtectedWindowsAppCodexPath,
  __testIsExecutableCodexCli,
  __testCodexCliSupportsExecContract,
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
export {
  __testAppendBoundedCodexOutput,
  __testBuildCloseStats,
  __testClassifyCodexStderrLine,
  __testExtractCodexToolUse,
  __testAppendCodexToolUseEvent,
  extractUsageFromEvent as __testExtractCodexUsageFromEvent,
  codexUsageEventDedupeKey as __testCodexUsageEventDedupeKey,
  createCodexUsageAccumulator as __testCreateCodexUsageAccumulator,
} from "./stream-events.js";
export {
  __testExtractCodexSessionHandleFromStreamMessage,
  __testRegisterCodexExitCleanup,
  __testDrainCodexExitCleanups,
} from "./session.js";
export {
  buildCodexExecArgs as __testBuildCodexExecArgs,
  prepareCodexConfigForSpawn as __testPrepareCodexConfigForSpawn,
  shouldSpillCodexConfigOverrides as __testShouldSpillCodexConfigOverrides,
  __testCollectCodexExtraDirs,
} from "./cli-spawn.js";
export {
  __testBuildCodexAtlasConfigOverrides,
  __testBuildCodexDeveloperInstructionRoute,
  __testBuildCodexDeterministicReadConfigOverrides,
  __testBuildCodexSystemToolLockdownOverrides,
} from "./request-builders.js";
export { buildWindowsSpawn as __testBuildCodexSpawn, terminateSpawnedProcess as __testTerminateSpawnedProcess } from "../shared/windows-spawn.js";
export { callProvider } from "./call-provider.js";
export { escalateTier, extractJson, getRateLimitState, isCodexResumeHandleExpiredError as __testIsCodexResumeHandleExpiredError, parseErrorBackoff, tripRateLimit } from "./errors.js";
