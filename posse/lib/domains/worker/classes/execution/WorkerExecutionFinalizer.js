import fs from "fs";
import {
  expireUnackedOperatorFeedbackForJob,
  getJob,
  mergeJobResultFields,
} from "../../../queue/functions/index.js";
import { summarizeJobToolMix } from "../../../observability/functions/observations.js";
import { PARKED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import {
  cleanupAgentLoaderAsync,
  loaderPathForJob,
} from "../../functions/helpers/agent-loader.js";
import {
  clearActiveWorktreeSentinel as clearActiveWorktreeSentinelFromModule,
} from "../../functions/helpers/worktree-lifecycle.js";
import { clearAtlasJobCache } from "../../../integrations/functions/atlas-embedded.js";
import { emitAtlasAutoFeedbackForJob } from "../../../integrations/functions/atlas-auto-feedback.js";
import { getAtlasIntegrationConfig } from "../../../integrations/functions/atlas.js";

export class WorkerExecutionFinalizer {
  constructor(worker) {
    this.worker = worker;
  }

  async finalize({
    job,
    wtPath = null,
    currentAttemptId = null,
  } = {}) {
    const worker = this.worker;
    try {
      const cleanupWtPath = wtPath || job?._worktreePath || null;
      if (cleanupWtPath) {
        clearActiveWorktreeSentinelFromModule(cleanupWtPath, {
          jobId: job.id ?? null,
          sentinelPath: job?._activeWorktreeSentinel || null,
        });
      }
    } catch (err) {
      worker._logFinalizerFailure(job, "worktree_sentinel", err);
    }
    if (job.id) {
      worker._stopSessionRecycleLeaseRenewal?.(job.id);
      worker._releasePendingSessionRecycleForJob(job.id);
      worker._abortControllers.delete(job.id);
      worker._killReasons.delete(job.id);
      worker._activeWorktrees.delete(job.id);
    }

    // One row read serves every status check below: nothing in this
    // finalizer changes the job's status (tool_mix merges result fields only).
    let freshJob = null;
    if (job.id != null) {
      try {
        freshJob = getJob(job.id);
      } catch (err) {
        worker._logFinalizerFailure(job, "job_row", err);
      }
    }

    // Clean up sandbox on success; keep on failure for debugging.
    if (job._jobDir) {
      try {
        if (freshJob && freshJob.status === "succeeded") {
          await fs.promises.rm(job._jobDir, { recursive: true, force: true });
        }
      } catch (err) {
        worker._logFinalizerFailure(job, "job_scratch", err);
      }
    }
    worker._maybeCleanupOldJobScratchDirs();

    if (job.id != null) {
      try {
        // Succeeded jobs only: "useful" is a permanent positive ranking
        // boost, and the feedback store has no outcome column — emitting for
        // failed jobs bakes their context in as equally trustworthy signal.
        if (freshJob && String(freshJob.status || "") === "succeeded") {
          await emitAtlasAutoFeedbackForJob({
            job: freshJob,
            attemptId: currentAttemptId,
            cwd: wtPath || worker.projectDir,
            config: getAtlasIntegrationConfig(),
            outcome: freshJob.status,
          });
        }
      } catch (err) {
        // ATLAS feedback is advisory; job finalization must never fail here.
        worker._logFinalizerFailure(job, "atlas_feedback", err);
      }
      try {
        // Persist a compact per-job tool-usage profile before the observation
        // tail prune reclaims this job's rows (10-min grace). Runs for
        // parked and terminal jobs — this is measurement, not the
        // auto-feedback path (which is gated + succeeded-only). Advisory: a
        // failure here must never fail finalization.
        if (freshJob && [...TERMINAL_JOB_STATUSES, ...PARKED_JOB_STATUSES].includes(String(freshJob.status || ""))) {
          const toolMix = summarizeJobToolMix(job.id);
          if (toolMix) mergeJobResultFields(job.id, { tool_mix: toolMix });
        }
      } catch (err) {
        worker._logFinalizerFailure(job, "tool_mix", err);
      }
      try {
        // Unacked operator guidance on a terminal job is undeliverable —
        // expire it loudly so the operator sees the nudge never landed,
        // instead of a forever-pending row no surface renders.
        if (freshJob && TERMINAL_JOB_STATUSES.includes(String(freshJob.status || ""))) {
          expireUnackedOperatorFeedbackForJob({
            job_id: job.id,
            reason: `job_${freshJob.status}`,
          });
        }
      } catch (err) {
        worker._logFinalizerFailure(job, "operator_feedback_expiry", err);
      }
    }

    // Remove per-job loader dirs left by the former Node CLI provider path.
    if (worker.projectDir && job.id != null) {
      try {
        await cleanupAgentLoaderAsync(loaderPathForJob(worker.projectDir, job.id));
      } catch {
        // ignore
      }
    }
    // Release any embedded-ATLAS results cached for this job so the in-memory
    // map doesn't grow unbounded across the worker's lifetime.
    if (job.id != null) {
      try { clearAtlasJobCache(job.id); } catch { /* ignore */ }
    }
  }
}
