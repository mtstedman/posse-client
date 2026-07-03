// lib/domains/worker/classes/Worker.js — Job execution engine
//
// Dispatches jobs by type, manages attempts, model escalation on retry,
// exponential backoff, artifact storage. Dev/fix jobs go through assessor
// after execution.

import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { isInsideRoot, isUnderRoot, normPath, normalizeRoots, resolvePathWithin } from "../../../shared/scope/functions/path.js";
import { parseJobPayload } from "../../queue/functions/payload.js";

import {
  getWorkItem,
  getJob,
  incrementAndCreateAttempt,
  completeAttempt,
  setAttemptCommitHash,
  setAttemptSession,
  updateJobStatus,
  setJobResult,
  setJobError,
  setJobContext,
  storeArtifact,
  getArtifacts,
  getArtifactsByWorkItem,
  logEvent,
  releaseLease,
  releaseLeaseWithoutAttemptPenalty,
  renewLease,
  isLeaseValid,
  refreshWorkItemStatus,
  updateJobPayload,
  createJob,
  storeInsight,
  updateJobProvider,
  addDependency,
  removeDependency,
  rewireDependency,
  getDependents,
  getDependencies,
  getAttempts,
  applyDelegation,
  listJobsByWorkItem,
  getEvents,
  getEventsByWorkItem,
  getSetting,
  listActiveFileLocks,
  sessionLeaseTtlSec,
} from "../../queue/functions/index.js";

