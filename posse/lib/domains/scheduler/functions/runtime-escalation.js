// The runtime watchdog kills a job so its next attempt runs on a stronger
// model (attempt N+1 escalates the tier). When the next attempt would run the
// same model (already on the top tier, a pinned model name, or a preserved
// execution profile), the kill only discards the agent's context and spends an
// attempt. Live 2026-10-01: a Fable catalog job was killed at 1200s "for model
// escalation" and restarted on Fable. Such jobs keep running to a backstop.

import { ASSESSABLE_JOB_TYPES } from "../../../catalog/job.js";
import { escalateModelTier } from "../../providers/functions/shared/turns.js";
import { tierModelName } from "../../providers/functions/provider.js";
import { providerRoleForJobType } from "../../providers/functions/roles.js";
import { getDefaultModelTierForRole } from "../../settings/functions/repository-settings.js";

// A job with no escalation left is killed only past this multiple of its
// runtime cap, so a runaway worker still frees its compute slot.
export const RUNTIME_NO_ESCALATION_BACKSTOP_MULTIPLIER = 3;

// Job types whose attempts run a tiered model. Every other job type (promote,
// atlas_warm, human_input, ...) is killed for runtime purely as stuck work.
const MODEL_TIER_ROLES = new Set(["researcher", "planner", "dev", "assessor", "artificer"]);

function jobPayload(job) {
  const raw = job?.payload_json;
  if (raw && typeof raw === "object") return raw;
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function defaultTierModelResolver(job, role) {
  const providerName = job?.provider || undefined;
  return (tier) => tierModelName(tier, { role, providerName });
}

function isAssessOnlyPayload(payload) {
  const flag = payload?._assess_only;
  return flag === true || flag === 1 || flag === "1";
}

function defaultAssessorTier() {
  try {
    return getDefaultModelTierForRole("assessor") || "standard";
  } catch {
    return "standard";
  }
}

/**
 * True when killing the running attempt for runtime would rerun the job on a
 * different model. Mirrors the attempt lifecycle: attempt N runs
 * escalateModelTier(model_tier, N), and a runtime kill consumes attempt N.
 *
 * An assess-only phase (a dev/fix/artificer job re-leased only for its
 * assessment) runs the assessor role on payload `_assess_model_tier`,
 * escalated by the assessment attempt count, so job.model_tier and
 * job.model_name do not apply. The worker clears `_assess_only` once the
 * assessment starts, so pass the lease-time row as `leasedJob`.
 */
export function runtimeKillCanEscalate(job, { resolveModel = null, leasedJob = null } = {}) {
  if (!job) return true;
  const payload = jobPayload(job);
  const leasedPayload = leasedJob ? jobPayload(leasedJob) : null;
  const assessOnly = ASSESSABLE_JOB_TYPES.has(job.job_type)
    && (isAssessOnlyPayload(payload) || isAssessOnlyPayload(leasedPayload));
  const role = assessOnly ? "assessor" : providerRoleForJobType(job.job_type);
  if (!MODEL_TIER_ROLES.has(role)) return true;

  let baseTier;
  let attempt;
  let resolve;
  if (assessOnly) {
    const assessTier = payload?._assess_model_tier || leasedPayload?._assess_model_tier;
    baseTier = typeof assessTier === "string" && assessTier.trim() ? assessTier.trim() : defaultAssessorTier();
    attempt = Math.max(1, Number(job.assessment_attempt_count) || 0);
    resolve = resolveModel || ((tier) => tierModelName(tier, { role }));
  } else {
    if (String(job.model_name || "").trim()) return false;
    if (payload?._preserve_execution_profile_on_retry === true) return false;
    // Research retry synthesis pins every attempt to the cheap tier
    // (ProviderAttemptLifecycle), so a kill reruns the same model.
    if (job.job_type === "research" && payload?._research_retry_synthesis === true) return false;
    baseTier = job.model_tier || "standard";
    attempt = Math.max(1, Number(job.attempt_count) || 0);
    resolve = resolveModel || defaultTierModelResolver(job, role);
  }
  let currentTier;
  let nextTier;
  try {
    currentTier = escalateModelTier(baseTier, attempt, { resolveModel: resolve });
    nextTier = escalateModelTier(baseTier, attempt + 1, { resolveModel: resolve });
  } catch {
    currentTier = escalateModelTier(baseTier, attempt);
    nextTier = escalateModelTier(baseTier, attempt + 1);
  }
  if (currentTier === nextTier) return false;
  try {
    return (resolve(currentTier) ?? "") !== (resolve(nextTier) ?? "");
  } catch {
    return true;
  }
}

/**
 * Whether recent write activity keeps an escalatable job alive past its
 * runtime cap. The job must have written a file within `graceSec`, and its
 * runtime must stay inside the hard ceiling (`limitSec * ceilingMultiplier`),
 * so a worker that is finishing its edits is not killed seconds before the
 * end while a looping one still dies.
 */
export function runtimeWriteExtensionActive({
  runtimeSec,
  limitSec,
  nowMs,
  lastWriteAtMs,
  graceSec,
  ceilingMultiplier,
}) {
  if (!(graceSec > 0) || !(ceilingMultiplier > 1)) return false;
  if (lastWriteAtMs == null || !Number.isFinite(lastWriteAtMs)) return false;
  if (!(runtimeSec <= limitSec * ceilingMultiplier)) return false;
  return nowMs - lastWriteAtMs <= graceSec * 1000;
}
