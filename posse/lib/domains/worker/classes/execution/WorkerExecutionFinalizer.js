import fs from "fs";
import {
  getJob,
} from "../../../queue/functions/index.js";
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
      if (cleanupWtPath) clearActiveWorktreeSentinelFromModule(cleanupWtPath, { jobId: job.id ?? null });
    } catch (err) {
      worker._logFinalizerFailure(job, "worktree_sentinel", err);
    }
    if (job.id) {
      worker._releasePendingSessionRecycleForJob(job.id);
      worker._abortControllers.delete(job.id);
      worker._killReasons.delete(job.id);
      worker._activeWorktrees.delete(job.id);
    }

    // Clean up sandbox on success; keep on failure for debugging.
    if (job._jobDir) {
      try {
        const freshJob = getJob(job.id);
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
        const freshJob = getJob(job.id);
        if (freshJob && ["succeeded", "failed"].includes(String(freshJob.status || ""))) {
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
    }

    // Clean up per-job agent loader dir regardless of outcome — it's always
    // supposed to be empty of real content (pre-launch guard asserts this).
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
