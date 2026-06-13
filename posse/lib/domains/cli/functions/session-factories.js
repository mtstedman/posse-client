// CLI session factories: wire the ReviewSession and RunSession
// constructor dependencies. These are the glue layer between the
// orchestrator CLI's module-scoped state (PROJECT_DIR, argv flags,
// lazy-loaded modules) and the session classes that drive the
// interactive review/run loops.
//
// Each factory takes a `bootDeps` bundle from orchestrator-app.js so
// this module never reaches back into the CLI module. All of the lazy
// `load*Module()` callers, the argv flags, and the in-CLI helper
// references arrive as named parameters.

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { C } from "../../../shared/format/functions/colors.js";
import {
  cancelWorkItemJobs,
  cleanupRunningAgentCalls,
  createJob,
  createWorkItem,
  findWriteLockConflict,
  getArtifacts,
  getArtifactsByWorkItem,
  getEventsByWorkItem,
  getJob,
  getJobWriteScope,
  getWorkItem,
  listActiveFileLocks,
  listJobs,
  listJobsByWorkItem,
  listWorkItems,
  logEvent,
  refreshWorkItemStatus,
  requeueWaitingHumanInputJobs,
  requeueWorkItemAfterRejection,
  setMergeState,
  skipJob,
  storeArtifact,
  updateJobPayload,
  updateWorkItemStatus,
} from "../../queue/functions/index.js";
import { contextDir, wiScopeId, artifactsDir, ensureArtifactDirs } from "../../artifacts/functions/index.js";
import { getRecentToolInvocations, getToolInvocationCountsByJob } from "../../observability/functions/observations.js";
import { getIterativeState } from "../../planning/functions/state.js";
import {
  collectHandledSuggestionKeys,
  createApprovedSuggestionFollowUp,
  suggestionDecisionEventJson,
  suggestionDevJobDecision,
  suggestionReviewKey,
} from "../../worker/functions/helpers/suggestions.js";
import {
  buildReviewReportData as buildReviewReportDataFromModule,
  listReviewableWorkItemsForApproval as listReviewableWorkItemsForApprovalFromModule,
  saveReport as saveReportFromModule,
} from "./review-report.js";
import { jobsNeedGitWorktree } from "../../git/functions/policy.js";
import { inferWiMode, researchBudgetMetadata, researchPayload } from "./flags.js";
import {
  defaultResearchModelTier,
  researchBudgetToReasoningEffort,
} from "../../worker/functions/helpers/role-utils.js";
import {
  checkRemotePromptBundleReadiness,
  checkRemotePromptCompilerReadiness,
} from "../../remote/functions/readiness.js";

export async function createReviewSessionDeps(bootDeps) {
  const {
    projectDir,
    NO_TUI,
    ask,
    cmdDashboard,
    loadDisplayModule,
    getGitWorkflowHelpers,
    getTargetBranch,
    processIterativeWrapUp,
    isReviewableWorkItem,
  } = bootDeps;

  const [
    { Display },
    helpers,
    worktreeStatusMod,
  ] = await Promise.all([
    loadDisplayModule(),
    getGitWorkflowHelpers(),
    import("./worktree-status.js"),
  ]);
  return {
    autoMergeCompletedWorkItems: helpers.autoMergeCompletedWorkItems,
    listWorkItems,
    isReviewableWorkItem,
    NO_TUI,
    Display,
    cmdDashboard,
    C,
    listJobsByWorkItem,
    ask,
    updateWorkItemStatus,
    logEvent,
    gitMergeToTarget: helpers.gitMergeToTarget,
    gitMergeToTargetAsync: helpers.gitMergeToTargetAsync,
    PROJECT_DIR: projectDir,
    execSync,
    TARGET_BRANCH: await getTargetBranch(),
    getTargetBranch,
    setMergeState,
    cleanupWiBranch: helpers.cleanupWiBranch,
    cleanupWiBranchAsync: helpers.cleanupWiBranchAsync,
    requeueWorkItemAfterRejection,
    offerPush: helpers.offerPush,
    ensureCleanTargetBranch: helpers.ensureCleanTargetBranch,
    ensureCleanTargetBranchAsync: helpers.ensureCleanTargetBranchAsync,
    cleanupRunningAgentCalls,
    listJobs,
    notifyDirtyState: helpers.notifyDirtyState,
    processIterativeWrapUp,
    mergeIterativePassToTarget: helpers.mergeIterativePassToTarget,
    saveReportFromModule,
    listReviewableWorkItemsForApprovalFromModule,
    buildReviewReportDataFromModule,
    gitDiffStat: helpers.gitDiffStat,
    gitDiffStatAsync: helpers.gitDiffStatAsync,
    getJobWriteScope,
    findWriteLockConflict,
    getWorkItem,
    getIterativeState,
    collectHandledSuggestionKeys,
    getEventsByWorkItem,
    getArtifactsByWorkItem,
    suggestionReviewKey,
    getJob,
    suggestionDevJobDecision,
    suggestionDecisionEventJson,
    getArtifacts,
    createApprovedSuggestionFollowUp,
    path,
    contextDir,
    wiScopeId,
    fs,
    updateJobPayload,
    worktreeStatusFn: worktreeStatusMod.computeWorktreeStatus,
    worktreeStatusAsyncFn: worktreeStatusMod.computeWorktreeStatusAsync,
    commitInScopeChangesFn: worktreeStatusMod.commitInScopeChanges,
    commitInScopeChangesAsyncFn: worktreeStatusMod.commitInScopeChangesAsync,
    discardWorktreeFilesFn: worktreeStatusMod.discardWorktreeFiles,
    discardWorktreeFilesAsyncFn: worktreeStatusMod.discardWorktreeFilesAsync,
    stashTargetBranchChangesFn: worktreeStatusMod.stashTargetBranchChanges,
    stashTargetBranchChangesAsyncFn: worktreeStatusMod.stashTargetBranchChangesAsync,
  };
}

