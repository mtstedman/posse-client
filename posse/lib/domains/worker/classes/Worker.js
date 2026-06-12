// lib/worker.js — Job execution engine
//
// Dispatches jobs by type, manages attempts, model escalation on retry,
// exponential backoff, artifact storage. Dev/fix jobs go through assessor
// after execution.

import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { isInsideRoot, isUnderRoot, normPath, normalizeRoots, resolvePathWithin } from "../functions/helpers/scope.js";
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
import { runHumanInputHandler } from "../functions/helpers/human-input.js";
import { ROLE_CLASSES_BY_JOB_TYPE } from "./role-classes.js";
import { buildRoutingPacket, handoff, parseMissingContext, parseFileRequest, splitFileRequestsByRisk, parseResearcherStructuredOutput, researcherOutputNeedsHuman, _parseFunctions, applyDeterministicDeletes, attachAssessmentDiffContext, hasWritableScope, renderAtlasHandoffSections } from "../../handoff/functions/index.js";
import { injectArtifactScope, normalizeArtifactCreateFiles, isArtifactMode, isValidTaskMode, buildManifest, wiScopeId, artifactsDir, workspaceDir, inputsDir, contextDir, getWiModeConfig, validateManifestAgainstContract, getArtifactProtocol, getResolvedImageProtocol, getConfiguredImageProviders, getConfiguredImageModel } from "../../artifacts/functions/index.js";
import { C } from "../../../shared/format/functions/colors.js";
import { roleBrandColor } from "../../ui/functions/display/helpers/brand.js";
import { extractJson } from "../../../shared/format/functions/json.js";
import { runHookAsync } from "../functions/helpers/hooks.js";
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
import { getWorkItemIntakeHints, buildResearchIntakePreload, buildIntakeHintsBlock } from "../functions/helpers/intake-hints.js";
import {
  countInternalAssessmentRetries,
  getAssessmentInternalRetryLimit,
} from "../functions/helpers/assessment-shared.js";
import { refreshAndExtractInsights as refreshAndExtractInsightsFromModule } from "../functions/helpers/insights.js";
import {
  gitCommitAll as gitCommitAllFromModule,
  gitCommitAllAsync as gitCommitAllAsyncFromModule,
  repairWebAssetCreateScope as repairWebAssetCreateScopeFromModule,
} from "../../git/functions/commit-scope.js";
import {
  gcWorktreesAsync as gcWorktreesAsyncFromModule,
  preserveDirtyWorktreeSnapshot as preserveDirtyWorktreeSnapshotFromModule,
  resetDirtyWorktreeFallbackAsync as resetDirtyWorktreeFallbackAsyncFromModule,
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
} from "../functions/helpers/plan-compiler.js";
import {
  ASSESSABLE_JOB_TYPES,
  MUTATING_JOB_TYPES,
} from "../functions/helpers/job-type-sets.js";
import {
  effectiveArtifactTaskMode as effectiveArtifactTaskModeFromModule,
  isImageOnlyModelName as isImageOnlyModelNameFromModule,
  requiresGitNoopCheck as requiresGitNoopCheckFromModule,
  resolveExecutionProviderFromSettings as resolveExecutionProviderFromModule,
  resolveImageExecutionProvider as resolveImageExecutionProviderFromModule,
  resolvePrimaryExecutionModelName as resolvePrimaryExecutionModelNameFromModule,
  sanitizeExecutionHintsForRole as sanitizeExecutionHintsForRoleFromModule,
  shouldPreservePinnedProvider as shouldPreservePinnedProviderFromModule,
} from "../functions/helpers/execution-routing.js";
import {
  buildDeterministicDelegations as buildDeterministicDelegationsFromModule,
  delegationRoleForJobType as delegationRoleForJobTypeFromModule,
  jobNeedsMlDelegation as jobNeedsMlDelegationFromModule,
  selectFallbackProvider as selectFallbackProviderFromModule,
} from "../functions/helpers/delegation-routing.js";
import {
  activeSiblingWriteLocks,
  findActiveSiblingLockForPath,
} from "../functions/helpers/shared-worktree-locks.js";
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
} from "../functions/helpers/plan-routing.js";
import {
  extractCheckpointFromOutput as extractCheckpointFromOutputFromModule,
  inferDeletionTargets as inferDeletionTargetsFromModule,
  isDeleteNoopSatisfied as isDeleteNoopSatisfiedFromModule,
  isFilePlacementNoopSatisfied as isFilePlacementNoopSatisfiedFromModule,
  parseAgentCompletionLog as parseAgentCompletionLogFromModule,
  planArtifactReuse as planArtifactReuseFromModule,
  scopedDeleteTargets as scopedDeleteTargetsFromModule,
} from "../functions/helpers/mutation-guards.js";
import {
  isDeepthinkTask as isDeepthinkTaskFromModule,
  shortJobTitle as shortJobTitleFromModule,
} from "../functions/helpers/role-utils.js";
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
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";

export {
  shouldFastPassArtifactAssessment,
  shouldOverrideArtifactMissingFail,
};

// --- Constants --------------------------------------------------------------

import {
  NON_PROVIDER_JOB_TYPES as NON_PROVIDER_TYPES,
  DECLARED_OUTPUT_CONTRACT_JOB_TYPES,
} from "../../../catalog/job.js";

function normalizeDeclaredOutputPath(filePath, cwd) {
  return normalizeFileRequestScopePath(filePath, cwd);
}

function uniqueNormalizedPaths(paths = [], cwd = process.cwd()) {
  const out = [];
  const seen = new Set();
  for (const pathValue of Array.isArray(paths) ? paths : []) {
    const normalized = normalizeDeclaredOutputPath(pathValue, cwd);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function declaredOutputContractDisabled(payload = {}) {
  return payload?.declared_output_contract === false
    || payload?.declared_output_contract === "false"
    || payload?._skip_output_contract === true
    || payload?._skip_output_contract === "true"
    || payload?._allow_missing_declared_outputs === true
    || payload?._allow_missing_declared_outputs === "true";
}

async function pathExistsInWorktreeAsync(cwd, relativePath) {
  if (!relativePath) return false;
  const resolved = path.resolve(cwd || process.cwd(), relativePath);
  try {
    await fs.promises.access(resolved);
    return true;
  } catch {
    return false;
  }
}

export async function validateDeclaredOutputContract({
  job,
  payload = {},
  filesCommitted = [],
  cwd = process.cwd(),
} = {}) {
  if (!DECLARED_OUTPUT_CONTRACT_JOB_TYPES.has(job?.job_type)) return { ok: true };
  if (declaredOutputContractDisabled(payload)) return { ok: true, skipped: true };

  // normPath lowercases on win32 so comparisons are case-insensitive, but
  // failure messages must show paths as the planner declared them.
  const displayByNormalized = new Map();
  for (const raw of [
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload.must_modify) ? payload.must_modify : []),
  ]) {
    const normalized = normalizeDeclaredOutputPath(raw, cwd);
    if (normalized && !displayByNormalized.has(normalized)) {
      displayByNormalized.set(normalized, String(raw).replace(/\\/g, "/").trim());
    }
  }
  const display = (paths) => paths.map((p) => displayByNormalized.get(p) || p);

  const declaredCreates = uniqueNormalizedPaths(payload.files_to_create, cwd);
  // must_modify is a hard requirement on its own; the planner is not required
  // to duplicate those paths into files_to_modify for them to be enforced.
  const declaredModifies = uniqueNormalizedPaths(
    [
      ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
      ...(Array.isArray(payload.must_modify) ? payload.must_modify : []),
    ],
    cwd,
  );
  if (declaredCreates.length === 0 && declaredModifies.length === 0) return { ok: true };

  const mustModify = new Set(uniqueNormalizedPaths(payload.must_modify, cwd));
  const committed = new Set(uniqueNormalizedPaths(filesCommitted, cwd));
  // Check all declared paths in parallel. This is in the post-commit hot
  // path so a synchronous loop of fs.existsSync over N declared files
  // would block the event loop and starve other workers' progress.
  const [createsExist, modifiesExist] = await Promise.all([
    Promise.all(declaredCreates.map((filePath) => pathExistsInWorktreeAsync(cwd, filePath))),
    Promise.all(declaredModifies.map((filePath) => pathExistsInWorktreeAsync(cwd, filePath))),
  ]);
  const missingCreates = declaredCreates.filter((_, i) => !createsExist[i]);
  const untouchedCreates = declaredCreates.filter((filePath) => !committed.has(filePath));
  // files_to_modify is allowed scope, not a work order: a dev that correctly
  // judges a declared file needs no change must not fail the attempt. Only
  // paths the planner explicitly listed in must_modify stay hard-required;
  // the rest are reported as unmodified scope for the assessor to weigh.
  const missingModifiesAll = declaredModifies.filter((_, i) => !modifiesExist[i]);
  const missingModifies = missingModifiesAll.filter((filePath) => mustModify.has(filePath));
  const untouchedModifiesAll = declaredModifies.filter((filePath) => !committed.has(filePath));
  const untouchedModifies = untouchedModifiesAll.filter((filePath) => mustModify.has(filePath));
  const unmodifiedDeclaredScope = untouchedModifiesAll.filter((filePath) => !mustModify.has(filePath));

  return {
    ok: missingCreates.length === 0
      && missingModifies.length === 0
      && untouchedCreates.length === 0
      && untouchedModifies.length === 0,
    missingCreates: display(missingCreates),
    missingModifies: display(missingModifies),
    untouchedCreates: display(untouchedCreates),
    untouchedModifies: display(untouchedModifies),
    unmodifiedDeclaredScope: display(unmodifiedDeclaredScope),
  };
}

