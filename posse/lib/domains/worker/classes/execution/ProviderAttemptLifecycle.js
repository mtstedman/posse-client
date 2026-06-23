import fs from "fs";
import {
  completeAttempt,
  incrementAndCreateAttempt,
  updateJobProvider,
} from "../../../queue/functions/index.js";
import {
  getProvider,
  getAvailableProviders,
  isProviderReady,
  tierModelName,
} from "../../../providers/functions/provider.js";
import {
  effectiveArtifactTaskMode as effectiveArtifactTaskModeFromModule,
  isImageOnlyModelName as isImageOnlyModelNameFromModule,
  resolveExecutionProviderFromSettings as resolveExecutionProviderFromModule,
  resolveImageExecutionProvider as resolveImageExecutionProviderFromModule,
} from "../../../providers/functions/execution-routing.js";
import { MUTATING_JOB_TYPES } from "../../../../catalog/job.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { getRuntimeRoot } from "../../../runtime/functions/paths.js";
import {
  jobScratchDirForJob,
  writeJobScratchSentinelAsync,
} from "../../functions/execution/job-scratch.js";
import {
  logAttemptSkippedStaleLease as _logAttemptSkippedStaleLease,
} from "../../functions/execution/attempt-logging.js";

export class ProviderAttemptLifecycle {
  constructor(worker) {
    this.worker = worker;
  }

  async prepare({ job, leaseToken, wrappedJob } = {}) {
    const worker = this.worker;
    const role = worker._roleFor(job.job_type);
    const executionPayload = worker.parsePayload(job);
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
          worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before image-route readiness failure handling${C.reset}`);
          return { ok: false };
        }
        completeAttempt(routeAttempt.attempt.id, {
          status: "failed",
          error_text: errMsg,
        });
        await wrappedJob.setError(errMsg);
        worker._retryOrFail(job, leaseToken, errMsg);
        return { ok: false, currentAttemptId: routeAttempt.attempt.id };
      }
      const needsModelClear = isImageOnlyModelNameFromModule(job.model_name);
      if (needsModelClear) {
        updateJobProvider(job.id, job.provider || null, null);
        job.model_name = null;
      }
      worker.emit(job.id, `${C.cyan}[image]${C.reset} WI#${job.work_item_id} job #${job.id}: generate_image will use ${imageRoute.provider}/${imageRoute.model || "<settings>"} at tool-call time`);
      job._imageRoute = { provider: imageRoute.provider, model: imageRoute.model || null };
    }
    const configuredProviderPool = getAvailableProviders(role);
    const providerResolution = resolveExecutionProviderFromModule(job.provider || null, configuredProviderPool, role);
    let executionProvider = providerResolution.provider;
    if (worker._isProviderCircuitOpen(executionProvider)) {
      const circuitFallback = worker._selectHealthyProviderFromPool(configuredProviderPool, executionProvider);
      if (circuitFallback) {
        worker.emit(job.id, `${C.yellow}[circuit]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} is circuit-open this run; routing to ${circuitFallback}`);
        executionProvider = circuitFallback;
        if (job.provider !== executionProvider || job.model_name) {
          updateJobProvider(job.id, executionProvider, null);
          job.provider = executionProvider;
          job.model_name = null;
        }
      }
    }
    if (providerResolution.ignoredPinnedProvider && job.provider && job.provider !== executionProvider) {
      worker.emit(job.id, `${C.yellow}[provider]${C.reset} WI#${job.work_item_id} job #${job.id}: ignoring pinned provider ${job.provider} because it is not enabled for role ${role}; using ${executionProvider}`);
      job.provider = executionProvider;
      updateJobProvider(job.id, executionProvider, null);
      job.model_name = null;
    }
    const providerReadiness = isProviderReady(executionProvider);
    if (!providerReadiness.ready) {
      const readinessFallback = worker._selectHealthyProviderFromPool(configuredProviderPool, executionProvider);
      if (readinessFallback) {
        worker.emit(job.id, `${C.yellow}[provider]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} unavailable (${providerReadiness.reason || "not ready"}); routing to ${readinessFallback}`);
        executionProvider = readinessFallback;
        job.provider = executionProvider;
        job.model_name = null;
        updateJobProvider(job.id, executionProvider, null);
      } else {
        const errMsg = `Provider auth liveness failed for ${executionProvider}: ${providerReadiness.reason || "provider not ready"}`;
        const livenessAttempt = incrementAndCreateAttempt(job.id, leaseToken, role, null, job.reasoning_effort);
        if (!livenessAttempt) {
          _logAttemptSkippedStaleLease(job, role, "Skipped provider-auth liveness failure because the lease was stale or expired");
          worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before provider-auth liveness handling${C.reset}`);
          return { ok: false };
        }
        completeAttempt(livenessAttempt.attempt.id, {
          status: "failed",
          error_text: errMsg,
        });
        await wrappedJob.setError(errMsg);
        worker._retryOrFail(job, leaseToken, errMsg);
        return { ok: false, currentAttemptId: livenessAttempt.attempt.id };
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
      worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before execution${C.reset}`);
      return { ok: false };
    }

    const { attemptCount, attempt } = result;

    // Recalculate tier if attempt drifted (provider already resolved above with job.provider).
    if (attemptCount > prelimCount && !researchRetrySynthesisTier) {
      effectiveTier = provider.escalateTier(job.model_tier, attemptCount, { resolveModel: resolveTierModel });
    }

    if (researchRetrySynthesisTier && effectiveTier !== job.model_tier) {
      worker.emit(job.id, `${C.yellow}[research-retry] WI#${job.work_item_id} job #${job.id}: pinned retry synthesis to ${effectiveTier} tier (attempt ${attemptCount})${C.reset}`);
      if (worker.display) worker.display.updateWorkerTier(job.id, effectiveTier, attemptCount, job.provider || null, modelName);
    } else if (effectiveTier !== job.model_tier) {
      worker.emit(job.id, `${C.yellow}[escalation] WI#${job.work_item_id} job #${job.id}: ${job.model_tier} -> ${effectiveTier} (attempt ${attemptCount})${C.reset}`);
      if (worker.display) worker.display.updateWorkerTier(job.id, effectiveTier, attemptCount, job.provider || null, modelName);
    }

    // Per-job scratch directory.
    const runtimeRoot = getRuntimeRoot(worker.projectDir, worker.projectDir);
    const jobDir = jobScratchDirForJob(job.id, { projectDir: worker.projectDir, runtimeRoot });
    await fs.promises.mkdir(jobDir, { recursive: true });
    await writeJobScratchSentinelAsync(jobDir, { projectDir: worker.projectDir, runtimeRoot });
    job._jobDir = jobDir;

    return {
      ok: true,
      role,
      executionPayload,
      imageRoute,
      configuredProviderPool,
      providerResolution,
      executionProvider,
      provider,
      resolveTierModel,
      researchRetrySynthesisTier,
      prelimCount,
      effectiveTier,
      modelName,
      attemptCount,
      attempt,
      currentAttemptId: attempt.id,
      startTime: Date.now(),
    };
  }
}
