import { PROVIDER_ROLE_NAMES } from "../../../catalog/provider.js";
import { ASSESSABLE_JOB_TYPES, MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { isProviderReady } from "../../providers/functions/provider.js";
import { jobProviderPool } from "../../providers/functions/job-provider-pool.js";
import { providerRoleForJobType } from "../../providers/functions/roles.js";
import { parseJobPayload } from "../../queue/functions/payload.js";

// Check the providers required by queued work, including configured fallbacks.
// Optional image providers and deterministic/human jobs cannot block a run.
export function providerEnvironmentProbe(jobs, { dryRun = false } = {}) {
  const failures = [];
  const readiness = new Map();
  for (const job of jobs) {
    if (dryRun && MUTATING_JOB_TYPES.has(job.job_type)) continue;
    const payload = parseJobPayload(job);
    const role = job.status === "awaiting_assessment" || (payload?._assess_only && ASSESSABLE_JOB_TYPES.has(job.job_type))
      ? "assessor" : providerRoleForJobType(job.job_type);
    if (!PROVIDER_ROLE_NAMES.includes(role)) continue;
    const { providers } = jobProviderPool(job, role, payload);
    const candidates = providers.map((provider) => {
      if (!readiness.has(provider)) readiness.set(provider, isProviderReady(provider));
      return { provider, ...readiness.get(provider) };
    });
    if (candidates.some((candidate) => candidate.ready)) continue;
    failures.push({ job_id: job.id, role, providers: candidates });
  }
  return { ok: failures.length === 0, failures };
}

export function formatProviderEnvironmentFailure(probe) {
  const details = [...new Set(probe.failures.map(({ role, providers }) =>
    `${role}: ${providers.map(({ provider, reason }) => `${provider}: ${reason || "not ready"}`).join("; ") || "no configured provider"}`))];
  return `Provider environment check failed — ${details.join("; ")}. Work remains queued; repair the provider installation or credentials, or configure an available provider, then run posse go.`;
}