function worktreeLockTimeoutInfo(error, detail = "") {
  const text = [error?.message, error?.stderr, detail].filter(Boolean).join("\n");
  if (!/Timed out waiting for worktree lock/i.test(text)) return { timeout: false };
  const match = text.match(/Timed out waiting for worktree lock:\s*([^\r\n]+)/i)
    || text.match(/([^\s"'`]*worktree-locks[\\/][^\s"'`]+\.lock)/i);
  const lockPath = match?.[1] ? String(match[1]).trim() : null;
  // This runs on the error-handling path; the lock file may live on a
  // network mount that's slow or hung, so we keep the sync stat but
  // surface "unknown" rather than letting the diagnostics call block.
  // The detailed mtime/size diagnostics are best-effort metadata.
  let lockStat = null;
  if (lockPath) {
    try {
      const stat = fs.statSync(lockPath);
      lockStat = {
        exists: true,
        mtime: stat.mtime.toISOString(),
        age_ms: Math.max(0, Date.now() - stat.mtimeMs),
        size: stat.size,
      };
    } catch {
      lockStat = { exists: false };
    }
  }
  return { timeout: true, lockPath, lockStat };
}

/**
 * Async variant that races the stat against a short timeout — useful on
 * network mounts where fs.statSync can hang for many seconds. Falls back
 * to {exists: "unknown"} so the diagnostics still surface the lock path.
 */
async function worktreeLockTimeoutInfoAsync(error, detail = "", { statTimeoutMs = 250 } = {}) {
  const text = [error?.message, error?.stderr, detail].filter(Boolean).join("\n");
  if (!/Timed out waiting for worktree lock/i.test(text)) return { timeout: false };
  const match = text.match(/Timed out waiting for worktree lock:\s*([^\r\n]+)/i)
    || text.match(/([^\s"'`]*worktree-locks[\\/][^\s"'`]+\.lock)/i);
  const lockPath = match?.[1] ? String(match[1]).trim() : null;
  let lockStat = null;
  if (lockPath) {
    let timer = null;
    const statPromise = fs.promises.stat(lockPath).then(
      (stat) => ({ ok: true, stat }),
      () => ({ ok: false }),
    );
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), statTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([statPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      if (result.ok) {
        lockStat = {
          exists: true,
          mtime: result.stat.mtime.toISOString(),
          age_ms: Math.max(0, Date.now() - result.stat.mtimeMs),
          size: result.stat.size,
        };
      } else if (result.timedOut) {
        lockStat = { exists: "unknown", reason: `stat timed out after ${statTimeoutMs}ms` };
      } else {
        lockStat = { exists: false };
      }
    } catch {
      lockStat = { exists: false };
    }
  }
  return { timeout: true, lockPath, lockStat };
}

function firstMeaningfulCommitErrorLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function commitFailureOutputDetail(error = {}) {
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  const parts = [];
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (stdout) parts.push(`stdout:\n${stdout}`);
  return parts.join("\n\n");
}

function formatCommitFailureDetail(error = {}) {
  const hookOutput = String(error?.hookOutput || "").trim();
  const outputDetail = commitFailureOutputDetail(error);
  return [error?.message || String(error), hookOutput, outputDetail]
    .filter(Boolean)
    .join("\n\n");
}

function formatCommitFailureSummary(error = {}) {
  const base = error?.message || String(error);
  const stderrLine = firstMeaningfulCommitErrorLine(error?.stderr);
  const stdoutLine = firstMeaningfulCommitErrorLine(error?.stdout);
  const extra = stderrLine || stdoutLine || error?.code || "";
  return extra && !String(base).includes(extra) ? `${base} - ${extra}` : base;
}

// Commit failures raised by the native identity/heartbeat layer are transient
// infrastructure faults: the agent's work in the tree is intact and a short
// in-place re-commit usually succeeds once the key renews. Scope, hook, and
// content failures must never classify as transient — those need a real retry.
const TRANSIENT_COMMIT_INFRA_RE = /posse_key\s+heartbeat|pulse[\s_-]?token|identity\s+heartbeat/i;
export function isTransientCommitInfraFailure(error = {}) {
  if (Array.isArray(error?.createdOutOfScope) && error.createdOutOfScope.length > 0) return false;
  if (String(error?.hookOutput || "").trim()) return false;
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join("\n");
  return TRANSIENT_COMMIT_INFRA_RE.test(text);
}

// When an attempt dies AFTER the agent finished (commit failure, output
// contract, hooks), the agent's reasoning is done and correct work may
// already sit in the tree. Persist a checkpoint unconditionally so the retry
// prompt inherits the prior approach instead of re-deriving it blind — the
// threshold-gated checkpoint in processOutput only fires for large outputs.
function storePostAgentFailureCheckpoint({ job, attemptId, output, failureNote }) {
  try {
    const text = String(output || "");
    const distilled = extractCheckpointFromOutputFromModule(text) || text.slice(-2000).trim();
    if (!distilled) return;
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId,
      artifact_type: "log",
      content_long: [
        "checkpoint:POST-AGENT FAILURE NOTE: the previous attempt's agent run COMPLETED;",
        `the attempt failed afterwards (${String(failureNote || "post-agent step failed").slice(0, 300)}).`,
        "Its work may already be present in the worktree or branch — verify current state",
        "before redoing anything.",
        "",
        distilled,
      ].join("\n"),
    });
  } catch { /* checkpoint is best-effort */ }
}

function normalizeFileRequestScopePath(filePath, cwd) {
  if (!filePath) return "";
  const raw = String(filePath);
  const relative = path.isAbsolute(raw) ? path.relative(cwd || process.cwd(), raw) : raw;
  const normalized = normPath(relative);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

export function filterFileRequestsToOutOfScope(fileRequests, jobPayloadScope = {}, allowedDeleteScope = [], cwd = process.cwd()) {
  if (!Array.isArray(fileRequests) || fileRequests.length === 0) return fileRequests;
  const scopedFiles = [
    ...(jobPayloadScope.files_to_create || []),
    ...(jobPayloadScope.files_to_modify || []),
    ...(allowedDeleteScope || []),
  ]
    .map((filePath) => normalizeFileRequestScopePath(filePath, cwd))
    .filter(Boolean);
  const inScope = new Set(scopedFiles);
  const scopeRoots = normalizeRoots(jobPayloadScope.create_roots || [], cwd);
  return fileRequests.filter((request) => {
    const requestPath = normalizeFileRequestScopePath(request?.path, cwd);
    if (!requestPath) return false;
    if (validateMutableRepoPath(requestPath, "file_request.path")) return false;
    if (inScope.has(requestPath)) return false;
    if (isUnderRoot(requestPath, scopeRoots)) return false;
    return true;
  });
}

export function leaseRenewalIntervalMs(leaseSec) {
  const leaseMs = Math.max(1000, Math.floor((Number(leaseSec) || 900) * 1000));
  if (leaseMs <= 5000) return Math.max(250, Math.floor(leaseMs / 2));
  return Math.max(5000, Math.floor(leaseMs / 3));
}

function isTransientLeaseRenewalError(err) {
  const code = String(err?.code || err?.errno || "").toUpperCase();
  const message = String(err?.message || err || "").toLowerCase();
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /database is (?:busy|locked)/i.test(message)
    || /sqlite_(?:busy|locked)/i.test(message);
}

const JOB_SCRATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_SCRATCH_GC_INTERVAL_MS = 60 * 60 * 1000;
const JOB_SCRATCH_ROOT_DIR = "posse-job-scratch";
const JOB_SCRATCH_SENTINEL_FILE = ".posse-job-scratch.json";
const JOB_SCRATCH_OWNER = "posse-worker-job-scratch";
const DEFAULT_MAX_TRANSIENT_LEASE_RENEW_ERRORS = 2;

function readIntegerSetting(key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  try {
    const raw = getSetting(key);
    const parsed = Number.parseInt(String(raw || ""), 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
  } catch {
    return fallback;
  }
}

function scratchNamespaceForProject(projectDir = process.cwd(), runtimeRoot = null) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || getRuntimeRoot(resolvedProjectDir, resolvedProjectDir));
  const basename = path.basename(resolvedProjectDir).replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 48) || "project";
  const digest = crypto.createHash("sha256")
    .update(`${resolvedProjectDir}\0${resolvedRuntimeRoot}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${basename}-${digest}`;
}

function jobScratchOwnerPayload(projectDir = process.cwd(), runtimeRoot = null) {
  const resolvedProjectDir = path.resolve(projectDir || process.cwd());
  const resolvedRuntimeRoot = path.resolve(runtimeRoot || getRuntimeRoot(resolvedProjectDir, resolvedProjectDir));
  return {
    owner: JOB_SCRATCH_OWNER,
    version: 1,
    projectDir: resolvedProjectDir,
    runtimeRoot: resolvedRuntimeRoot,
    namespace: scratchNamespaceForProject(resolvedProjectDir, resolvedRuntimeRoot),
  };
}

function markerMatchesProject(marker, expected) {
  return marker
    && marker.owner === JOB_SCRATCH_OWNER
    && marker.projectDir === expected.projectDir
    && marker.runtimeRoot === expected.runtimeRoot
    && marker.namespace === expected.namespace;
}

function readJobScratchSentinel(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readJobScratchSentinelAsync(dir) {
  try {
    const raw = await fs.promises.readFile(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function jobScratchRootForProject({
  tmpDir = os.tmpdir(),
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  return path.join(tmpDir, JOB_SCRATCH_ROOT_DIR, scratchNamespaceForProject(projectDir, runtimeRoot));
}

export function jobScratchDirForJob(jobId, {
  tmpDir = os.tmpdir(),
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  return path.join(jobScratchRootForProject({ tmpDir, projectDir, runtimeRoot }), `posse-job-${jobId}`);
}

export function writeJobScratchSentinel(dir, {
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  const payload = jobScratchOwnerPayload(projectDir, runtimeRoot);
  fs.writeFileSync(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return payload;
}

async function writeJobScratchSentinelAsync(dir, {
  projectDir = process.cwd(),
  runtimeRoot = null,
} = {}) {
  const payload = jobScratchOwnerPayload(projectDir, runtimeRoot);
  await fs.promises.writeFile(path.join(dir, JOB_SCRATCH_SENTINEL_FILE), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return payload;
}

export function cleanupOldJobScratchDirs({
  tmpDir = os.tmpdir(),
  scratchRoot = null,
  projectDir = process.cwd(),
  runtimeRoot = null,
  retentionMs = JOB_SCRATCH_RETENTION_MS,
  activeJobIds = [],
  nowMs = Date.now(),
} = {}) {
  const root = scratchRoot || jobScratchRootForProject({ tmpDir, projectDir, runtimeRoot });
  const expectedOwner = jobScratchOwnerPayload(projectDir, runtimeRoot);
  const active = new Set([...activeJobIds].map((id) => String(id)));
  let removed = 0;
  let failed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, failed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^posse-job-(\d+)$/.exec(entry.name);
    if (!match || active.has(match[1])) continue;
    const fullPath = path.join(root, entry.name);
    try {
      if (!markerMatchesProject(readJobScratchSentinel(fullPath), expectedOwner)) continue;
      const stat = fs.statSync(fullPath);
      const ageMs = nowMs - Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0);
      if (ageMs < retentionMs) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}

export async function cleanupOldJobScratchDirsAsync({
  tmpDir = os.tmpdir(),
  scratchRoot = null,
  projectDir = process.cwd(),
  runtimeRoot = null,
  retentionMs = JOB_SCRATCH_RETENTION_MS,
  activeJobIds = [],
  nowMs = Date.now(),
} = {}) {
  const root = scratchRoot || jobScratchRootForProject({ tmpDir, projectDir, runtimeRoot });
  const expectedOwner = jobScratchOwnerPayload(projectDir, runtimeRoot);
  const active = new Set([...activeJobIds].map((id) => String(id)));
  let removed = 0;
  let failed = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { removed, failed };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^posse-job-(\d+)$/.exec(entry.name);
    if (!match || active.has(match[1])) continue;
    const fullPath = path.join(root, entry.name);
    try {
      if (!markerMatchesProject(await readJobScratchSentinelAsync(fullPath), expectedOwner)) continue;
      const stat = await fs.promises.stat(fullPath);
      const ageMs = nowMs - Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0);
      if (ageMs < retentionMs) continue;
      await fs.promises.rm(fullPath, { recursive: true, force: true });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}

export function renewJobLeaseOrAbort({
  worker,
  job,
  leaseToken,
  leaseSec,
  abortController = null,
  renewLeaseFn = renewLease,
  clearRenewal = () => {},
  state = null,
  maxTransientErrors = readIntegerSetting(
    SETTING_KEYS.WORKER_LEASE_RENEW_MAX_TRANSIENT_ERRORS,
    DEFAULT_MAX_TRANSIENT_LEASE_RENEW_ERRORS,
    { min: 0 },
  ),
} = {}) {
  if (abortController?.signal?.aborted) {
    clearRenewal();
    return "aborted";
  }

  try {
    const renewed = renewLeaseFn(job.id, leaseToken, leaseSec);
    if (renewed) {
      if (state) state.transientErrors = 0;
      return "renewed";
    }
    clearRenewal();
    worker.emit(job.id, `${C.red}[lease] WI#${job.work_item_id} job #${job.id} - renewal failed, aborting to prevent double-execution${C.reset}`);
    worker.killJob(job.id, "lease_expired");
    return "failed";
  } catch (err) {
    if (isTransientLeaseRenewalError(err)) {
      const nextErrors = (Number(state?.transientErrors) || 0) + 1;
      if (state) state.transientErrors = nextErrors;
      if (nextErrors <= maxTransientErrors) {
        const message = err?.message || String(err || "unknown error");
        worker.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} - transient renewal error (${nextErrors}/${maxTransientErrors}): ${message}; retrying${C.reset}`);
        return "retrying";
      }
    }
    clearRenewal();
    const message = err?.message || String(err || "unknown error");
    worker.emit(job.id, `${C.red}[lease] WI#${job.work_item_id} job #${job.id} - renewal threw: ${message}; aborting job${C.reset}`);
    worker.killJob(job.id, "lease_renew_failed");
    return "error";
  }
}

function _syncAssessorWorkerDisplay(display, job, {
  tier = "cheap",
  effort = "medium",
  attempt = 1,
} = {}) {
  syncAssessorWorkerDisplayFromModule(display, job, {
    shortJobTitle: shortJobTitleFromModule,
    tier,
    effort,
    attempt,
  });
}

// --- Kaizen: extract insights on work item completion ------------------------

// --- Kaizen: extract insights from completed work items ---------------------

/**
 * Extract structured insights from a completed work item's jobs.
 * Called once when refreshWorkItemStatus transitions to "complete" or "failed".
 *
 * Unlike the original shallow version that just recorded "job X took N attempts",
 * this builds real lessons by walking the attempt chain: what errors occurred,
 * what the assessor said, and what eventually worked (or didn't).
 */
// --- Context loss protection: checkpointing ---------------------------------

/**
 * Extract a structured checkpoint from dev/fix output when the agent used
 * a lot of tokens (likely approaching context limits). The checkpoint captures
 * what was accomplished so retry attempts don't start completely cold.
 */
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

  _releasePendingSessionRecycleForJob(jobId) {
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

  _finalizeSessionRecycleForJob(job, attempt = null) {
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
    const leaseToken = job._leaseToken;
    let leaseRenewTimer = null;
    let leaseRenewalStopped = false;
    let wtPath = null;
    let currentAttemptId = null;
    const executeAbortController = job.id ? this._registerAbortController(job.id) : null;
    const wrappedJob = this._wrapJob(job);

    try {
      const startLeaseRenewal = () => {
        if (leaseRenewTimer || leaseRenewalStopped) return;
        const leaseRenewMs = leaseRenewalIntervalMs(this.leaseSec);
        const renewalState = { transientErrors: 0 };
        const clearRenewal = () => {
          leaseRenewalStopped = true;
          if (leaseRenewTimer) {
            clearTimeout(leaseRenewTimer);
            leaseRenewTimer = null;
          }
        };
        const transientRetryMs = Math.max(500, Math.min(5000, Math.floor(leaseRenewMs / 4)));
        const scheduleRenewal = (delayMs = leaseRenewMs) => {
          if (leaseRenewalStopped || leaseRenewTimer) return;
          leaseRenewTimer = setTimeout(() => {
            leaseRenewTimer = null;
            const result = renewJobLeaseOrAbort({
              worker: this,
              job,
              leaseToken,
              leaseSec: this.leaseSec,
              abortController: executeAbortController,
              renewLeaseFn: this.renewLease,
              clearRenewal,
              state: renewalState,
            });
            if (result === "retrying" && !leaseRenewalStopped) {
              scheduleRenewal(transientRetryMs);
            } else if (result === "renewed" && !leaseRenewalStopped) {
              scheduleRenewal();
            }
          }, delayMs);
        };
        scheduleRenewal();
      };

      // Lease renewal must start before async setup: setup can now spend real
      // wall-clock time awaiting worktree locks, git merges, or ATLAS graph prep.
      startLeaseRenewal();

      const atlasFreshnessGate = await this._gateAtlasFreshnessBeforePlanningOrDev(job, leaseToken, {
        signal: executeAbortController?.signal || null,
      });
      if (!atlasFreshnessGate.ok) return;

      // -- Git worktree setup (mutating code-mode jobs only) --
      let branchName = null;
      const setup = await setUpWorktreeForJobFromModule(this, job, leaseToken, {
        signal: executeAbortController?.signal || null,
      });
      if (!setup.ok) {
        try {
          const cleanupWtPath = setup?.wtPath || job?._worktreePath || null;
          if (cleanupWtPath) clearActiveWorktreeSentinelFromModule(cleanupWtPath, { jobId: job.id ?? null });
        } catch {
          // best effort
        }
        return;
      }
      ({ wtPath, branchName } = setup);
      if (job.id && wtPath) {
        this._activeWorktrees.set(job.id, {
          wtPath,
          workItemId: job.work_item_id ?? null,
          branchName: branchName || null,
          sentinelPath: setup?.sentinelPath || job?._activeWorktreeSentinel || null,
        });
      }

      // -- Lease renewal (must be set up BEFORE any short-circuit path) --
      // All paths below (human_input, promote, assess-only, main) can run
      // long enough for the lease to expire. Without renewal, the scheduler
      // requeues the job mid-execution, causing double-execution and loops.

      // -- Short-circuit: human_input needs no provider --
      if (job.job_type === "human_input") {
        await runHumanInputJobFromModule(this, job, {
          leaseToken,
          abortSignal: executeAbortController?.signal || null,
        });
        await yieldNow({ signal: executeAbortController?.signal || null }).catch(() => {});
        return;
      }

      // -- Short-circuit: promote is deterministic - no provider needed --
      if (job.job_type === "promote") {
        await runPromoteJobFromModule(this, job, wrappedJob, { leaseToken });
        return;
      }

      // -- Short-circuit: atlas_warm is deterministic - no provider needed --
      if (job.job_type === "atlas_warm") {
        await runAtlasWarmJobFromModule(this, job, wrappedJob, {
          leaseToken,
          abortSignal: executeAbortController?.signal || null,
        });
        return;
      }

      // -- Short-circuit: orphaned assessment requeue --
      // If the job was awaiting_assessment when the process crashed, the dev work
      // is already committed. Skip dev and go straight to assessment using the
      // stored output from the previous attempt.
      const assessOnly = this.parsePayload(job)._assess_only;
      if (assessOnly && ASSESSABLE_JOB_TYPES.has(job.job_type)) {
        const assessStart = Date.now();
        const cleanPayload = this.parsePayload(job);
        const assessModelTierOverride = typeof cleanPayload?._assess_model_tier === "string"
          ? cleanPayload._assess_model_tier
          : null;
        const assessReasoningEffortOverride = typeof cleanPayload?._assess_reasoning_effort === "string"
          ? cleanPayload._assess_reasoning_effort
          : null;
        // Retrieve the previous attempt's stored output
        const prevAttempts = getAttempts(job.id);
        const lastWithCommit = [...prevAttempts].reverse().find(a => a.commit_hash);
        const prevOutput = getArtifacts(job.id, "response");
        // Pair the assessed commit with the SAME attempt's output. Taking the
        // last response artifact unconditionally can feed attempt N's commit
        // alongside attempt N+1's prose (e.g. a later attempt that stored output
        // but produced no commit), so the assessor would judge a diff against
        // unrelated narrative. Prefer the response whose attempt_id matches the
        // committing attempt; fall back to the last artifact only when none match.
        const matchedOutput = lastWithCommit
          ? [...prevOutput].reverse().find(o => o.attempt_id === lastWithCommit.id)
          : null;
        const storedOutput = matchedOutput
          ? matchedOutput.content_long
          : (prevOutput.length > 0 ? prevOutput[prevOutput.length - 1].content_long : "");

        if (lastWithCommit && storedOutput) {
          this.emit(job.id, `${C.cyan}[assess-only]${C.reset} WI#${job.work_item_id} job #${job.id}: orphaned assessment — skipping dev, re-assessing prior commit ${lastWithCommit.commit_hash.slice(0, 8)}`);

          const assessAttempt = incrementAndCreateAttempt(job.id, leaseToken, "assessor", null, job.reasoning_effort);
          if (!assessAttempt) {
            _logAttemptSkippedStaleLease(job, "assessor", "Skipped assess-only attempt because the lease was stale or expired");
            this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before assess-only execution${C.reset}`);
            return;
          }

          // Clean the assess-only flags only after the lease-backed assessor
          // attempt is claimed. If the lease is stale, the next owner should
          // still see the orphaned-assessment optimization.
          if (cleanPayload && (
            Object.prototype.hasOwnProperty.call(cleanPayload, "_assess_only") ||
            Object.prototype.hasOwnProperty.call(cleanPayload, "_assess_model_tier") ||
            Object.prototype.hasOwnProperty.call(cleanPayload, "_assess_reasoning_effort") ||
            Object.prototype.hasOwnProperty.call(cleanPayload, "_assess_model_name")
          )) {
            delete cleanPayload._assess_only;
            delete cleanPayload._assess_model_tier;
            delete cleanPayload._assess_reasoning_effort;
            delete cleanPayload._assess_model_name;
            job.payload_json = JSON.stringify(cleanPayload);
            updateJobPayload(job.id, job.payload_json);
          }

          // Re-run assessment with the stored output (reuse the existing attempt)
          const role = this._roleFor(job.job_type);
          const provider = getProvider(role, job.provider || undefined);
          const assessAttemptCount = assessAttempt.attemptCount || (prevAttempts.length + 1);
          const resolveAssessModel = (tier) => tierModelName(tier, { role, providerName: job.provider || undefined });
          const effectiveTier = assessModelTierOverride || provider.escalateTier(job.model_tier, assessAttemptCount, { resolveModel: resolveAssessModel });
          const internalAssessRetries = countInternalAssessmentRetries(job.id);
          const priorAssessmentFindings = _buildPriorAssessmentFindings(job.id);
          await wrappedJob.setStatus("awaiting_assessment", { leaseToken });
          _syncAssessorWorkerDisplay(this.display, job, {
            tier: effectiveTier,
            effort: job.reasoning_effort || "medium",
            attempt: assessAttemptCount,
          });
          try {
            const jobPayloadForAssess = this.parsePayload(job);
            const assessAc = this._abortControllers.get(job.id);
            const assessmentContext = attachAssessmentDiffContext({
              task_mode: jobPayloadForAssess.task_mode || "code",
              manifest: null,
              commit_hash: lastWithCommit.commit_hash || null,
              output_root: jobPayloadForAssess.output_root || null,
              allowed_files: jobPayloadForAssess.files_to_modify || [],
              allowed_create_files: jobPayloadForAssess.files_to_create || [],
              allowed_delete_files: scopedDeleteTargetsFromModule(job, jobPayloadForAssess),
              allowed_create_roots: jobPayloadForAssess.create_roots || [],
              files_committed: [],
              files_reverted: [],
              files_requested: [],
            }, (isArtifactMode(jobPayloadForAssess.task_mode || "code") && jobPayloadForAssess.output_root)
              ? path.resolve(this.projectDir, jobPayloadForAssess.output_root)
              : (wtPath || this.projectDir));
            const assessmentSession = new AssessmentSession({
              job,
              output: storedOutput,
              providerClient: this.providerClient,
              worker: this,
              options: {
                silent: this.silent,
                autoApprove: this.autoApprove,
                abortSignal: assessAc?.signal || null,
                modelTier: effectiveTier,
                reasoningEffort: assessReasoningEffortOverride || job.reasoning_effort || "medium",
                fallbackReads: _assessmentRetryFallbackReads(effectiveTier, internalAssessRetries),
                priorAssessmentFindings,
                cwd: (isArtifactMode(jobPayloadForAssess.task_mode || "code") && jobPayloadForAssess.output_root)
                  ? path.resolve(this.projectDir, jobPayloadForAssess.output_root)
                  : (wtPath || this.projectDir),
                assessmentContext,
              },
            });
            const verdict = await assessmentSession.assess();
            if (!isLeaseValid(job.id, leaseToken)) {
              this.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} - lease expired before assess-only verdict${C.reset}`);
              completeAttempt(assessAttempt.attempt.id, {
                status: "interrupted",
                duration_ms: Date.now() - assessStart,
                error_text: "Lease expired before assess-only verdict - result discarded",
              });
              refreshAndExtractInsightsFromModule(job.work_item_id);
              this._cleanupWorktreeIfDone(job.work_item_id);
              return;
            }
            const emitFn = (msg) => this.emit(job.id, msg);
            processVerdict(job, verdict, { emit: emitFn, autoApprove: this.autoApprove, leaseToken });
            const freshJob = getJob(job.id);
            if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
              this._releaseLease(job, leaseToken, freshJob.status);
            }
            const ATTEMPT_STATUS_MAP = { succeeded: "succeeded", failed: "failed", queued: "interrupted", waiting_on_review: "interrupted", waiting_on_human: "interrupted", blocked: "blocked" };
            completeAttempt(assessAttempt.attempt.id, {
              status: ATTEMPT_STATUS_MAP[freshJob?.status] || "failed",
              duration_ms: Date.now() - assessStart,
              output_chars: storedOutput.length,
            });
            refreshAndExtractInsightsFromModule(job.work_item_id);
            this._cleanupWorktreeIfDone(job.work_item_id);
          } catch (assessErr) {
            completeAttempt(assessAttempt.attempt.id, {
              status: "failed",
              duration_ms: Date.now() - assessStart,
              error_text: assessErr.message,
            });
            this.emit(job.id, `${C.red}[assess-only] Assessment failed: ${assessErr.message.split("\n")[0]}${C.reset}`);
            this._retryOrFail(job, leaseToken, `Assessment failed: ${assessErr.message}`);
          }
          return;
        }
        // If no prior commit/output found, fall through to normal execution
        this.emit(job.id, `${C.yellow}[assess-only]${C.reset} WI#${job.work_item_id} job #${job.id}: no prior commit found — running full execution`);
      }

      // -- Create attempt record --
      const role = this._roleFor(job.job_type);
      const executionPayload = this.parsePayload(job);
      const shouldValidateImageRoute = MUTATING_JOB_TYPES.has(job.job_type)
        && effectiveArtifactTaskModeFromModule(job, executionPayload) !== "code"
        && !!executionPayload.needs_image_generation;
      const imageRoute = shouldValidateImageRoute
        ? resolveImageExecutionProviderFromModule(executionPayload)
        : { provider: null, model: null, readiness: { ready: true, reason: null } };
      if (imageRoute.provider) {
        if (!imageRoute.readiness.ready) {
          const errMsg = `Image generation requires an available image provider (${imageRoute.provider})${imageRoute.readiness.reason ? ` — ${imageRoute.readiness.reason}` : ""}`;
          const routeAttempt = incrementAndCreateAttempt(job.id, leaseToken, role, null, job.reasoning_effort);
          if (!routeAttempt) {
            _logAttemptSkippedStaleLease(job, role, "Skipped image-route readiness failure because the lease was stale or expired");
            this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before image-route readiness failure handling${C.reset}`);
            return;
          }
          currentAttemptId = routeAttempt.attempt.id;
          completeAttempt(routeAttempt.attempt.id, {
            status: "failed",
            error_text: errMsg,
          });
          await wrappedJob.setError(errMsg);
          this._retryOrFail(job, leaseToken, errMsg);
          return;
        }
        const needsModelClear = isImageOnlyModelNameFromModule(job.model_name);
        if (needsModelClear) {
          updateJobProvider(job.id, job.provider || null, null);
          job.model_name = null;
        }
        this.emit(job.id, `${C.cyan}[image]${C.reset} WI#${job.work_item_id} job #${job.id}: generate_image will use ${imageRoute.provider}/${imageRoute.model || "<settings>"} at tool-call time`);
        job._imageRoute = { provider: imageRoute.provider, model: imageRoute.model || null };
      }
      const configuredProviderPool = getAvailableProviders(role);
      const providerResolution = resolveExecutionProviderFromModule(job.provider || null, configuredProviderPool, role);
      let executionProvider = providerResolution.provider;
      if (this._isProviderCircuitOpen(executionProvider)) {
        const circuitFallback = this._selectHealthyProviderFromPool(configuredProviderPool, executionProvider);
        if (circuitFallback) {
          this.emit(job.id, `${C.yellow}[circuit]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} is circuit-open this run; routing to ${circuitFallback}`);
          executionProvider = circuitFallback;
          if (job.provider !== executionProvider || job.model_name) {
            updateJobProvider(job.id, executionProvider, null);
            job.provider = executionProvider;
            job.model_name = null;
          }
        }
      }
      if (providerResolution.ignoredPinnedProvider && job.provider && job.provider !== executionProvider) {
        this.emit(job.id, `${C.yellow}[provider]${C.reset} WI#${job.work_item_id} job #${job.id}: ignoring pinned provider ${job.provider} because it is not enabled for role ${role}; using ${executionProvider}`);
        job.provider = executionProvider;
        updateJobProvider(job.id, executionProvider, null);
        job.model_name = null;
      }
      const providerReadiness = isProviderReady(executionProvider);
      if (!providerReadiness.ready) {
        const readinessFallback = this._selectHealthyProviderFromPool(configuredProviderPool, executionProvider);
        if (readinessFallback) {
          this.emit(job.id, `${C.yellow}[provider]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} unavailable (${providerReadiness.reason || "not ready"}); routing to ${readinessFallback}`);
          executionProvider = readinessFallback;
          job.provider = executionProvider;
          job.model_name = null;
          updateJobProvider(job.id, executionProvider, null);
        } else {
          const errMsg = `Provider auth liveness failed for ${executionProvider}: ${providerReadiness.reason || "provider not ready"}`;
          const livenessAttempt = incrementAndCreateAttempt(job.id, leaseToken, role, null, job.reasoning_effort);
          if (!livenessAttempt) {
            _logAttemptSkippedStaleLease(job, role, "Skipped provider-auth liveness failure because the lease was stale or expired");
            this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before provider-auth liveness handling${C.reset}`);
            return;
          }
          currentAttemptId = livenessAttempt.attempt.id;
          completeAttempt(livenessAttempt.attempt.id, {
            status: "failed",
            error_text: errMsg,
          });
          await wrappedJob.setError(errMsg);
          this._retryOrFail(job, leaseToken, errMsg);
          return;
        }
      }
      job._executionProvider = executionProvider;
      job._allowedProviders = [...new Set((configuredProviderPool || []).filter(Boolean))];

      const provider = getProvider(role, executionProvider || undefined);
      const resolveTierModel = (tier) => tierModelName(tier, { role, providerName: executionProvider || undefined });
      const researchRetrySynthesisTier = job.job_type === "research" && executionPayload?._research_retry_synthesis === true
        ? "cheap"
        : null;

      const prelimCount = (job.attempt_count || 0) + 1;
      let effectiveTier = researchRetrySynthesisTier || provider.escalateTier(job.model_tier, prelimCount, { resolveModel: resolveTierModel });
      const modelName = tierModelName(effectiveTier, { role, providerName: executionProvider || undefined });

      const result = incrementAndCreateAttempt(job.id, leaseToken, role, modelName, job.reasoning_effort);
      if (!result) {
        _logAttemptSkippedStaleLease(job, role, "Skipped provider attempt because the lease was stale or expired");
        this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before execution${C.reset}`);
        return;
      }

      const { attemptCount, attempt } = result;
      currentAttemptId = attempt.id;

      // Recalculate tier if attempt drifted (provider already resolved above with job.provider)
      if (attemptCount > prelimCount && !researchRetrySynthesisTier) {
        effectiveTier = provider.escalateTier(job.model_tier, attemptCount, { resolveModel: resolveTierModel });
      }

      if (researchRetrySynthesisTier && effectiveTier !== job.model_tier) {
        this.emit(job.id, `${C.yellow}[research-retry] WI#${job.work_item_id} job #${job.id}: pinned retry synthesis to ${effectiveTier} tier (attempt ${attemptCount})${C.reset}`);
        if (this.display) this.display.updateWorkerTier(job.id, effectiveTier, attemptCount, job.provider || null, modelName);
      } else if (effectiveTier !== job.model_tier) {
        this.emit(job.id, `${C.yellow}[escalation] WI#${job.work_item_id} job #${job.id}: ${job.model_tier} -> ${effectiveTier} (attempt ${attemptCount})${C.reset}`);
        if (this.display) this.display.updateWorkerTier(job.id, effectiveTier, attemptCount, job.provider || null, modelName);
      }

      // Per-job scratch directory
      const runtimeRoot = getRuntimeRoot(this.projectDir, this.projectDir);
      const jobDir = jobScratchDirForJob(job.id, { projectDir: this.projectDir, runtimeRoot });
      await fs.promises.mkdir(jobDir, { recursive: true });
      await writeJobScratchSentinelAsync(jobDir, { projectDir: this.projectDir, runtimeRoot });
      job._jobDir = jobDir;

      const startTime = Date.now();
      let output = "";

      try {
        // -- Auto-inject artifact scope for non-code task modes --
        // This is system-enforced: even if the planner forgot to set output_root
        // or create_roots, the worker fills them before dispatch. For artifact
        // modes this also clears files_to_modify/files_to_create (forces create_roots).
        // Artificer ALWAYS gets artifact scope — it writes to output dirs, not the repo.
        if (MUTATING_JOB_TYPES.has(job.job_type)) {
          let jobPayloadInject = this.parsePayload(job);
          const taskMode = jobPayloadInject.task_mode || "code";
          if (taskMode !== "code" || job.job_type === "artificer") {
            const scopeId = wiScopeId(job.work_item_id);
            jobPayloadInject = injectArtifactScope(jobPayloadInject, scopeId, this.projectDir);
            job.payload_json = JSON.stringify(jobPayloadInject);
            this.emit(job.id, `${C.cyan}[artifacts]${C.reset} WI#${job.work_item_id} job #${job.id}: ${taskMode} mode — output_root=${jobPayloadInject.output_root}`);
            const scopeWarnings = Array.isArray(jobPayloadInject._artifact_scope_warnings)
              ? jobPayloadInject._artifact_scope_warnings
              : [];
            if (scopeWarnings.length > 0) {
              const warningMsg = `Artifact scope normalized ${scopeWarnings.length} planner path(s): ${scopeWarnings.slice(0, 3).map((w) => `${w.type}:${w.file}`).join(", ")}`;
              this.emit(job.id, `${C.yellow}[artifacts]${C.reset} WI#${job.work_item_id} job #${job.id}: ${warningMsg}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_ARTIFACT_SCOPE_WARNING,
                actor_type: EVENT_ACTORS.WORKER,
                message: warningMsg,
                event_json: JSON.stringify({ warnings: scopeWarnings.slice(0, 20) }),
              });
            }
          }
        }

        // -- Pre-execution snapshot for artifact-mode stale-file detection --
        let preManifestState = null;
        {
          const prePayload = this.parsePayload(job);
          const preTaskMode = prePayload.task_mode || "code";
          if (isArtifactMode(preTaskMode) && prePayload.output_root) {
            const absRoot = path.resolve(this.projectDir, prePayload.output_root);
            const pre = buildManifest(absRoot, absRoot);
            preManifestState = new Map(pre.files.map((file) => [file.path, {
              size: file.size,
              mtimeMs: file.mtimeMs,
              ext: file.ext,
            }]));
          }
        }

        // -- Dispatch to handler --
        log.info("worker", `Job start: ${job.job_type} #${job.id} "${shortJobTitleFromModule(job).slice(0, 60)}"`, { jobId: job.id, wiId: job.work_item_id, type: job.job_type, tier: effectiveTier, attempt: attemptCount, provider: executionProvider || undefined });
        jobLog("START", { wi: job.work_item_id, job: job.id, detail: `${job.job_type} "${shortJobTitleFromModule(job).slice(0, 60)}" (${modelName}, attempt ${attemptCount}${executionProvider ? `, ${executionProvider}` : ""})` });
        const observationPayload = this.parsePayload(job);
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          observation_type: "attempt.start",
          summary: `${role} start (${modelName})`,
          detail: {
            title: job.title,
            provider: executionProvider || getProviderName(role),
            provider_pool: job._allowedProviders || [],
            provider_source: providerResolution.honoredPinnedProvider ? "job_pin" : "role_config",
            image_provider: imageRoute.provider || null,
            image_model: imageRoute.model || null,
            cwd: wtPath || this.projectDir,
            worktree: wtPath || null,
            attempt: attemptCount,
            files_to_modify: observationPayload.files_to_modify || [],
            files_to_create: observationPayload.files_to_create || [],
          },
        });
        const roleColor = roleBrandColor(role);
        const roleLabel = role === "dev" ? "developer" : role;
        const providerTag = executionProvider ? ` ${C.dim}(${executionProvider})${C.reset}` : "";
        if (role !== "artificer" && !this.display) {
          this.emit(job.id, `${roleColor}[${roleLabel}]${C.reset} WI#${job.work_item_id} job #${job.id}: ${shortJobTitleFromModule(job).slice(0, 60)} ${C.dim}(${modelName})${C.reset}${providerTag}`);
        }
        if (this.display) this.display.updateWorkerTier(job.id, effectiveTier, attemptCount, executionProvider || null, modelName);
        // Wrap the whole role runner in observation context so side-effect
        // observations (ATLAS prefetches, git ops, hook writes) auto-tag with
        // this job_id instead of showing up as "#?" in the TUI. The inner
        // provider calls re-wrap with their own scope through providerClient.
        output = await runWithObservationContext(
          { work_item_id: job.work_item_id, job_id: job.id, attempt_id: attempt.id },
          () => this._dispatch(job, effectiveTier, attemptCount, attempt.id, wrappedJob),
        );

        // Store output artifact
        storeArtifact({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: attempt.id,
          artifact_type: "response",
          content_long: output,
        });

        // NOTE: Do NOT completeAttempt here — we don't know the final status yet.
        // The attempt status depends on git commit, scope validation, no-op guard,
        // pre-assessment hook, and assessment result. Marking it "succeeded" before
        // those checks corrupts retry history.

        // -- Layer 1b: Parse file-request (follow-ups spawned after success) --
        let pendingFileRequests = null;
        if (MUTATING_JOB_TYPES.has(job.job_type) && output) {
          let fileRequests = parseFileRequest(output);
          if (fileRequests) {
            // Filter out files already in the job's scope — no follow-up needed
            const jobPayloadScope = this.parsePayload(job);
            const allowedDeleteScope = scopedDeleteTargetsFromModule(job, jobPayloadScope);
            const cwd = job._worktreePath || this.projectDir;
            fileRequests = filterFileRequestsToOutOfScope(fileRequests, jobPayloadScope, allowedDeleteScope, cwd);
            if (fileRequests.length === 0) fileRequests = null;
          }
          if (fileRequests) {
            pendingFileRequests = splitFileRequestsByRisk(fileRequests);
            const allFiles = fileRequests.map(r => `${r.path} (${r.risk})`).join(", ");
            this.emit(job.id, `${C.cyan}[file-request]${C.reset} WI#${job.work_item_id} job #${job.id}: ${fileRequests.length} file(s) requested: ${allFiles}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_FILE_REQUEST_PARSED,
              actor_type: EVENT_ACTORS.WORKER,
              message: `File creation requested: ${allFiles}`,
              event_json: JSON.stringify({ files: fileRequests }),
            });
          }
        }

        // -- Layer 2: Git scope enforcement + commit (mutating jobs only) --
        const hasPendingFileRequests = () => {
          if (!pendingFileRequests) return false;
          const total = (pendingFileRequests.autoApproved?.length || 0)
            + (pendingFileRequests.needsApproval?.length || 0);
          return total > 0;
        };
        const agentCompletionLog = MUTATING_JOB_TYPES.has(job.job_type)
          ? parseAgentCompletionLogFromModule(output)
          : { found: false, status: null, body: "", blockReason: null, verifiedNoChange: false };

        if (agentCompletionLog.status === "BLOCKED" && MUTATING_JOB_TYPES.has(job.job_type)) {
          const blockReason = agentCompletionLog.blockReason || "Agent reported BLOCKED";
          const blockMsg = `Agent BLOCKED: ${blockReason}`;
          this.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: ${blockMsg}${C.reset}`);

          if (wtPath) {
            try {
              if (await gitHasChangesAsync(wtPath)) {
                const siblingLocks = activeSiblingWriteLocks(job);
                if (siblingLocks.length > 0) {
                  logEvent({
                    work_item_id: job.work_item_id,
                    job_id: job.id,
                    attempt_id: attempt.id,
                    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                    actor_type: EVENT_ACTORS.WORKER,
                    message: `Deferred blocked-attempt dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                    event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                  });
                } else {
                  await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                    reason: `blocked-job-${job.id}`,
                    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                    wiId: job.work_item_id,
                  });
                }
              }
            } catch {
              try { await resetDirtyWorktreeFallbackAsyncFromModule(wtPath, this.projectDir); } catch { /* best effort */ }
            }
          }

          const allAttempts = getAttempts(job.id);
          const blockedCount = allAttempts.filter(a => a.status === "blocked").length;
          completeAttempt(attempt.id, {
            status: "blocked",
            duration_ms: Date.now() - startTime,
            error_text: blockMsg,
          });
          logEvent({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            event_type: EVENT_TYPES.JOB_BLOCKED,
            actor_type: EVENT_ACTORS.WORKER,
            message: blockMsg,
          });
          await wrappedJob.setError(blockMsg);

          const blockedPayload = {
            original_job_id: job.id,
            questions: [`Agent was blocked on job #${job.id}. What should be done?`],
            context: [
              `Task: ${job.title}`,
              `Block reason: ${blockReason}`,
              "",
              agentCompletionLog.body || output,
            ].join("\n"),
          };
          if (hasPendingFileRequests()) {
            const allRequested = [
              ...(pendingFileRequests.autoApproved || []),
              ...(pendingFileRequests.needsApproval || []),
            ];
            blockedPayload.file_requests = allRequested;
            blockedPayload.context = [
              blockedPayload.context,
              "",
              `The agent also requested creation of ${allRequested.length} file(s):`,
              ...allRequested.map(r => `  - ${r.path} (${r.risk}) — ${r.reason || "no reason given"}`),
            ].join("\n");
          }

          if (blockedCount >= 2) {
            this.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: blocked ${blockedCount + 1} times — dead-lettering${C.reset}`);
            this._releaseWithoutAttemptPenalty(job, leaseToken, "dead_letter");
          } else {
            createJob({
              work_item_id: job.work_item_id,
              job_type: "human_input",
              title: `Blocked: ${job.title.slice(0, 80)}`,
              parent_job_id: job.id,
              priority: "high",
              payload_json: JSON.stringify(blockedPayload),
            });
            this._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
          }
          refreshAndExtractInsightsFromModule(job.work_item_id);
          this._cleanupWorktreeIfDone(job.work_item_id);
          return;
        }

        let hasFileChanges = false;
        let satisfiedNoop = false;
        let verifiedNoChange = false;
        let filesReverted = [];
        let filesCommitted = [];
        let filesCommittedUnknown = false;
        let filesCommittedError = null;
        let committedHash = null;
        let preAssessAlreadyVerified = false;
        if (wtPath) {
          if (!isLeaseValid(job.id, leaseToken)) {
            this.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before commit${C.reset}`);
            try {
              if (await gitHasChangesAsync(wtPath)) {
                const siblingLocks = activeSiblingWriteLocks(job);
                if (siblingLocks.length > 0) {
                  logEvent({
                    work_item_id: job.work_item_id,
                    job_id: job.id,
                    attempt_id: attempt.id,
                    event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                    actor_type: EVENT_ACTORS.WORKER,
                    message: `Deferred stale-lease dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                    event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                  });
                } else {
                  await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                    reason: `stale-lease-job-${job.id}`,
                    branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                    wiId: job.work_item_id,
                  });
                }
              }
            } catch { /* best effort */ }
            completeAttempt(attempt.id, {
              status: "failed",
              duration_ms: Date.now() - startTime,
              error_text: "Lease expired before commit",
            });
            refreshAndExtractInsightsFromModule(job.work_item_id);
            this._cleanupWorktreeIfDone(job.work_item_id);
            return;
          }
          const preCommitPayload = this.parsePayload(job);
          if (
            requiresGitNoopCheckFromModule(job, preCommitPayload)
            && isDeleteNoopSatisfiedFromModule(job, preCommitPayload, wtPath)
          ) {
            const noopDeleteMsg = `Cleanup task already satisfied before commit — scoped files absent, skipping gitCommitAll`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${noopDeleteMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_DELETE_NOOP_SATISFIED_PRECOMMIT,
              actor_type: EVENT_ACTORS.WORKER,
              message: noopDeleteMsg,
            });
            hasFileChanges = true;
            satisfiedNoop = true;
          } else {
          try {
            const jobPayload = preCommitPayload;
            const activeLocksForCommit = listActiveFileLocks();
            try {
              const caseFoldScopePath = (file) => {
                const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
                return process.platform === "win32" ? normalized.toLowerCase() : normalized;
              };
              const scopeSet = new Set([
                ...(jobPayload.files_to_modify || []),
                ...(jobPayload.files_to_create || []),
                ...(jobPayload.files_to_delete || []),
              ].map(caseFoldScopePath).filter(Boolean));
              const roots = (jobPayload.create_roots || []).filter(Boolean).map(caseFoldScopePath);
              const preCommit = await gitExecAsync(["status", "--porcelain"], wtPath);
              const changedPaths = String(preCommit || "")
                .split("\n")
                .map((line) => line)
                .filter(Boolean)
                .map((line) => {
                  const normalized = line.replace(/\\/g, "/");
                  if (normalized.length >= 4 && normalized[2] === " ") return normalized.slice(3).trim();
                  return normalized.trim().replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
                })
                .filter(Boolean);
              let nestedRepoPrefix = null;
              try {
                const repoRoot = path.resolve(await gitExecAsync(["rev-parse", "--show-toplevel"], wtPath));
                const rel = path.relative(repoRoot, path.resolve(wtPath)).replace(/\\/g, "/").replace(/\/+$/, "");
                if (rel && rel !== "." && isInsideRoot(path.resolve(wtPath), repoRoot, { allowEqual: false, followSymlinks: false })) nestedRepoPrefix = rel;
              } catch {
                nestedRepoPrefix = null;
              }
              const normalizedChangedPaths = changedPaths.map((file) => {
                const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
                const scoped = (() => {
                  if (!nestedRepoPrefix) return normalized;
                  const prefix = `${nestedRepoPrefix}/`;
                  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
                })();
                return caseFoldScopePath(scoped);
              });
              const outside = normalizedChangedPaths.filter((file) => {
                if (scopeSet.has(file)) return false;
                for (const root of roots) {
                  if (!root || root === ".") continue;
                  if (file === root || file.startsWith(`${root}/`)) return false;
                }
                if (findActiveSiblingLockForPath(file, job, { locks: activeLocksForCommit })) return false;
                return true;
              });
              if (outside.length > 0) {
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.WORKTREE_EXTERNAL_DRIFT_DETECTED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: `Pre-commit telemetry detected ${outside.length} change(s) outside declared scope`,
                  event_json: JSON.stringify({ files: outside.slice(0, 50) }),
                });
              }
            } catch {
              // Telemetry-only; never fail the job.
            }
            const headBefore = await gitCurrentHashAsync(wtPath);
            const commitMsg = `posse: ${job.job_type} job #${job.id} - ${job.title}`;
            // Retry the commit step in place when the failure is a transient
            // identity/heartbeat fault. The agent's work is already correct;
            // failing the whole attempt would discard it and re-run the
            // provider call just to reproduce the same tree.
            let commitResult = null;
            for (let commitInfraRetries = 0; ; commitInfraRetries += 1) {
              try {
                commitResult = await gitCommitAllAsyncFromModule(commitMsg, wtPath, {
                  // must_modify paths are writable scope even when the planner
                  // didn't duplicate them into files_to_modify.
                  modifyFiles: [...new Set([
                    ...(Array.isArray(jobPayload.files_to_modify) ? jobPayload.files_to_modify : []),
                    ...(Array.isArray(jobPayload.must_modify) ? jobPayload.must_modify : []),
                  ])],
                  createFiles: jobPayload.files_to_create || [],
                  deleteFiles: jobPayload.files_to_delete || [],
                  createRoots: jobPayload.create_roots || [],
                }, {
                  projectDir: this.projectDir,
                  wiId: job.work_item_id,
                  branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                  snapshotReason: `dev-scope-enforcement-job-${job.id}`,
                  taskMode: jobPayload.task_mode || "code",
                  jobId: job.id,
                  activeFileLocks: activeLocksForCommit,
                });
                break;
              } catch (commitErr) {
                if (commitInfraRetries >= 2 || !isTransientCommitInfraFailure(commitErr)) throw commitErr;
                const retryMsg = `Commit hit transient infra fault (${formatCommitFailureSummary(commitErr)}) — retrying commit in place (${commitInfraRetries + 1}/2)`;
                this.emit(job.id, `${C.yellow}[git] WI#${job.work_item_id} job #${job.id}: ${retryMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_COMMIT_INFRA_RETRY,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: retryMsg,
                  event_json: JSON.stringify({
                    retry: commitInfraRetries + 1,
                    error: formatCommitFailureSummary(commitErr).slice(0, 500),
                  }),
                });
                await new Promise((resolve) => setTimeout(resolve, (commitInfraRetries + 1) * 2000));
              }
            }
            const {
              hash: commitHash,
              reverted,
              createdViaModifyScope,
              createdOutOfScope,
              skippedIgnoredCreateFiles,
              skippedStaleModifyFiles,
              gitAddWarnings,
              scopeCleanedNoOp,
              mergeCompleted,
              outOfScopeMergeFiles,
              mergeAuditFailed,
              mergeAuditError,
              siblingDirtySkipped,
              siblingUntrackedSkipped,
              siblingStagingSkipped,
            } = commitResult;

            filesReverted = reverted;

            if (mergeCompleted) {
              this.emit(job.id, `${C.dim}[git] WI#${job.work_item_id} job #${job.id}: merge completed by dev${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_MERGE_COMPLETED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Dev resolved pending merge and committed`,
              });
            }

            if (outOfScopeMergeFiles && outOfScopeMergeFiles.length > 0) {
              const auditMsg = `Merge commit touched ${outOfScopeMergeFiles.length} file(s) outside task scope and outside merge diff: ${outOfScopeMergeFiles.slice(0, 5).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${auditMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_MERGE_SCOPE_AUDIT,
                actor_type: EVENT_ACTORS.WORKER,
                message: auditMsg,
                event_json: JSON.stringify({ files: outOfScopeMergeFiles }),
              });
            }

            if (mergeAuditFailed) {
              const auditFailMsg = `Post-merge scope audit failed: ${mergeAuditError || "unknown error"}`;
              this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${auditFailMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_MERGE_SCOPE_AUDIT_FAILED,
                actor_type: EVENT_ACTORS.WORKER,
                message: auditFailMsg,
                event_json: JSON.stringify({ error: mergeAuditError || null }),
              });
            }

            // Log scope violations
            if (reverted.length > 0) {
              const scopeMsg = `Reverted ${reverted.length} out-of-scope file(s): ${reverted.slice(0, 5).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope] WI#${job.work_item_id} job #${job.id}: ${scopeMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_VIOLATION,
                actor_type: EVENT_ACTORS.WORKER,
                message: scopeMsg,
              });
            }

            // Log planner scope bugs: new files created via files_to_modify
            if (createdViaModifyScope.length > 0) {
              const compatMsg = `Planner scope bug: ${createdViaModifyScope.length} new file(s) created via files_to_modify (should be files_to_create): ${createdViaModifyScope.join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-compat] WI#${job.work_item_id} job #${job.id}: ${compatMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_COMPAT_CREATE_VIA_MODIFY,
                actor_type: EVENT_ACTORS.WORKER,
                message: compatMsg,
                event_json: JSON.stringify({ files: createdViaModifyScope }),
              });
            }

            // Log residual untracked files outside scope. They are deliberately
            // left on disk and ignored until terminal WI cleanup.
            if (createdOutOfScope && createdOutOfScope.length > 0) {
              const oosMsg = `Left ${createdOutOfScope.length} out-of-scope untracked file(s) for terminal cleanup: ${createdOutOfScope.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-compat] WI#${job.work_item_id} job #${job.id}: ${oosMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_COMPAT_UNTRACKED_OUT_OF_SCOPE,
                actor_type: EVENT_ACTORS.WORKER,
                message: oosMsg,
                event_json: JSON.stringify({ files: createdOutOfScope }),
              });
            }

            if (gitAddWarnings && gitAddWarnings.length > 0) {
              const addWarnMsg = `Git add reported ${gitAddWarnings.length} non-fatal staging warning(s): ${gitAddWarnings.slice(0, 3).map((w) => `${w.context}:${w.file}`).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${addWarnMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_GIT_ADD_WARNING,
                actor_type: EVENT_ACTORS.WORKER,
                message: addWarnMsg,
                event_json: JSON.stringify({ warnings: gitAddWarnings.slice(0, 20) }),
              });
            }

            if (skippedIgnoredCreateFiles && skippedIgnoredCreateFiles.length > 0) {
              const ignoredMsg = `Skipped ${skippedIgnoredCreateFiles.length} ignored createFiles path(s) during commit staging: ${skippedIgnoredCreateFiles.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${ignoredMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_IGNORED_CREATEFILES_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: ignoredMsg,
                event_json: JSON.stringify({ files: skippedIgnoredCreateFiles }),
              });
            }

            if (skippedStaleModifyFiles && skippedStaleModifyFiles.length > 0) {
              const staleMsg = `Skipped ${skippedStaleModifyFiles.length} stale modifyFiles path(s) during commit staging: ${skippedStaleModifyFiles.slice(0, 10).join(", ")}`;
              this.emit(job.id, `${C.yellow}[scope-runtime] WI#${job.work_item_id} job #${job.id}: ${staleMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_STALE_MODIFYFILES_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: staleMsg,
                event_json: JSON.stringify({ files: skippedStaleModifyFiles }),
              });
            }

            const siblingSkipped = [
              ...(siblingDirtySkipped || []),
              ...(siblingUntrackedSkipped || []),
              ...(siblingStagingSkipped || []),
            ];
            if (siblingSkipped.length > 0) {
              const siblingMsg = `Left ${siblingSkipped.length} sibling-owned dirty path(s) unstaged: ${siblingSkipped.slice(0, 5).map((entry) => `${entry.file} by #${entry.job_id || "?"}`).join(", ")}`;
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_SIBLING_DIRTY_SKIPPED,
                actor_type: EVENT_ACTORS.WORKER,
                message: siblingMsg,
                event_json: JSON.stringify({
                  visible: false,
                  dirty: siblingDirtySkipped || [],
                  untracked: siblingUntrackedSkipped || [],
                  staging: siblingStagingSkipped || [],
                }),
              });
            }

            if (commitHash !== headBefore) {
              hasFileChanges = true;
              committedHash = commitHash;
              setAttemptCommitHash(attempt.id, commitHash);
              // Capture what was actually committed (ground truth for assessor)
              try {
                filesCommitted = (await gitExecAsync(["diff", "--no-renames", "--name-only", "--relative", headBefore, commitHash], wtPath))
                  .split("\n")
                  .map((line) => String(line || "").replace(/\\/g, "/").trim())
                  .filter(Boolean);
                filesCommittedUnknown = false;
                filesCommittedError = null;
              } catch (err) {
                filesCommitted = [];
                filesCommittedUnknown = true;
                filesCommittedError = err?.message || String(err);
              }
              recordObservation({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                observation_type: "git.commit",
                summary: filesCommittedUnknown
                  ? `Committed ${commitHash.slice(0, 8)} but could not verify committed file list`
                  : `Committed ${filesCommitted.length} file(s) at ${commitHash.slice(0, 8)}`,
                detail: {
                  cwd: wtPath,
                  commit_hash: commitHash,
                  files_committed: filesCommitted,
                  files_committed_unknown: filesCommittedUnknown,
                  files_committed_error: filesCommittedError,
                  files_reverted: filesReverted,
                  created_via_modify_scope: createdViaModifyScope,
                  skipped_stale_modify_files: skippedStaleModifyFiles || [],
                  scope_cleaned_noop: scopeCleanedNoOp,
                  sibling_dirty_skipped: siblingSkipped,
                },
              });
              this.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${branchName}: ${commitHash.slice(0, 8)} — ${shortJobTitleFromModule(job).slice(0, 40)}${C.reset}`);
              void this._kickAtlasReindex(job, commitHash);

              const outputContract = filesCommittedUnknown
                ? { ok: true }
                : await validateDeclaredOutputContract({
                    job,
                    payload: jobPayload,
                    filesCommitted,
                    cwd: wtPath,
                  });
              if (!outputContract.ok) {
                const contractMsg = [
                  "Declared output contract failed after commit",
                  outputContract.missingCreates?.length ? `missing creates: ${outputContract.missingCreates.slice(0, 10).join(", ")}` : null,
                  outputContract.missingModifies?.length ? `missing modifies: ${outputContract.missingModifies.slice(0, 10).join(", ")}` : null,
                  outputContract.untouchedCreates?.length ? `creates not committed: ${outputContract.untouchedCreates.slice(0, 10).join(", ")}` : null,
                  outputContract.untouchedModifies?.length ? `modifies not committed: ${outputContract.untouchedModifies.slice(0, 10).join(", ")}` : null,
                ].filter(Boolean).join(" — ");
                this.emit(job.id, `${C.red}[contract] WI#${job.work_item_id} job #${job.id}: ${contractMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_OUTPUT_CONTRACT_FAILED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: contractMsg,
                  event_json: JSON.stringify({
                    files_committed: filesCommitted,
                    missing_creates: outputContract.missingCreates || [],
                    missing_modifies: outputContract.missingModifies || [],
                    untouched_creates: outputContract.untouchedCreates || [],
                    untouched_modifies: outputContract.untouchedModifies || [],
                  }),
                });
                await wrappedJob.setError(contractMsg);
                {
                  const freshForPartial = getJob(job.id) || job;
                  const finalAttempt = Number(freshForPartial.attempt_count || attemptCount || 0) >= Number(freshForPartial.max_attempts || job.max_attempts || 3);
                  if (finalAttempt && committedHash) {
                    const partialOutput = [
                      output || "",
                      "",
                      "PARTIAL WORK NOTE:",
                      contractMsg,
                      "The worker committed the in-scope partial output so the assessor can decide whether a fix job is needed.",
                    ].filter(Boolean).join("\n");
                    setJobResult(job.id, {
                      partial_work: true,
                      output_length: partialOutput.length,
                      commit_hash: committedHash,
                      files_committed: filesCommitted,
                      reason: contractMsg,
                    });
                    await runPostExecutionAssessmentFromModule(this, {
                      attempt,
                      committedHash,
                      filesCommitted,
                      filesCommittedUnknown,
                      filesCommittedError,
                      filesReverted,
                      hasFileChanges: true,
                      job,
                      leaseToken,
                      output: partialOutput,
                      pendingFileRequests: null,
                      preAssessAlreadyVerified: true,
                      preManifestState,
                      satisfiedNoop: false,
                      startTime,
                      wtPath,
                    }, {
                      assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
                      isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
                      isProviderError: _isProviderError,
                      logBadInputFailure: _logBadInputFailure,
                      shouldFastPassArtifactAssessment,
                      shouldOverrideArtifactMissingFail,
                      shortJobTitle: shortJobTitleFromModule,
                      syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
                    });
                    return;
                  }
                }
                storePostAgentFailureCheckpoint({
                  job,
                  attemptId: attempt.id,
                  output,
                  failureNote: contractMsg,
                });
                completeAttempt(attempt.id, {
                  status: "failed",
                  duration_ms: Date.now() - startTime,
                  error_text: contractMsg,
                });
                this._retryOrFail(job, leaseToken, contractMsg);
                return;
              }
              if (outputContract.unmodifiedDeclaredScope?.length > 0) {
                // Declared-but-unmodified scope passes the contract (scope is
                // an allowance, not a work order); record it so the assessor
                // and operators can see the dev's no-change judgment call.
                const unusedMsg = `Declared modify scope left unmodified (allowed): ${outputContract.unmodifiedDeclaredScope.slice(0, 10).join(", ")}`;
                this.emit(job.id, `${C.dim}[contract] WI#${job.work_item_id} job #${job.id}: ${unusedMsg}${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_OUTPUT_CONTRACT_SCOPE_UNUSED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: unusedMsg,
                  event_json: JSON.stringify({
                    visible: false,
                    files_committed: filesCommitted,
                    unmodified_declared_scope: outputContract.unmodifiedDeclaredScope,
                  }),
                });
              }

              // -- Deterministic hook: post-dev build/lint verification --
              const verifyResult = await runHookAsync("post_dev_verify", { cwd: wtPath });
              if (!verifyResult.ok) {
                const verifyMsg = `Build/lint verification failed after commit — ${verifyResult.output.slice(0, 500)}`;
                this.emit(job.id, `${C.red}[hook] WI#${job.work_item_id} job #${job.id}: post-dev-verify BLOCKED${C.reset}`);
                logEvent({
                  work_item_id: job.work_item_id,
                  job_id: job.id,
                  attempt_id: attempt.id,
                  event_type: EVENT_TYPES.JOB_HOOK_VERIFY_FAILED,
                  actor_type: EVENT_ACTORS.WORKER,
                  message: verifyMsg,
                });
                // Fail the job with the build error — skip assessment since code doesn't build
                await wrappedJob.setError(verifyMsg);
                {
                  const freshForPartial = getJob(job.id) || job;
                  const finalAttempt = Number(freshForPartial.attempt_count || attemptCount || 0) >= Number(freshForPartial.max_attempts || job.max_attempts || 3);
                  if (finalAttempt && committedHash) {
                    const partialOutput = [
                      output || "",
                      "",
                      "PARTIAL WORK NOTE:",
                      verifyMsg,
                      "The worker committed the in-scope partial output so the assessor can decide whether a fix job is needed.",
                    ].filter(Boolean).join("\n");
                    setJobResult(job.id, {
                      partial_work: true,
                      output_length: partialOutput.length,
                      commit_hash: committedHash,
                      files_committed: filesCommitted,
                      reason: verifyMsg,
                    });
                    await runPostExecutionAssessmentFromModule(this, {
                      attempt,
                      committedHash,
                      filesCommitted,
                      filesCommittedUnknown,
                      filesCommittedError,
                      filesReverted,
                      hasFileChanges: true,
                      job,
                      leaseToken,
                      output: partialOutput,
                      pendingFileRequests: null,
                      preAssessAlreadyVerified: true,
                      preManifestState,
                      satisfiedNoop: false,
                      startTime,
                      wtPath,
                    }, {
                      assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
                      isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
                      isProviderError: _isProviderError,
                      logBadInputFailure: _logBadInputFailure,
                      shouldFastPassArtifactAssessment,
                      shouldOverrideArtifactMissingFail,
                      shortJobTitle: shortJobTitleFromModule,
                      syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
                    });
                    return;
                  }
                }
                storePostAgentFailureCheckpoint({
                  job,
                  attemptId: attempt.id,
                  output,
                  failureNote: verifyMsg,
                });
                completeAttempt(attempt.id, {
                  status: "failed",
                  duration_ms: Date.now() - startTime,
                  error_text: verifyMsg,
                });
                this._retryOrFail(job, leaseToken, verifyMsg);
                return;
              }
              preAssessAlreadyVerified = true;
            } else if (scopeCleanedNoOp) {
              // Dev produced changes, but ALL were out-of-scope and got reverted.
              // This is distinct from "dev made no changes" — it means the dev
              // worked on the wrong files entirely. Surface it as a specific failure.
              const cleanMsg = `All changes were out-of-scope and reverted — dev worked on wrong files`;
              this.emit(job.id, `${C.red}[scope] WI#${job.work_item_id} job #${job.id}: ${cleanMsg}${C.reset}`);
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_CLEANED_NOOP,
                actor_type: EVENT_ACTORS.WORKER,
                message: cleanMsg,
              });
              await wrappedJob.setError(cleanMsg);
              completeAttempt(attempt.id, {
                status: "failed",
                duration_ms: Date.now() - startTime,
                error_text: cleanMsg,
              });
              this._retryOrFail(job, leaseToken, cleanMsg);
              return;
            } else {
              this.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${branchName}: no changes to commit${C.reset}`);
            }
          } catch (gitErr) {
            // Git failures must fail the attempt with the real reason,
            // not silently continue to the no-op guard for a generic retry.
            const hookOutput = String(gitErr.hookOutput || "").trim();
            const gitFailureDetail = formatCommitFailureDetail(gitErr);
            const gitFailureSummary = formatCommitFailureSummary(gitErr);
            const lockTimeout = await worktreeLockTimeoutInfoAsync(gitErr, gitFailureDetail);
            this.emit(job.id, `${C.dim}[system] WI#${job.work_item_id} ${branchName}: commit failed — ${gitFailureSummary}${C.reset}`);
            if (hookOutput) {
              this.emit(job.id, `${C.red}[hook] WI#${job.work_item_id} job #${job.id}: ${hookOutput.split("\n").slice(0, 8).join(" | ")}${C.reset}`);
            }
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: lockTimeout.timeout ? EVENT_TYPES.JOB_WORKTREE_LOCK_TIMEOUT : EVENT_TYPES.JOB_COMMIT_FAILED,
              actor_type: EVENT_ACTORS.WORKER,
              message: lockTimeout.timeout
                ? `Git commit blocked by worktree lock timeout: ${gitFailureSummary}`
                : `Git commit failed: ${gitFailureSummary}`,
              event_json: JSON.stringify({
                ...(hookOutput ? { hook_output: hookOutput } : {}),
                ...(isTransientCommitInfraFailure(gitErr) ? { transient_infra: true, infra_retries_exhausted: true } : {}),
                ...(gitErr.stderr ? { stderr: String(gitErr.stderr).slice(0, 4000) } : {}),
                ...(gitErr.stdout ? { stdout: String(gitErr.stdout).slice(0, 4000) } : {}),
                ...(gitErr.code ? { code: gitErr.code } : {}),
                ...(gitErr.signal ? { signal: gitErr.signal } : {}),
                ...(gitErr.gitCommitTimedOut ? {
                  git_commit_timed_out: true,
                  git_commit_timeout_budget: gitErr.gitCommitTimeoutBudget || null,
                } : {}),
                ...(lockTimeout.timeout ? {
                  lock_path: lockTimeout.lockPath,
                  lock_stat: lockTimeout.lockStat,
                } : {}),
              }),
            });
            if (Array.isArray(gitErr.createdOutOfScope) && gitErr.createdOutOfScope.length > 0) {
              logEvent({
                work_item_id: job.work_item_id,
                job_id: job.id,
                attempt_id: attempt.id,
                event_type: EVENT_TYPES.JOB_SCOPE_UNTRACKED_OUT_OF_SCOPE_BLOCKED,
                actor_type: EVENT_ACTORS.WORKER,
                message: `Blocked commit with ${gitErr.createdOutOfScope.length} out-of-scope untracked file(s): ${gitErr.createdOutOfScope.slice(0, 10).join(", ")}`,
                event_json: JSON.stringify({ files: gitErr.createdOutOfScope.slice(0, 50) }),
              });
            }
            await wrappedJob.setError(lockTimeout.timeout
              ? `Git commit blocked by worktree lock timeout: ${gitFailureDetail}`
              : `Git commit failed: ${gitFailureDetail}`);
            // Preserve the failed attempt's dirty state to .recovery/ and
            // reset the worktree so the retry starts clean. Snapshots are
            // forensic; orphan stashes otherwise accumulate across failures.
            if (wtPath) {
              try {
                if (await gitHasChangesAsync(wtPath)) {
                  const siblingLocks = activeSiblingWriteLocks(job);
                  if (siblingLocks.length > 0) {
                    logEvent({
                      work_item_id: job.work_item_id,
                      job_id: job.id,
                      attempt_id: attempt.id,
                      event_type: EVENT_TYPES.WORKTREE_DIRTY_CLEANUP_DEFERRED,
                      actor_type: EVENT_ACTORS.WORKER,
                      message: `Deferred commit-failure dirty cleanup; ${siblingLocks.length} same-WI job lock(s) still active`,
                      event_json: JSON.stringify({ locks: siblingLocks.slice(0, 20) }),
                    });
                  } else {
                    try {
                      await snapshotAndResetDirtyWorktreeAsyncFromModule(wtPath, this.projectDir, {
                        reason: `commit-failed-job-${job.id}`,
                        branchName: getWorkItem(job.work_item_id)?.branch_name || null,
                        wiId: job.work_item_id,
                      });
                    } catch {
                      try { await resetDirtyWorktreeFallbackAsyncFromModule(wtPath, this.projectDir); } catch { /* ignore */ }
                    }
                  }
                }
              } catch { /* ignore */ }
            }
            storeArtifact({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              artifact_type: "log",
              content_long: `${lockTimeout.timeout ? "Git commit blocked by worktree lock timeout" : "Git commit failed"} (job #${job.id}, attempt ${attemptCount}): ${gitFailureDetail}`,
            });
            storePostAgentFailureCheckpoint({
              job,
              attemptId: attempt.id,
              output,
              failureNote: `Git commit failed: ${gitFailureSummary}`,
            });
            completeAttempt(attempt.id, {
              status: lockTimeout.timeout ? "interrupted" : "failed",
              duration_ms: Date.now() - startTime,
              error_text: lockTimeout.timeout
                ? `Git commit blocked by worktree lock timeout: ${gitFailureDetail}`
                : `Git commit failed: ${gitFailureDetail}`,
            });
            if (lockTimeout.timeout) {
              const readyAt = new Date(Date.now() + 5000).toISOString();
              this._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt });
              return;
            }
            this._retryOrFail(job, leaseToken, `Git commit failed: ${gitFailureDetail}`);
            return;
          }
          }
        }

        // -- Idempotency check --
        const outputHash = crypto.createHash("sha256").update(output).digest("hex").slice(0, 16);
        const prevResultJson = job.result_json;
        await wrappedJob.setResult({ output_length: output.length, attempt: attemptCount, output_hash: outputHash });

        if (attemptCount > 1 && prevResultJson) {
          // Narrow the try to JSON.parse only. Wrapping the whole dead-letter
          // block meant a synchronous DB throw after completeAttempt() skipped
          // the `return` and fell through to a full (duplicate) assessment,
          // letting a later completeAttempt overwrite the "failed" status. (B8)
          let prevResult = null;
          try {
            prevResult = JSON.parse(prevResultJson);
          } catch { prevResult = null; }
          if (prevResult) {
            if (prevResult.output_hash === outputHash) {
              // Don't dead-letter if file requests are pending — the output is
              // deterministically the same because the task genuinely needs those
              // files, not because the model is stuck.
              if (hasPendingFileRequests()) {
                this.emit(job.id, `${C.yellow}[idempotency] WI#${job.work_item_id} job #${job.id}: identical output, but file requests pending — allowing through${C.reset}`);
                // Fall through to no-op guard / assessment with file-request spawning
              } else {
              // Don't dead-letter if the next attempt would escalate to a stronger
              // model — the different model may produce different output. Only
              // dead-letter when escalation can't help (same tier next time or
              // no attempts remaining).
              const maxAttempts = job.max_attempts || 3;
              const nextTier = attemptCount < maxAttempts
                ? provider.escalateTier(job.model_tier, attemptCount + 1, { resolveModel: resolveTierModel })
                : effectiveTier;
              if (nextTier !== effectiveTier) {
                this.emit(job.id, `${C.yellow}[idempotency] WI#${job.work_item_id} job #${job.id}: identical output, but next attempt escalates ${effectiveTier} ? ${nextTier} — allowing retry${C.reset}`);
                // Fall through to no-op guard / assessment instead of dead-lettering
              } else {
                this.emit(job.id, `${C.red}[idempotency] WI#${job.work_item_id} job #${job.id}: identical output (same tier next) — dead-lettering${C.reset}`);
                completeAttempt(attempt.id, {
                  status: "failed",
                  duration_ms: Date.now() - startTime,
                  error_text: "Identical output on retry — dead-lettered",
                });
                spawnDeadLetterRecoveryForDependentsFromModule(this, job, getJob(job.id) || job, {
                  reasonText: "produced identical output on retry and could not escalate to a different model, so it was dead-lettered",
                  context: "This job produced identical retry output with no pending file request and no stronger model path available. Its downstream dependent(s) are temporarily gated on this recovery job so a human can choose a retry, simplification, or explicit skip.",
                });
                this._releaseLease(job, leaseToken, "dead_letter");
                refreshAndExtractInsightsFromModule(job.work_item_id);
                this._cleanupWorktreeIfDone(job.work_item_id);
                return;
              }
              } // end else (no pending file requests)
            }
          } // end if (prevResult)
        }

        // -- No-op guard (git-based — code tasks only; artifact tasks use manifest check) --
        const noOpPayload = this.parsePayload(job);
        if (!hasFileChanges && requiresGitNoopCheckFromModule(job, noOpPayload)) {
          // Parse dev/artificer log status — BLOCKED is handled before commit.
          const devLogMatch = agentCompletionLog.found ? { 1: agentCompletionLog.body } : null;
          const devStatus = agentCompletionLog.status || null;

          if (devStatus === "BLOCKED") {
            // Dev correctly identified it can't proceed — escalate to human immediately
            const blockReason = agentCompletionLog.blockReason
              || "Dev reported BLOCKED with no file changes";
            const blockMsg = `Dev BLOCKED: ${blockReason}`;
            this.emit(job.id, `${C.yellow}[worker] WI#${job.work_item_id} job #${job.id}: ${blockMsg}${C.reset}`);

            // -- BLOCKED cycle cap: prevent infinite block?human?block loops --
            const MAX_BLOCKED_CYCLES = 2;
            const allAttempts = getAttempts(job.id);
            const blockedCount = allAttempts.filter(a => a.status === "blocked").length;

            completeAttempt(attempt.id, {
              status: "blocked",
              duration_ms: Date.now() - startTime,
              error_text: blockMsg,
            });
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_BLOCKED,
              actor_type: EVENT_ACTORS.WORKER,
              message: blockMsg,
            });
            await wrappedJob.setError(blockMsg);

            // Don't consume the attempt — BLOCKED is a correct diagnosis, not a
            // failure. The human needs to provide guidance (expand scope, etc.)
            // and the job should retain its retry budget for after the human helps.

            if (blockedCount >= MAX_BLOCKED_CYCLES) {
              // Same block keeps recurring — dead-letter instead of looping
              this.emit(job.id, `${C.red}[worker] WI#${job.work_item_id} job #${job.id}: blocked ${blockedCount + 1} times — dead-lettering${C.reset}`);
              this._releaseWithoutAttemptPenalty(job, leaseToken, "dead_letter");

              // Spawn recovery human_input with full context
              const dependents = getDependents(job.id);
              if (dependents.length > 0) {
                const recoveryJob = createJob({
                  work_item_id: job.work_item_id,
                  job_type: "human_input",
                  title: `Blocked ${blockedCount + 1}x: ${job.title.slice(0, 70)}`,
                  parent_job_id: job.id,
                  priority: "urgent",
                  model_tier: "cheap",
                  payload_json: JSON.stringify({
                    questions: [
                      `Job #${job.id} "${job.title}" has been blocked ${blockedCount + 1} times with the same issue. How should we proceed?`,
                    ],
                    context: [
                      `Block reason: ${blockReason}`,
                      "",
                      devLogMatch[1].trim(),
                    ].join("\n"),
                  }),
                });
                for (const dep of dependents) {
                  rewireDependency(dep.job_id, job.id, recoveryJob.id, dep.dependency_kind);
                }
                this.emit(job.id, `${C.yellow}[recovery] WI#${job.work_item_id} spawned human_input #${recoveryJob.id} — ${dependents.length} dep(s) rewired${C.reset}`);
              }

              refreshAndExtractInsightsFromModule(job.work_item_id);
              this._cleanupWorktreeIfDone(job.work_item_id);
              return;
            }

            // Create human_input job — include file requests if present
            const blockedPayload = {
              original_job_id: job.id,
              questions: [`Dev was blocked on job #${job.id}. What should be done?`],
              context: [
                `Task: ${job.title}`,
                `Block reason: ${blockReason}`,
                "",
                devLogMatch[1].trim(),
              ].join("\n"),
            };
            if (hasPendingFileRequests()) {
              const allRequested = [
                ...(pendingFileRequests.autoApproved || []),
                ...(pendingFileRequests.needsApproval || []),
              ];
              blockedPayload.file_requests = allRequested;
              blockedPayload.context = [
                blockedPayload.context,
                "",
                `The dev also requested creation of ${allRequested.length} file(s):`,
                ...allRequested.map(r => `  - ${r.path} (${r.risk}) — ${r.reason || "no reason given"}`),
              ].join("\n");
            }
            createJob({
              work_item_id: job.work_item_id,
              job_type: "human_input",
              title: `Blocked: ${job.title.slice(0, 80)}`,
              parent_job_id: job.id,
              priority: "high",
              payload_json: JSON.stringify(blockedPayload),
            });
            this._releaseWithoutAttemptPenalty(job, leaseToken, "waiting_on_human");
            refreshAndExtractInsightsFromModule(job.work_item_id);
            return;
          }

          // File-request bypass: no file changes, but valid file requests pending.
          // The dev discovered what files are needed — this is a legitimate outcome.
          // Fall through to skip-assessment success path to spawn follow-ups.
          if (hasPendingFileRequests()) {
            const totalRequested = (pendingFileRequests.autoApproved?.length || 0)
              + (pendingFileRequests.needsApproval?.length || 0);
            this.emit(job.id, `${C.cyan}[file-request]${C.reset} WI#${job.work_item_id} job #${job.id}: no in-scope changes, but ${totalRequested} file(s) requested — bypassing no-op guard`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_NOOP_BYPASS_FILE_REQUEST,
              actor_type: EVENT_ACTORS.WORKER,
              message: `No-op guard bypassed: ${totalRequested} file request(s) pending`,
            });
            // Fall through to assessment / success
          } else if (agentCompletionLog.verifiedNoChange) {
            const verifiedMsg = `Agent reported VERIFIED_NO_CHANGE; routing current scoped files to assessment instead of forcing a decorative diff`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${verifiedMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_VERIFIED_NO_CHANGE,
              actor_type: EVENT_ACTORS.WORKER,
              message: verifiedMsg,
            });
            verifiedNoChange = true;
          } else if (isDeleteNoopSatisfiedFromModule(job, this.parsePayload(job), wtPath || job._worktreePath || this.projectDir)) {
            const noopDeleteMsg = `Cleanup task already satisfied — scoped files are absent, so there was nothing left to delete`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${noopDeleteMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_DELETE_NOOP_SATISFIED,
              actor_type: EVENT_ACTORS.WORKER,
              message: noopDeleteMsg,
            });
            hasFileChanges = true;
            satisfiedNoop = true;
          } else if (devStatus === "COMPLETE" && isFilePlacementNoopSatisfiedFromModule(job, this.parsePayload(job), wtPath || job._worktreePath || this.projectDir, output)) {
            const noopPlacementMsg = `File placement task already satisfied — destination file(s) already exist, so there was nothing left to move or copy`;
            this.emit(job.id, `${C.cyan}[worker] WI#${job.work_item_id} job #${job.id}: ${noopPlacementMsg}${C.reset}`);
            logEvent({
              work_item_id: job.work_item_id,
              job_id: job.id,
              attempt_id: attempt.id,
              event_type: EVENT_TYPES.JOB_FILE_PLACEMENT_NOOP_SATISFIED,
              actor_type: EVENT_ACTORS.WORKER,
              message: noopPlacementMsg,
            });
            hasFileChanges = true;
            satisfiedNoop = true;
          } else {
            // True no-op: no file changes and no file requests. Early attempts
            // requeue without assessment; the final budgeted attempt fails.
            // Build a diagnostic message so the retry knows what went wrong and
            // which files are actually in scope.
            const noopPayload = this.parsePayload(job);
            const scopeFiles = scopedDeleteTargetsFromModule(job, noopPayload);
            const scopeCreate = noopPayload.files_to_create || [];
            let noopMsg = `Dev produced no file changes - nothing to assess`;
            if (filesReverted.length > 0) {
              noopMsg += `\nReverted ${filesReverted.length} out-of-scope file(s): ${filesReverted.slice(0, 8).join(", ")}`;
            }
            if (scopeFiles.length > 0 || scopeCreate.length > 0) {
              const allScope = [...scopeFiles, ...scopeCreate.map(f => `${f} (new)`)];
              noopMsg += `\nAllowed scope: ${allScope.slice(0, 10).join(", ")}`;
            }
            noopMsg += `\nEither modify files within the allowed scope, request missing context/scope, or return status VERIFIED_NO_CHANGE with concrete evidence that the requested end state is already present.`;
            finishNoWriteAttemptFromModule(this, {
              attempt,
              attemptCount,
              job,
              leaseToken,
              message: noopMsg,
              startTime,
            });
            return;
          }
        }

        if (shouldShortCircuitNoWriteAssessmentFromModule({
          job,
          hasFileChanges,
          pendingFileRequests,
          satisfiedNoop,
          verifiedNoChange,
        })) {
          const noopPayload = this.parsePayload(job);
          const scopeFiles = scopedDeleteTargetsFromModule(job, noopPayload);
          const scopeCreate = noopPayload.files_to_create || [];
          let noopMsg = `Dev produced no file changes - nothing to assess`;
          if (filesReverted.length > 0) {
            noopMsg += `\nReverted ${filesReverted.length} out-of-scope file(s): ${filesReverted.slice(0, 8).join(", ")}`;
          }
          if (scopeFiles.length > 0 || scopeCreate.length > 0) {
            const allScope = [...scopeFiles, ...scopeCreate.map(f => `${f} (new)`)];
            noopMsg += `\nAllowed scope: ${allScope.slice(0, 10).join(", ")}`;
          }
          noopMsg += `\nEither modify files within the allowed scope, request missing context/scope, or return status VERIFIED_NO_CHANGE with concrete evidence that the requested end state is already present.`;
          finishNoWriteAttemptFromModule(this, {
            attempt,
            attemptCount,
            job,
            leaseToken,
            message: noopMsg,
            startTime,
          });
          return;
        }

        await runPostExecutionAssessmentFromModule(this, {
          attempt,
          committedHash,
          filesCommitted,
          filesCommittedUnknown,
          filesCommittedError,
          filesReverted,
          hasFileChanges,
          job,
          leaseToken,
          output,
          pendingFileRequests,
          preAssessAlreadyVerified,
          preManifestState,
          satisfiedNoop,
          verifiedNoChange,
          startTime,
          wtPath,
        }, {
          assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
          isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
          isProviderError: _isProviderError,
          logBadInputFailure: _logBadInputFailure,
          shouldFastPassArtifactAssessment,
          shouldOverrideArtifactMissingFail,
          shortJobTitle: shortJobTitleFromModule,
          syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
        });
        const postAssessmentJob = getJob(job.id);
        if (postAssessmentJob?.status === "succeeded") {
          this._finalizeSessionRecycleForJob(job, attempt);
        } else {
          this._releasePendingSessionRecycleForJob(job.id);
        }

      } catch (err) {
        this._releasePendingSessionRecycleForJob(job.id);
        const partialHandled = await this._handlePartialWorkFailure({
          attempt,
          attemptCount,
          err,
          job,
          leaseToken,
          output,
          signal: executeAbortController?.signal || null,
          startTime,
          wtPath,
        });
        if (partialHandled) return;
        await handleExecuteAttemptErrorFromModule(this, {
          attempt,
          attemptCount,
          err,
          job,
          leaseToken,
          startTime,
          wtPath,
        }, {
          isProviderError: _isProviderError,
        });
      }

    } catch (outerErr) {
      handleCatastrophicExecuteErrorFromModule(this, {
        job,
        leaseToken,
        outerErr,
      });
    } finally {
      leaseRenewalStopped = true;
      if (leaseRenewTimer) clearTimeout(leaseRenewTimer);
      try {
        const cleanupWtPath = wtPath || job?._worktreePath || null;
        if (cleanupWtPath) clearActiveWorktreeSentinelFromModule(cleanupWtPath, { jobId: job.id ?? null });
      } catch (err) {
        this._logFinalizerFailure(job, "worktree_sentinel", err);
      }
      if (job.id) {
        this._releasePendingSessionRecycleForJob(job.id);
        this._abortControllers.delete(job.id);
        this._killReasons.delete(job.id);
        this._activeWorktrees.delete(job.id);
      }

      // Clean up sandbox on success; keep on failure for debugging
      if (job._jobDir) {
        try {
          const freshJob = getJob(job.id);
          if (freshJob && freshJob.status === "succeeded") {
            await fs.promises.rm(job._jobDir, { recursive: true, force: true });
          }
        } catch (err) {
          this._logFinalizerFailure(job, "job_scratch", err);
        }
      }
      this._maybeCleanupOldJobScratchDirs();

      if (job.id != null) {
        try {
          const freshJob = getJob(job.id);
          if (freshJob && ["succeeded", "failed"].includes(String(freshJob.status || ""))) {
            await emitAtlasAutoFeedbackForJob({
              job: freshJob,
              attemptId: currentAttemptId,
              cwd: wtPath || this.projectDir,
              config: getAtlasIntegrationConfig(),
              outcome: freshJob.status,
            });
          }
        } catch (err) {
          // ATLAS feedback is advisory; job finalization must never fail here.
          this._logFinalizerFailure(job, "atlas_feedback", err);
        }
      }

      // Clean up per-job agent loader dir regardless of outcome — it's always
      // supposed to be empty of real content (pre-launch guard asserts this).
      if (this.projectDir && job.id != null) {
        try {
          await cleanupAgentLoaderAsync(loaderPathForJob(this.projectDir, job.id));
        } catch { /* ignore */ }
      }
      // Plan 9: Release any embedded-ATLAS results cached for this job so the
      // in-memory map doesn't grow unbounded across the worker's lifetime.
      if (job.id != null) {
        try { clearAtlasJobCache(job.id); } catch { /* ignore */ }
      }
    }
  }

  async _handlePartialWorkFailure({
    attempt,
    attemptCount,
    err,
    job,
    leaseToken,
    output = "",
    signal = null,
    startTime,
    wtPath,
  } = {}) {
    if (!attempt?.id || !job?.id || !wtPath || !MUTATING_JOB_TYPES.has(job.job_type)) return false;

    const errorDetails = getErrorDetailsFromModule(err);
    const freshJob = getJob(job.id) || job;
    const maxAttempts = Number(freshJob.max_attempts || job.max_attempts || 3);
    const usedAttempts = Number(freshJob.attempt_count || attemptCount || 0);
    const finalAttempt = usedAttempts >= maxAttempts;
    const state = await collectPartialWorkStateAsyncFromModule(job, wtPath);
    if (!state.hasChanges) return false;

    const reason = errorDetails.summary || err?.message || "job failed with partial work";
    recordPartialWorkDetectedFromModule(job, attempt.id, state, reason);

    const canResumeDirtyWork = shouldOfferPartialTurnExtensionFromModule(job, errorDetails, state);
    if (!finalAttempt) {
      if (canResumeDirtyWork) {
        try {
          if (await stashPartialWorkForExtensionAsyncFromModule(job, wtPath, { projectDir: this.projectDir, signal })) {
            this.emit(job.id, `${C.yellow}[partial]${C.reset} WI#${job.work_item_id} job #${job.id}: stashed partial work for turn-budget retry resume`);
          }
        } catch {
          // Best effort only. The normal failure cleanup path will preserve or
          // defer the dirty tree if the scoped stash cannot be made safely.
        }
      }
      return false;
    }

    if (canResumeDirtyWork) {
      let stashed = false;
      try {
        stashed = await stashPartialWorkForExtensionAsyncFromModule(job, wtPath, { projectDir: this.projectDir, signal });
      } catch {
        stashed = false;
      }
      if (stashed) {
        completeAttempt(attempt.id, {
          status: "failed",
          duration_ms: Date.now() - startTime,
          error_text: reason,
        });
        setPartialWorkErrorFromModule(job, reason);
        spawnPartialWorkReviewJobFromModule(this, job, {
          errorDetails,
          reason,
          state,
          wtPath,
        });
        this._releaseLease(job, leaseToken, "waiting_on_human");
        refreshAndExtractInsightsFromModule(job.work_item_id);
        this._cleanupWorktreeIfDone(job.work_item_id);
        return true;
      }
    }

    if (state.inScopePaths.length > 0) {
      let partialCommit = null;
      try {
        const partialOutput = errorDetails.partialOutput
          || output
          || [
            `Provider failed after producing partial scoped work.`,
            `Failure: ${reason}`,
            "",
            "The worker committed the in-scope partial output so the assessor can decide whether a fix job is needed.",
          ].join("\n");
        partialCommit = await commitScopedPartialWorkAsyncFromModule(this, job, attempt, wtPath, {
          reason,
          output: partialOutput,
        });
        if (partialCommit.committed) {
          storeArtifact({
            work_item_id: job.work_item_id,
            job_id: job.id,
            attempt_id: attempt.id,
            artifact_type: "response",
            content_long: partialOutput,
          });
          await runPostExecutionAssessmentFromModule(this, {
            attempt,
            committedHash: partialCommit.committedHash,
            filesCommitted: partialCommit.filesCommitted || [],
            filesReverted: partialCommit.filesReverted || [],
            hasFileChanges: true,
            job,
            leaseToken,
            output: partialOutput,
            pendingFileRequests: null,
            preAssessAlreadyVerified: true,
            preManifestState: null,
            satisfiedNoop: false,
            startTime,
            wtPath,
          }, {
            assessmentRetryFallbackReads: _assessmentRetryFallbackReads,
            isAssessorParseRetryBudgetExceeded: _isAssessorParseRetryBudgetExceeded,
            isProviderError: _isProviderError,
            logBadInputFailure: _logBadInputFailure,
            shouldFastPassArtifactAssessment,
            shouldOverrideArtifactMissingFail,
            shortJobTitle: shortJobTitleFromModule,
            syncAssessorWorkerDisplay: _syncAssessorWorkerDisplay,
          });
          return true;
        }
      } catch (partialErr) {
        this.emit(job.id, `${C.yellow}[partial]${C.reset} WI#${job.work_item_id} job #${job.id}: partial commit failed - ${partialErr.message?.split("\n")[0] || partialErr}`);
      }
    }

    if (finalAttempt && state.outOfScopePaths.length > 0 && state.siblingPaths.length === 0) {
      try {
        await revertPartialWorkFromModule(this, job, wtPath, {
          attemptId: attempt.id,
          reason: `partial-work-out-of-scope-job-${job.id}`,
        });
      } catch {
        // The regular failure cleanup path will snapshot/reset or flag the
        // remaining dirt if this best-effort revert cannot complete.
      }
    }

    return false;
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
    const cleanup = cleanupWorktreeIfDoneAsyncFromModule(this, ...args);
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
    if (this.display) {
      this.display.workerLine(jobId, message);
    } else if (!this.silent) {
      console.log(message);
    }
  }

  async _kickAtlasReindex(jobOrId, commitHash) {
    const job = jobOrId && typeof jobOrId === "object" ? jobOrId : null;
    const jobId = job?.id ?? jobOrId;

    // ATLAS v2 transactional outbox: emit `atlas.dev_committed` and enqueue a
    // companion warm job whenever the flag is set, independent of the
    // legacy reindex path below.
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
