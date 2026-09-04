import path from "path";
import {
  acquireAssessmentBarrier,
  completeAttempt,
  getJob,
  getWorkItem,
  incrementAndCreateAssessmentAttempt,
  isLeaseValid,
  logEvent,
  setJobError,
  setAssessmentLifecycle,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import {
  tierModelName,
} from "../../../providers/functions/provider.js";
import { AssessmentSession } from "../../../assessment/classes/AssessmentSession.js";
import { processVerdict } from "../roles/assessor.js";
import {
  attachAssessmentDiffContextAsync,
} from "../../../handoff/functions/index.js";
import { isRetryableTerminalHandoffError } from "../../../handoff/functions/agent-handoff.js";
import {
  isArtifactMode,
} from "../../../artifacts/functions/index.js";
import { ASSESSABLE_JOB_TYPES } from "../../../../catalog/job.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { C } from "../../../../shared/format/functions/colors.js";
import {
  scopedDeleteTargets as scopedDeleteTargetsFromModule,
} from "../../functions/helpers/mutation-guards.js";
import {
  countInternalAssessmentRetries,
  harnessAssessorEffort,
  harnessAssessorProvider,
} from "../../functions/helpers/assessment-shared.js";
import {
  refreshAndExtractInsights as refreshAndExtractInsightsFromModule,
} from "../../functions/helpers/insights.js";
import {
  ensurePostChangeTestReceipt,
  renderTestExecutionEvidence,
  testReceiptObservationDetail,
} from "../../functions/helpers/test-execution-receipt.js";
import {
  snapshotAndResetDirtyWorktreeAsync,
} from "../../../git/functions/worktree.js";
import {
  gitExecAsync,
} from "../../../git/functions/utils.js";
import {
  recordObservation,
} from "../../../observability/functions/observations.js";
import {
  assessmentRetryFallbackReads as _assessmentRetryFallbackReads,
  buildPriorAssessmentFindings as _buildPriorAssessmentFindings,
  raiseAssessmentFallbackReadsForScope as _raiseAssessmentFallbackReadsForScope,
} from "../../functions/execution/assessment-policy.js";
import {
  logAttemptSkippedStaleLease as _logAttemptSkippedStaleLease,
} from "../../functions/execution/attempt-logging.js";
import {
  syncAssessorWorkerDisplay as syncAssessorWorkerDisplayFromModule,
} from "../../functions/execution/display-sync.js";
import {
  shortJobTitle as shortJobTitleFromModule,
} from "../../../../shared/policies/functions/role-utils.js";
import {
  clearPendingAssessmentFileRequests,
  flattenPendingAssessmentFileRequests,
  readPendingAssessmentFileRequests,
} from "../../functions/helpers/assessment-file-requests.js";
import {
  siblingLockSummary,
} from "../../../queue/functions/sibling-locks.js";
import { loadAssessmentSource } from "../../functions/execution/assessment-source.js";
import { ensureAssessmentScopedCheckEvidence } from "../../../assessment/functions/scoped-check-evidence.js";
import {
  assessmentWorktreeDirtySummary,
  inspectAssessmentWorktreeReadiness,
} from "../../functions/helpers/assessment-worktree-readiness.js";
import { ensureConfiguredVerification } from "../../functions/helpers/configured-verification.js";
import { repairTestDependencies } from "../../functions/helpers/test-dependency-repair.js";

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

const ATTEMPT_STATUS_MAP = {
  succeeded: "succeeded",
  failed: "failed",
  queued: "interrupted",
  waiting_on_review: "interrupted",
  waiting_on_human: "interrupted",
  blocked: "blocked",
};

export function assessmentFallbackRetryCount({
  assessmentAttemptCount = 1,
  internalRetryCount = 0,
} = {}) {
  const priorAssessmentAttempts = Math.max(
    0,
    Math.floor(Number(assessmentAttemptCount) || 1) - 1,
  );
  const recordedInternalRetries = Math.max(
    0,
    Math.floor(Number(internalRetryCount) || 0),
  );
  return Math.max(priorAssessmentAttempts, recordedInternalRetries);
}

export function retryAssessmentOnlyAfterTerminalHandoffError(
  worker,
  job,
  leaseToken,
  error,
  { delayMs = 2_000 } = {},
) {
  if (!isRetryableTerminalHandoffError(error)) return false;
  preserveAssessmentOnlyRetryPayload(worker, job);
  worker.emit(job.id, `${C.yellow}[assess-only] Missing terminal handoff — retrying assessor only${C.reset}`);
  parkAssessmentFailure(worker, job, leaseToken, error, { delayMs });
  return true;
}

export function preserveAssessmentOnlyRetryPayload(worker, job) {
  const retryPayload = worker.parsePayload(job);
  retryPayload._assess_only = true;
  const nextPayloadJson = JSON.stringify(retryPayload);
  updateJobPayload(job.id, nextPayloadJson);
  job.payload_json = nextPayloadJson;
  return retryPayload;
}

export async function resolveAssessmentOnlyProvider(agentDispatcher) {
  const role = "assessor";
  if (!agentDispatcher || typeof agentDispatcher.providerFor !== "function") {
    throw new Error("Assessment routing requires the worker AgentDispatcher");
  }
  // A pinned harness provider that is not configured for the role must fail
  // loud (dispatchError) rather than silently comparing unequal assessors.
  const binding = await agentDispatcher.providerFor({ role, providerName: harnessAssessorProvider() });
  const provider = binding?.provider;
  if (!provider) {
    throw new Error("AgentDispatcher did not bind a Provider for assessor");
  }
  return {
    role,
    provider,
    providerName: String(binding.providerName || "").trim() || null,
  };
}

function parkAssessmentFailure(worker, job, leaseToken, error, {
  delayMs = 2_000,
} = {}) {
  const fresh = getJob(job.id) || job;
  const count = Number(fresh.assessment_attempt_count || 0);
  const max = Math.max(1, Number(fresh.assessment_max_attempts || 3));
  const message = String(error?.message || error || "Assessment unavailable");
  preserveAssessmentOnlyRetryPayload(worker, job);
  if (count >= max) {
    const terminalProtocolFailure = isRetryableTerminalHandoffError(error);
    setAssessmentLifecycle(job.id, "assessment_failed", { error: message, completed: true });
    setJobError(job.id, `Assessment infrastructure exhausted after ${count}/${max} attempts: ${message}`);
    worker.emit(job.id, `${C.red}[assess-only] Assessment recovery exhausted; failed closed without a human gate${C.reset}`);
    worker._releaseLease(job, leaseToken, "failed");
    return { gated: false, terminalProtocolFailure };
  }
  setAssessmentLifecycle(job.id, "assessment_unavailable", { error: message });
  const readyAt = new Date(Date.now() + delayMs).toISOString();
  worker._releaseLease(job, leaseToken, "queued", { readyAt });
  return { gated: false, readyAt };
}

export function spawnDeferredAssessmentFileRequestFollowUp(
  worker,
  job,
  freshJob,
  pendingFileRequests,
  attemptId,
) {
  if (freshJob?.status !== "succeeded" || !pendingFileRequests) return false;
  worker._spawnFileRequestFollowUp(job, pendingFileRequests, attemptId);
  const persistedJob = getJob(job.id) || freshJob || job;
  const payload = worker.parsePayload(persistedJob);
  if (clearPendingAssessmentFileRequests(payload)) {
    const nextPayloadJson = JSON.stringify(payload);
    updateJobPayload(job.id, nextPayloadJson);
    job.payload_json = nextPayloadJson;
  }
  return true;
}

export class AssessmentHandoffAdapter {
  constructor(worker) {
    this.worker = worker;
  }

  async runIfNeeded({ job, leaseToken, wtPath = null } = {}) {
    const worker = this.worker;
    const assessOnly = worker.parsePayload(job)._assess_only;
    if (!assessOnly || !ASSESSABLE_JOB_TYPES.has(job.job_type)) {
      return { handled: false };
    }

    const assessStart = Date.now();
    const cleanPayload = worker.parsePayload(job);
    const pendingFileRequests = readPendingAssessmentFileRequests(cleanPayload);
    const assessModelTierOverride = typeof cleanPayload?._assess_model_tier === "string"
      ? cleanPayload._assess_model_tier
      : null;
    const assessReasoningEffortOverride = typeof cleanPayload?._assess_reasoning_effort === "string"
      ? cleanPayload._assess_reasoning_effort
      : null;
    const assessmentReasoningEffort = harnessAssessorEffort() || assessReasoningEffortOverride || "medium";
    const assessmentSource = loadAssessmentSource(job.id);
    if (!assessmentSource.ok) {
      const missing = new Error(`Assessment evidence is unavailable: ${assessmentSource.reason}`);
      const recoveryCount = Math.max(0, Number(cleanPayload?._assessment_source_recovery_count || 0));
      if (recoveryCount < 1) {
        const recoveryPayload = { ...cleanPayload };
        delete recoveryPayload._assess_only;
        delete recoveryPayload._assess_model_tier;
        delete recoveryPayload._assess_reasoning_effort;
        delete recoveryPayload._assess_model_name;
        recoveryPayload._assessment_source_recovery_count = recoveryCount + 1;
        recoveryPayload._assessment_source_recovery_reason = missing.message.slice(0, 1000);
        updateJobPayload(job.id, JSON.stringify(recoveryPayload));
        setAssessmentLifecycle(job.id, "assessment_unavailable", { error: missing.message });
        worker.emit(job.id, `${C.yellow}[assess-only] Missing bound source; resuming implementation once to repair terminal evidence${C.reset}`);
        if (typeof worker._releaseWithoutAttemptPenalty === "function") {
          worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", {
            readyAt: new Date().toISOString(),
          });
        } else {
          worker._releaseLease(job, leaseToken, "queued");
        }
      } else {
        setAssessmentLifecycle(job.id, "assessment_failed", { error: missing.message, completed: true });
        setJobError(job.id, `${missing.message}; automatic source repair already attempted`);
        worker.emit(job.id, `${C.red}[assess-only] Missing bound source after automatic repair; failed closed without a human gate${C.reset}`);
        worker._releaseLease(job, leaseToken, "failed");
      }
      return { handled: true };
    }

    const sourceLabel = assessmentSource.kind === "commit"
      ? `prior commit ${assessmentSource.commitHash.slice(0, 8)}`
      : `prior VERIFIED_NO_CHANGE result from attempt #${assessmentSource.attempt.id}`;
    worker.emit(job.id, `${C.cyan}[assess-only]${C.reset} WI#${job.work_item_id} job #${job.id}: orphaned assessment — skipping dev, re-assessing ${sourceLabel}`);

    const barrier = acquireAssessmentBarrier(job.id, leaseToken);
    if (!barrier.ok) {
      if (barrier.reason === "lease_invalid") {
        _logAttemptSkippedStaleLease(job, "assessor", "Skipped assess-only barrier because the lease was stale or expired");
        worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before assess-only execution${C.reset}`);
        return { handled: true };
      }
      const siblingLocks = barrier.blockers || [];
      const summary = siblingLockSummary(siblingLocks);
      worker.emit(job.id, `${C.dim}[assess-only] Waiting for ${siblingLocks.length} same-WI writer lock(s) to drain${summary ? ` (${summary})` : ""}${C.reset}`);
      worker._releaseLease(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + 1_000).toISOString(),
      });
      return { handled: true };
    }

    const readiness = assessmentSource.kind === "commit"
      ? await inspectAssessmentWorktreeReadiness(wtPath)
      : { ready: true };
    if (!readiness.ready) {
      const detail = assessmentWorktreeDirtySummary(readiness);
      setAssessmentLifecycle(job.id, "implementation_complete");
      worker.emit(
        job.id,
        `${C.dim}[assess-only] Deferred until the committed worktree is clean (${detail})${C.reset}`,
      );
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_ASSESSMENT_DEFERRED_FOR_DIRTY_WORKTREE,
        actor_type: EVENT_ACTORS.WORKER,
        message: "Deferred assess-only recovery before budget consumption because the worktree was not clean after barrier acquisition",
        event_json: JSON.stringify({
          dirty_count: readiness.dirty_count,
          dirty_paths: readiness.dirty_paths.slice(0, 100),
        }),
      });
      worker._releaseLease(job, leaseToken, "queued", {
        readyAt: new Date(Date.now() + 2_000).toISOString(),
      });
      return { handled: true };
    }

    const assessAttempt = incrementAndCreateAssessmentAttempt(
      job.id,
      leaseToken,
      null,
      assessmentReasoningEffort,
    );
    if (!assessAttempt) {
      _logAttemptSkippedStaleLease(job, "assessor", "Skipped assess-only attempt because the lease was stale or expired");
      worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before assess-only execution${C.reset}`);
      return { handled: true };
    }

    // Re-run assessment with the stored output (reuse the existing attempt).
    const { role, provider, providerName } = await resolveAssessmentOnlyProvider(worker.agentDispatcher);
    const assessAttemptCount = assessAttempt.attemptCount || (Number(assessmentSource.attempt?.attempt_number || 0) + 1);
    const resolveAssessModel = (tier) => tierModelName(tier, { role, providerName });
    const effectiveTier = provider.escalateTier(
      assessModelTierOverride || "cheap",
      assessAttemptCount,
      { resolveModel: resolveAssessModel },
    );
    const internalAssessRetries = countInternalAssessmentRetries(job.id);
    // Tool/transport failures requeue assessment without producing the
    // `job.assessment_internal_retry` event used by verdict escalation. Count
    // prior assessment attempts too, otherwise those retries receive the same
    // read allowance and deterministically hit the same ceiling again.
    const fallbackRetryCount = assessmentFallbackRetryCount({
      assessmentAttemptCount: assessAttempt.assessmentAttemptCount,
      internalRetryCount: internalAssessRetries,
    });
    const priorAssessmentFindings = _buildPriorAssessmentFindings(job.id);
    // Keep _assess_only set until acquireAssessmentBarrier atomically moves the
    // job into awaiting_assessment. Clearing it earlier opens an unprotected
    // window where a sibling writer can lease into this assessment.
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
    _syncAssessorWorkerDisplay(worker.display, job, {
      tier: effectiveTier,
      effort: assessmentReasoningEffort,
      attempt: assessAttemptCount,
    });
    try {
      const jobPayloadForAssess = worker.parsePayload(job);
      const assessAc = worker._abortControllers.get(job.id);
      const assessmentCwd = (isArtifactMode(jobPayloadForAssess.task_mode || "code") && jobPayloadForAssess.output_root)
        ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
        : (wtPath || worker.projectDir);
      const deterministicTestRun = await ensurePostChangeTestReceipt({
        job,
        payload: jobPayloadForAssess,
        cwd: assessmentCwd,
        commitHash: assessmentSource.commitHash,
        attemptId: assessAttempt.attempt.id,
        cleanupWorktree: wtPath
          ? async () => snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
              reason: `test-post-change-side-effects-wi-${job.work_item_id}-job-${job.id}`,
              branchName: getWorkItem(job.work_item_id)?.branch_name || null,
              wiId: job.work_item_id,
              onMsg: (message) => worker.emit(job.id, `${C.dim}[assessor-test] ${message}${C.reset}`),
            })
          : null,
        repairDependencies: wtPath
          ? () => repairTestDependencies(worker, job, wtPath, {
              signal: assessAc?.signal || null,
              phase: "assessor",
            })
          : null,
      });
      const postReceipt = deterministicTestRun?.post_change || null;
      if (postReceipt) {
        worker.emit(
          job.id,
          `${postReceipt.status === "passed" ? C.green : postReceipt.status === "failed" ? C.red : C.yellow}[assessor-test] ${postReceipt.reused ? "Reused" : "Ran"} frozen command: ${postReceipt.status}${C.reset}`,
        );
        recordObservation({
          work_item_id: job.work_item_id,
          job_id: job.id,
          attempt_id: assessAttempt.attempt.id,
          observation_type: "command.pre_assess",
          summary: `Frozen ${postReceipt.source || "planner"} test command ${postReceipt.status}`,
          detail: {
            ...testReceiptObservationDetail(postReceipt),
            cwd: assessmentCwd,
          },
        });
        if (["infrastructure_error", "unavailable"].includes(postReceipt.status)) {
          throw new Error(`Deterministic post-change test execution unavailable: ${postReceipt.reason || postReceipt.status}`);
        }
      }
      const configuredVerification = await ensureConfiguredVerification(worker, {
        job,
        attemptId: assessAttempt.attempt.id,
        assessedCommitHash: assessmentSource.commitHash,
        // Configured repository verification has the same root-relative
        // contract in attached and recovery assessment paths. Artifact
        // inspection may use output_root, but the verifier must not.
        wtPath: wtPath || worker.projectDir,
      });
      if (configuredVerification.status === "failed") {
        throw configuredVerification.error
          || new Error(configuredVerification.message || "Pre-assessment hook failed");
      }
      let filesCommitted = [];
      let filesCommittedUnknown = false;
      let filesCommittedError = null;
      // Attempts persist the pre-commit HEAD, so multi-commit attempts diff
      // base..head; older rows without a base fall back to the final commit.
      const commitBaseHash = assessmentSource.commitBaseHash;
      const commitDiffRevs = assessmentSource.commitHash
        ? (commitBaseHash
          ? [commitBaseHash, assessmentSource.commitHash]
          : [`${assessmentSource.commitHash}^!`])
        : null;
      // File names must be worktree-root-relative to match the scope contract
      // (the live path computes them in wtPath), not artifact output_root.
      const commitListCwd = wtPath || worker.projectDir;
      if (commitDiffRevs) {
        try {
          filesCommitted = (await gitExecAsync([
            "diff",
            "--no-renames",
            "--name-only",
            "--relative",
            ...commitDiffRevs,
          ], commitListCwd))
            .split("\n")
            .map((line) => String(line || "").replace(/\\/g, "/").trim())
            .filter(Boolean);
        } catch (error) {
          filesCommittedUnknown = true;
          filesCommittedError = error?.message || String(error);
        }
      }
      const assessmentContext = await attachAssessmentDiffContextAsync({
        task_mode: jobPayloadForAssess.task_mode || "code",
        manifest: null,
        commit_hash: assessmentSource.commitHash,
        commit_base_hash: commitBaseHash,
        output_root: jobPayloadForAssess.output_root || null,
        verified_no_change: assessmentSource.kind === "verified_no_change",
        allowed_files: jobPayloadForAssess.files_to_modify || [],
        allowed_create_files: jobPayloadForAssess.files_to_create || [],
        allowed_delete_files: scopedDeleteTargetsFromModule(job, jobPayloadForAssess),
        allowed_create_roots: jobPayloadForAssess.create_roots || [],
        files_committed: filesCommitted,
        files_committed_unknown: filesCommittedUnknown,
        files_committed_error: filesCommittedError,
        files_reverted: [],
        files_requested: flattenPendingAssessmentFileRequests(pendingFileRequests),
      }, assessmentCwd);
      const deterministicTestEvidence = renderTestExecutionEvidence(deterministicTestRun || {});
      if (deterministicTestEvidence) {
        assessmentContext.task_ab_test_evidence = deterministicTestEvidence;
      }
      const scopedCheckReceipt = await ensureAssessmentScopedCheckEvidence({
        job,
        attemptId: assessAttempt.attempt.id,
        cwd: assessmentCwd,
        assessmentContext,
        cleanupWorktree: async () => snapshotAndResetDirtyWorktreeAsync(
          assessmentCwd,
          worker.projectDir,
          {
            reason: `assessment-scoped-check-side-effects-wi-${job.work_item_id}-job-${job.id}`,
            branchName: getWorkItem(job.work_item_id)?.branch_name || null,
            wiId: job.work_item_id,
            onMsg: (message) => worker.emit(job.id, `${C.dim}[assessor-checks] ${message}${C.reset}`),
          },
        ),
      });
      if (scopedCheckReceipt) {
        assessmentContext.scoped_check_evidence = scopedCheckReceipt.evidence;
        worker.emit(
          job.id,
          `${C.dim}[assessor-checks] ${scopedCheckReceipt.reused ? "Reused" : "Ran"} changed-file lint/typecheck: ${scopedCheckReceipt.result.status}${C.reset}`,
        );
      }
      const assessmentSession = new AssessmentSession({
        job,
        output: assessmentSource.output,
        attemptId: assessAttempt.attempt.id,
        providerClient: worker.providerClient,
        worker,
        options: {
          silent: worker.silent,
          autoApprove: worker.autoApprove,
          abortSignal: assessAc?.signal || null,
          modelTier: effectiveTier,
          reasoningEffort: assessmentReasoningEffort,
          fallbackReads: _raiseAssessmentFallbackReadsForScope(
            _assessmentRetryFallbackReads(effectiveTier, fallbackRetryCount),
            { assessmentContext, payload: jobPayloadForAssess },
          ),
          priorAssessmentFindings,
          routedProviderName: providerName,
          cwd: assessmentCwd,
          assessmentContext,
        },
      });
      const verdict = await assessmentSession.assess();
      if (!isLeaseValid(job.id, leaseToken)) {
        worker.emit(job.id, `${C.yellow}[lease] WI#${job.work_item_id} job #${job.id} - lease expired before assess-only verdict${C.reset}`);
        completeAttempt(assessAttempt.attempt.id, {
          status: "interrupted",
          duration_ms: Date.now() - assessStart,
          error_text: "Lease expired before assess-only verdict - result discarded",
        });
        refreshAndExtractInsightsFromModule(job.work_item_id);
        worker._cleanupWorktreeIfDone(job.work_item_id);
        return { handled: true, currentAttemptId: assessAttempt.attempt.id };
      }
      const emitFn = (msg) => worker.emit(job.id, msg);
      processVerdict(job, verdict, { emit: emitFn, autoApprove: worker.autoApprove, leaseToken });
      const freshJob = getJob(job.id);
      if (freshJob?.status === "succeeded") {
        setAssessmentLifecycle(job.id, "assessment_passed", { completed: true });
      } else if (freshJob?.status === "failed") {
        setAssessmentLifecycle(job.id, "assessment_failed", { completed: true });
      } else if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
        setAssessmentLifecycle(job.id, "assessment_needs_human");
      }
      if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
        worker._releaseLease(job, leaseToken, freshJob.status);
      }
      completeAttempt(assessAttempt.attempt.id, {
        status: ATTEMPT_STATUS_MAP[freshJob?.status] || "failed",
        duration_ms: Date.now() - assessStart,
        output_chars: assessmentSource.output.length,
      });
      spawnDeferredAssessmentFileRequestFollowUp(
        worker,
        job,
        freshJob,
        pendingFileRequests,
        assessAttempt.attempt.id,
      );
      refreshAndExtractInsightsFromModule(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
    } catch (assessErr) {
      completeAttempt(assessAttempt.attempt.id, {
        status: "failed",
        duration_ms: Date.now() - assessStart,
        error_text: assessErr.message,
      });
      worker.emit(job.id, `${C.red}[assess-only] Assessment failed: ${assessErr.message.split("\n")[0]}${C.reset}`);
      // The developer's committed output remains authoritative. Assessment
      // Transport/tool failures have their own retry budget. Terminal handoff
      // protocol failures are internal harness faults and fail closed without
      // asking the operator to repair them.
      parkAssessmentFailure(worker, job, leaseToken, assessErr);
    }
    return { handled: true, currentAttemptId: assessAttempt.attempt.id };
  }
}
