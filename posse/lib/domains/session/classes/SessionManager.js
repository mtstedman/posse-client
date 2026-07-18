import {
  acquireSessionHandle,
  advanceSessionHandle,
  ensureSessionLane,
  getActiveSessionLane,
  invalidateSessionLane,
  invalidateSessionLanesForWorkItem,
  markSessionExpired,
  recordInitialSessionHandle,
  recordSessionRecycleSavings,
  releaseSessionHandle,
  renewSessionHandleLease,
} from "../../queue/functions/sessions.js";
import { deriveSessionKey, isRecyclableLane } from "../functions/keys.js";
import {
  normalizeRecycleMode,
  providerCoverageForReuse,
  transitionAllowsRecycling,
} from "../functions/eligibility.js";
import { skillRecyclePolicyForJob } from "../functions/skill-policy.js";
import { isSessionResumeCapableProvider } from "../../providers/functions/provider.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getSetting } from "../../queue/functions/settings.js";

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function getJobRow(jobId) {
  if (jobId == null) return null;
  return getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(Number(jobId)) || null;
}

function sessionStrictProviderLockEnabled() {
  try {
    const value = String(getSetting(SETTING_KEYS.SESSION_RECYCLE_STRICT_PROVIDER) || "true").trim().toLowerCase();
    return !["0", "false", "off", "no"].includes(value);
  } catch {
    return true;
  }
}

export class SessionManager {
  constructor({
    recycleMode = "off",
    providerMap = {},
    requiredRoles = null,
    sessionResumeCapableProviders = null,
    capabilityResolver = isSessionResumeCapableProvider,
    skillPolicyResolver = skillRecyclePolicyForJob,
  } = {}) {
    this.recycleMode = normalizeRecycleMode(recycleMode);
    this.providerMap = providerMap || {};
    this.requiredRoles = requiredRoles;
    this.sessionResumeCapableProviders = Array.isArray(sessionResumeCapableProviders)
      ? new Set(sessionResumeCapableProviders.map(normalizeProvider).filter(Boolean))
      : null;
    this.capabilityResolver = typeof capabilityResolver === "function" ? capabilityResolver : null;
    this.skillPolicyResolver = typeof skillPolicyResolver === "function" ? skillPolicyResolver : null;
  }

  keyForJob(job, opts = {}) {
    return deriveSessionKey(job, opts);
  }

  providerCoverage(providerName, opts = {}) {
    return providerCoverageForReuse({
      providerName,
      providerMap: opts.providerMap || this.providerMap,
      mode: opts.recycleMode || this.recycleMode,
      requiredRoles: opts.requiredRoles || this.requiredRoles,
    });
  }

  providerHasResumeCapability(providerName) {
    const provider = normalizeProvider(providerName);
    if (!provider) return false;
    if (this.sessionResumeCapableProviders) return this.sessionResumeCapableProviders.has(provider);
    if (this.capabilityResolver) return Boolean(this.capabilityResolver(provider));
    return true;
  }

  canRecycleJob(job, { provider = null } = {}) {
    if (this.recycleMode === "off") {
      return { ok: false, reason: "disabled" };
    }
    const key = this.keyForJob(job, { provider });
    if (!isRecyclableLane(key.lane)) {
      return { ok: false, reason: "non_recyclable_lane", key };
    }
    const skillPolicy = this.skillPolicyResolver
      ? this.skillPolicyResolver(job)
      : { ok: true };
    if (!skillPolicy.ok) {
      return { ok: false, reason: "skill_recycle_not_allowed", key, skillPolicy };
    }
    const activeLane = getActiveSessionLane({
      workItemId: key.workItemId,
      lane: key.lane,
      skillKey: key.skillKey,
    });
    const effectiveProvider = normalizeProvider(activeLane?.provider || key.provider);
    const providerLocked = Boolean(activeLane && normalizeProvider(activeLane.provider) !== key.provider);
    if (providerLocked && sessionStrictProviderLockEnabled()) {
      return {
        ok: true,
        key: { ...key, provider: effectiveProvider },
        requestedProvider: key.provider,
        activeLane,
        providerLocked,
        coverage: this.providerCoverage(key.provider),
        skillPolicy,
      };
    }
    if (!this.providerHasResumeCapability(effectiveProvider)) {
      return {
        ok: false,
        reason: "provider_capability_gap",
        key: { ...key, provider: effectiveProvider },
        activeLane: activeLane || null,
      };
    }
    const coverage = this.providerCoverage(effectiveProvider);
    if (!coverage.ok) {
      return {
        ok: false,
        reason: "provider_coverage_gap",
        key: { ...key, provider: effectiveProvider },
        activeLane: activeLane || null,
        coverage,
      };
    }
    return {
      ok: true,
      key: { ...key, provider: effectiveProvider },
      requestedProvider: key.provider,
      activeLane: activeLane || null,
      providerLocked,
      coverage,
      skillPolicy,
    };
  }

  ensureLaneForJob(job, { provider = null, lockReason = "session_recycle" } = {}) {
    const key = this.keyForJob(job, { provider });
    const result = ensureSessionLane({
      workItemId: key.workItemId,
      lane: key.lane,
      provider: key.provider,
      skillKey: key.skillKey,
      lockReason,
    });
    return { ...result, key: { ...key, provider: result.lockedProvider || key.provider } };
  }

