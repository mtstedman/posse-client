import path from "path";
import {
  completeAttempt,
  createJob,
  getArtifacts,
  getAttempts,
  getJob,
  getWorkItem,
  incrementAndCreateAssessmentAttempt,
  isLeaseValid,
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
import { C } from "../../../../shared/format/functions/colors.js";
import {
  scopedDeleteTargets as scopedDeleteTargetsFromModule,
} from "../../functions/helpers/mutation-guards.js";
import {
  countInternalAssessmentRetries,
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
  recordObservation,
} from "../../../observability/functions/observations.js";
import {
  assessmentRetryFallbackReads as _assessmentRetryFallbackReads,
  buildPriorAssessmentFindings as _buildPriorAssessmentFindings,
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
  const binding = await agentDispatcher.providerFor({ role });
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
    setAssessmentLifecycle(job.id, "assessment_needs_human", { error: message });
    const reviewJob = createJob({
      work_item_id: job.work_item_id,
      job_type: "human_input",
      title: `Assessment unavailable: ${String(job.title || "").slice(0, 70)}`,
      parent_job_id: job.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: job.id,
        gate_kind: "assessment_retry_exhausted",
        review_type: "assessment_retry_limit",
        questions: [
          `Assessment for job #${job.id} could not complete after ${count} attempt(s): ${message.split("\n")[0].slice(0, 180)}`,
          "Choose retry_assessment, pass, fail, explicit waiver, or replan.",
        ],
        context: "The implementation commit is preserved. This gate controls assessment only.",
      }),
    });
    worker.emit(job.id, `${C.yellow}[assess-only] Assessment retry budget exhausted; opened review gate #${reviewJob.id}${C.reset}`);
    worker._releaseLease(job, leaseToken, "waiting_on_review");
    return { gated: true, reviewJob };
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

  async runIfNeeded({ job, leaseToken, wtPath = null, wrappedJob } = {}) {
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
    const assessmentReasoningEffort = assessReasoningEffortOverride || "medium";
    // Retrieve the previous attempt's stored output.
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

    if (!lastWithCommit || !storedOutput) {
      const missing = new Error("Assessment evidence is unavailable: no prior committed output was found.");
      setAssessmentLifecycle(job.id, "assessment_needs_human", { error: missing.message });
      const reviewJob = createJob({
        work_item_id: job.work_item_id,
        job_type: "human_input",
        title: `Assessment evidence unavailable: ${String(job.title || "").slice(0, 60)}`,
        parent_job_id: job.id,
        priority: "high",
        model_tier: "cheap",
        payload_json: JSON.stringify({
          original_job_id: job.id,
          gate_kind: "assessor_evidence_unavailable",
          review_type: "assessment_parse_error",
          questions: [
            `Job #${job.id} was queued for assessment-only recovery, but its commit/output evidence is missing.`,
            "Choose retry_assessment after restoring evidence, pass, fail, explicit waiver, or replan.",
          ],
        }),
      });
      worker.emit(job.id, `${C.yellow}[assess-only] Missing prior evidence; opened review gate #${reviewJob.id}${C.reset}`);
      worker._releaseLease(job, leaseToken, "waiting_on_review");
      return { handled: true };
    }

    worker.emit(job.id, `${C.cyan}[assess-only]${C.reset} WI#${job.work_item_id} job #${job.id}: orphaned assessment — skipping dev, re-assessing prior commit ${lastWithCommit.commit_hash.slice(0, 8)}`);

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

    // Re-run assessment with the stored output (reuse the existing attempt).
    const { role, provider, providerName } = await resolveAssessmentOnlyProvider(worker.agentDispatcher);
    const assessAttemptCount = assessAttempt.attemptCount || (prevAttempts.length + 1);
    const resolveAssessModel = (tier) => tierModelName(tier, { role, providerName });
    const effectiveTier = provider.escalateTier(
      assessModelTierOverride || "cheap",
      assessAttemptCount,
      { resolveModel: resolveAssessModel },
    );
    const internalAssessRetries = countInternalAssessmentRetries(job.id);
    const priorAssessmentFindings = _buildPriorAssessmentFindings(job.id);
    await wrappedJob.setStatus("awaiting_assessment", { leaseToken });
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
        commitHash: lastWithCommit.commit_hash || null,
        attemptId: assessAttempt.attempt.id,
        cleanupWorktree: wtPath
          ? async () => snapshotAndResetDirtyWorktreeAsync(wtPath, worker.projectDir, {
              reason: `test-post-change-side-effects-wi-${job.work_item_id}-job-${job.id}`,
              branchName: getWorkItem(job.work_item_id)?.branch_name || null,
              wiId: job.work_item_id,
              onMsg: (message) => worker.emit(job.id, `${C.dim}[assessor-test] ${message}${C.reset}`),
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
      const assessmentContext = await attachAssessmentDiffContextAsync({
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
        files_requested: flattenPendingAssessmentFileRequests(pendingFileRequests),
      }, assessmentCwd);
      const deterministicTestEvidence = renderTestExecutionEvidence(deterministicTestRun || {});
      if (deterministicTestEvidence) {
        assessmentContext.task_ab_test_evidence = deterministicTestEvidence;
      }
      const assessmentSession = new AssessmentSession({
        job,
        output: storedOutput,
        providerClient: worker.providerClient,
        worker,
        options: {
          silent: worker.silent,
          autoApprove: worker.autoApprove,
          abortSignal: assessAc?.signal || null,
          modelTier: effectiveTier,
          reasoningEffort: assessmentReasoningEffort,
          fallbackReads: _assessmentRetryFallbackReads(effectiveTier, internalAssessRetries),
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
        output_chars: storedOutput.length,
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
      // transport/tool/protocol failures have their own retry budget and can
      // only end in an assessment recovery gate.
      parkAssessmentFailure(worker, job, leaseToken, assessErr);
    }
    return { handled: true, currentAttemptId: assessAttempt.attempt.id };
  }
}
