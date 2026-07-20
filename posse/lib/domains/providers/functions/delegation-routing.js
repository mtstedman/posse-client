// lib/domains/providers/functions/delegation-routing.js
//
// Shared delegation and provider-assignment helpers used by the worker's
// delegate lane and deterministic provider routing.

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getJob, getSetting } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { getAvailableProviders, getProviderCapacityState } from "./provider.js";
import { delegationRoleForJobType as resolveDelegationRoleForJobType } from "./roles.js";
import { needsImageGeneration, shouldPreservePinnedProvider } from "./execution-routing.js";

export function delegationRoleForJobType(jobType) {
  return resolveDelegationRoleForJobType(jobType);
}

export function delegationPriorityForJobType(jobType) {
  switch (jobType) {
    case "assess": return 0;
    case "research": return 1;
    case "plan": return 2;
    case "dev":
    case "fix":
    case "artificer":
      return 3;
    default:
      return 9;
  }
}

export function getDelegationMode() {
  const raw = String(getSetting(SETTING_KEYS.DELEGATION_MODE) || "js").trim().toLowerCase();
  return raw === "ml" ? "ml" : "js";
}

export function jobNeedsMlDelegation(job) {
  if (!job || job.provider) return false;
  const role = delegationRoleForJobType(job.job_type);
  return getAvailableProviders(role).length > 1;
}

export function buildDeterministicDelegations(pendingJobs = [], {
  providerMap = {},
  getJobById = getJob,
  getProviderCapacity = (providerName, opts = {}) => getProviderCapacityState(providerName, opts),
  nowMs = Date.now(),
} = {}) {
  if (!Array.isArray(pendingJobs) || pendingJobs.length === 0) return null;

  const assignments = [];
  const roleProviderCursor = new Map();
  const sortedPendingJobs = [...pendingJobs].sort((a, b) => {
    const aJob = a?.job_id ? getJobById(a.job_id) : null;
    const bJob = b?.job_id ? getJobById(b.job_id) : null;
    const priDiff = delegationPriorityForJobType(aJob?.job_type) - delegationPriorityForJobType(bJob?.job_type);
    if (priDiff !== 0) return priDiff;
    return (aJob?.id || 0) - (bJob?.id || 0);
  });

  for (const pending of sortedPendingJobs) {
    if (!pending?.job_id) continue;
    const targetJob = getJobById(pending.job_id);
    if (!targetJob) continue;

    const role = delegationRoleForJobType(targetJob.job_type);
    const allowedProviders = Array.isArray(providerMap[role]) ? providerMap[role] : getAvailableProviders(role);
    if (!Array.isArray(allowedProviders) || allowedProviders.length === 0) continue;
    const targetPayload = parseJobPayload(targetJob);
    const targetNeedsImageGeneration = role === "artificer" && needsImageGeneration(targetPayload);

    const capacityOpts = { nowMs };

    const pinnedImageProviderBlocked = targetNeedsImageGeneration
      && targetJob.provider === "codex"
      && allowedProviders.some((providerName) => providerName !== "codex");
    if (!pinnedImageProviderBlocked && shouldPreservePinnedProvider(targetJob, role, allowedProviders)) {
      assignments.push({
        job_id: targetJob.id,
        provider: targetJob.provider,
        model: targetJob.model_name || null,
        model_tier: pending.model_tier || targetJob.model_tier || null,
        reasoning_effort: pending.reasoning_effort || targetJob.reasoning_effort || null,
        priority: pending.priority || targetJob.priority || null,
        reason: `Planner-pinned provider preserved (${targetJob.provider})`,
      });
      continue;
    }

    const capacityAvailableProviders = allowedProviders.filter((providerName) => {
      const state = getProviderCapacity(providerName, capacityOpts);
      return !state.blocked || state.source === "readiness";
    });
    const availableProviders = targetNeedsImageGeneration
      ? (capacityAvailableProviders.filter((providerName) => providerName !== "codex").length > 0
          ? capacityAvailableProviders.filter((providerName) => providerName !== "codex")
          : capacityAvailableProviders)
      : capacityAvailableProviders;

    if (availableProviders.length === 0) {
      const fallbackProvider = allowedProviders[0];
      assignments.push({
        job_id: targetJob.id,
        provider: fallbackProvider,
        model: null,
        model_tier: pending.model_tier || targetJob.model_tier || null,
        reasoning_effort: pending.reasoning_effort || targetJob.reasoning_effort || null,
        priority: pending.priority || targetJob.priority || null,
        reason: `All ${role} providers appear blocked; assigning ${fallbackProvider} to avoid stale pin`,
      });
      continue;
    }

    if (availableProviders.length === 1) {
      assignments.push({
        job_id: targetJob.id,
        provider: availableProviders[0],
        model: null,
        model_tier: pending.model_tier || targetJob.model_tier || null,
        reasoning_effort: pending.reasoning_effort || targetJob.reasoning_effort || null,
        priority: pending.priority || targetJob.priority || null,
        reason: `Single available ${role} provider (${availableProviders[0]})`,
      });
      continue;
    }

    const cursorKey = `${role}:${availableProviders.join(",")}`;
    const cursor = roleProviderCursor.get(cursorKey) || 0;
    const selectedProvider = availableProviders[cursor % availableProviders.length];
    roleProviderCursor.set(cursorKey, cursor + 1);

    assignments.push({
      job_id: targetJob.id,
      provider: selectedProvider,
      model: null,
      model_tier: pending.model_tier || targetJob.model_tier || null,
      reasoning_effort: pending.reasoning_effort || targetJob.reasoning_effort || null,
      priority: pending.priority || targetJob.priority || null,
      reason: `Deterministic ${role} split: round-robin selected ${selectedProvider} (${(cursor % availableProviders.length) + 1}/${availableProviders.length} available)`,
    });
  }

  return assignments.length > 0 ? assignments : null;
}

export function selectFallbackProvider(allProviders = [], providerName, needsImageGeneration = false) {
  const fallbackProviders = Array.isArray(allProviders) ? allProviders : [];
  // The configured pool is an authorization boundary. Do not invent Claude
  // when an operator or experiment explicitly pins a role to one provider.
  return fallbackProviders.find((p) => p !== providerName)
    || null;
}
