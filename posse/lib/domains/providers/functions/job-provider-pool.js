import { getJob } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { getAvailableProviders } from "./provider.js";

// Startup and execution must honor the same authenticated recovery override.
export function jobProviderPool(job, role, payload = parseJobPayload(job)) {
  const configuredProviderPool = getAvailableProviders(role);
  const recovery = payload?._dead_letter_recovery;
  const provider = String(recovery?.provider_override || "").trim().toLowerCase();
  const recoveryJobId = Number(recovery?.recovery_job_id);
  const gate = Number.isInteger(recoveryJobId) && recoveryJobId > 0 ? getJob(recoveryJobId) : null;
  const gatePayload = parseJobPayload(gate);
  const explicitRecoveryProvider = provider
    && provider === String(job.provider || "").trim().toLowerCase()
    && gate?.job_type === "human_input"
    && ["running", "succeeded"].includes(gate.status)
    && Number(gatePayload?.original_job_id) === Number(job.parent_job_id)
    && Array.isArray(gatePayload?.choices)
    && gatePayload.choices.includes(`retry:${provider}`)
    ? provider : null;
  return {
    providers: explicitRecoveryProvider ? [explicitRecoveryProvider] : configuredProviderPool,
    configuredProviderPool,
    explicitRecoveryProvider,
  };
}
