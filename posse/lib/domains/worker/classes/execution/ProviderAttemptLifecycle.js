import fs from "fs";
import { jobProviderPool } from "../../../providers/functions/job-provider-pool.js";
import {
  completeAttempt,
  getAttempts,
  incrementAndCreateAttempt,
  setAttemptModelName,
  updateJobProvider,
} from "../../../queue/functions/index.js";
import {
  getProvider,
  isProviderReady,
  tierModelName,
} from "../../../providers/functions/provider.js";
import {
  effectiveArtifactTaskMode as effectiveArtifactTaskModeFromModule,
  isImageOnlyModelName as isImageOnlyModelNameFromModule,
  NO_IMAGE_PROVIDERS_AVAILABLE,
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

  async prepare({ job, leaseToken, wrappedJob, onAttemptCreated } = {}) {
    const worker = this.worker;
    const role = worker._roleFor(job.job_type);
    const executionPayload = worker.parsePayload(job);
    const shouldValidateImageRoute = MUTATING_JOB_TYPES.has(job.job_type)
      && effectiveArtifactTaskModeFromModule(job, executionPayload) !== "code"
      && !!executionPayload.needs_image_generation;
    const imageRoute = shouldValidateImageRoute
      ? resolveImageExecutionProviderFromModule(executionPayload)
      : { provider: null, model: null, readiness: { ready: true, reason: null } };
    if (shouldValidateImageRoute) {
      if (!imageRoute.readiness.ready) {
        const errMsg = imageRoute.readiness.reason || NO_IMAGE_PROVIDERS_AVAILABLE;
        const routeAttempt = incrementAndCreateAttempt(job.id, leaseToken, role, null, job.reasoning_effort);
        if (!routeAttempt) {
          _logAttemptSkippedStaleLease(job, role, "Skipped image-route readiness failure because the lease was stale or expired");
          worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before image-route readiness failure handling${C.reset}`);
          return { ok: false };
        }
        onAttemptCreated?.(routeAttempt.attempt.id);
        completeAttempt(routeAttempt.attempt.id, {
          status: "failed",
          error_text: errMsg,
        });
        await wrappedJob.setError(errMsg);
        worker._retryOrFail(job, leaseToken, errMsg, { attemptId: routeAttempt.attempt.id });
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
    const { providers: executionProviderPool, explicitRecoveryProvider, configuredProviderPool } = jobProviderPool(job, role, executionPayload);
    const providerResolution = resolveExecutionProviderFromModule(job.provider || null, executionProviderPool, role);
    let executionProvider = providerResolution.provider;
    if (worker._isProviderCircuitOpen(executionProvider)) {
      const circuitFallback = worker._selectHealthyProviderFromPool(executionProviderPool, executionProvider);
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
      const readinessFallback = worker._selectHealthyProviderFromPool(executionProviderPool, executionProvider);
      if (readinessFallback) {
        worker.emit(job.id, `${C.yellow}[provider]${C.reset} WI#${job.work_item_id} job #${job.id}: ${executionProvider} unavailable (${providerReadiness.reason || "not ready"}); routing to ${readinessFallback}`);
        executionProvider = readinessFallback;
        job.provider = executionProvider;
        job.model_name = null;
        updateJobProvider(job.id, executionProvider, null);
      } else {
        const errMsg = `Provider environment check failed for ${executionProvider}: ${providerReadiness.reason || "provider not ready"}. Work remains queued; repair the provider and run posse go.`;
        // Readiness is an environment condition, not a model attempt. This
        // guard also covers a provider disappearing after startup or new work
        // injected into the running scheduler.
        if (!worker._releaseWithoutAttemptPenalty(job, leaseToken, "queued", { readyAt: new Date().toISOString() })) {
          return { ok: false };
        }
        await wrappedJob.setError(errMsg);
        worker.emit(job.id, `${C.red}[environment]${C.reset} ${errMsg}`);
        worker.onProviderUnavailable?.(new Error(errMsg));
        return { ok: false };
      }
    }
    job._executionProvider = executionProvider;
    job._allowedProviders = [...new Set((executionProviderPool || []).filter(Boolean))];
    job._explicitRecoveryProvider = explicitRecoveryProvider;

    const provider = getProvider(role, executionProvider || undefined);
    const resolveTierModel = (tier) => tierModelName(tier, { role, providerName: executionProvider || undefined });
    const preserveExecutionProfile = executionPayload?._preserve_execution_profile_on_retry === true;
    const researchRetrySynthesisTier = job.job_type === "research"
      && executionPayload?._research_retry_synthesis === true
      && !preserveExecutionProfile
      ? "cheap"
      : null;
    const cappedExecutionRole = role === "dev" || role === "assessor";
    const baseModelTier = cappedExecutionRole && job.model_tier === "strong"
      ? "standard"
      : job.model_tier;

    const retryGeneration = Math.max(0, Number(executionPayload?._retry_generation) || 0);
    const countsTowardGeneration = (entry) => (
      ["implementation", "human"].includes(String(entry.attempt_kind || "implementation"))
      && Number(entry.attempt_number || 0) > retryGeneration
    );
    const priorGenerationAttempts = getAttempts(job.id).filter(countsTowardGeneration).length;
    const prelimCount = priorGenerationAttempts + 1;
    let effectiveTier = preserveExecutionProfile
      ? baseModelTier
      : (researchRetrySynthesisTier || provider.escalateTier(baseModelTier, prelimCount, { resolveModel: resolveTierModel }));
    let modelName = provider.resolveExecutionModelName(
      job.model_name || tierModelName(effectiveTier, { role, providerName: executionProvider || undefined }),
      { role, modelTier: effectiveTier },
    );

    const result = incrementAndCreateAttempt(job.id, leaseToken, role, modelName, job.reasoning_effort);
    if (!result) {
      _logAttemptSkippedStaleLease(job, role, "Skipped provider attempt because the lease was stale or expired");
      worker.emit(job.id, `${C.red}[stale-lease] WI#${job.work_item_id} job #${job.id} — lease lost before execution${C.reset}`);
      return { ok: false };
    }

    const { attemptCount, attempt } = result;
    onAttemptCreated?.(attempt.id);
    // The only row added since the count above is the attempt just created,
    // so the drift check reads it instead of re-querying the table.
    const effectiveAttemptCount = priorGenerationAttempts + (countsTowardGeneration(attempt) ? 1 : 0);

    // Recalculate tier if attempt drifted (provider already resolved above with job.provider).
    if (effectiveAttemptCount !== prelimCount && !researchRetrySynthesisTier && !preserveExecutionProfile) {
      effectiveTier = provider.escalateTier(baseModelTier, effectiveAttemptCount, { resolveModel: resolveTierModel });
      const driftedModelName = provider.resolveExecutionModelName(
        job.model_name || resolveTierModel(effectiveTier),
        { role, modelTier: effectiveTier },
      );
      if (driftedModelName !== modelName) {
        modelName = driftedModelName;
        setAttemptModelName(attempt.id, modelName);
        attempt.model_name = modelName;
      }
    }
    job._executionModelName = modelName;

    if (baseModelTier !== job.model_tier) {
      worker.emit(job.id, `${C.yellow}[tier-policy] WI#${job.work_item_id} job #${job.id}: ${role} tier capped ${job.model_tier} -> ${baseModelTier}${C.reset}`);
    } else if (researchRetrySynthesisTier && effectiveTier !== job.model_tier) {
      worker.emit(job.id, `${C.yellow}[research-retry] WI#${job.work_item_id} job #${job.id}: pinned retry synthesis to ${effectiveTier} tier (generation attempt ${effectiveAttemptCount})${C.reset}`);
    } else if (effectiveTier !== job.model_tier) {
      worker.emit(job.id, `${C.yellow}[escalation] WI#${job.work_item_id} job #${job.id}: ${job.model_tier} -> ${effectiveTier} (generation attempt ${effectiveAttemptCount})${C.reset}`);
    }
    if (worker.display) {
      worker.display.updateWorkerTier(job.id, effectiveTier, effectiveAttemptCount, executionProvider || null, modelName);
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
