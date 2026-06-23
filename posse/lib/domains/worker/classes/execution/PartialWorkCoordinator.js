import {
  completeAttempt,
  getJob,
  setJobResult,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { MUTATING_JOB_TYPES } from "../../../../catalog/job.js";
import { C } from "../../../../shared/format/functions/colors.js";
import {
  assessmentRetryFallbackReads as _assessmentRetryFallbackReads,
  isAssessorParseRetryBudgetExceeded as _isAssessorParseRetryBudgetExceeded,
  shouldFastPassArtifactAssessment,
  shouldOverrideArtifactMissingFail,
} from "../../functions/execution/assessment-policy.js";
import {
  runPostExecutionAssessment as runPostExecutionAssessmentFromModule,
} from "../../functions/helpers/assessment-pipeline.js";
import {
  collectPartialWorkStateAsync as collectPartialWorkStateAsyncFromModule,
  commitScopedPartialWorkAsync as commitScopedPartialWorkAsyncFromModule,
  recordPartialWorkDetected as recordPartialWorkDetectedFromModule,
  revertPartialWork as revertPartialWorkFromModule,
  setPartialWorkError as setPartialWorkErrorFromModule,
  shouldOfferPartialTurnExtension as shouldOfferPartialTurnExtensionFromModule,
  spawnPartialWorkReviewJob as spawnPartialWorkReviewJobFromModule,
  stashPartialWorkForExtensionAsync as stashPartialWorkForExtensionAsyncFromModule,
} from "../../functions/helpers/partial-work.js";
import {
  getErrorDetails as getErrorDetailsFromModule,
} from "../../functions/helpers/diagnostics.js";
import {
  refreshAndExtractInsights as refreshAndExtractInsightsFromModule,
} from "../../functions/helpers/insights.js";
import {
  shortJobTitle as shortJobTitleFromModule,
} from "../../../../shared/policies/functions/role-utils.js";
import {
  logBadInputFailure as _logBadInputFailure,
} from "../../functions/execution/bad-input.js";
import {
  isProviderError as _isProviderError,
} from "../../functions/execution/job-helpers.js";
import {
  syncAssessorWorkerDisplay as syncAssessorWorkerDisplayFromModule,
} from "../../functions/execution/display-sync.js";

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

export class PartialWorkCoordinator {
  constructor(worker) {
    this.worker = worker;
  }

  async handle(args = {}) {
    return await handlePartialWorkFailureForWorker.call(this.worker, args);
  }
}

export async function handlePartialWorkFailureForWorker({
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
