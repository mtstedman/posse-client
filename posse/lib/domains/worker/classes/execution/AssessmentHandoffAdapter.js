import path from "path";
import {
  completeAttempt,
  getArtifacts,
  getAttempts,
  getJob,
  incrementAndCreateAttempt,
  isLeaseValid,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import {
  getProvider,
  tierModelName,
} from "../../../providers/functions/provider.js";
import { AssessmentSession } from "../../../assessment/classes/AssessmentSession.js";
import { processVerdict } from "../roles/assessor.js";
import {
  attachAssessmentDiffContextAsync,
} from "../../../handoff/functions/index.js";
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
    const assessModelTierOverride = typeof cleanPayload?._assess_model_tier === "string"
      ? cleanPayload._assess_model_tier
      : null;
    const assessReasoningEffortOverride = typeof cleanPayload?._assess_reasoning_effort === "string"
      ? cleanPayload._assess_reasoning_effort
      : null;
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
      worker.emit(job.id, `${C.yellow}[assess-only]${C.reset} WI#${job.work_item_id} job #${job.id}: no prior commit found — running full execution`);
      return { handled: false };
    }

    worker.emit(job.id, `${C.cyan}[assess-only]${C.reset} WI#${job.work_item_id} job #${job.id}: orphaned assessment — skipping dev, re-assessing prior commit ${lastWithCommit.commit_hash.slice(0, 8)}`);

    const assessAttempt = incrementAndCreateAttempt(job.id, leaseToken, "assessor", null, job.reasoning_effort);
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
    const role = worker._roleFor(job.job_type);
    const provider = getProvider(role, job.provider || undefined);
    const assessAttemptCount = assessAttempt.attemptCount || (prevAttempts.length + 1);
    const resolveAssessModel = (tier) => tierModelName(tier, { role, providerName: job.provider || undefined });
    const effectiveTier = assessModelTierOverride || provider.escalateTier(job.model_tier, assessAttemptCount, { resolveModel: resolveAssessModel });
    const internalAssessRetries = countInternalAssessmentRetries(job.id);
    const priorAssessmentFindings = _buildPriorAssessmentFindings(job.id);
    await wrappedJob.setStatus("awaiting_assessment", { leaseToken });
    _syncAssessorWorkerDisplay(worker.display, job, {
      tier: effectiveTier,
      effort: job.reasoning_effort || "medium",
      attempt: assessAttemptCount,
    });
    try {
      const jobPayloadForAssess = worker.parsePayload(job);
      const assessAc = worker._abortControllers.get(job.id);
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
        files_requested: [],
      }, (isArtifactMode(jobPayloadForAssess.task_mode || "code") && jobPayloadForAssess.output_root)
        ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
        : (wtPath || worker.projectDir));
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
          reasoningEffort: assessReasoningEffortOverride || job.reasoning_effort || "medium",
          fallbackReads: _assessmentRetryFallbackReads(effectiveTier, internalAssessRetries),
          priorAssessmentFindings,
          cwd: (isArtifactMode(jobPayloadForAssess.task_mode || "code") && jobPayloadForAssess.output_root)
            ? path.resolve(worker.projectDir, jobPayloadForAssess.output_root)
            : (wtPath || worker.projectDir),
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
      if (["waiting_on_human", "waiting_on_review"].includes(freshJob?.status)) {
        worker._releaseLease(job, leaseToken, freshJob.status);
      }
      completeAttempt(assessAttempt.attempt.id, {
        status: ATTEMPT_STATUS_MAP[freshJob?.status] || "failed",
        duration_ms: Date.now() - assessStart,
        output_chars: storedOutput.length,
      });
      refreshAndExtractInsightsFromModule(job.work_item_id);
      worker._cleanupWorktreeIfDone(job.work_item_id);
    } catch (assessErr) {
      completeAttempt(assessAttempt.attempt.id, {
        status: "failed",
        duration_ms: Date.now() - assessStart,
        error_text: assessErr.message,
      });
      worker.emit(job.id, `${C.red}[assess-only] Assessment failed: ${assessErr.message.split("\n")[0]}${C.reset}`);
      worker._retryOrFail(job, leaseToken, `Assessment failed: ${assessErr.message}`);
    }
    return { handled: true, currentAttemptId: assessAttempt.attempt.id };
  }
}