import { getProvider, getProviderName, getAvailableProviders, isProviderReady, tierModelName } from "../../providers/functions/provider.js";
import { workerRoleForJobType } from "../../providers/functions/roles.js";
import { Job } from "../../queue/classes/job/Job.js";
import { AssessmentSession } from "../../assessment/classes/AssessmentSession.js";
import { processVerdict } from "./roles/assessor.js";
import { PlanSession } from "../../planning/classes/PlanSession.js";
import { cleanupAgentLoaderAsync, loaderPathForJob } from "../functions/helpers/agent-loader.js";
import { TrackedProviderClient } from "./TrackedProviderClient.js";
import { RoleRegistry } from "./RoleRegistry.js";
import { JobLease } from "./JobLease.js";
import { WorkerExecutionCoordinator } from "./execution/WorkerExecutionCoordinator.js";
import { PartialWorkCoordinator } from "./execution/PartialWorkCoordinator.js";
import { runHumanInputHandler } from "../functions/helpers/human-input.js";
import { ROLE_CLASSES_BY_JOB_TYPE } from "./role-classes.js";
import { buildRoutingPacket, handoff, parseMissingContext, parseFileRequest, splitFileRequestsByRisk, parseResearcherStructuredOutput, researcherOutputNeedsHuman, _parseFunctions, applyDeterministicDeletes, attachAssessmentDiffContextAsync, hasWritableScope, renderAtlasHandoffSections } from "../../handoff/functions/index.js";
import { injectArtifactScope, normalizeArtifactCreateFiles, isArtifactMode, isValidTaskMode, buildManifest, wiScopeId, artifactsDir, workspaceDir, inputsDir, contextDir, getWiModeConfig, validateManifestAgainstContract, getArtifactProtocol, getResolvedImageProtocol, getConfiguredImageProviders, getConfiguredImageModel } from "../../artifacts/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { roleBrandColor } from "../../ui/functions/display/helpers/brand.js";
import { extractJson } from "../../../shared/format/functions/json.js";
import { runHookAsync } from "../../git/functions/hooks.js";
import { log, jobLog } from "../../../shared/telemetry/functions/logging/logger.js";
import { getRuntimeRoot } from "../../runtime/functions/paths.js";
import { validateMutableRepoPath } from "../../runtime/functions/protected-paths.js";
import { yieldNow } from "../../runtime/functions/yield.js";
import { recordObservation, runWithObservationContext } from "../../observability/functions/observations.js";
import {
  checkAtlasMainFreshnessGate,
  reindexAtlasAfterCommit,
  getAtlasIntegrationConfig,
} from "../../integrations/functions/atlas.js";
import { clearAtlasJobCache } from "../../integrations/functions/atlas-embedded.js";
import { emitAtlasAutoFeedbackForJob } from "../../integrations/functions/atlas-auto-feedback.js";
import { getWorkItemIntakeHints, buildResearchIntakePreload, buildIntakeHintsBlock } from "../../intake/functions/hints.js";
import {
  countInternalAssessmentRetries,
  getAssessmentInternalRetryLimit,
} from "../functions/helpers/assessment-shared.js";
import { refreshAndExtractInsights as refreshAndExtractInsightsFromModule } from "../functions/helpers/insights.js";
import { isTransientMcpInfraBlock, MAX_MCP_INFRA_BLOCK_RETRIES, MCP_INFRA_BLOCK_BACKOFF_MS } from "../functions/helpers/block-reason.js";
import {
  gitCommitAll as gitCommitAllFromModule,
  gitCommitAllAsync as gitCommitAllAsyncFromModule,
  repairWebAssetCreateScope as repairWebAssetCreateScopeFromModule,
} from "../../git/functions/commit-scope.js";
import {
  gcWorktreesAsync as gcWorktreesAsyncFromModule,
  preserveDirtyWorktreeSnapshot as preserveDirtyWorktreeSnapshotFromModule,
  snapshotAndResetDirtyWorktree as snapshotAndResetDirtyWorktreeFromModule,
  snapshotAndResetDirtyWorktreeAsync as snapshotAndResetDirtyWorktreeAsyncFromModule,
  worktreeRoot as worktreeRootFromModule,
} from "../../git/functions/worktree.js";
import {
  gitCurrentHashAsync,
  gitExecAsync,
  gitHasChangesAsync,
  gitStash,
} from "../../git/functions/utils.js";
import {
  applyStallStash as applyStallStashFromModule,
  applyStallStashAsync as applyStallStashAsyncFromModule,
  detectDrift as detectDriftFromModule,
} from "../functions/helpers/stall-resume.js";
import {
  retryOrFail as retryOrFailFromModule,
  spawnDeadLetterRecoveryForDependents as spawnDeadLetterRecoveryForDependentsFromModule,
} from "../functions/helpers/dead-letter.js";
import {
  isTransientCommitInfraFailure,
} from "../functions/helpers/commit-infra.js";
export { isTransientCommitInfraFailure };
import {
  clearActiveWorktreeSentinel as clearActiveWorktreeSentinelFromModule,
  cleanupWorktreeIfDoneAsync as cleanupWorktreeIfDoneAsyncFromModule,
  primeCreatableFiles as primeCreatableFilesFromModule,
  readActiveWorktreeSentinel as readActiveWorktreeSentinelFromModule,
  setUpWorktreeForJob as setUpWorktreeForJobFromModule,
} from "../functions/helpers/worktree-lifecycle.js";
import {
  extractResearcherQuestions as extractResearcherQuestionsFromModule,
  spawnFileRequestFollowUp as spawnFileRequestFollowUpFromModule,
  spawnPlanAfterResearch as spawnPlanAfterResearchFromModule,
  spawnResearchAfterPreflight as spawnResearchAfterPreflightFromModule,
} from "../functions/helpers/pipeline-continuation.js";
import {
  handleCatastrophicExecuteError as handleCatastrophicExecuteErrorFromModule,
  handleDeterministicInterruption as handleDeterministicInterruptionFromModule,
  handleExecuteAttemptError as handleExecuteAttemptErrorFromModule,
} from "../functions/helpers/attempt-errors.js";
import {
  runPostExecutionAssessment as runPostExecutionAssessmentFromModule,
} from "../functions/helpers/assessment-pipeline.js";
import {
  createJobsFromPlan as createJobsFromPlanFromModule,
} from "../../planning/functions/plan-compiler.js";
import {
  ASSESSABLE_JOB_TYPES,
  MUTATING_JOB_TYPES,
} from "../../../catalog/job.js";
import {
  effectiveArtifactTaskMode as effectiveArtifactTaskModeFromModule,
  isImageOnlyModelName as isImageOnlyModelNameFromModule,
  requiresGitNoopCheck as requiresGitNoopCheckFromModule,
  resolveExecutionProviderFromSettings as resolveExecutionProviderFromModule,
  resolveImageExecutionProvider as resolveImageExecutionProviderFromModule,
  resolvePrimaryExecutionModelName as resolvePrimaryExecutionModelNameFromModule,
  sanitizeExecutionHintsForRole as sanitizeExecutionHintsForRoleFromModule,
  shouldPreservePinnedProvider as shouldPreservePinnedProviderFromModule,
} from "../../providers/functions/execution-routing.js";
import {
  buildDeterministicDelegations as buildDeterministicDelegationsFromModule,
  delegationRoleForJobType as delegationRoleForJobTypeFromModule,
  jobNeedsMlDelegation as jobNeedsMlDelegationFromModule,
  selectFallbackProvider as selectFallbackProviderFromModule,
} from "../../providers/functions/delegation-routing.js";
import {
  activeSiblingWriteLocks,
  findActiveSiblingLockForPath,
} from "../../queue/functions/sibling-locks.js";
import {
  artifactOutputClaimsReusableComplete as artifactOutputClaimsReusableCompleteFromModule,
  filterNewOrChangedManifestFiles as filterNewOrChangedManifestFilesFromModule,
  materializeFallbackArtifactOutput as materializeFallbackArtifactOutputFromModule,
} from "../functions/helpers/artifact-output.js";
import {
  buildFailureDiagnosticsArtifact as buildFailureDiagnosticsArtifactFromModule,
  extractResearchRetryContext as extractResearchRetryContextFromModule,
  getErrorDetails as getErrorDetailsFromModule,
} from "../functions/helpers/diagnostics.js";
import {
  finishNoWriteAttempt as finishNoWriteAttemptFromModule,
  shouldShortCircuitNoWriteAssessment as shouldShortCircuitNoWriteAssessmentFromModule,
} from "../functions/helpers/no-write-retry.js";
import {
  collectPartialWorkStateAsync as collectPartialWorkStateAsyncFromModule,
  commitScopedPartialWorkAsync as commitScopedPartialWorkAsyncFromModule,
  recordPartialWorkDetected as recordPartialWorkDetectedFromModule,
  revertPartialWork as revertPartialWorkFromModule,
  setPartialWorkError as setPartialWorkErrorFromModule,
  shouldOfferPartialTurnExtension as shouldOfferPartialTurnExtensionFromModule,
  spawnPartialWorkReviewJob as spawnPartialWorkReviewJobFromModule,
  stashPartialWorkForExtensionAsync as stashPartialWorkForExtensionAsyncFromModule,
} from "../functions/helpers/partial-work.js";
import {
  buildStructuredDataPromotePlan as buildStructuredDataPromotePlanFromModule,
  getExplicitIntakeBindings as getExplicitIntakeBindingsFromModule,
  inferPromoteTask as inferPromoteTaskFromModule,
  looksLikeArtifactGenerationTask as looksLikeArtifactGenerationTaskFromModule,
  looksLikeRepoCodeCreationTask as looksLikeRepoCodeCreationTaskFromModule,
  looksLikeRepoDesignTask as looksLikeRepoDesignTaskFromModule,
  looksLikeFileDestination as looksLikeFileDestinationFromModule,
  looksLikeStructuredDataRepoTransformTask as looksLikeStructuredDataRepoTransformTaskFromModule,
  normalizePromoteMappings as normalizePromoteMappingsFromModule,
  validatePlannedTask as validatePlannedTaskFromModule,
} from "../../planning/functions/plan-routing.js";
import {
  extractCheckpointFromOutput as extractCheckpointFromOutputFromModule,
  inferDeletionTargets as inferDeletionTargetsFromModule,
  isDeleteNoopSatisfied as isDeleteNoopSatisfiedFromModule,
  isFilePlacementNoopSatisfied as isFilePlacementNoopSatisfiedFromModule,
  parseAgentCompletionLog as parseAgentCompletionLogFromModule,
  scopedDeleteTargets as scopedDeleteTargetsFromModule,
} from "../functions/helpers/mutation-guards.js";
import {
  isDeepthinkTask as isDeepthinkTaskFromModule,
  shortJobTitle as shortJobTitleFromModule,
} from "../../../shared/policies/functions/role-utils.js";
import {
  buildDeadLetterRetryPayload as _buildDeadLetterRetryPayload,
  classifyApprovalAnswer as _classifyApprovalAnswer,
  classifyDeadLetterRecoveryAnswer as _classifyDeadLetterRecoveryAnswer,
  classifyReviewAnswer as _classifyReviewAnswer,
  extractHumanAnswerText as _extractHumanAnswerText,
  extractHumanAnswers as _extractHumanAnswers,
  incomingDependenciesForRecoveryRetry as _incomingDependenciesForRecoveryRetry,
} from "../functions/execution/human-review.js";
import {
  runHumanInputJob as runHumanInputJobFromModule,
} from "../functions/execution/human-input-job.js";
import {
  runPromoteJob as runPromoteJobFromModule,
} from "../functions/execution/promote-job.js";
import {
  runAtlasWarmJob as runAtlasWarmJobFromModule,
} from "../functions/execution/atlas-warm-job.js";
import {
  emitDevCommitted as emitAtlasV2DevCommitted,
  isAtlasV2EmissionEnabled,
} from "../../atlas/classes/v2/PipelineHooks.js";
import {
  logAttemptSkippedStaleLease as _logAttemptSkippedStaleLease,
} from "../functions/execution/attempt-logging.js";
import {
  assessmentRetryFallbackReads as _assessmentRetryFallbackReads,
  buildPriorAssessmentFindings as _buildPriorAssessmentFindings,
  isAssessorParseRetryBudgetExceeded as _isAssessorParseRetryBudgetExceeded,
  shouldFastPassArtifactAssessment,
  shouldOverrideArtifactMissingFail,
} from "../functions/execution/assessment-policy.js";
import {
  artifactTaskSlug as _artifactTaskSlug,
  buildIntermediateReportTask as _buildIntermediateReportTask,
  isBogusResearchPlaceholderPayload as _isBogusResearchPlaceholderPayload,
  isProcessAlive as _isProcessAlive,
  isProviderError as _isProviderError,
  latestArtifactText as _latestArtifactText,
  loadNudges as _loadNudges,
  normalizePlannerScore as _normalizePlannerScore,
  resolveCallCostEstimate as _resolveCallCostEstimate,
} from "../functions/execution/job-helpers.js";
import {
  syncAssessorWorkerDisplay as syncAssessorWorkerDisplayFromModule,
} from "../functions/execution/display-sync.js";
import {
  logBadInputFailure as _logBadInputFailure,
} from "../functions/execution/bad-input.js";
import {
  validateDeclaredOutputContract,
  filterFileRequestsToOutOfScope,
} from "../functions/execution/declared-output-contract.js";
import {
  worktreeLockTimeoutInfo,
} from "../functions/execution/commit-diagnostics.js";
import {
  JOB_SCRATCH_GC_INTERVAL_MS,
  cleanupOldJobScratchDirs,
  cleanupOldJobScratchDirsAsync,
  jobScratchDirForJob,
  jobScratchRootForProject,
  readIntegerSetting,
  writeJobScratchSentinel,
} from "../functions/execution/job-scratch.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";

