import path from "path";
import {
  logEvent,
  storeArtifact,
  updateJobPayload,
} from "../../../queue/functions/index.js";
import {
  getProviderName,
} from "../../../providers/functions/provider.js";
import {
  injectArtifactScope,
  isArtifactMode,
  buildManifest,
  wiScopeId,
} from "../../../artifacts/functions/index.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { log, jobLog } from "../../../../shared/telemetry/functions/logging/logger.js";
import { yieldNow } from "../../../runtime/functions/yield.js";
import { recordObservation, runWithObservationContext } from "../../../observability/functions/observations.js";
import { MUTATING_JOB_TYPES } from "../../../../catalog/job.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../catalog/event.js";
import { roleBrandColor } from "../../../ui/functions/display/helpers/brand.js";
import {
  runHumanInputJob as runHumanInputJobFromModule,
} from "../../functions/execution/human-input-job.js";
import {
  runPromoteJob as runPromoteJobFromModule,
} from "../../functions/execution/promote-job.js";
import {
  runAtlasWarmJob as runAtlasWarmJobFromModule,
} from "../../functions/execution/atlas-warm-job.js";
import {
  setUpWorktreeForJob as setUpWorktreeForJobFromModule,
  clearActiveWorktreeSentinel as clearActiveWorktreeSentinelFromModule,
} from "../../functions/helpers/worktree-lifecycle.js";
import {
  handleCatastrophicExecuteError as handleCatastrophicExecuteErrorFromModule,
  handleExecuteAttemptError as handleExecuteAttemptErrorFromModule,
} from "../../functions/helpers/attempt-errors.js";
import {
  isProviderError as _isProviderError,
} from "../../functions/execution/job-helpers.js";
import {
  shortJobTitle as shortJobTitleFromModule,
} from "../../../../shared/policies/functions/role-utils.js";
import { AssessmentHandoffAdapter } from "./AssessmentHandoffAdapter.js";
import { ProviderAttemptLifecycle } from "./ProviderAttemptLifecycle.js";
import { PostExecutionCoordinator } from "./PostExecutionCoordinator.js";
import { WorkerExecutionFinalizer } from "./WorkerExecutionFinalizer.js";

export class WorkerExecutionCoordinator {
  constructor(worker, {
    assessmentHandoff = null,
    attemptLifecycle = null,
    postExecution = null,
    finalizer = null,
  } = {}) {
    this.worker = worker;
    this.assessmentHandoff = assessmentHandoff || new AssessmentHandoffAdapter(worker);
    this.attemptLifecycle = attemptLifecycle || new ProviderAttemptLifecycle(worker);
    this.postExecution = postExecution || new PostExecutionCoordinator(worker);
    this.finalizer = finalizer || new WorkerExecutionFinalizer(worker);
  }

