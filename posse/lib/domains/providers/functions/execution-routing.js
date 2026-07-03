// lib/domains/providers/functions/execution-routing.js
//
// Shared execution-routing helpers for provider/model selection and
// role-specific execution hint sanitization.

import { getProviderName, nextProviderSelectionCursor, selectProviderName, isProviderReady } from "./provider.js";
import { getConfiguredImageProviders, getConfiguredImageModel, isArtifactMode } from "../../artifacts/functions/index.js";

export const NO_IMAGE_PROVIDERS_AVAILABLE = "No image providers available";

export function needsImageGeneration(payload = null) {
  const taskMode = payload?.task_mode || "code";
  return !!(payload?.needs_image_generation || taskMode === "image");
}

export function sanitizeExecutionHintsForRole(role, opts = {}) {
  if (role !== "dev") return opts;
  if (!opts?.needsImageGeneration) return opts;
  return { ...opts, needsImageGeneration: false };
}

export function effectiveArtifactTaskMode(job, payload = null) {
  const taskMode = payload?.task_mode || (job?.job_type === "artificer" ? "content" : "code");
  if (taskMode === "content" && needsImageGeneration(payload)) return "image";
  return taskMode;
}

export function isImageOnlyModelName(modelName = null) {
  const value = String(modelName || "").trim().toLowerCase();
  if (!value) return false;
  const normalizedGrokImage = value.replace(
    /^(grok-imagine-image(?:-(?:quality(?:-(?:latest|\d{8}))?|pro|\d{4}-\d{2}-\d{2}))?)(?:-image)+$/,
    "$1",
  );
  return /^(grok-imagine-image(?:-(?:quality|pro|quality-latest|quality-\d{8}|\d{4}-\d{2}-\d{2}))?|gpt-image(?:-\d+(?:\.\d+)?)?|dall-e-\d+)$/i.test(normalizedGrokImage);
}

export function resolvePrimaryExecutionModelName(jobModelName, opts, tierConfig) {
  // Image-only model names (e.g. grok-imagine-image, gpt-image-1) can never
  // drive a chat call. If one is present in job.model_name (legacy data, a
  // delegator hallucination, or a stale row) fall back to the tier text model
  // for every role — including assessor/fix/summary, which previously crashed
  // with "model not found" because their roles were not in the allowlist.
  if (isImageOnlyModelName(jobModelName)) {
    return tierConfig?.model || null;
  }
  return jobModelName || tierConfig?.model || null;
}

export function resolveExecutionProviderFromSettings(jobProvider, configuredProviderPool, role) {
  const pool = Array.isArray(configuredProviderPool)
    ? [...new Set(configuredProviderPool.filter(Boolean))]
    : [];
  if (jobProvider && pool.includes(jobProvider)) {
    return { provider: jobProvider, honoredPinnedProvider: true, ignoredPinnedProvider: false };
  }
  if (pool.length <= 1) {
    return {
      provider: pool[0] || getProviderName(role),
      honoredPinnedProvider: false,
      ignoredPinnedProvider: !!jobProvider && pool.length > 0,
    };
  }
  const selected = selectProviderName(role);
  return {
    provider: pool.includes(selected) ? selected : (pool[0] || selected || getProviderName(role)),
    honoredPinnedProvider: false,
    ignoredPinnedProvider: !!jobProvider,
  };
}

export function shouldPreservePinnedProvider(targetJob, role, allowedProviders, targetPayload, imageRoute) {
  const provider = targetJob?.provider || null;
  if (!provider) return false;
  const pool = Array.isArray(allowedProviders) ? allowedProviders : [];
  if (!pool.includes(provider)) return false;
  return true;
}

export function requiresGitNoopCheck(job, payload = null) {
  if (!(job?.job_type === "dev" || job?.job_type === "fix")) return false;
  const taskMode = effectiveArtifactTaskMode(job, payload);
  // DB-only jobs mutate the project database, not the worktree — a zero-diff
  // COMPLETE is their normal success shape, so the git no-op guard must not
  // treat it as a failed attempt.
  if (taskMode === "db") return false;
  return !isArtifactMode(taskMode);
}

export function resolveImageExecutionProvider(payload = null) {
  if (!needsImageGeneration(payload)) return { provider: null, model: null, readiness: { ready: true, reason: null } };
  const providers = getConfiguredImageProviders();
  const readinessByProvider = new Map(providers.map((provider) => [provider, isProviderReady(provider, "images")]));
  const readyProviders = providers.filter((provider) => readinessByProvider.get(provider)?.ready);
  if (readyProviders.length === 0) {
    return {
      provider: null,
      model: null,
      readiness: {
        ready: false,
        reason: NO_IMAGE_PROVIDERS_AVAILABLE,
        providers,
        failures: providers.map((provider) => ({
          provider,
          reason: readinessByProvider.get(provider)?.reason || null,
        })),
      },
    };
  }
  const pool = readyProviders;
  const cursor = nextProviderSelectionCursor("images");
  const provider = pool[cursor % pool.length];
  return { provider, model: getConfiguredImageModel(provider), readiness: readinessByProvider.get(provider) };
}