export {
  cleanupOldJobScratchDirs,
  cleanupOldJobScratchDirsAsync,
  filterFileRequestsToOutOfScope,
  jobScratchDirForJob,
  jobScratchRootForProject,
  shouldFastPassArtifactAssessment,
  shouldOverrideArtifactMissingFail,
  validateDeclaredOutputContract,
  writeJobScratchSentinel,
};

// --- Constants --------------------------------------------------------------

import {
  NON_PROVIDER_JOB_TYPES as NON_PROVIDER_TYPES,
  DECLARED_OUTPUT_CONTRACT_JOB_TYPES,
} from "../../../catalog/job.js";

export function __testDelegationRoleForJobType(jobType) {
  return delegationRoleForJobTypeFromModule(jobType);
}

export function __testBuildDeterministicDelegations(pendingJobs, opts) {
  return buildDeterministicDelegationsFromModule(pendingJobs, opts);
}

export function __testEffectiveArtifactTaskMode(job, payload) {
  return effectiveArtifactTaskModeFromModule(job, payload);
}
export function __testShouldFastPassArtifactAssessment(args) {
  return shouldFastPassArtifactAssessment(args);
}
export function __testRepairWebAssetCreateScope(task) {
  return repairWebAssetCreateScopeFromModule(task);
}
export function __testMaterializeFallbackArtifactOutput(args) {
  return materializeFallbackArtifactOutputFromModule(args);
}

export function __testSelectFallbackProvider(allProviders, providerName, needsImageGeneration = false) {
  return selectFallbackProviderFromModule(allProviders, providerName, needsImageGeneration);
}

export function __testAssessorParseRetryBudget(jobId) {
  return _isAssessorParseRetryBudgetExceeded(jobId);
}

export function __testAssessmentRetryFallbackReads(modelTier, retryCount) {
  return _assessmentRetryFallbackReads(modelTier, retryCount);
}

// --- Git Helpers ------------------------------------------------------------



/**
 * Stage and commit changes in the worktree.
 *
 * Three-part file scope contract:
 *   modifyFiles  — exact existing files the bot may edit
 *   createFiles  — exact new files the bot may create
 *   deleteFiles  — exact existing files the system may delete
 *   createRoots  — directories where any file may be created or edited
 *                  (for dynamic intake: archives, generated assets, etc.)
 *
 * Staging rules:
 *   - Stage exact modifyFiles (tracked edits)
 *   - Stage exact createFiles (new files)
 *   - For untracked files: allow if exact match in createFiles, or inside createRoots
 *   - For dirty tracked files: allow if in modifyFiles, or inside createRoots
 *   - Everything else: revert and log as out-of-scope
 *   - Root "." is never a valid createRoot
 *   - If no scope is provided at all, fall back to `git add -A`
 *
 * @param {string} message - Commit message
 * @param {string} cwd - Worktree path
 * @param {object} [scope] - File scope contract
 * @param {string[]} [scope.modifyFiles] - Existing files the bot may edit
 * @param {string[]} [scope.createFiles] - Exact new files the bot may create
 * @param {string[]} [scope.deleteFiles] - Exact existing files the system may delete
 * @param {string[]} [scope.createRoots] - Directories where any file may be created/edited
 * @returns {{ hash: string, reverted: string[] }} - Commit hash and any reverted files
 */
function gitCommitAll(message, cwd, scope = null, opts = null) {
  return gitCommitAllFromModule(message, cwd, scope, opts);
}

// --- Worktree Helpers -------------------------------------------------------

export function worktreeRoot(projectDir) {
  return worktreeRootFromModule(projectDir);
}

export function gcWorktreesAsync(projectDir, onMsg = () => {}, opts = {}) {
  return gcWorktreesAsyncFromModule(projectDir, onMsg, opts);
}

// --- Worker Class -----------------------------------------------------------

const PROVIDER_CIRCUIT_TTL_MS = 5 * 60 * 1000;
const ATLAS_FRESHNESS_GATED_JOB_TYPES = new Set(["plan", "dev", "fix"]);
const ATLAS_FRESHNESS_GATE_MAX_DEFERRALS = 3;
const ATLAS_FRESHNESS_GATE_DEFAULT_DELAY_MS = 2500;