  async execute(job) {
    const worker = this.worker;
    const leaseToken = job._leaseToken;
    let wtPath = null;
    let currentAttemptId = null;
    const executeAbortController = job.id ? worker._registerAbortController(job.id) : null;
    const jobLease = worker._createJobLease(job, leaseToken, executeAbortController);
    const wrappedJob = worker._wrapJob(job);

    try {
      // Lease renewal must start before async setup: setup can now spend real
      // wall-clock time awaiting worktree locks, git merges, or ATLAS graph prep.
      jobLease.start();

      const atlasFreshnessGate = await worker._gateAtlasFreshnessBeforePlanningOrDev(job, leaseToken, {
        signal: executeAbortController?.signal || null,
      });
      if (!atlasFreshnessGate.ok) return;

      // -- Git worktree setup (mutating code-mode jobs only) --
      let branchName = null;
      const setup = await setUpWorktreeForJobFromModule(worker, job, leaseToken, {
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
        worker._activeWorktrees.set(job.id, {
          wtPath,
          workItemId: job.work_item_id ?? null,
          branchName: branchName || null,
          sentinelPath: setup?.sentinelPath || job?._activeWorktreeSentinel || null,
        });
      }

      // -- Short-circuit: human_input needs no provider --
      if (job.job_type === "human_input") {
        await runHumanInputJobFromModule(worker, job, {
          leaseToken,
          abortSignal: executeAbortController?.signal || null,
        });
        await yieldNow({ signal: executeAbortController?.signal || null }).catch(() => {});
        return;
      }

      // -- Short-circuit: promote is deterministic - no provider needed --
      if (job.job_type === "promote") {
        await runPromoteJobFromModule(worker, job, wrappedJob, { leaseToken });
        return;
      }

      // -- Short-circuit: atlas_warm is deterministic - no provider needed --
      if (job.job_type === "atlas_warm") {
        await runAtlasWarmJobFromModule(worker, job, wrappedJob, {
          leaseToken,
          abortSignal: executeAbortController?.signal || null,
        });
        return;
      }

      // -- Short-circuit: orphaned assessment requeue --
      const assessOnly = await this.assessmentHandoff.runIfNeeded({
        job,
        leaseToken,
        wtPath,
        wrappedJob,
      });
      if (assessOnly.currentAttemptId) currentAttemptId = assessOnly.currentAttemptId;
      if (assessOnly.handled) return;

      // -- Create attempt record --
      const attemptContext = await this.attemptLifecycle.prepare({
        job,
        leaseToken,
        wrappedJob,
      });
      if (attemptContext.currentAttemptId) currentAttemptId = attemptContext.currentAttemptId;
      if (!attemptContext.ok) return;

      const {
        role,
        imageRoute,
        providerResolution,
        executionProvider,
        provider,
        resolveTierModel,
        effectiveTier,
        modelName,
        attemptCount,
        attempt,
        startTime,
      } = attemptContext;

      let output = "";

      try {
        // -- Auto-inject artifact scope for non-code task modes --
        // This is system-enforced: even if the planner forgot to set output_root
        // or create_roots, the worker fills them before dispatch. For artifact
        // modes this also clears files_to_modify/files_to_create (forces create_roots).
        // Artificer ALWAYS gets artifact scope — it writes to output dirs, not the repo.
        if (MUTATING_JOB_TYPES.has(job.job_type)) {
          let jobPayloadInject = worker.parsePayload(job);
          if (job.job_type === "artificer" && (!jobPayloadInject.task_mode || jobPayloadInject.task_mode === "code")) {
            jobPayloadInject = { ...jobPayloadInject, task_mode: "content" };
          }
          const taskMode = jobPayloadInject.task_mode || "code";
          if (taskMode !== "code" || job.job_type === "artificer") {
            const scopeId = wiScopeId(job.work_item_id);
            jobPayloadInject = injectArtifactScope(jobPayloadInject, scopeId, worker.projectDir);
            job.payload_json = JSON.stringify(jobPayloadInject);
            updateJobPayload(job.id, job.payload_json);
            worker.emit(job.id, `${C.cyan}[artifacts]${C.reset} WI#${job.work_item_id} job #${job.id}: ${taskMode} mode — output_root=${jobPayloadInject.output_root}`);
            const scopeWarnings = Array.isArray(jobPayloadInject._artifact_scope_warnings)
              ? jobPayloadInject._artifact_scope_warnings
              : [];
            if (scopeWarnings.length > 0) {
              const warningMsg = `Artifact scope normalized ${scopeWarnings.length} planner path(s): ${scopeWarnings.slice(0, 3).map((w) => `${w.type}:${w.file}`).join(", ")}`;
              worker.emit(job.id, `${C.yellow}[artifacts]${C.reset} WI#${job.work_item_id} job #${job.id}: ${warningMsg}`);
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
          const prePayload = worker.parsePayload(job);
          const preTaskMode = prePayload.task_mode || "code";
          if (isArtifactMode(preTaskMode) && prePayload.output_root) {
            const absRoot = path.resolve(worker.projectDir, prePayload.output_root);
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
        const observationPayload = worker.parsePayload(job);
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
            cwd: wtPath || worker.projectDir,
            worktree: wtPath || null,
            attempt: attemptCount,
            files_to_modify: observationPayload.files_to_modify || [],
            files_to_create: observationPayload.files_to_create || [],
          },
        });
        const roleColor = roleBrandColor(role);
        const roleLabel = role === "dev" ? "developer" : role;
        const providerTag = executionProvider ? ` ${C.dim}(${executionProvider})${C.reset}` : "";
        if (role !== "artificer" && !worker.display) {
          worker.emit(job.id, `${roleColor}[${roleLabel}]${C.reset} WI#${job.work_item_id} job #${job.id}: ${shortJobTitleFromModule(job).slice(0, 60)} ${C.dim}(${modelName})${C.reset}${providerTag}`);
        }
        if (worker.display) worker.display.updateWorkerTier(job.id, effectiveTier, attemptCount, executionProvider || null, modelName);
        // Wrap the whole role runner in observation context so side-effect
        // observations (ATLAS prefetches, git ops, hook writes) auto-tag with
        // this job_id instead of showing up as "#?" in the TUI. The inner
        // provider calls re-wrap with their own scope through providerClient.
        output = await runWithObservationContext(
          { work_item_id: job.work_item_id, job_id: job.id, attempt_id: attempt.id },
          () => worker._dispatch(job, effectiveTier, attemptCount, attempt.id, wrappedJob),
        );

        return await this.postExecution.handle({
          attempt,
          attemptCount,
          branchName,
          effectiveTier,
          executionProvider,
          imageRoute,
          job,
          leaseToken,
          modelName,
          output,
          preManifestState,
          provider,
          providerResolution,
          resolveTierModel,
          role,
          startTime,
          wrappedJob,
          wtPath,
        });
      } catch (err) {
        worker._releasePendingSessionRecycleForJob(job.id);
        const partialHandled = await worker._handlePartialWorkFailure({
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
        await handleExecuteAttemptErrorFromModule(worker, {
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
      handleCatastrophicExecuteErrorFromModule(worker, {
        job,
        leaseToken,
        outerErr,
      });
    } finally {
      jobLease.stop();
      await this.finalizer.finalize({
        job,
        wtPath,
        currentAttemptId,
      });
    }
  }
}