  acquireForJob(job, {
    provider = null,
    jobId = job?.id,
    leaseTtlSec = undefined,
    lockReason = "session_recycle",
  } = {}) {
    const eligibility = this.canRecycleJob(job, { provider });
    if (!eligibility.ok) {
      return {
        recyclingMode: "fresh",
        reason: eligibility.reason,
        key: eligibility.key || this.keyForJob(job, { provider }),
        coverage: eligibility.coverage || null,
        skillPolicy: eligibility.skillPolicy || null,
      };
    }

    if (eligibility.providerLocked && sessionStrictProviderLockEnabled()) {
      const requestedProvider = eligibility.requestedProvider || normalizeProvider(provider || job?.provider);
      invalidateSessionLane(eligibility.activeLane.id, "provider_switch");
      if (!this.providerHasResumeCapability(requestedProvider)) {
        return {
          recyclingMode: "fresh",
          reason: "provider_capability_gap",
          provider: requestedProvider,
          requestedProvider,
          providerLocked: false,
          lane: null,
          session: null,
          sessionHandle: null,
          key: { ...eligibility.key, provider: requestedProvider },
        };
      }
      const requestedCoverage = this.providerCoverage(requestedProvider);
      if (!requestedCoverage.ok) {
        return {
          recyclingMode: "fresh",
          reason: "provider_coverage_gap",
          provider: requestedProvider,
          requestedProvider,
          providerLocked: false,
          lane: null,
          session: null,
          sessionHandle: null,
          key: { ...eligibility.key, provider: requestedProvider },
          coverage: requestedCoverage,
        };
      }
      const resetLane = this.ensureLaneForJob(job, {
        provider: requestedProvider,
        lockReason: "session_recycle_provider_switch",
      });
      return {
        recyclingMode: "fresh",
        reason: "provider_switch_reset",
        provider: normalizeProvider(resetLane.lockedProvider || resetLane.key.provider),
        requestedProvider,
        providerLocked: false,
        lane: resetLane.lane,
        session: null,
        sessionHandle: null,
        key: resetLane.key,
      };
    }

    const laneResult = this.ensureLaneForJob(job, { provider: eligibility.key.provider, lockReason });
    const effectiveProvider = normalizeProvider(laneResult.lockedProvider || laneResult.key.provider);
    const session = acquireSessionHandle({
      laneId: laneResult.lane.id,
      jobId,
      leaseTtlSec,
    });

    if (session) {
      const previousJob = session.parent_job_id ? getJobRow(session.parent_job_id) : null;
      if (!previousJob || !transitionAllowsRecycling(previousJob.job_type, job?.job_type)) {
        releaseSessionHandle(session.id, session.leaseToken);
        invalidateSessionLane(laneResult.lane.id, "transition_not_allowed");
        const resetLane = this.ensureLaneForJob(job, {
          provider: effectiveProvider,
          lockReason: "session_recycle_transition_reset",
        });
        return {
          recyclingMode: "fresh",
          reason: "transition_reset",
          provider: effectiveProvider,
          requestedProvider: eligibility.requestedProvider || normalizeProvider(provider || job?.provider),
          providerLocked: Boolean(eligibility.providerLocked || resetLane.providerLocked),
          lane: resetLane.lane,
          session: null,
          sessionHandle: null,
          key: { ...resetLane.key, provider: effectiveProvider },
          transition: {
            from: previousJob?.job_type || null,
            to: job?.job_type || null,
          },
        };
      }
    }

    return {
      recyclingMode: session ? "resume" : "fresh",
      reason: session ? "session_acquired" : "no_available_session",
      provider: effectiveProvider,
      requestedProvider: eligibility.requestedProvider || normalizeProvider(provider || job?.provider),
      providerLocked: Boolean(eligibility.providerLocked || laneResult.providerLocked),
      lane: laneResult.lane,
      session,
      sessionHandle: session?.handle || null,
      key: { ...laneResult.key, provider: effectiveProvider },
    };
  }

  recordFreshHandleForJob(job, {
    provider = null,
    handle,
    parentJobId = job?.id,
    expiresAt = null,
    lastAgentCallId = null,
    lockReason = "session_recycle",
  } = {}) {
    const laneResult = this.ensureLaneForJob(job, { provider, lockReason });
    const session = recordInitialSessionHandle({
      laneId: laneResult.lane.id,
      handle,
      parentJobId,
      expiresAt,
      lastAgentCallId,
    });
    return { ...laneResult, session };
  }

  advanceSession({ sessionId, leaseToken, newHandle, jobId, expiresAt = null, lastAgentCallId = null } = {}) {
    return advanceSessionHandle({ sessionId, leaseToken, newHandle, jobId, expiresAt, lastAgentCallId });
  }

  releaseSession(sessionId, leaseToken) {
    return releaseSessionHandle(sessionId, leaseToken);
  }

  renewSession(sessionId, leaseToken, { jobId = null, leaseTtlSec = undefined } = {}) {
    return renewSessionHandleLease(sessionId, leaseToken, { jobId, leaseTtlSec });
  }

  invalidateLane(laneId, reason = "invalidated", opts = {}) {
    return invalidateSessionLane(laneId, reason, opts);
  }

  invalidateWorkItem(workItemId, reason = "work_item_reset", opts = {}) {
    return invalidateSessionLanesForWorkItem(workItemId, reason, opts);
  }

  markExpired(sessionId, reason = "expired") {
    return markSessionExpired(sessionId, reason);
  }

  recordSavings(data = {}) {
    return recordSessionRecycleSavings(data);
  }
}