function atlasFreshnessDeferralCount(payload = {}) {
  const value = Number(payload?._atlas_freshness_deferrals || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function withAtlasFreshnessDeferral(payload = {}, nextCount = 0) {
  return {
    ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
    _atlas_freshness_deferrals: Math.max(0, Math.floor(Number(nextCount) || 0)),
  };
}

function atlasFreshnessGateDelayMs(config = {}) {
  const configured = Number(config?.viewWaitMs);
  const fallback = Number.isFinite(configured) && configured > 0
    ? configured
    : ATLAS_FRESHNESS_GATE_DEFAULT_DELAY_MS;
  return Math.max(1000, Math.min(5000, Math.floor(fallback)));
}

export class Worker {
  constructor(opts = {}) {
    this.autoApprove = opts.autoApprove || false;
    this.projectDir = opts.projectDir || process.cwd();
    this.display = opts.display || null;
    this.silent = opts.silent || false;
    this.dryRun = opts.dryRun || false;
    this.stallTimeout = opts.stallTimeout || null;
    this.leaseSec = opts.leaseSec || 900;
    this.renewLease = opts.renewLease || renewLease;
    this.createJobLease = typeof opts.createJobLease === "function"
      ? opts.createJobLease
      : (leaseOptions) => new JobLease(leaseOptions);
    this.providerCircuitTtlMs = Number.isFinite(Number(opts.providerCircuitTtlMs))
      ? Math.max(1000, Number(opts.providerCircuitTtlMs))
      : null;
    this._releaseLeaseWithoutAttemptPenalty = opts.releaseLeaseWithoutAttemptPenalty || releaseLeaseWithoutAttemptPenalty;
    this.shuttingDown = false;
    this._abortControllers = new Map();
    this._killReasons = new Map(); // jobId -> reason string (e.g. "runtime_exceeded")
    this._activeWorktrees = new Map(); // jobId -> { wtPath, workItemId, branchName, sentinelPath }
    this._lastAtlasReindexKickAtByRepo = new Map(); // repo/worktree path -> ms
    this._lastScratchGcAt = 0;
    this._providerCircuitOpen = new Map(); // provider -> { openedAt, trippedAt, ttlMs, reason }
    this._pendingSessionRecycles = new Map(); // jobId -> leased/fresh provider session result awaiting durable success
    this._pendingSessionRecycleRenewals = new Map(); // jobId -> session lease renewal timer
    this._terminalCleanupByWorkItem = new Map(); // workItemId -> in-flight cleanup promise
    this.providerClient = opts.providerClient || new TrackedProviderClient({
      worker: this,
      isProviderError: _isProviderError,
      isProviderCircuitOpen: this._isProviderCircuitOpen.bind(this),
      resolveCallCostEstimate: _resolveCallCostEstimate,
    });
    this.roleRegistry = new RoleRegistry({
      providerClient: this.providerClient,
      context: this,
      deps: {
        loadNudges: _loadNudges,
        logBadInputFailure: _logBadInputFailure,
        ...(opts.roleDeps || {}),
      },
    });
    for (const [jobType, RoleClass] of Object.entries(ROLE_CLASSES_BY_JOB_TYPE)) {
      this.roleRegistry.register(jobType, RoleClass);
    }
    this.jobDeps = {
      getJob,
      getDependencies,
      updateJobStatus,
      setJobResult,
      setJobError,
      setJobContext,
      updateJobProvider,
      logEvent,
      ...(opts.jobDeps || {}),
    };
    this.partialWorkCoordinator = opts.partialWorkCoordinator || new PartialWorkCoordinator(this);
    this.executionCoordinator = opts.executionCoordinator || new WorkerExecutionCoordinator(this);
  }

  _providerCircuitTtlMs() {
    return this.providerCircuitTtlMs ?? readIntegerSetting(
      SETTING_KEYS.WORKER_PROVIDER_CIRCUIT_TTL_MS,
      PROVIDER_CIRCUIT_TTL_MS,
      { min: 1000 },
    );
  }

  _wrapJob(job) {
    const agent = NON_PROVIDER_TYPES.has(job?.job_type)
      ? null
      : this.roleRegistry.get(job.job_type);
    return new Job({ row: job, agent, deps: this.jobDeps });
  }

  _createJobLease(job, leaseToken, abortController) {
    return this.createJobLease({
      worker: this,
      job,
      leaseToken,
      leaseSec: this.leaseSec,
      abortController,
      renewLeaseFn: this.renewLease,
    });
  }

  async _setJobRowStatus(jobRow, status) {
    if (!jobRow) return;
    await new Job({ row: jobRow, deps: this.jobDeps }).setStatus(status);
  }

  _logFinalizerFailure(job, kind, err) {
    const message = `${kind} finalizer failed for job #${job?.id ?? "unknown"}: ${err?.message || String(err || "unknown error")}`;
    if (job?.id != null) {
      this.emit(job.id, `${C.yellow}[cleanup] ${message}${C.reset}`);
    }
    try {
      logEvent({
        work_item_id: job?.work_item_id || null,
        job_id: job?.id || null,
        event_type: EVENT_TYPES.WORKER_FINALIZER_FAILED,
        actor_type: EVENT_ACTORS.WORKER,
        message,
      });
    } catch (logErr) {
      log.warn("worker", "Failed to record finalizer failure event", {
        jobId: job?.id ?? null,
        wiId: job?.work_item_id ?? null,
        kind,
        error: message,
        eventLogError: logErr?.message || String(logErr || "unknown error"),
      });
    }
  }

  _maybeCleanupOldJobScratchDirs() {
    const nowMs = Date.now();
    if (nowMs - this._lastScratchGcAt < JOB_SCRATCH_GC_INTERVAL_MS) return;
    this._lastScratchGcAt = nowMs;
    cleanupOldJobScratchDirsAsync({
      projectDir: this.projectDir,
      runtimeRoot: getRuntimeRoot(this.projectDir, this.projectDir),
      activeJobIds: this._abortControllers.keys(),
      nowMs,
    }).then((result) => {
      if (result.removed > 0 || result.failed > 0) {
        try {
          logEvent({
            event_type: EVENT_TYPES.WORKER_SCRATCH_GC,
            actor_type: EVENT_ACTORS.WORKER,
            message: `Removed ${result.removed} old job scratch dir(s); ${result.failed} cleanup failure(s)`,
          });
        } catch {
          // Best-effort housekeeping telemetry.
        }
      }
    }).catch((err) => {
      this._logFinalizerFailure(null, "scratch_gc", err);
    });
  }

  _isProviderCircuitOpen(providerName) {
    if (!providerName) return false;
    const entry = this._providerCircuitOpen.get(providerName);
    if (!entry) return false;
    const trippedAt = Number(entry.trippedAt) || Date.parse(entry.openedAt || "") || 0;
    const ttlMs = Number(entry.ttlMs) || this._providerCircuitTtlMs();
    if (trippedAt > 0 && Date.now() - trippedAt > ttlMs) {
      this._providerCircuitOpen.delete(providerName);
      return false;
    }
    return true;
  }

  _openProviderCircuit(providerName, reason = "provider circuit open") {
    if (!providerName) return;
    this._providerCircuitOpen.set(providerName, {
      openedAt: new Date().toISOString(),
      trippedAt: Date.now(),
      ttlMs: this._providerCircuitTtlMs(),
      reason,
    });
  }

  _selectHealthyProviderFromPool(pool = [], currentProvider = null) {
    if (!Array.isArray(pool) || pool.length === 0) return null;
    for (const candidate of pool) {
      if (!candidate || candidate === currentProvider) continue;
      if (this._isProviderCircuitOpen(candidate)) continue;
      if (!isProviderReady(candidate).ready) continue;
      return candidate;
    }
    return null;
  }

  _registerSessionRecycleResult(result = {}) {
    if (result.jobId == null || !result.newHandle) return;
    this._pendingSessionRecycles.set(Number(result.jobId), result);
  }

  _startSessionRecycleLeaseRenewal(meta = {}) {
    const jobId = Number(meta.jobId);
    const session = meta.decision?.session || null;
    if (!Number.isFinite(jobId) || !session?.id || !session?.leaseToken || !meta.manager?.renewSession) return null;
    this._stopSessionRecycleLeaseRenewal(jobId);

    const leaseSec = sessionLeaseTtlSec();
    const renewMs = JobLease.renewalIntervalMs(leaseSec);
    const entry = {
      timer: null,
      stopped: false,
      stop: () => {
        entry.stopped = true;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      },
      renewNow: () => {
        if (entry.stopped) return "stopped";
        try {
          const renewed = meta.manager.renewSession(session.id, session.leaseToken, {
            jobId,
            leaseTtlSec: leaseSec,
          });
          if (renewed) return "renewed";
          entry.stop();
          this._invalidatePendingSessionRecycleForJob({ id: jobId, work_item_id: meta.workItemId }, "session_lease_expired");
          this.killJob(jobId, "session_lease_expired");
          return "failed";
        } catch (err) {
          entry.stop();
          const message = err?.message || String(err || "unknown error");
          this.emit(jobId, `${C.red}[session]${C.reset} WI#${meta.workItemId ?? "?"} job #${jobId}: session lease renewal threw: ${message}`);
          this.killJob(jobId, "session_lease_renew_failed");
          return "error";
        }
      },
      schedule: () => {
        if (entry.stopped || entry.timer) return;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          if (entry.renewNow() === "renewed") entry.schedule();
        }, renewMs);
        entry.timer?.unref?.();
      },
    };
    this._pendingSessionRecycleRenewals.set(jobId, entry);
    entry.schedule();
    return entry;
  }

  _stopSessionRecycleLeaseRenewal(jobId) {
    const normalizedJobId = Number(jobId);
    const entry = this._pendingSessionRecycleRenewals.get(normalizedJobId);
    if (!entry) return false;
    entry.stop?.();
    this._pendingSessionRecycleRenewals.delete(normalizedJobId);
    return true;
  }

  _releasePendingSessionRecycleForJob(jobId) {
    this._stopSessionRecycleLeaseRenewal(jobId);
    const pending = this._pendingSessionRecycles.get(Number(jobId));
    if (!pending) return;
    try {
      const session = pending.decision?.session;
      if (session?.id && session?.leaseToken) {
        pending.manager?.releaseSession?.(session.id, session.leaseToken);
      }
    } catch {
      // Lease TTL recovery is the durable fallback.
    } finally {
      this._pendingSessionRecycles.delete(Number(jobId));
    }
  }

  _invalidatePendingSessionRecycleForJob(job, reason = "invalidated") {
    const jobId = Number(job?.id);
    this._stopSessionRecycleLeaseRenewal(jobId);
    const pending = this._pendingSessionRecycles.get(jobId);
    if (!pending) return null;
    let sessionInvalidated = false;
    let laneInvalidated = false;
    let sessionId = null;
    let laneId = null;
    try {
      const session = pending.decision?.session || null;
      sessionId = session?.id || null;
      laneId = pending.decision?.lane?.id || session?.lane_id || null;
      if (sessionId) {
        pending.manager?.markExpired?.(sessionId, reason);
        sessionInvalidated = true;
      }
      if (laneId) {
        pending.manager?.invalidateLane?.(laneId, reason);
        laneInvalidated = true;
      }
      recordObservation({
        work_item_id: job?.work_item_id ?? pending.workItemId ?? null,
        job_id: job?.id ?? pending.jobId ?? null,
        attempt_id: pending.attemptId ?? null,
        observation_type: "session.recycle_invalidated",
        summary: `session recycle invalidated: ${reason}`,
        detail: {
          reason,
          provider: pending.providerName || null,
          role: pending.role || job?.job_type || null,
          lane_id: laneId,
          session_id: sessionId,
          session_invalidated: sessionInvalidated,
          lane_invalidated: laneInvalidated,
        },
      });
      return { sessionInvalidated, laneInvalidated, sessionId, laneId };
    } catch {
      return { sessionInvalidated, laneInvalidated, sessionId, laneId };
    } finally {
      this._pendingSessionRecycles.delete(jobId);
    }
  }

  _invalidatePendingSessionRecycleForMcpInfra(job, reason = "mcp_attach_failure") {
    return this._invalidatePendingSessionRecycleForJob(job, reason);
  }

  _finalizeSessionRecycleForJob(job, attempt = null) {
    this._stopSessionRecycleLeaseRenewal(job?.id);
    const pending = this._pendingSessionRecycles.get(Number(job?.id));
    if (!pending || !pending.newHandle) return null;
    try {
      let session = null;
      const decisionSession = pending.decision?.session || null;
      if (pending.mode === "resume" && decisionSession?.id && decisionSession?.leaseToken) {
        session = pending.manager?.advanceSession?.({
          sessionId: decisionSession.id,
          leaseToken: decisionSession.leaseToken,
          newHandle: pending.newHandle,
          jobId: job.id,
          lastAgentCallId: pending.agentCallId || null,
        });
        if (session) {
          pending.manager?.recordSavings?.({
            jobId: job.id,
            workItemId: job.work_item_id,
            laneId: session.lane_id,
            sessionId: session.id,
            role: pending.role || job.job_type,
            provider: pending.providerName || session.provider,
            skillKey: session.skill_key || "",
            hopCount: session.hop_count,
            tokensResume: pending.tokensResume || 0,
            tokensFreshEstimate: pending.tokensFreshEstimate || 0,
            estimateMethod: "prompt_chars_div4",
          });
        } else {
          this._invalidatePendingSessionRecycleForJob(job, "session_advance_lost_lease");
          return null;
        }
      } else {
        const recorded = pending.manager?.recordFreshHandleForJob?.(job, {
          provider: pending.providerName,
          handle: pending.newHandle,
          parentJobId: job.id,
          lastAgentCallId: pending.agentCallId || null,
        });
        session = recorded?.session || null;
      }

      if (session && attempt?.id) {
        setAttemptSession(attempt.id, {
          sessionId: session.id,
          leaseToken: null,
          hopCount: session.hop_count,
        });
      }
      return session;
    } finally {
      this._pendingSessionRecycles.delete(Number(job?.id));
    }
  }

  // --- Main Entry Point --------------------------------------------------

  async execute(job) {
    return await this.executionCoordinator.execute(job);
  }

  async _handlePartialWorkFailure(args = {}) {
    return await this.partialWorkCoordinator.handle(args);
  }

  // --- Job Dispatch -----------------------------------------------------

  async _dispatch(job, tier, attemptCount, attemptId, wrappedJob = null) {
    if (!wrappedJob) wrappedJob = this._wrapJob(job);

    if (wrappedJob?.agent) {
      return await wrappedJob.run({ tier, attemptId, attemptCount });
    }

    throw new Error(`Unknown job type: ${job.job_type}`);
  }

  _spawnFileRequestFollowUp(...args) { return spawnFileRequestFollowUpFromModule(this, ...args); }

  _spawnPlanAfterResearch(...args) { return spawnPlanAfterResearchFromModule(this, ...args); }

  _spawnResearchAfterPreflight(...args) { return spawnResearchAfterPreflightFromModule(this, ...args); }

  _extractResearcherQuestions(...args) { return extractResearcherQuestionsFromModule(...args); }

  // --- Handler: Human Input ---------------------------------------------

  async _humanInputHandler(job, abortSignal = null) {
    return runHumanInputHandler(this, job, abortSignal);
  }

  // --- Kill Support -----------------------------------------------------

  killJob(jobId, reason) {
    if (reason) this._killReasons.set(jobId, reason);
    const ac = this._abortControllers.get(jobId);
    if (ac) {
      const err = new Error("Job aborted");
      err.name = "AbortError";
      err.code = "ABORT_ERR";
      const killReason = reason || this._killReasons.get(jobId);
      if (killReason) err._killReason = killReason;
      ac.abort(err);
      return true;
    }
    return false;
  }

  /**
   * Kill all currently running jobs. Used by the shutdown handler.
   * Snapshots the job IDs first to avoid iterating a mutating map.
   */
  killAllJobs(reason) {
    const jobIds = [...this._abortControllers.keys()];
    for (const jobId of jobIds) {
      this.killJob(jobId, reason);
    }
    return jobIds.length;
  }

  _activeDirtyWorktreeSweepTargets() {
    const unique = new Map();
    for (const [jobId, ctx] of this._activeWorktrees.entries()) {
      if (!ctx?.wtPath) continue;
      const key = String(ctx.wtPath);
      if (!unique.has(key)) unique.set(key, { ...ctx, jobId });
    }
    return [...unique.values()];
  }

  async _readActiveWorktreeSentinelAtRootAsync(wtPath) {
    if (!wtPath) return null;
    const sentinelPath = path.join(wtPath, ".posse", "active-job");
    try {
      const raw = await fs.promises.readFile(sentinelPath, "utf-8");
      const payload = JSON.parse(raw);
      return { sentinelPath, payload };
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      return { sentinelPath, payload: null };
    }
  }

  /**
   * Best-effort synchronous sweep: snapshot+reset dirty active worktrees during
   * shutdown so SIGKILL/OOM windows are smaller before startup GC.
   */
  sweepActiveDirtyWorktrees(reason = "shutdown-dirty-sweep", {
    maxTotalMs = 30000,
    worktreeLockWaitMs = null,
  } = {}) {
    const targets = this._activeDirtyWorktreeSweepTargets();

    let swept = 0;
    let snapshotted = 0;
    let skippedDueBudget = 0;
    let skippedActive = 0;
    let skippedLockTimeout = 0;
    let resetIncomplete = 0;
    const startedAt = Date.now();
    for (const ctx of targets) {
      if (Number.isFinite(maxTotalMs) && maxTotalMs > 0 && (Date.now() - startedAt) > maxTotalMs) {
        skippedDueBudget++;
        continue;
      }
      try {
        const sentinel = readActiveWorktreeSentinelFromModule(ctx.wtPath);
        const sentinelPid = sentinel?.payload?.pid;
        const sentinelLive = sentinelPid != null ? _isProcessAlive(sentinelPid) : null;
        if (sentinel && sentinelLive !== false) {
          skippedActive++;
          continue;
        }
      } catch {
        // Best effort check only.
      }
      try {
        const snapshotDir = snapshotAndResetDirtyWorktreeFromModule(ctx.wtPath, this.projectDir, {
          reason: `${reason}-job-${ctx.jobId}`,
          branchName: ctx.branchName || null,
          wiId: ctx.workItemId ?? null,
          onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "" }) => {
            resetIncomplete++;
            try {
              logEvent({
                work_item_id: ctx.workItemId ?? null,
                job_id: ctx.jobId ?? null,
                event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Shutdown dirty sweep left ${remainingPaths.length} path(s)`,
                event_json: JSON.stringify({
                  remaining_paths: remainingPaths,
                  porcelain: postResetPorcelain,
                  wt_path: ctx.wtPath,
                }),
              });
            } catch {
              // best effort
            }
          },
          worktreeLockWaitMs,
        });
        swept++;
        if (snapshotDir) snapshotted++;
      } catch (err) {
        if (/Timed out waiting for worktree lock/i.test(String(err?.message || err || ""))) {
          skippedLockTimeout++;
        }
      }
    }
    if (resetIncomplete > 0) {
      try {
        logEvent({
          event_type: EVENT_TYPES.WORKTREE_SHUTDOWN_SWEEP_INCOMPLETE,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Shutdown sweep left residual dirt in ${resetIncomplete} worktree reset(s)`,
          event_json: JSON.stringify({
            swept,
            snapshotted,
            skipped_due_budget: skippedDueBudget,
            skipped_active: skippedActive,
            skipped_lock_timeout: skippedLockTimeout,
            reset_incomplete: resetIncomplete,
          }),
        });
      } catch {
        // best effort
      }
    }
    return { swept, snapshotted, skippedDueBudget, skippedActive, skippedLockTimeout, resetIncomplete };
  }

  /**
   * Best-effort async sweep used by signal-driven shutdown. Keep this off the
   * signal handler's stack so another Ctrl+C can still be handled immediately.
   */
  async sweepActiveDirtyWorktreesAsync(reason = "shutdown-dirty-sweep", {
    maxTotalMs = 30000,
    worktreeLockWaitMs = null,
  } = {}) {
    const targets = this._activeDirtyWorktreeSweepTargets();

    let swept = 0;
    let snapshotted = 0;
    let skippedDueBudget = 0;
    let skippedActive = 0;
    let skippedLockTimeout = 0;
    let resetIncomplete = 0;
    const startedAt = Date.now();
    for (const ctx of targets) {
      if (Number.isFinite(maxTotalMs) && maxTotalMs > 0 && (Date.now() - startedAt) > maxTotalMs) {
        skippedDueBudget++;
        continue;
      }
      try {
        const sentinel = await this._readActiveWorktreeSentinelAtRootAsync(ctx.wtPath);
        const sentinelPid = sentinel?.payload?.pid;
        const sentinelLive = sentinelPid != null ? _isProcessAlive(sentinelPid) : null;
        if (sentinel && sentinelLive !== false) {
          skippedActive++;
          continue;
        }
      } catch {
        // Best effort check only.
      }
      try {
        const snapshotDir = await snapshotAndResetDirtyWorktreeAsyncFromModule(ctx.wtPath, this.projectDir, {
          reason: `${reason}-job-${ctx.jobId}`,
          branchName: ctx.branchName || null,
          wiId: ctx.workItemId ?? null,
          onResetIncomplete: ({ remainingPaths = [], postResetPorcelain = "" }) => {
            resetIncomplete++;
            try {
              logEvent({
                work_item_id: ctx.workItemId ?? null,
                job_id: ctx.jobId ?? null,
                event_type: EVENT_TYPES.WORKTREE_RESET_INCOMPLETE,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Shutdown dirty sweep left ${remainingPaths.length} path(s)`,
                event_json: JSON.stringify({
                  remaining_paths: remainingPaths,
                  porcelain: postResetPorcelain,
                  wt_path: ctx.wtPath,
                }),
              });
            } catch {
              // best effort
            }
          },
          worktreeLockWaitMs,
        });
        swept++;
        if (snapshotDir) snapshotted++;
      } catch (err) {
        if (/Timed out waiting for worktree lock/i.test(String(err?.message || err || ""))) {
          skippedLockTimeout++;
        }
      }
      await yieldNow();
    }
    if (resetIncomplete > 0) {
      try {
        logEvent({
          event_type: EVENT_TYPES.WORKTREE_SHUTDOWN_SWEEP_INCOMPLETE,
          actor_type: EVENT_ACTORS.WORKER,
          message: `Shutdown sweep left residual dirt in ${resetIncomplete} worktree reset(s)`,
          event_json: JSON.stringify({
            swept,
            snapshotted,
            skipped_due_budget: skippedDueBudget,
            skipped_active: skippedActive,
            skipped_lock_timeout: skippedLockTimeout,
            reset_incomplete: resetIncomplete,
          }),
        });
      } catch {
        // best effort
      }
    }
    return { swept, snapshotted, skippedDueBudget, skippedActive, skippedLockTimeout, resetIncomplete };
  }

  // --- Stall Resume ----------------------------------------------------

  /**
   * Detect if scoped files were modified by other jobs since this job was created.
   * Returns a drift context string for the prompt, or empty string if no drift.
   */
  detectDrift(...args) { return detectDriftFromModule(this, ...args); }

  /**
   * Apply a stall-kill stash and generate continuation context for the prompt.
   * Returns a continuation context string, or null if no stash / stash failed.
   */
  applyStallStash(...args) { return applyStallStashFromModule(this, ...args); }
  applyStallStashAsync(...args) { return applyStallStashAsyncFromModule(this, ...args); }

  // --- JSON Repair (cheap LLM call) -------------------------------------

  /**
   * When extractJson fails on planner/delegator output, make one cheap LLM
   * call asking the model to emit ONLY valid JSON. This avoids burning a
   * full retry (with the entire research context re-sent) on a fixable
   * formatting issue.
   *
   * Returns the parsed result or null if repair also failed.
   */
  _registerAbortController(jobId) {
    const ac = new AbortController();
    if (jobId) this._abortControllers.set(jobId, ac);
    return ac;
  }

  _throwIfKilled(jobId) {
    const ac = this._abortControllers.get(jobId);
    if (!ac?.signal?.aborted) return;
    const err = new Error("Job aborted");
    err.name = "AbortError";
    if (this._killReasons.has(jobId)) err._killReason = this._killReasons.get(jobId);
    throw err;
  }

  _abortPromise(jobId, abortSignal) {
    if (!abortSignal) return null;
    if (abortSignal.aborted) {
      const err = new Error("Job aborted");
      err.name = "AbortError";
      if (this._killReasons.has(jobId)) err._killReason = this._killReasons.get(jobId);
      return Promise.reject(err);
    }
    return new Promise((_, reject) => {
      const onAbort = () => {
        abortSignal.removeEventListener("abort", onAbort);
        const err = new Error("Job aborted");
        err.name = "AbortError";
        if (this._killReasons.has(jobId)) err._killReason = this._killReasons.get(jobId);
        reject(err);
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  _handleDeterministicInterruption(...args) { return handleDeterministicInterruptionFromModule(this, ...args); }

  async repairJson(rawOutput, role, job) {
    const snippet = (rawOutput || "").slice(0, 4000).trim();

    // Nothing to repair — the output was empty.  Skip the API call;
    // the caller will treat null as "repair failed" and throw/retry.
    if (!snippet) {
      this.emit(job.id, `${C.yellow}[${role}] WI#${job.work_item_id} JSON parse failed — output was empty, skipping repair${C.reset}`);
      return null;
    }

    const prompt = [
      `The following LLM output was supposed to be a JSON array but could not be parsed.`,
      `Fix it and respond with ONLY the corrected JSON — no explanation, no markdown fences.`,
      `If the JSON is truncated, close any open brackets/braces after removing the incomplete trailing entry.`,
      ``,
      `--- RAW OUTPUT ---`,
      snippet,
      `--- END ---`,
    ].join("\n");

    try {
      this.emit(job.id, `${C.yellow}[${role}] WI#${job.work_item_id} JSON parse failed — attempting cheap repair call${C.reset}`);
      const { output } = await this.providerClient.call(prompt, {
        role,
        allowWrite: false,
        modelTier: "cheap",
        reasoningEffort: "low",
        maxTurns: 1,
        activity: `json-repair: ${shortJobTitleFromModule(job).slice(0, 30)}`,
      }, { job_id: job.id, work_item_id: job.work_item_id, cwd: this.projectDir });

      const result = extractJson(output);
      // Reject empty arrays — the caller always needs a non-empty array,
      // and a repair LLM that returns [] had nothing to work with.
      if (Array.isArray(result) && result.length === 0) {
        this.emit(job.id, `${C.yellow}[${role}] WI#${job.work_item_id} JSON repair returned empty array${C.reset}`);
        return null;
      }
      if (result) {
        this.emit(job.id, `${C.green}[${role}] WI#${job.work_item_id} JSON repair succeeded${C.reset}`);
      }
      return result;
    } catch (err) {
      this.emit(job.id, `${C.red}[${role}] WI#${job.work_item_id} JSON repair call failed: ${err.message?.split("\n")[0]}${C.reset}`);
      return null;
    }
  }

  // --- Retry / Dead-Letter ----------------------------------------------

  async _gateAtlasFreshnessBeforePlanningOrDev(job, leaseToken, { signal = null } = {}) {
    if (!ATLAS_FRESHNESS_GATED_JOB_TYPES.has(job?.job_type)) return { ok: true };
    if (signal?.aborted) {
      throw (signal.reason instanceof Error ? signal.reason : new Error("Job interrupted before ATLAS freshness gate"));
    }

    const payload = this.parsePayload(job);
    if (payload?._assess_only && ASSESSABLE_JOB_TYPES.has(job?.job_type)) {
      return { ok: true, skipped: "assess_only" };
    }
    const priorDeferrals = atlasFreshnessDeferralCount(payload);
    const config = getAtlasIntegrationConfig();
    const gate = await checkAtlasMainFreshnessGate({
      cwd: this.projectDir,
      config,
      requestRefresh: priorDeferrals < ATLAS_FRESHNESS_GATE_MAX_DEFERRALS,
    });
    if (gate.ready || !gate.attempted) return { ok: true, gate };

    const pendingIds = (gate.pendingWarmJobs || [])
      .map((warmJob) => Number(warmJob?.id))
      .filter((id) => Number.isFinite(id));

    if (gate.action === "defer" && priorDeferrals < ATLAS_FRESHNESS_GATE_MAX_DEFERRALS) {
      const nextDeferrals = priorDeferrals + 1;
      job.payload_json = JSON.stringify(withAtlasFreshnessDeferral(payload, nextDeferrals));
      updateJobPayload(job.id, job.payload_json);

      const delayMs = atlasFreshnessGateDelayMs(config);
      const readyAt = new Date(Date.now() + delayMs).toISOString();
      const message = `Deferred ${job.job_type} job behind ATLAS main refresh (${pendingIds.length || 1} warm job${pendingIds.length === 1 ? "" : "s"} pending)`;
      this.emit(
        job.id,
        `${C.dim}[atlas] WI#${job.work_item_id} job #${job.id}: main refresh pending; retrying in ${delayMs}ms${C.reset}`,
      );
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.ATLAS_FRESHNESS_GATE_DEFERRED,
        actor_type: EVENT_ACTORS.ATLAS,
        message,
        event_json: JSON.stringify({
          job_type: job.job_type,
          deferrals: nextDeferrals,
          max_deferrals: ATLAS_FRESHNESS_GATE_MAX_DEFERRALS,
          ready_at: readyAt,
          delay_ms: delayMs,
          reason: gate.reason || null,
          action: gate.action || null,
          target_branch: gate.targetBranch || null,
          pending_warm_job_ids: pendingIds,
          request: gate.request || null,
          readiness: gate.readiness || null,
        }),
      });
      this._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
      return { ok: false, deferred: true, gate, readyAt };
    }

    const message = `Proceeding with ${job.job_type} job after ATLAS freshness gate degraded (${gate.reason || "atlas_not_ready"})`;
    this.emit(
      job.id,
      `${C.yellow}[atlas] WI#${job.work_item_id} job #${job.id}: main view not fresh after ${priorDeferrals} deferral(s); proceeding with degraded ATLAS${C.reset}`,
    );
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.ATLAS_FRESHNESS_GATE_DEGRADED,
      actor_type: EVENT_ACTORS.ATLAS,
      message,
      event_json: JSON.stringify({
        job_type: job.job_type,
        deferrals: priorDeferrals,
        max_deferrals: ATLAS_FRESHNESS_GATE_MAX_DEFERRALS,
        reason: gate.reason || null,
        action: gate.action || null,
        target_branch: gate.targetBranch || null,
        pending_warm_job_ids: pendingIds,
        readiness: gate.readiness || null,
      }),
    });
    return { ok: true, degraded: true, gate };
  }

  _retryOrFail(...args) { return retryOrFailFromModule(this, ...args); }

  // --- Lease Management -------------------------------------------------

  _releaseLease(job, leaseToken, finalStatus, { readyAt = null } = {}) {
    const released = releaseLease(job.id, leaseToken, finalStatus, { readyAt });
    if (!released) {
      log.warn("worker", `Stale lease on release`, { jobId: job.id, wiId: job.work_item_id, finalStatus });
      this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease expired${C.reset}`);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_STALE_LEASE_RELEASE,
        actor_type: EVENT_ACTORS.WORKER,
        message: `Lease expired before release — result discarded`,
      });
      return false;
    }
    job.status = finalStatus;
    if (readyAt !== null) job.ready_at = readyAt;
    return true;
  }

  _releaseWithoutAttemptPenalty(job, leaseToken, finalStatus, { readyAt = null } = {}) {
    const released = this._releaseLeaseWithoutAttemptPenalty(job.id, leaseToken, finalStatus, { readyAt });
    if (released) {
      job.status = finalStatus;
      if (readyAt !== null) job.ready_at = readyAt;
      refreshWorkItemStatus(job.work_item_id);
      return true;
    }
    this.emit(
      job.id,
      `${C.red}[stale-lease]${C.reset} WI#${job.work_item_id} job #${job.id}: lease lost before release (${finalStatus})`
    );
    return released;
  }

  // --- Worktree Cleanup -------------------------------------------------

  primeCreatableFiles(...args) { return primeCreatableFilesFromModule(...args); }

  _cleanupWorktreeIfDone(...args) {
    const workItemId = args[0];
    const cleanupKey = workItemId == null ? null : Number(workItemId) || String(workItemId);
    if (cleanupKey != null && this._terminalCleanupByWorkItem.has(cleanupKey)) {
      return this._terminalCleanupByWorkItem.get(cleanupKey);
    }
    const cleanup = cleanupWorktreeIfDoneAsyncFromModule(this, ...args);
    if (cleanupKey != null && cleanup?.finally) {
      this._terminalCleanupByWorkItem.set(cleanupKey, cleanup);
      void cleanup.finally(() => {
        if (this._terminalCleanupByWorkItem.get(cleanupKey) === cleanup) {
          this._terminalCleanupByWorkItem.delete(cleanupKey);
        }
      }).catch(() => {});
    }
    cleanup?.catch?.((err) => {
      try { this._logFinalizerFailure({ id: null }, "worktree_terminal_cleanup", err); } catch { /* ignore */ }
    });
    return cleanup;
  }

  // --- Assessment Skip Check --------------------------------------------

  _shouldSkipAssessment(job) {
    // Skip assessment if the planner explicitly set skip_assessment: true
    if (parseJobPayload(job).skip_assessment) return true;
    // Skip assessment if an explicit assess job depends on this one
    // (single authority rule — avoid double assessment)
    try {
      const dependents = getDependents(job.id);
      return dependents.some(d => {
        const depJob = getJob(d.job_id);
        return depJob && depJob.job_type === "assess";
      });
    } catch { return false; }
  }

  // --- Plan ? Jobs -----------------------------------------------------

  createJobsFromPlan(...args) {
    const [planJob, tasks] = args;
    const session = new PlanSession({
      worker: this,
      planJob,
      rawTasks: tasks,
      options: {
      artifactTaskSlug: _artifactTaskSlug,
      buildIntermediateReportTask: _buildIntermediateReportTask,
      isDeepthinkTask: isDeepthinkTaskFromModule,
      logBadInputFailure: _logBadInputFailure,
      normalizePlannerScore: _normalizePlannerScore,
      },
    });
    return session.emit();
  }

  // --- Utilities --------------------------------------------------------

  emit(jobId, message) {
    if (this.display && typeof this.display.workerLine === "function") {
      this.display.workerLine(jobId, message);
    } else if (!this.silent) {
      console.log(message);
    }
  }

  async _kickAtlasReindex(jobOrId, commitHash, options = {}) {
    const job = jobOrId && typeof jobOrId === "object" ? jobOrId : null;
    const jobId = job?.id ?? jobOrId;
    const suppressTerminalWiRefresh = options?.suppressTerminalWiRefresh === true;

    // ATLAS v2 transactional outbox: emit `atlas.dev_committed` and enqueue a
    // companion warm job. A branch-local warm is still useful while a completed
    // WI waits for review or a cross-WI blocker before merge-to-main replay.
    if (job && commitHash && isAtlasV2EmissionEnabled()) {
      try {
        let branchName = job._branchName || null;
        if (!branchName) {
          try {
            branchName = (await gitExecAsync(["rev-parse", "--abbrev-ref", "HEAD"], job._worktreePath || this.projectDir)).trim();
          } catch {
            branchName = null;
          }
        }
        let paths = [];
        if (job._worktreePath) {
          try {
            paths = (await gitExecAsync(["show", "--name-only", "--pretty=format:", commitHash], job._worktreePath))
              .split("\n")
              .map((line) => String(line || "").replace(/\\/g, "/").trim())
              .filter(Boolean);
          } catch { paths = []; }
        }
        emitAtlasV2DevCommitted({
          payload: {
            wi_id: Number(job.work_item_id),
            branch: branchName || "",
            commit_sha: String(commitHash),
            paths,
            job_id: Number(job.id),
          },
          enqueueWarmJob: !suppressTerminalWiRefresh,
          onError: (err) => {
            this.emit(jobId, `${C.dim}[atlas-v2] outbox emit failed: ${err.message.split("\n")[0]}${C.reset}`);
          },
        });
      } catch (emitErr) {
        // Outbox errors must never block the pipeline.
        this.emit(jobId, `${C.dim}[atlas-v2] outbox emit skipped: ${emitErr?.message?.split?.("\n")?.[0] || emitErr}${C.reset}`);
      }
    }

    let atlasConfig;
    try {
      atlasConfig = job?._atlasConfig || getAtlasIntegrationConfig();
    } catch {
      return;
    }
    if (!atlasConfig.enabled || job?._atlasDisabledForWorkItem) return;
    const shortHash = commitHash ? String(commitHash).slice(0, 8) : "";
    if (suppressTerminalWiRefresh) {
      this.emit(jobId, `${C.dim}[atlas] reindex skipped after ${shortHash} (commit warm explicitly suppressed)${C.reset}`);
      return;
    }
    const reindexCwd = job?._worktreePath || this.projectDir;
    const repoKey = String(reindexCwd || this.projectDir);
    const nowMs = Date.now();
    const lastKickAt = Number(this._lastAtlasReindexKickAtByRepo.get(repoKey) || 0);
    if (lastKickAt > 0 && nowMs - lastKickAt < 60_000) {
      this.emit(jobId, `${C.dim}[atlas] reindex skipped after ${shortHash} (cooldown; latest commit will be picked up by the next refresh)${C.reset}`);
      return;
    }
    this._lastAtlasReindexKickAtByRepo.set(repoKey, nowMs);
    const result = reindexAtlasAfterCommit({
      cwd: reindexCwd,
      config: atlasConfig,
      onStatus: ({ ok, error, status }) => {
        if (ok) {
          this.emit(jobId, `${C.dim}[atlas] reindex complete after ${shortHash}${C.reset}`);
        } else {
          const detail = error || (status != null ? `exit ${status}` : "unknown");
          this.emit(jobId, `${C.yellow}[atlas] reindex failed after ${shortHash}: ${detail}${C.reset}`);
        }
      },
    });
    if (result.attempted) {
      this.emit(jobId, `${C.dim}[atlas] reindex kicked off after ${shortHash}${C.reset}`);
    } else if (result.skipped === "reindex_in_progress") {
      this.emit(jobId, `${C.dim}[atlas] reindex queued (in-progress run will replay)${C.reset}`);
    }
  }

  parsePayload(job) {
    return parseJobPayload(job);
  }


  _roleFor(jobType) {
    const agent = this.roleRegistry?.get(jobType);
    if (agent && typeof agent.getRole === "function") return agent.getRole();
    return workerRoleForJobType(jobType);
  }
}

export const __testPreserveDirtyWorktreeSnapshot = preserveDirtyWorktreeSnapshotFromModule;
export const __testGitStash = gitStash;
export const __testArtifactOutputClaimsReusableComplete = artifactOutputClaimsReusableCompleteFromModule;
export const __testFilterNewOrChangedManifestFiles = filterNewOrChangedManifestFilesFromModule;
export const __testRequiresGitNoopCheck = requiresGitNoopCheckFromModule;
export const __testValidateDeclaredOutputContract = validateDeclaredOutputContract;
export const __testWorktreeLockTimeoutInfo = worktreeLockTimeoutInfo;
export const __testResolvePrimaryExecutionModelName = resolvePrimaryExecutionModelNameFromModule;
export const __testResolveExecutionProviderFromSettings = resolveExecutionProviderFromModule;
export const __testSanitizeExecutionHintsForRole = sanitizeExecutionHintsForRoleFromModule;
export const __testClassifyApprovalAnswer = _classifyApprovalAnswer;
export const __testExtractHumanAnswerText = _extractHumanAnswerText;
export const __testInferDeletionTargets = inferDeletionTargetsFromModule;
export const __testFilePlacementNoopSatisfied = isFilePlacementNoopSatisfiedFromModule;
export const resolveImageExecutionProvider = resolveImageExecutionProviderFromModule;