export async function createReviewSession(bootDeps) {
  const { loadReviewSessionModule } = bootDeps;
  const { ReviewSession } = await loadReviewSessionModule();
  return new ReviewSession(await createReviewSessionDeps(bootDeps));
}

export async function createRunSessionDeps(bootDeps) {
  const {
    projectDir,
    NO_TUI,
    AUTO_APPROVE,
    DRY_RUN,
    log,
    getResolvedImageProtocol,
    getConcurrency,
    getStallTimeout,
    getAutoMergeConfig,
    maybeAnnounceAutoMergeSetting,
    ensureRepoSetupConfirmed,
    ensureGitReady,
    classifyResearchForRouting,
    createInitialResearchOrPlanJob,
    shouldUseRedTeamPlanForWorkItem,
    processIterativeWrapUp,
    loadSchedulerModule,
    loadWorkerModule,
    loadDisplayModule,
    loadProviderModule,
    loadRunSessionModule,
    loadAtlasModule,
    getGitWorkflowHelpers,
    isReviewableWorkItem,
  } = bootDeps;

  const [
    { Scheduler },
    { Worker },
    { Display },
    { primeProviderUsageAuth, primeProviderUsageAuthAsync, getProviderHealth, getConfiguredProviderUsageAsync },
    { RunSession },
    atlasModule,
    helpers,
  ] = await Promise.all([
    loadSchedulerModule(),
    loadWorkerModule(),
    loadDisplayModule(),
    loadProviderModule(),
    loadRunSessionModule(),
    loadAtlasModule(),
    getGitWorkflowHelpers(),
  ]);
  const reviewSession = await createReviewSession(bootDeps);
  return {
    RunSession,
    maybeAnnounceAutoMergeSetting,
    listJobs,
    jobsNeedGitWorktree,
    processIterativeWrapUp,
    mergeIterativePassToTarget: helpers.mergeIterativePassToTarget,
    listWorkItems,
    isReviewableWorkItem,
    cmdReview: () => reviewSession.cmdReview(),
    C,
    CONCURRENCY: getConcurrency(),
    getWorkItem,
    updateWorkItemStatus,
    ensureRepoSetupConfirmed,
    ensureGitReady,
    guardStartupDirtyTree: helpers.guardStartupDirtyTreeInWorker || helpers.guardStartupDirtyTreeAsync || helpers.guardStartupDirtyTree,
    NO_TUI,
    Scheduler,
    primeProviderUsageAuth,
    primeProviderUsageAuthAsync,
    getProviderHealth,
    PROJECT_DIR: projectDir,
    checkRemotePromptBundleReadiness,
    checkRemotePromptCompilerReadiness,
    getConfiguredProviderUsageAsync,
    startupWorktreeCleanup: helpers.startupWorktreeCleanup,
    ensureAtlasCommitReindexHook: atlasModule.ensureAtlasCommitReindexHook,
    getAtlasIntegrationConfig: atlasModule.getAtlasIntegrationConfig,
    ensureAtlasRepoIndexedOnBoot: atlasModule.ensureAtlasRepoIndexedOnBoot,
    prewarmAtlasV2BootDeps: atlasModule.prewarmAtlasV2BootDeps,
    disableAtlasForRun: atlasModule.disableAtlasForRun,
    isAtlasRuntimeDisabled: atlasModule.isAtlasRuntimeDisabled,
    getAtlasRuntimeDisabledReason: atlasModule.getAtlasRuntimeDisabledReason,
    // Worker-backed variant: the readiness sqlite scans run off the main
    // thread; same args/result shape, just async (run-session awaits it, and
    // test stubs returning plain objects still work through the await).
    enqueueAtlasSelfRepair: atlasModule.enqueueAtlasSelfRepairInWorker,
    log,
    Display,
    STALL_TIMEOUT: getStallTimeout(),
    Worker,
    AUTO_APPROVE,
    DRY_RUN,
    requeueWaitingHumanInputJobs,
    refreshWorkItemStatus,
    inferWiMode,
    researchBudgetMetadata,
    createWorkItem,
    createInitialResearchOrPlanJob,
    shouldUseRedTeamPlanForWorkItem,
    classifyResearchForRouting,
    ensureArtifactDirs,
    wiScopeId,
    artifactsDir,
    getResolvedImageProtocol,
    createJob,
    getJob,
    storeArtifact,
    logEvent,
    cancelWorkItemJobs,
    cleanupWiBranch: helpers.cleanupWiBranch,
    cleanupWiBranchAsync: helpers.cleanupWiBranchAsync,
    skipJob,
    runLiveReview: (display) => reviewSession.runLiveReview(display),
    listJobsByWorkItem,
    getArtifacts,
    getToolInvocationCountsByJob,
    getRecentToolInvocations,
    listActiveFileLocks,
    collectDirtyState: helpers.collectDirtyState || helpers._collectDirtyState,
    collectDirtyStateAsync: helpers.collectDirtyStateAsync,
    defaultResearchModelTier,
    researchBudgetToReasoningEffort,
    researchPayload,
    autoMergeCompletedWorkItems: helpers.autoMergeCompletedWorkItems,
    hasAutoMergeableCompletedWorkItems: helpers.hasAutoMergeableCompletedWorkItems,
    autoMergePendingReviewBlockers: getAutoMergeConfig().enabled,
    describePendingReviewLockBlockers: () => reviewSession.describePendingReviewLockBlockers(),
    wrapUpTui: (display) => reviewSession.wrapUpTui(display),
    wrapUp: () => reviewSession.wrapUp(),
    offerPush: helpers.offerPush,
  };
}
