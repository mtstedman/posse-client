// lib/queue.js — SQLite DB layer for the orchestrator job queue
//
// All database operations organized by entity.
// Uses better-sqlite3 (synchronous) for simplicity and atomicity.

import { SETTING_KEYS } from "../../../catalog/settings.js";
import { MUTATING_JOB_TYPES } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { isShadowFanoutJob } from "../../research/functions/fanout-payload.js";
import { parseJobPayload } from "./payload.js";
import { isLeaseValid } from "./attempts.js";
import {
  ACTIVE_LEASE_STATUSES,
  ACTIVE_LEASE_STATUSES_SQL,
  DEADLOCK_TERMINAL_STATUSES_SQL,
  FAILED_JOB_STATUSES,
  LEASE_HOLDING_STATUSES,
  LEASE_HOLDING_STATUSES_SQL,
  TERMINAL_JOB_STATUSES,
  TERMINAL_JOB_STATUSES_SQL,
  TERMINAL_WORK_ITEM_STATUSES,
  isPushOfferJob,
  normalizeSkillsColumn,
  now,
  runImmediateTransaction,
} from "./common.js";
import { logEvent } from "./events.js";
import { getIntSetting, getSetting } from "./settings.js";
import { invalidateSessionLanesForWorkItem as invalidateSessionLanesForWorkItemInternal } from "./sessions.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { listUnresolvedActionableFailures } from "./failure-actionability.js";
import {
  releaseJobLocksForStatus,
  releaseWorkItemFileLocks,
  releaseWorkItemLocksForMergeState,
  releaseWorkItemLocksForStatus,
} from "./file-locks.js";
import {
  clearCrossWiMergeDependenciesForWorkItem,
  rollbackPendingCrossWiSyncHandoffsForJob,
} from "./cross-wi-deps.js";
import {
  __registerRequeueExpiredLeases,
  graceCutoff as _graceCutoff,
  leaseNowMs as _leaseNowMs,
  leaseRequeueGraceSec,
} from "./leases.js";
import { findDeadlockedJobs } from "./dependencies.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const TERMINAL_JOB_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const ACTIVE_LEASE_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);
const FAILED_JOB_STATUS_SET = new Set(FAILED_JOB_STATUSES);
const NON_COMPLETION_BLOCKING_JOB_TYPES = new Set(["atlas_warm"]);

function isActiveIterativeWorkItemRecord(wi) {
  if (!wi?.metadata_json) return false;
  try {
    const metadata = JSON.parse(wi.metadata_json);
    const iteration = metadata?.iteration && typeof metadata.iteration === "object"
      ? metadata.iteration
      : {};
    return !!(metadata?.iterate || metadata?.workflow_mode) && iteration.active !== false;
  } catch {
    return false;
  }
}

export {
  completeAttempt,
  getAttempts,
  getLatestAttempt,
  incrementAndCreateAttempt,
  setAttemptCommitHash,
  setAttemptSession,
} from "./attempts.js";

export { isLeaseValid };

// Public transaction wrapper for callers that need to make multiple queue
// writes atomic. Short-circuits when already inside a transaction so it can
// be safely nested. Keep raw DB access inside this module.
export function runInTransaction(fn) {
  const db = getDb();
  return db.inTransaction ? fn() : runImmediateTransaction(db, fn);
}

// Find fanout research children that started running but fell back to
// `queued` and have sat there past the supplied ISO cutoff. Only targets
// `queued` rows so an active worker holding the lease is never raced, and
// requires started_at so a never-leased child merely waiting out queue
// saturation is not falsely "timed out" (which would fabricate success and
// silently drop its research branch). Caller decides what to do with the
// rows (typically: mark succeeded with a synthetic artifact so the
// synthesis dep can resolve and the planner is not blocked indefinitely).
export function findStuckFanoutChildren(cutoffIso) {
  const db = getDb();
  return db.prepare(`
    SELECT id, work_item_id, payload_json, created_at, title
    FROM jobs
    WHERE job_type = 'research'
      AND status = 'queued'
      AND started_at IS NOT NULL
      AND started_at < ?
      AND payload_json IS NOT NULL
      AND json_valid(payload_json) = 1
      AND json_extract(payload_json, '$.role_mode') = 'child'
      AND json_extract(payload_json, '$.fanout_run_id') IS NOT NULL
  `).all(cutoffIso);
}

export {
  getArtifact,
  getArtifacts,
  getArtifactsByWorkItem,
  storeArtifact,
} from "./artifacts.js";

export {
  _discardPendingEventsForTests,
  countEventsByType,
  flushEventsNow,
  getEvents,
  getEventsByWorkItem,
  getEventsByWorkItemSinceId,
  getEventsSinceId,
  getHeadEventId,
  logAgentActivity,
  logEvent,
} from "./events.js";

export {
  getRecentJobsByFiles,
  getRecentWorkItemSummaries,
} from "./history.js";

export {
  claimInsightPromotion,
  getInsightById,
  getInsights,
  getInsightsByWorkItem,
  getPendingInsightPromotions,
  hasPromotedInsightMemories,
  isCannedInsightAction,
  storeInsight,
  updateInsightPromotion,
} from "./insights.js";

export {
  reconcileOrphanedAttempts,
} from "./orphaned-attempts.js";

export {
  getProviderForRole,
  getSetting,
  getIntSetting,
  getSettingsDataVersion,
  listSettings,
  setSetting,
} from "./settings.js";

export {
  acquireLeaseWithWriteLocksAsync,
  acquireLeaseWithWriteLocks,
  ancestorJobIdsForJob,
  cleanupStaleFileLocks,
  findWriteLockConflict,
  getJobWriteScopeAsync,
  getJobWriteScope,
  jobHasWritePermission,
  jobHoldsWriteLockForPath,
  jobNeedsWriteLocks,
  listActiveFileLocks,
  queuedCohortJobIdsForJob,
  releaseWorkItemFileLockForPath,
  releaseJobFileLocks,
  releaseWorkItemFileLocks,
  verifyOrAcquireJobWriteLockForPath,
  workItemCanReleaseFileLock,
} from "./file-locks.js";

export {
  activeLiveSiblingWriteLocks,
  activeSiblingWriteLocks,
  findActiveSiblingLockForPath,
  hasActiveSiblingWriteLocks,
  siblingLockSummary,
} from "./sibling-locks.js";

export {
  createHashRefStoreForContext,
  fetchHashRefForContext,
  resolveHashRefContext,
  surfaceHashRefForContext,
} from "./hash-refs.js";

export {
  acquireMergeLock,
  acquireSchedulerLock,
  forceAcquireSchedulerLock,
  getLiveSchedulerBlockMessage,
  getSchedulerLockInfo,
  LIVE_SCHEDULER_LOCK_GRACE_MS,
  releaseMergeLock,
  releaseSchedulerLock,
  renewSchedulerLock,
} from "./locks.js";

export {
  acquireSessionHandle,
  advanceSessionHandle,
  aggregateSessionRecycleSavings,
  deriveSessionKeyForJob,
  ensureSessionLane,
  expireStaleSessionLeases,
  getActiveSessionForLane,
  getActiveSessionLane,
  invalidateSessionLane,
  invalidateSessionLanesForWorkItem,
  listSessionLanes,
  listSessionRecycleSavings,
  markSessionExpired,
  markSessionFailed,
  markSessionStatus,
  recordInitialSessionHandle,
  recordSessionRecycleSavings,
  releaseSessionHandle,
  renewSessionHandleLease,
  sessionLeaseTtlSec,
} from "./sessions.js";

// Grace period between lease expiry and requeue. A lease that expires at T
// stays in its hold status (and therefore contributes to scheduler file-scope
// locks via _collectHeldMutationLocks) until T + grace. This covers the
// window where a hung worker process still touches files after its lease has
// lapsed — without the grace, the scheduler would requeue immediately and
// could dispatch a cross-WI conflicting job while the zombie is still live.

const ASSESS_ONLY_PAYLOAD_SQL = `
  payload_json = CASE
    WHEN payload_json IS NULL OR trim(payload_json) = '' THEN json_set('{}', '$._assess_only', 1)
    WHEN json_valid(payload_json) THEN json_set(payload_json, '$._assess_only', 1)
    ELSE json_set(json_object('_legacy_invalid_payload_json', payload_json), '$._assess_only', 1)
  END
`;

const STALL_RESUME_FLAG_PAYLOAD_SQL = `
  payload_json = CASE
    WHEN payload_json IS NULL OR trim(payload_json) = '' THEN json_set('{}', '$._stall_resume', json('true'))
    WHEN json_valid(payload_json) THEN json_set(payload_json, '$._stall_resume', json('true'))
    ELSE json_set(json_object('_legacy_invalid_payload_json', payload_json), '$._stall_resume', json('true'))
  END
`;

const STALL_RESUME_CLEAR_PAYLOAD_SQL = `
  payload_json = CASE
    WHEN payload_json IS NULL OR trim(payload_json) = '' THEN json_remove('{}', '$._stall_resume')
    WHEN json_valid(payload_json) THEN json_remove(payload_json, '$._stall_resume')
    ELSE json_remove(json_object('_legacy_invalid_payload_json', payload_json), '$._stall_resume')
  END
`;

export {
  __testSetLeaseClockForTests,
  acquireLease,
  renewLease,
  releaseLease,
  releaseLeaseWithoutAttemptPenalty,
  getLeaseManager,
} from "./leases.js";

// ═════════════════════════════════════════════════════════════════════════════
// WORK ITEMS
// ═════════════════════════════════════════════════════════════════════════════

export function createWorkItem(title, description, priority = "normal", opts = {}) {
  const db = getDb();
  const tier = opts.governance_tier || "mvp";
  const recycle = ["on", "off"].includes(String(opts.session_recycle || "").toLowerCase())
    ? String(opts.session_recycle).toLowerCase()
    : null;
  const stmt = db.prepare(`
    INSERT INTO work_items (title, description, priority, source, requested_by, mode, metadata_json, governance_tier, session_recycle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    title,
    description,
    priority,
    opts.source || null,
    opts.requested_by || null,
    opts.mode || "build",
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    tier,
    recycle,
  );
  return getWorkItem(info.lastInsertRowid);
}

export function getWorkItem(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id);
}

export {
  getWorkItemMergeDependencies,
  crossWiMergeDependencyWouldCycle,
  addCrossWiMergeDependency,
  removeCrossWiMergeDependency,
  clearCrossWiMergeDependenciesForWorkItem,
  rollbackPendingCrossWiSyncHandoffsForJob,
  listCrossWiMergeBlockers,
  getWorkItemRecycleOverride,
} from "./cross-wi-deps.js";

export function listWorkItems(statusFilter = null) {
  const db = getDb();
  if (statusFilter) {
    if (Array.isArray(statusFilter)) {
      const placeholders = statusFilter.map(() => "?").join(",");
      return db.prepare(`SELECT * FROM work_items WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statusFilter);
    }
    return db.prepare(`SELECT * FROM work_items WHERE status = ? ORDER BY created_at`).all(statusFilter);
  }
  return db.prepare(`SELECT * FROM work_items ORDER BY created_at`).all();
}

export function updateWorkItemStatus(id, status, {
  allowTerminalFailureBlockers = false,
  resolvePendingReviews = false,
} = {}) {
  const db = getDb();
  const execute = () => {
    const ts = now();
    const current = getWorkItem(id);
    if (!current) return false;

    const isTerminal = TERMINAL_WORK_ITEM_STATUS_SET.has(status);
    const isStarting = status === "running" || status === "planning";
    if (
      TERMINAL_WORK_ITEM_STATUS_SET.has(current.status)
      && !isTerminal
      && current.status !== status
      && !isActiveIterativeWorkItemRecord(current)
    ) {
      logEvent({
        work_item_id: id,
        event_type: EVENT_TYPES.WORK_ITEM_STATUS_TRANSITION_REJECTED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Rejected invalid terminal transition: ${current.status} -> ${status}`,
      });
      return false;
    }

    if (status === "complete") {
      const blockers = completionBlockersForWorkItem(id);
      const reviewPlan = resolvePendingReviews
        ? pendingWorkItemReviewSettlement(id)
        : null;
      const resolvableReviewJobIds = new Set([
        ...(reviewPlan?.originals || []).map((job) => job.id),
        ...(reviewPlan?.gates || []).map((job) => job.id),
      ]);
      let effectiveBlockers = allowTerminalFailureBlockers
        ? blockers.filter((job) => !FAILED_JOB_STATUS_SET.has(job.status))
        : blockers;
      if (resolvePendingReviews) {
        effectiveBlockers = effectiveBlockers.filter((job) => !resolvableReviewJobIds.has(job.id));
      }
      if (effectiveBlockers.length > 0) {
        logEvent({
          work_item_id: id,
          event_type: EVENT_TYPES.WORK_ITEM_COMPLETION_BLOCKED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: `Blocked completion: ${effectiveBlockers.length} unresolved required job(s) remain`,
          event_json: JSON.stringify({
            blockers: effectiveBlockers.slice(0, 20).map((job) => ({
              job_id: job.id,
              job_type: job.job_type,
              status: job.status,
              title: job.title,
            })),
            ignored_terminal_failure_blockers: allowTerminalFailureBlockers
              ? blockers.length - effectiveBlockers.length
              : 0,
          }),
        });
        return false;
      }
      if (reviewPlan) {
        settleWorkItemReviewPlan(id, reviewPlan, { resolution: "work_item_approved" });
      }
    }

    if (status === "canceled") cancelInactiveWorkItemJobs(id);

    // - started_at: set once on first start, never overwritten (COALESCE(existing, new))
    // - completed_at: set on terminal states, CLEARED on non-terminal states
    //   so that retried/replanned work items don't carry a stale completed_at
    db.prepare(`
      UPDATE work_items
      SET status = ?, updated_at = ?,
          started_at = COALESCE(started_at, ?),
          completed_at = ?
      WHERE id = ?
    `).run(status, ts, isStarting ? ts : null, isTerminal ? ts : null, id);
    if (status === "complete" && current.branch_name && current.merge_state === null) {
      db.prepare(`
        UPDATE work_items
        SET merge_state = 'pending_review', updated_at = ?
        WHERE id = ? AND merge_state IS NULL
      `).run(ts, id);
    }
    logEvent({
      work_item_id: id,
      event_type: EVENT_TYPES.WORK_ITEM_STATUS_CHANGED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Status -> ${status}`,
    });
    if (isTerminal) {
      invalidateSessionLanesForWorkItemInternal(id, `work_item_${status}`);
      if (status === "failed" || status === "canceled") {
        clearCrossWiMergeDependenciesForWorkItem(id, `work_item_${status}`);
      }
    }
    releaseWorkItemLocksForStatus(id, status);
    if (status === "complete" && !current.branch_name) {
      releaseWorkItemFileLocks(id, "work_item_complete_no_branch");
    }
    notifyQueueStateChanged({
      reason: `work_item_status_${status}`,
      workItemId: id,
    });
    return true;
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

export function setWorkItemBranch(id, branchName, mergeBaseHash) {
  const db = getDb();
  db.prepare(`
    UPDATE work_items SET branch_name = ?, merge_base_hash = ?, updated_at = ? WHERE id = ?
  `).run(branchName, mergeBaseHash, now(), id);
}

function reviewGateOriginalJobId(job) {
  if (job?.job_type !== "human_input" || isPushOfferJob(job)) return null;
  const payload = parseJobPayload(job);
  if (!String(payload.review_type || "").trim()) return null;
  const originalJobId = Number(payload.original_job_id);
  return Number.isInteger(originalJobId) && originalJobId > 0 ? originalJobId : null;
}

function reviewGateNeedsRetirement(job) {
  return !["succeeded", "canceled"].includes(job?.status);
}

function pendingWorkItemReviewSettlement(id) {
  const jobs = listJobsByWorkItem(id);
  const originals = jobs.filter((job) => (
    job.job_type !== "human_input" && job.status === "waiting_on_review"
  ));
  const originalIds = new Set(originals.map((job) => Number(job.id)));
  const gates = jobs.filter((job) => (
    reviewGateNeedsRetirement(job)
    && originalIds.has(reviewGateOriginalJobId(job))
  ));
  return { originals, gates };
}

function settleWorkItemReviewPlan(id, plan, { resolution }) {
  let resolved = 0;
  let canceled = 0;
  for (const job of plan.gates || []) {
    if (reviewGateNeedsRetirement(job)) {
      if (forceUpdateJobStatus(job.id, "canceled", {
        expectedStatuses: [job.status],
      })) {
        canceled += 1;
      }
    }
  }

  for (const job of plan.originals || []) {
    if (!forceUpdateJobStatus(job.id, "succeeded", {
      expectedStatuses: ["waiting_on_review"],
    })) {
      continue;
    }
    if (job.assessor_verdict !== "pass") {
      setAssessorVerdict(job.id, "pass", "high", { force: true });
    }
    logEvent({
      work_item_id: id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_REVIEW_RESOLVED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: resolution === "work_item_merged"
        ? "Pending job review resolved by approved work-item merge"
        : "Pending job review resolved by explicit work-item approval",
      event_json: JSON.stringify({ resolution }),
    });
    resolved += 1;
  }
  return { resolved, canceled };
}

function settleMergedWorkItemReviewJobs(id) {
  const jobs = listJobsByWorkItem(id);
  const plan = {
    originals: jobs.filter((job) => (
      job.job_type !== "human_input" && job.status === "waiting_on_review"
    )),
    // Once the work item is actually merged, every remaining review gate is
    // stale even if its original row was already made terminal elsewhere.
    gates: jobs.filter((job) => (
      reviewGateNeedsRetirement(job) && reviewGateOriginalJobId(job) != null
    )),
  };
  const result = settleWorkItemReviewPlan(id, plan, { resolution: "work_item_merged" });
  const settledIds = new Set([
    ...plan.originals.map((job) => Number(job.id)),
    ...plan.gates.map((job) => Number(job.id)),
  ]);
  for (const job of jobs) {
    if (settledIds.has(Number(job.id))) continue;
    if (TERMINAL_JOB_STATUS_SET.has(job.status)) continue;
    if (NON_COMPLETION_BLOCKING_JOB_TYPES.has(job.job_type) || isPushOfferJob(job)) continue;
    if (forceUpdateJobStatus(job.id, "canceled", { expectedStatuses: [job.status] })) {
      result.canceled += 1;
    }
  }
  return result;
}

export function cancelPendingReviewGatesForOriginal(originalJobId, { exceptJobId = null } = {}) {
  return runInTransaction(() => {
    const original = getJob(originalJobId);
    if (!original) return 0;
    let canceled = 0;
    for (const job of listJobsByWorkItem(original.work_item_id)) {
      if (Number(job.id) === Number(exceptJobId)) continue;
      if (reviewGateOriginalJobId(job) !== Number(originalJobId)) continue;
      if (!reviewGateNeedsRetirement(job)) continue;
      if (forceUpdateJobStatus(job.id, "canceled", { expectedStatuses: [job.status] })) canceled += 1;
    }
    return canceled;
  });
}

/** Repair review rows left behind by older/racing merge finalization. */
export function reconcileMergedWorkItemReviewStates() {
  return runInTransaction(() => {
    const merged = listWorkItems().filter((wi) => wi.merge_state === "merged");
    let workItems = 0;
    let resolved = 0;
    let canceled = 0;
    for (const wi of merged) {
      const result = settleMergedWorkItemReviewJobs(wi.id);
      if (result.resolved > 0 || result.canceled > 0) workItems += 1;
      resolved += result.resolved;
      canceled += result.canceled;
    }
    return { workItems, resolved, canceled };
  });
}

export function setMergeState(id, mergeState) {
  const db = getDb();
  const execute = () => {
    db.prepare(`
      UPDATE work_items SET merge_state = ?, updated_at = ? WHERE id = ?
    `).run(mergeState, now(), id);
    if (mergeState === "merged") {
      // A successful human/system merge is the terminal approval decision for
      // this work item. A review raised in the narrow completion-to-merge
      // window must not leave its original job parked or its human gate open.
      settleMergedWorkItemReviewJobs(id);
      clearCrossWiMergeDependenciesForWorkItem(id, "work_item_merged");
    }
    releaseWorkItemLocksForMergeState(id, mergeState);
  };
  if (db.inTransaction) execute();
  else runImmediateTransaction(db, execute);
}

export function requeueWorkItemAfterRejection(id, { description = null, feedback = null } = {}) {
  return runInTransaction(() => {
    const db = getDb();
    const current = getWorkItem(id);
    if (!current) return false;

    const jobs = listJobsByWorkItem(id);
    const activeRequiredJob = jobs.find((job) => (
      ACTIVE_LEASE_STATUS_SET.has(job.status) && job.job_type !== "atlas_warm"
    ));
    if (activeRequiredJob) return false;

    const ts = now();
    const nextDescription = description == null ? current.description : description;
    const guidance = String(feedback || "The previous implementation was rejected during human review. Reinspect the requested behavior and correct the implementation before resubmitting.")
      .trim()
      .slice(0, 2000);
    const mutatingJobs = jobs.filter((job) => MUTATING_JOB_TYPES.has(job.job_type));
    const mutatingParentIds = new Set(
      mutatingJobs.map((job) => Number(job.parent_job_id)).filter((jobId) => jobId > 0),
    );
    let retryJobs = mutatingJobs.filter((job) => !mutatingParentIds.has(Number(job.id)));
    if (retryJobs.length === 0) {
      const fallback = [...jobs].reverse().find((job) => (
        job.job_type !== "human_input" && job.job_type !== "atlas_warm"
      ));
      retryJobs = fallback ? [fallback] : [];
    }
    if (retryJobs.length === 0) {
      retryJobs = [createJob({
        work_item_id: id,
        job_type: "plan",
        title: `Replan after review rejection: ${(current.title || `WI#${id}`).slice(0, 80)}`,
        priority: current.priority || "normal",
        model_tier: "standard",
        reasoning_effort: "medium",
        payload_json: JSON.stringify({
          task_spec: nextDescription || current.title || `Replan WI#${id}`,
          replan_after_review_rejection: true,
        }),
      })];
    }

    for (const job of jobs) {
      if (job.job_type === "atlas_warm" || TERMINAL_JOB_STATUS_SET.has(job.status)) continue;
      forceUpdateJobStatus(job.id, "canceled", { expectedStatuses: [job.status] });
    }
    for (const job of jobs) {
      if (reviewGateOriginalJobId(job) == null || !reviewGateNeedsRetirement(job)) continue;
      forceUpdateJobStatus(job.id, "canceled", { expectedStatuses: [job.status] });
    }

    for (const job of retryJobs) {
      const fresh = getJob(job.id) || job;
      const payload = parseJobPayload(fresh);
      const instructionKey = fresh.job_type === "fix" && String(payload.fix_instructions || "").trim()
        ? "fix_instructions"
        : "task_spec";
      const priorInstructions = String(payload[instructionKey] || payload.task_spec || fresh.title || "").trim();
      payload[instructionKey] = [
        priorInstructions,
        `HUMAN REVIEW REJECTION:\n${guidance}`,
      ].filter(Boolean).join("\n\n");
      payload._review_retry = {
        rejected_at: ts,
        feedback: guidance,
      };
      updateJobPayload(fresh.id, JSON.stringify(payload));
      if (!forceUpdateJobStatus(fresh.id, "queued", { expectedStatuses: [fresh.status] })) continue;
      db.prepare(`
        UPDATE jobs
        SET assessor_verdict = 'not_assessed',
            assessor_confidence = NULL,
            result_json = NULL,
            last_error = NULL,
            ready_at = ?,
            max_attempts = MAX(COALESCE(max_attempts, 0), attempt_count + 1, 1),
            updated_at = ?
        WHERE id = ?
      `).run(ts, ts, fresh.id);
    }

    const result = db.prepare(`
      UPDATE work_items
      SET status = 'queued',
          description = ?,
          merge_state = NULL,
          completed_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(nextDescription, ts, id);
    if (result.changes === 0) return false;

    releaseWorkItemFileLocks(id, "work_item_rejected");
    clearCrossWiMergeDependenciesForWorkItem(id, "work_item_requeued");
    invalidateSessionLanesForWorkItemInternal(id, "work_item_requeued");
    return true;
  });
}

export function reopenWorkItemForFollowUp(id, { status = "planning", reason = "follow_up" } = {}) {
  const db = getDb();
  const allowedStatuses = new Set([
    "queued",
    "planning",
    "planned",
    "running",
    "blocked",
    "waiting_on_human",
    "waiting_on_review",
  ]);
  if (!allowedStatuses.has(status)) return false;

  const execute = () => {
    const current = getWorkItem(id);
    if (!current || current.status === "canceled") return false;

    const ts = now();
    const result = db.prepare(`
      UPDATE work_items
      SET status = ?,
          merge_state = NULL,
          completed_at = NULL,
          updated_at = ?,
          started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `).run(status, ts, status === "running" || status === "planning" ? ts : null, id);
    if (result.changes === 0) return false;

    const releaseReason = `work_item_${String(reason || "follow_up").replace(/[^a-z0-9_]+/gi, "_").toLowerCase()}`;
    releaseWorkItemFileLocks(id, releaseReason);
    clearCrossWiMergeDependenciesForWorkItem(id, releaseReason);
    invalidateSessionLanesForWorkItemInternal(id, releaseReason);
    logEvent({
      work_item_id: id,
      event_type: EVENT_TYPES.WORK_ITEM_STATUS_CHANGED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Status -> ${status} (${reason || "follow_up"})`,
    });
    return true;
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

export function updateWorkItemMetadata(id, metadata) {
  const db = getDb();
  db.prepare(`
    UPDATE work_items SET metadata_json = ?, updated_at = ? WHERE id = ?
  `).run(metadata ? JSON.stringify(metadata) : null, now(), id);
}

export function updateWorkItemResearchSkip(id, { skipped = true, reason = null } = {}) {
  const db = getDb();
  db.prepare(`
    UPDATE work_items
    SET research_skipped = ?, research_skip_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(skipped ? 1 : 0, reason || null, now(), id);
}

export function countWorkItemJobs(workItemId) {
  const db = getDb();
  return db.prepare(`
    SELECT status, COUNT(*) as count
    FROM jobs WHERE work_item_id = ?
    GROUP BY status
  `).all(workItemId);
}

/**
 * Recompute a work item's status from its child jobs' current states.
 *
 * This is the single authoritative work-item state machine. Call it after
 * any job status transition instead of ad-hoc updateWorkItemStatus calls.
 *
 * State priority (highest wins):
 *   1. All jobs terminal + all succeeded  → complete
 *   2. All jobs terminal + some failed    → failed
 *   3. Any job waiting_on_human           → waiting_on_human
 *   4. Any job running/leased/assessing   → running
 *   5. Any job waiting_on_review          → waiting_on_review
 *   6. Any job blocked (non-human)        → blocked
 *   7. Only queued jobs remain            → planning (if research/plan) or running
 *
 * Skips work items in "canceled" state (manual override).
 */
/**
 * Recompute work item status from its jobs. Returns the new status (or null if unchanged).
 */
export function refreshWorkItemStatus(workItemId) {
  const db = getDb();
  let result = null;
  const execute = () => {
    // Push-offer gates are out-of-band deploy prompts — an open one must not
    // drag a completed work item back to waiting_on_human.
    const jobs = listJobsByWorkItem(workItemId)
      .filter((job) => !isShadowFanoutJob(job))
      .filter((job) => !isPushOfferJob(job));
    if (jobs.length === 0) return;
    const completionJobs = jobs.filter((job) => !NON_COMPLETION_BLOCKING_JOB_TYPES.has(job.job_type));
    const stateJobs = completionJobs.length > 0 ? completionJobs : jobs;

    const wi = getWorkItem(workItemId);
    if (!wi || wi.status === "canceled") return;

    const allTerminal = completionJobs.length > 0
      && completionJobs.every(j => TERMINAL_JOB_STATUS_SET.has(j.status));
    let newStatus;

    if (allTerminal) {
      const blockers = completionBlockersForWorkItem(workItemId);
      newStatus = completionJobs.every(j => j.status === "canceled")
        ? "canceled"
        : (blockers.length === 0 ? "complete" : "failed");
    } else if (stateJobs.some(j => j.status === "waiting_on_human")) {
      newStatus = "waiting_on_human";
    } else if (stateJobs.some(j => ["running", "leased", "awaiting_assessment"].includes(j.status))) {
      newStatus = "running";
    } else if (stateJobs.some(j => j.status === "waiting_on_review")) {
      newStatus = "waiting_on_review";
    } else if (stateJobs.some(j => j.status === "blocked")) {
      newStatus = "blocked";
    } else if (stateJobs.some(j => j.status === "queued")) {
      // Queued-only: "planning" if only routing/research/plan jobs remain, otherwise "running"
      const nonTerminal = stateJobs.filter(j => !TERMINAL_JOB_STATUS_SET.has(j.status));
      const allPlanning = nonTerminal.every(j => ["preflight", "research", "plan"].includes(j.job_type));
      newStatus = allPlanning ? "planning" : "running";
    } else {
      return; // ambiguous — leave untouched
    }

    if (wi.status !== newStatus) {
      const updated = updateWorkItemStatus(workItemId, newStatus);
      if (!updated) return;

      result = newStatus;
    }
  };
  if (db.inTransaction) execute();
  else runImmediateTransaction(db, execute);
  return result;
}

export function refreshWorkItemStatuses(statusFilter = null) {
  const items = listWorkItems(statusFilter);
  let changed = 0;
  for (const wi of items) {
    if (!wi?.id) continue;
    if (refreshWorkItemStatus(wi.id)) changed++;
  }
  return changed;
}

export function completionBlockersForWorkItem(workItemId) {
  const jobs = listJobsByWorkItem(workItemId)
    .filter((job) => !isShadowFanoutJob(job))
    .filter((job) => !isPushOfferJob(job))
    .filter((job) => !NON_COMPLETION_BLOCKING_JOB_TYPES.has(job.job_type));
  if (jobs.length === 0) return [];

  const byParent = new Map();
  for (const job of jobs) {
    if (!job.parent_job_id) continue;
    if (!byParent.has(job.parent_job_id)) byParent.set(job.parent_job_id, []);
    byParent.get(job.parent_job_id).push(job);
  }

  function hasSucceededDescendant(jobId) {
    const stack = [...(byParent.get(jobId) || [])];
    const seen = new Set();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current.id)) continue;
      seen.add(current.id);
      if (current.status === "succeeded" && current.job_type !== "human_input") return true;
      stack.push(...(byParent.get(current.id) || []));
    }
    return false;
  }

  return jobs.filter((job) => {
    if (job.status === "succeeded" || job.status === "canceled") return false;
    if ((job.status === "failed" || job.status === "dead_letter") && hasSucceededDescendant(job.id)) return false;
    return true;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// JOBS
// ═════════════════════════════════════════════════════════════════════════════

export function createJob({
  work_item_id,
  job_type,
  title,
  parent_job_id = null,
  priority = "normal",
  model_tier = "standard",
  reasoning_effort = "medium",
  provider = null,
  token_budget_input = null,
  token_budget_output = null,
  context_budget_chars = null,
  max_attempts = null,
  payload_json = null,
  ready_at = null,
  planner_complexity_score = null,
  planner_risk_score = null,
  planner_context_score = null,
  planner_failure_cost_score = null,
  skills = null,
} = {}) {
  const db = getDb();
  if (max_attempts == null) {
    try { max_attempts = getIntSetting(SETTING_KEYS.DEFAULT_MAX_ATTEMPTS, 3); } catch { max_attempts = 3; }
  }
  const stmt = db.prepare(`
    INSERT INTO jobs (
      work_item_id, job_type, title, parent_job_id,
      priority, model_tier, reasoning_effort, provider,
      token_budget_input, token_budget_output, context_budget_chars,
      max_attempts, payload_json, ready_at,
      planner_complexity_score, planner_risk_score,
      planner_context_score, planner_failure_cost_score, skills
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    work_item_id, job_type, title, parent_job_id,
    priority, model_tier, reasoning_effort, provider,
    token_budget_input, token_budget_output, context_budget_chars,
    max_attempts,
    typeof payload_json === "object" && payload_json !== null ? JSON.stringify(payload_json) : payload_json,
    ready_at || now(),
    planner_complexity_score, planner_risk_score,
    planner_context_score, planner_failure_cost_score,
    normalizeSkillsColumn(skills),
  );

  const job = getJob(info.lastInsertRowid);
  logEvent({
    work_item_id, job_id: job.id,
    event_type: EVENT_TYPES.JOB_CREATED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Created ${job_type} job: ${title}`,
    event_json: job_type === "promote"
      ? JSON.stringify({ visible: false, internal_mutation_job: true })
      : null,
  });
  notifyQueueStateChanged({
    reason: "job_created",
    jobId: job.id,
    workItemId: work_item_id,
  });
  return job;
}

export function getJob(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

export function listJobsByWorkItem(workItemId, statusFilter = null) {
  const db = getDb();
  if (statusFilter) {
    if (Array.isArray(statusFilter)) {
      const placeholders = statusFilter.map(() => "?").join(",");
      return db.prepare(`SELECT * FROM jobs WHERE work_item_id = ? AND status IN (${placeholders}) ORDER BY created_at`).all(workItemId, ...statusFilter);
    }
    return db.prepare(`SELECT * FROM jobs WHERE work_item_id = ? AND status = ? ORDER BY created_at`).all(workItemId, statusFilter);
  }
  return db.prepare(`SELECT * FROM jobs WHERE work_item_id = ? ORDER BY created_at`).all(workItemId);
}

export function listJobs(statusFilter = null) {
  const db = getDb();
  if (statusFilter) {
    if (Array.isArray(statusFilter)) {
      const placeholders = statusFilter.map(() => "?").join(",");
      return db.prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statusFilter);
    }
    return db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at`).all(statusFilter);
  }
  return db.prepare(`SELECT * FROM jobs ORDER BY created_at`).all();
}

export function hasJobs(statusFilter = null) {
  const db = getDb();
  if (statusFilter) {
    if (Array.isArray(statusFilter)) {
      if (statusFilter.length === 0) return false;
      const placeholders = statusFilter.map(() => "?").join(",");
      const row = db.prepare(`SELECT 1 AS found FROM jobs WHERE status IN (${placeholders}) LIMIT 1`).get(...statusFilter);
      return !!row;
    }
    const row = db.prepare(`SELECT 1 AS found FROM jobs WHERE status = ? LIMIT 1`).get(statusFilter);
    return !!row;
  }
  return !!db.prepare(`SELECT 1 AS found FROM jobs LIMIT 1`).get();
}

export function updateJobStatus(id, status, { expectedStatuses = null, leaseToken = null, force = false } = {}) {
  const db = getDb();
  const isTerminal = TERMINAL_JOB_STATUS_SET.has(status);
  const leaseStatuses = new Set(LEASE_HOLDING_STATUSES);
  const shouldClearLease = !leaseStatuses.has(status);

  const execute = () => {
    const updates = {};
    if (status === "running") {
      updates.started_at = now();
    }
    if (isTerminal) {
      updates.finished_at = now();
    }

    // When transitioning to a non-terminal state (e.g. requeue to "queued"),
    // clear finished_at so the job doesn't look finished in the DB.
    const where = ["id = ?"];
    const whereParams = [id];
    if (!force && leaseToken != null) {
      where.push("lease_token = ?");
      whereParams.push(leaseToken);
    } else if (!force) {
      where.push("lease_token IS NULL");
    }
    if (Array.isArray(expectedStatuses) && expectedStatuses.length > 0) {
      where.push(`status IN (${expectedStatuses.map(() => "?").join(",")})`);
      whereParams.push(...expectedStatuses);
    }

    const result = db.prepare(`
      UPDATE jobs
      SET status = ?, updated_at = ?,
          started_at = COALESCE(?, started_at),
          finished_at = ${isTerminal ? "COALESCE(?, finished_at)" : "NULL"},
          lease_owner = ${shouldClearLease ? "NULL" : "lease_owner"},
          lease_token = ${shouldClearLease ? "NULL" : "lease_token"},
          lease_expires_at = ${shouldClearLease ? "NULL" : "lease_expires_at"}
      WHERE ${where.join(" AND ")}
    `).run(status, now(), updates.started_at || null, ...(isTerminal ? [updates.finished_at || null] : []), ...whereParams);
    if (result.changes === 0) return false;

    const job = getJob(id);
    logEvent({
      work_item_id: job?.work_item_id, job_id: id,
      event_type: EVENT_TYPES.JOB_STATUS_CHANGED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Status -> ${status}`,
    });
    if (status === "dead_letter" || status === "canceled") {
      rollbackPendingCrossWiSyncHandoffsForJob(job || id, `job_${status}`);
    }
    releaseJobLocksForStatus(id, status);
    notifyQueueStateChanged({
      reason: `job_status_${status}`,
      jobId: id,
      workItemId: job?.work_item_id,
    });
    return true;
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

export function forceUpdateJobStatus(id, status, opts = {}) {
  return updateJobStatus(id, status, { ...opts, force: true });
}

export function setJobResult(id, result) {
  const db = getDb();
  const json = result === undefined ? null : JSON.stringify(result);
  db.prepare(`UPDATE jobs SET result_json = ?, last_error = NULL, updated_at = ? WHERE id = ?`).run(json, now(), id);
}

export function setJobError(id, errorText) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?`).run(errorText, now(), id);
}

/**
 * Merge fields into a job's result_json without clobbering the existing result
 * or touching last_error (unlike setJobResult, which overwrites both). Only
 * merges when the stored result is a plain object or absent; a non-object
 * result (array/scalar) is left untouched and the merge is skipped so no
 * existing data is lost. Returns true when the merge was written.
 *
 * @param {number|string} id
 * @param {Record<string, unknown>} fields
 * @returns {boolean}
 */
export function mergeJobResultFields(id, fields) {
  if (!fields || typeof fields !== "object") return false;
  const db = getDb();
  const row = db.prepare(`SELECT result_json FROM jobs WHERE id = ?`).get(id);
  if (!row) return false;
  let base = null;
  if (row.result_json != null && String(row.result_json).trim() !== "") {
    try { base = JSON.parse(row.result_json); } catch { return false; }
    if (base !== null && (typeof base !== "object" || Array.isArray(base))) return false;
  }
  const merged = { ...(base || {}), ...fields };
  db.prepare(`UPDATE jobs SET result_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(merged), now(), id);
  return true;
}

export function setJobContext(id, text) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET context_text = ?, updated_at = ? WHERE id = ?`).run(text, now(), id);
}

export function extendJobMaxAttempts(id, minMaxAttempts) {
  const db = getDb();
  const target = Math.max(1, Math.floor(Number(minMaxAttempts) || 0));
  const result = db.prepare(`
    UPDATE jobs
    SET max_attempts = MAX(COALESCE(max_attempts, 0), ?),
        updated_at = ?
    WHERE id = ?
  `).run(target, now(), id);
  return result.changes > 0;
}

export function flagStallResume(jobId) {
  const db = getDb();
  db.prepare(`
    UPDATE jobs
    SET ${STALL_RESUME_FLAG_PAYLOAD_SQL},
        updated_at = ?
    WHERE id = ?
  `).run(now(), jobId);
}

export function clearStallResume(jobId) {
  const db = getDb();
  db.prepare(`
    UPDATE jobs
    SET ${STALL_RESUME_CLEAR_PAYLOAD_SQL},
        updated_at = ?
    WHERE id = ?
  `).run(now(), jobId);
}

export function setAssessorVerdict(
  id,
  verdict,
  confidence = null,
  { leaseToken = null, force = false, allowReleasedLease = false } = {},
) {
  const db = getDb();
  const where = ["id = ?"];
  const whereParams = [id];
  if (!force && leaseToken != null) {
    where.push(allowReleasedLease ? "(lease_token IS NULL OR lease_token = ?)" : "lease_token = ?");
    whereParams.push(leaseToken);
  } else if (!force) {
    where.push("lease_token IS NULL");
  }
  const result = db.prepare(`
    UPDATE jobs
    SET assessor_verdict = ?, assessor_confidence = ?, updated_at = ?
    WHERE ${where.join(" AND ")}
  `).run(verdict, confidence, now(), ...whereParams);
  return result.changes > 0;
}

/**
 * Set the provider (and optionally model_name) on a job.
 * Used by the delegator to assign provider+model after planning.
 */
export function updateJobProvider(id, provider, modelName = undefined) {
  const db = getDb();
  if (modelName !== undefined) {
    db.prepare(`UPDATE jobs SET provider = ?, model_name = ?, updated_at = ? WHERE id = ?`)
      .run(provider, modelName, now(), id);
  } else {
    db.prepare(`UPDATE jobs SET provider = ?, updated_at = ? WHERE id = ?`)
      .run(provider, now(), id);
  }
}

/**
 * Apply a full delegation assignment to a job.
 * Updates any non-null fields: provider, model_name, model_tier, reasoning_effort, priority.
 * Used by the delegator to optimize task execution.
 */
export function applyDelegation(id, { provider = null, model = undefined, model_tier = null, reasoning_effort = null, priority = null } = {}) {
  const db = getDb();
  const sets = [];
  const vals = [];

  if (provider !== null && provider !== undefined) { sets.push("provider = ?"); vals.push(provider); }
  if (model !== undefined) { sets.push("model_name = ?"); vals.push(model); }
  if (model_tier !== null && model_tier !== undefined) { sets.push("model_tier = ?"); vals.push(model_tier); }
  if (reasoning_effort !== null && reasoning_effort !== undefined) { sets.push("reasoning_effort = ?"); vals.push(reasoning_effort); }
  if (priority !== null && priority !== undefined) { sets.push("priority = ?"); vals.push(priority); }

  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  vals.push(now(), id);

  const result = db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return result.changes > 0;
}

/**
 * Get historical average duration per role+tier+provider for completion time estimation.
 */
export {
  getDurationStats,
  getProviderStats,
  getFailureStats,
  getPipelineHealth,
} from "./stats.js";

/**
 * Count failed + dead_letter jobs for a work item.
 * Used by the escalation guard to detect runaway retry/fix loops.
 */
export function countFailedJobs(workItemId) {
  const jobs = listJobsByWorkItem(workItemId);
  return listUnresolvedActionableFailures(jobs).length;
}

/**
 * Cancel all non-terminal jobs for a work item.
 * Returns the list of job IDs that were canceled (for killing active workers).
 */
export function cancelWorkItemJobs(workItemId) {
  return runInTransaction(() => {
    const jobs = listJobsByWorkItem(workItemId);
    const canceled = [];

    for (const job of jobs) {
      if (!TERMINAL_JOB_STATUS_SET.has(job.status)) {
        if (forceUpdateJobStatus(job.id, "canceled")) {
          canceled.push(job.id);
        }
      }
    }
    invalidateSessionLanesForWorkItemInternal(workItemId, "work_item_jobs_canceled");

    return canceled;
  });
}

// A status-only cancellation has no process handle with which to stop a live
// worker. Retire every runnable/parked child immediately, but leave active
// leases visible until their owner exits so worktree cleanup cannot race a
// process that may still be writing. RunDisplayActions kills workers first and
// then uses cancelWorkItemJobs() for the stronger interactive cancellation.
function cancelInactiveWorkItemJobs(workItemId) {
  const canceled = [];
  for (const job of listJobsByWorkItem(workItemId)) {
    if (TERMINAL_JOB_STATUS_SET.has(job.status) || ACTIVE_LEASE_STATUS_SET.has(job.status)) continue;
    if (forceUpdateJobStatus(job.id, "canceled", { expectedStatuses: [job.status] })) {
      canceled.push(job.id);
    }
  }
  return canceled;
}

/**
 * Skip a job by marking it as succeeded.
 * Only works on non-terminal, non-running jobs.
 * Returns true if the job was skipped.
 */
export function skipJob(jobId) {
  const result = runInTransaction(() => {
    const job = getJob(jobId);
    if (!job) return null;

    if (TERMINAL_JOB_STATUS_SET.has(job.status) || ACTIVE_LEASE_STATUS_SET.has(job.status)) return null;

    if (!updateJobStatus(jobId, "succeeded")) return null;
    logEvent({
      work_item_id: job.work_item_id,
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_SKIPPED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: "Job manually skipped by user",
    });

    return job.work_item_id;
  });

  if (result !== null) {
    refreshWorkItemStatus(result);
    return true;
  }
  return false;
}

export function decrementAttemptCount(id) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET attempt_count = MAX(0, attempt_count - 1), updated_at = ? WHERE id = ?`).run(now(), id);
}

export function incrementAttemptCount(id) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?`).run(now(), id);
}

export function updateJobPayload(id, payloadJson) {
  const db = getDb();
  const result = db.prepare(`UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?`).run(payloadJson, now(), id);
  if ((result?.changes || 0) > 0) {
    const job = getJob(id);
    notifyQueueStateChanged({
      reason: "job_payload_updated",
      jobId: id,
      workItemId: job?.work_item_id,
    });
  }
}

const SCOPE_REQUEST_REVIEW_TYPE = "scope_expansion_request";

function normalizeRequestedScopePath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function parseJobPayloadObject(job) {
  try {
    const parsed = JSON.parse(job?.payload_json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function scopeRequestResult({ request, humanJobId = null, reused = false } = {}) {
  return {
    ok: false,
    code: "scope_approval_pending",
    paused: true,
    request_id: request?.id || null,
    approval_job_id: humanJobId,
    path: request?.path || null,
    access: request?.access || null,
    operation: request?.operation || null,
    reused,
    message: `The current job is paused until a human approves or denies writable scope for ${request?.path || "the requested path"}.`,
  };
}

/**
 * Persist one exact-path scope expansion and park the active job. This is the
 * queue-side implementation behind the internal request_scope tool; callers
 * must resolve and authorize the path before invoking it.
 */
export function requestJobScopeExpansion({
  jobId,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  path,
  access,
  operation,
  reason = "",
  source = "internal_tool",
} = {}) {
  const normalizedJobId = Number(jobId);
  const normalizedPath = normalizeRequestedScopePath(path);
  const normalizedAccess = String(access || "").trim().toLowerCase();
  const normalizedOperation = String(operation || "").trim().toLowerCase();
  if (!Number.isInteger(normalizedJobId) || normalizedJobId <= 0) {
    return { ok: false, code: "scope_request_unavailable", paused: false, message: "No active job context is available for a scope request." };
  }
  if (!normalizedPath) {
    return { ok: false, code: "invalid_scope_path", paused: false, message: "Scope requests require one repository-relative file path." };
  }
  if (!new Set(["modify", "create"]).has(normalizedAccess)) {
    return { ok: false, code: "invalid_scope_access", paused: false, message: "Scope request access must be modify or create." };
  }
  if (!new Set(["write_file", "edit_file"]).has(normalizedOperation)) {
    return { ok: false, code: "invalid_scope_operation", paused: false, message: "Scope request operation must be write_file or edit_file." };
  }

  return runInTransaction(() => {
    const current = getJob(normalizedJobId);
    if (!current) {
      return { ok: false, code: "scope_request_job_missing", paused: false, message: `Job #${normalizedJobId} no longer exists.` };
    }
    if (workItemId != null && Number(workItemId) !== Number(current.work_item_id)) {
      return { ok: false, code: "scope_request_context_mismatch", paused: false, message: "The scope request does not belong to the active work item." };
    }
    const payload = parseJobPayloadObject(current);
    const pending = payload._pending_scope_request;
    if (pending && typeof pending === "object") {
      if (
        pending.path === normalizedPath
        && pending.access === normalizedAccess
        && pending.operation === normalizedOperation
      ) {
        return scopeRequestResult({ request: pending, humanJobId: pending.approval_job_id || null, reused: true });
      }
      return {
        ok: false,
        code: "scope_approval_already_pending",
        paused: true,
        request_id: pending.id || null,
        path: pending.path || null,
        message: `Job #${normalizedJobId} is already paused for a scope decision on ${pending.path || "another path"}.`,
      };
    }
    if (current.status !== "running") {
      return {
        ok: false,
        code: "scope_request_job_inactive",
        paused: false,
        message: `Job #${normalizedJobId} cannot request scope while its status is ${current.status}.`,
      };
    }

    const requestId = `job-${normalizedJobId}-scope-${Date.now()}`;
    const request = {
      id: requestId,
      path: normalizedPath,
      access: normalizedAccess,
      operation: normalizedOperation,
      reason: String(reason || "").trim().slice(0, 500),
      source: String(source || "internal_tool").slice(0, 80),
      requested_at: now(),
      attempt_id: Number(attemptId) || null,
      agent_call_id: Number(agentCallId) || null,
    };
    const humanJob = createJob({
      work_item_id: current.work_item_id,
      job_type: "human_input",
      title: `Approve scope: ${normalizedPath}`.slice(0, 180),
      parent_job_id: current.id,
      priority: "high",
      model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: current.id,
        review_type: SCOPE_REQUEST_REVIEW_TYPE,
        scope_request: request,
        questions: [[
          `Job #${current.id} (${current.title}) attempted ${normalizedOperation} on a file outside its writable scope:`,
          `  ${normalizedPath}`,
          request.reason ? `Reason: ${request.reason}` : null,
          `Approve to add this exact path to ${normalizedAccess === "modify" ? "files_to_modify" : "files_to_create"} and retry the job, or deny to fail it with an out-of-scope error.`,
          `Reply with "approve" or "deny".`,
        ].filter(Boolean).join("\n")],
        context: `The request was surfaced automatically by the internal request_scope tool after ${normalizedOperation} hit the job's scope boundary.`,
      }),
    });
    request.approval_job_id = humanJob.id;
    updateJobPayload(current.id, JSON.stringify({
      ...payload,
      _pending_scope_request: request,
    }));
    const parked = updateJobStatus(current.id, "waiting_on_human", {
      expectedStatuses: ["running"],
      force: true,
    });
    if (parked) {
      decrementAttemptCount(current.id);
    }
    logEvent({
      work_item_id: current.work_item_id,
      job_id: current.id,
      attempt_id: Number(attemptId) || null,
      event_type: EVENT_TYPES.JOB_SCOPE_REQUESTED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Paused for ${normalizedAccess} scope approval: ${normalizedPath}`,
      event_json: JSON.stringify({ request, approval_job_id: humanJob.id }),
    });
    return scopeRequestResult({ request, humanJobId: humanJob.id });
  });
}

/** Resolve a human answer for a request created by requestJobScopeExpansion. */
export function resolveJobScopeExpansion({ approvalJobId, approved, answer = "" } = {}) {
  const humanJob = getJob(Number(approvalJobId));
  const humanPayload = parseJobPayloadObject(humanJob);
  if (!humanJob || humanPayload.review_type !== SCOPE_REQUEST_REVIEW_TYPE) {
    return { ok: false, code: "scope_request_gate_missing" };
  }
  return runInTransaction(() => {
    const original = getJob(Number(humanPayload.original_job_id));
    if (!original) return { ok: false, code: "scope_request_job_missing" };
    const payload = parseJobPayloadObject(original);
    const pending = payload._pending_scope_request;
    const request = humanPayload.scope_request;
    if (!request || !pending || request.id !== pending.id) {
      return { ok: false, code: "scope_request_stale", job: original, request: request || null };
    }

    const nextPayload = { ...payload };
    const decision = approved === true ? "approved" : "rejected";
    nextPayload._pending_scope_request = {
      ...pending,
      decision,
      decided_at: now(),
      answer: String(answer || "").slice(0, 300),
    };
    if (approved === true) {
      const field = request.access === "modify" ? "files_to_modify" : "files_to_create";
      nextPayload[field] = [...new Set([
        ...(Array.isArray(nextPayload[field]) ? nextPayload[field] : []),
        request.path,
      ])];
      const executionSettled = pending.execution_settled === true;
      if (executionSettled) delete nextPayload._pending_scope_request;
      updateJobPayload(original.id, JSON.stringify(nextPayload));
      if (executionSettled) {
        updateJobStatus(original.id, "queued", { expectedStatuses: ["waiting_on_human"], force: true });
      }
      logEvent({
        work_item_id: original.work_item_id,
        job_id: original.id,
        event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_APPROVED,
        actor_type: EVENT_ACTORS.HUMAN,
        message: `Approved ${request.access} scope: ${request.path}`,
        event_json: JSON.stringify({ request, approval_job_id: humanJob.id, answer: String(answer || "").slice(0, 300) }),
      });
      return { ok: true, approved: true, requeued: executionSettled, job: getJob(original.id), request };
    }

    nextPayload._scope_request_denials = [
      ...(Array.isArray(nextPayload._scope_request_denials) ? nextPayload._scope_request_denials : []),
      { ...request, denied_at: now(), answer: String(answer || "").slice(0, 300) },
    ].slice(-20);
    const error = `Out-of-scope ${request.operation} denied for ${request.path}.`;
    const executionSettled = pending.execution_settled === true;
    if (executionSettled) delete nextPayload._pending_scope_request;
    updateJobPayload(original.id, JSON.stringify(nextPayload));
    if (executionSettled) {
      setJobError(original.id, error);
      updateJobStatus(original.id, "failed", { expectedStatuses: ["waiting_on_human"], force: true });
    }
    logEvent({
      work_item_id: original.work_item_id,
      job_id: original.id,
      event_type: EVENT_TYPES.JOB_SCOPE_REQUEST_REJECTED,
      actor_type: EVENT_ACTORS.HUMAN,
      message: error,
      event_json: JSON.stringify({ request, approval_job_id: humanJob.id, answer: String(answer || "").slice(0, 300) }),
    });
    return { ok: true, approved: false, finalized: executionSettled, job: getJob(original.id), request, error };
  });
}

/**
 * Mark the provider attempt that triggered a scope request as fully stopped.
 * A fast human answer may arrive while the old provider process is still
 * unwinding; only this boundary is allowed to requeue/fail the original job.
 */
export function settleJobScopeExpansionAttempt({ jobId, attemptId = null } = {}) {
  return runInTransaction(() => {
    const original = getJob(Number(jobId));
    if (!original) return { ok: false, code: "scope_request_job_missing" };
    const payload = parseJobPayloadObject(original);
    const pending = payload._pending_scope_request;
    if (!pending) return { ok: false, code: "scope_request_not_pending", job: original };
    const normalizedAttemptId = Number(attemptId) || null;
    if (pending.attempt_id && normalizedAttemptId && Number(pending.attempt_id) !== normalizedAttemptId) {
      return { ok: false, code: "scope_request_attempt_mismatch", job: original, request: pending };
    }

    const nextPayload = { ...payload };
    const settled = { ...pending, execution_settled: true, settled_at: now() };
    if (settled.decision === "approved") {
      delete nextPayload._pending_scope_request;
      updateJobPayload(original.id, JSON.stringify(nextPayload));
      updateJobStatus(original.id, "queued", { expectedStatuses: ["waiting_on_human"], force: true });
      return { ok: true, decision: "approved", finalized: true, job: getJob(original.id), request: settled };
    }
    if (settled.decision === "rejected") {
      delete nextPayload._pending_scope_request;
      updateJobPayload(original.id, JSON.stringify(nextPayload));
      const error = `Out-of-scope ${settled.operation} denied for ${settled.path}.`;
      setJobError(original.id, error);
      updateJobStatus(original.id, "failed", { expectedStatuses: ["waiting_on_human"], force: true });
      return { ok: true, decision: "rejected", finalized: true, job: getJob(original.id), request: settled, error };
    }
    nextPayload._pending_scope_request = settled;
    updateJobPayload(original.id, JSON.stringify(nextPayload));
    return { ok: true, decision: null, finalized: false, job: getJob(original.id), request: settled };
  });
}

/**
 * Requeue a job for graceful shutdown: set status back to queued, clear lease,
 * and undo the attempt_count increment from the interrupted run.
 * Only affects jobs still in a leased/running/assessing state.
 */
export function requeueForShutdown(jobId) {
  const db = getDb();
  const ts = now();
  const requeueOne = db.transaction(() => {
    const row = db.prepare(`
      SELECT status
      FROM jobs
      WHERE id = ?
        AND status IN (${LEASE_HOLDING_STATUSES_SQL})
    `).get(jobId);
    if (!row) return { changes: 0, wasAssessing: false };

    const update = db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          ready_at = ?,
          attempt_count = CASE
            WHEN status = 'awaiting_assessment' THEN attempt_count
            ELSE MAX(0, attempt_count - 1)
          END,
          updated_at = ?
      WHERE id = ?
        AND status IN (${LEASE_HOLDING_STATUSES_SQL})
    `).run(ts, ts, jobId);

    const wasAssessing = row.status === "awaiting_assessment";
    if (update.changes > 0 && wasAssessing) {
      db.prepare(`
        UPDATE jobs
        SET ${ASSESS_ONLY_PAYLOAD_SQL}
        WHERE id = ?
      `).run(jobId);
    }

    return { changes: update.changes, wasAssessing };
  });
  const result = requeueOne();

  if (result.changes > 0) {
    releaseJobLocksForStatus(jobId, "queued");
    logEvent({
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_SHUTDOWN_REQUEUE,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: result.wasAssessing
        ? "Assessment interrupted by graceful shutdown, requeued as assess-only"
        : "Requeued for graceful shutdown (attempt not counted)",
    });
    notifyQueueStateChanged({
      reason: "job_shutdown_requeue",
      jobId,
    });
  }
  return result.changes > 0;
}

// ═════════════════════════════════════════════════════════════════════════════
export function requeueWaitingHumanInputJobs() {
  const db = getDb();
  const execute = () => {
    const parked = db.prepare(`
      SELECT id, work_item_id, job_type, payload_json
      FROM jobs
      WHERE status = 'waiting_on_human' AND job_type = 'human_input'
    `).all().filter((job) => !isPushOfferJob(job));

    if (parked.length === 0) return [];

    const placeholders = parked.map(() => "?").join(",");
    db.prepare(`
      UPDATE jobs
      SET status = 'queued',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          started_at = NULL,
          finished_at = NULL,
          updated_at = ?
      WHERE id IN (${placeholders})
        AND status = 'waiting_on_human'
        AND job_type = 'human_input'
    `).run(now(), ...parked.map((job) => job.id));

    for (const job of parked) {
      releaseJobLocksForStatus(job.id, "queued");
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_HUMAN_PROMPT_REQUEUED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: "Requeued parked human_input job after interactive display became available",
      });
      notifyQueueStateChanged({
        reason: "job_human_prompt_requeued",
        jobId: job.id,
        workItemId: job.work_item_id,
      });
    }
    for (const workItemId of new Set(parked.map((job) => job.work_item_id).filter(Boolean))) {
      refreshWorkItemStatus(workItemId);
    }

    return parked.map((job) => ({ job_id: job.id, work_item_id: job.work_item_id }));
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

// LEASING
// ═════════════════════════════════════════════════════════════════════════════
//
// The per-job lease primitives (acquire / renew / release) and the
// lease clock live in ./leases.js. The bulk requeue sweeps below stay
// in this file because they also need refreshWorkItemStatus to fan
// out to the affected WIs.

// Lease-holding statuses that are parked rather than actively executing.
// Derived from the catalog so a future parked status inherits the sweep.
const PARKED_LEASE_STATUSES_SQL = LEASE_HOLDING_STATUSES
  .filter((status) => !ACTIVE_LEASE_STATUS_SET.has(status))
  .map((status) => `'${status}'`)
  .join(",");

/**
 * Crash-only recovery: a process can die between processVerdict() parking a
 * job in waiting_on_human / waiting_on_review and the worker releasing the
 * lease immediately afterwards. Parked jobs are deliberately excluded from
 * the requeue sweeps (they may wait indefinitely on a human), so a lease
 * token retained across that crash would otherwise stick forever. Clear the
 * lease fields once the lease expires; status and file locks stay untouched —
 * parked statuses hold their locks by design.
 */
function clearExpiredParkedLeaseTokens(db, ts, cutoff) {
  const parkedStale = db.prepare(`
    SELECT id, status, lease_token FROM jobs
    WHERE status IN (${PARKED_LEASE_STATUSES_SQL})
      AND lease_token IS NOT NULL
      AND (lease_expires_at IS NULL OR lease_expires_at < ?)
  `).all(cutoff);
  if (parkedStale.length === 0) return 0;

  const clearParked = db.prepare(`
    UPDATE jobs
    SET lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = ?
    WHERE id = ?
      AND lease_token = ?
      AND status IN (${PARKED_LEASE_STATUSES_SQL})
  `);
  let cleared = 0;
  runInTransaction(() => {
    for (const { id, status, lease_token } of parkedStale) {
      const res = clearParked.run(ts, id, lease_token);
      if ((res?.changes || 0) < 1) continue;
      cleared += 1;
      logEvent({
        job_id: id,
        event_type: EVENT_TYPES.JOB_LEASE_EXPIRED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Cleared lease token retained by parked ${status} job (process died before release)`,
      });
    }
  });
  return cleared;
}

/**
 * Find jobs with expired leases and requeue them.
 * Returns the number of requeued jobs.
 */
/**
 * Requeue orphaned active leased/running/assessing jobs whose lease is stale.
 * Parked human/review jobs are deliberately excluded: they may wait
 * indefinitely until a user answers, and separate recovery paths handle truly
 * orphaned human gates.
 * Called on scheduler startup after the scheduler lock is acquired.
 *
 * Important safety rule: do NOT blindly requeue jobs with fresh leases.
 * Workers renew their own job leases independently of the scheduler lock, so a
 * false-positive scheduler takeover could otherwise steal healthy in-flight
 * jobs from a live worker and create systemic stale-lease failures.
 */
export function requeueOrphanedJobs({ force = false } = {}) {
  const db = getDb();
  const ts = now();
  const leaseNow = new Date(_leaseNowMs()).toISOString();
  // Boot-time callers pass force=true: the scheduler lock guarantees no other
  // instance is running, so any actively-held job is by definition orphaned
  // even if the lease hasn't expired yet (e.g. Ctrl+C kill within the 120s lease
  // window). Parked human/review jobs are intentionally excluded.
  const orphaned = force
    ? db.prepare(`
      SELECT id, status, work_item_id, job_type FROM jobs
      WHERE status IN (${ACTIVE_LEASE_STATUSES_SQL})
    `).all()
    : db.prepare(`
      SELECT id, status, work_item_id, job_type FROM jobs
      WHERE status IN (${ACTIVE_LEASE_STATUSES_SQL})
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)
    `).all(leaseNow);

  if (orphaned.length === 0) return 0;
  const warmOrphanIds = orphaned.filter((row) => row.job_type === "atlas_warm").map((row) => row.id);
  const requeueIds = orphaned.filter((row) => row.job_type !== "atlas_warm").map((row) => row.id);
  const assessOnlyIds = orphaned
    .filter((row) => row.job_type !== "atlas_warm" && row.status === "awaiting_assessment")
    .map((row) => row.id);
  const requeuedAssessOnlyIds = [];
  const chunkSize = 200;
  const chunked = (values, fn) => {
    for (let i = 0; i < values.length; i += chunkSize) {
      fn(values.slice(i, i + chunkSize));
    }
  };

  const affectedWIs = new Set();
  let failedWarmCount = 0;
  let requeuedCount = 0;

  // Phase 1: bulk-UPDATE under IMMEDIATE transaction. Keep the writer hold
  // short — per-row lock release and event emission run after commit so they
  // don't block readers. If the process crashes between phases, the stale
  // file-lock sweeper (cleanupStaleFileLocks) requeues abandoned locks.
  const recoverAll = db.transaction(() => {
    chunked(warmOrphanIds, (ids) => {
      const placeholders = ids.map(() => "?").join(",");
      const res = db.prepare(`
        UPDATE jobs
        SET status = 'failed',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            finished_at = ?,
            updated_at = ?,
            last_error = COALESCE(last_error, 'atlas_warm: orphaned on scheduler boot (fail-silent per policy)')
        WHERE id IN (${placeholders})
          AND status IN (${ACTIVE_LEASE_STATUSES_SQL})
      `).run(ts, ts, ...ids);
      failedWarmCount += res?.changes || 0;
    });

    chunked(requeueIds, (ids) => {
      const placeholders = ids.map(() => "?").join(",");
      const res = db.prepare(`
        UPDATE jobs
        SET status = 'queued',
            lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            finished_at = NULL,
            ready_at = ?,
            attempt_count = CASE
              WHEN status = 'awaiting_assessment' THEN attempt_count
              ELSE MAX(0, attempt_count - 1)
            END,
            updated_at = ?
        WHERE id IN (${placeholders})
          AND status IN (${ACTIVE_LEASE_STATUSES_SQL})
      `).run(ts, ts, ...ids);
      requeuedCount += res?.changes || 0;
      if ((res?.changes || 0) > 0) {
        const changedRows = db.prepare(`
          SELECT id
          FROM jobs
          WHERE id IN (${placeholders})
            AND status = 'queued'
        `).all(...ids);
        for (const row of changedRows) {
          if (assessOnlyIds.includes(row.id)) requeuedAssessOnlyIds.push(row.id);
        }
      }
    });

    if (requeuedAssessOnlyIds.length > 0) {
      chunked(requeuedAssessOnlyIds, (ids) => {
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(`
          UPDATE jobs
          SET ${ASSESS_ONLY_PAYLOAD_SQL}
          WHERE id IN (${placeholders})
        `).run(...ids);
      });
    }
  });

  recoverAll();

  // Phase 2: per-row follow-up work outside the write transaction.
  for (const { id, status, work_item_id, job_type } of orphaned) {
    affectedWIs.add(work_item_id);
    if (job_type === "atlas_warm") {
      releaseJobLocksForStatus(id, "failed");
      logEvent({
        job_id: id,
        event_type: EVENT_TYPES.JOB_WARM_LEASE_EXPIRED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: "atlas_warm orphaned on scheduler boot; marked failed (fail-silent per ATLAS_WARM_JOB_POLICY)",
      });
      continue;
    }
    releaseJobLocksForStatus(id, "queued");
    const wasAssessing = status === "awaiting_assessment";
    logEvent({
      job_id: id,
      event_type: wasAssessing ? EVENT_TYPES.JOB_ASSESSMENT_ORPHANED : EVENT_TYPES.JOB_ORPHAN_REQUEUE,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: wasAssessing
        ? "Assessment orphaned (process crash), requeued as assess-only"
        : "Requeued orphaned job from previous instance (attempt not counted)",
    });
  }

  // Refresh WI status so it reflects the recovered jobs.
  for (const wiId of affectedWIs) {
    refreshWorkItemStatus(wiId);
  }

  if (failedWarmCount + requeuedCount > 0) {
    notifyQueueStateChanged({
      reason: "job_orphan_requeue",
    });
  }

  return requeuedCount;
}

export function requeueExpiredLeases() {
  const db = getDb();
  const ts = now();
  const cutoff = _graceCutoff();
  clearExpiredParkedLeaseTokens(db, ts, cutoff);
  const expired = db.prepare(`
    SELECT id, status, work_item_id, lease_token, lease_owner, job_type FROM jobs
    WHERE status IN (${ACTIVE_LEASE_STATUSES_SQL})
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `).all(cutoff);

  if (expired.length === 0) return 0;

  // ATLAS warm jobs are fail-silent and capped at max_attempts=1 per
  // ATLAS_WARM_JOB_POLICY. Re-leasing them violates the contract: the
  // pipeline outbox re-emits new warm jobs as needed, so a dead lease
  // should terminate, not requeue.
  const failWarm = db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        finished_at = ?,
        updated_at = ?,
        last_error = COALESCE(last_error, 'atlas_warm: lease expired (fail-silent per policy)')
    WHERE id = ?
      AND lease_token = ?
      AND lease_owner IS NOT NULL
      AND status IN (${ACTIVE_LEASE_STATUSES_SQL})
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `);

  const requeue = db.prepare(`
    UPDATE jobs
    SET status = 'queued',
        lease_owner = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        finished_at = NULL,
        ready_at = ?,
        attempt_count = CASE
          WHEN status = 'awaiting_assessment' THEN attempt_count
          ELSE MAX(0, attempt_count - 1)
        END,
        updated_at = ?
    WHERE id = ?
      AND lease_token = ?
      AND lease_owner IS NOT NULL
      AND status IN (${ACTIVE_LEASE_STATUSES_SQL})
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `);

  // For awaiting_assessment jobs, flag them so the worker skips dev and goes
  // straight to assessment. The prior attempt's output + commits are already done.
  const markAssessOnly = db.prepare(`
    UPDATE jobs
    SET ${ASSESS_ONLY_PAYLOAD_SQL}
    WHERE id = ?
  `);

  const affectedWIs = new Set();

  let requeuedCount = 0;
  let changedCount = 0;
  const requeueAll = () => runInTransaction(() => {
    for (const { id, status, work_item_id, lease_token, job_type } of expired) {
      if (job_type === "atlas_warm") {
        const res = failWarm.run(ts, ts, id, lease_token, cutoff);
        if ((res?.changes || 0) < 1) continue;
        changedCount += 1;
        releaseJobLocksForStatus(id, "failed");
        affectedWIs.add(work_item_id);
        logEvent({
          job_id: id,
          event_type: EVENT_TYPES.JOB_WARM_LEASE_EXPIRED,
          actor_type: EVENT_ACTORS.SCHEDULER,
          message: "atlas_warm lease expired; marked failed (fail-silent per ATLAS_WARM_JOB_POLICY)",
        });
        continue;
      }
      const res = requeue.run(ts, ts, id, lease_token, cutoff);
      if ((res?.changes || 0) < 1) continue;
      requeuedCount += 1;
      changedCount += 1;
      releaseJobLocksForStatus(id, "queued");
      affectedWIs.add(work_item_id);
      const wasAssessing = status === "awaiting_assessment";
      if (wasAssessing) markAssessOnly.run(id);
      logEvent({
        job_id: id,
        event_type: wasAssessing ? EVENT_TYPES.JOB_ASSESSMENT_ORPHANED : EVENT_TYPES.JOB_LEASE_EXPIRED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: wasAssessing
          ? "Assessment orphaned (scheduler crash), requeued as assess-only"
          : "Lease expired, requeued (attempt not counted)",
      });
    }
  });

  requeueAll();

  for (const wiId of affectedWIs) {
    refreshWorkItemStatus(wiId);
  }
  if (changedCount > 0) {
    notifyQueueStateChanged({
      reason: "job_lease_expired",
    });
  }

  return requeuedCount;
}

// ═════════════════════════════════════════════════════════════════════════════
// RUNNABLE JOB QUERY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Find the next runnable job: status=queued, ready_at<=now, all hard deps succeeded.
 * Ordered by priority then creation time.
 */
export function findRunnableJobsBatch(limit = 25, { excludeWorkItemIds = [], excludeJobIds = [], onlyJobTypes = [], onlyWorkItemIds = [] } = {}) {
  const db = getDb();
  const ts = now();

  const conditions = [
    "j.status = 'queued'",
    "j.ready_at <= ?",
  ];
  const params = [ts];

  if (excludeWorkItemIds.length > 0) {
    conditions.push(`j.work_item_id NOT IN (${excludeWorkItemIds.map(() => "?").join(",")})`);
    params.push(...excludeWorkItemIds);
  }
  if (onlyWorkItemIds.length > 0) {
    conditions.push(`j.work_item_id IN (${onlyWorkItemIds.map(() => "?").join(",")})`);
    params.push(...onlyWorkItemIds);
  }
  if (excludeJobIds.length > 0) {
    conditions.push(`j.id NOT IN (${excludeJobIds.map(() => "?").join(",")})`);
    params.push(...excludeJobIds);
  }
  if (onlyJobTypes.length > 0) {
    conditions.push(`j.job_type IN (${onlyJobTypes.map(() => "?").join(",")})`);
    params.push(...onlyJobTypes);
  }

  conditions.push(`NOT EXISTS (
      SELECT 1 FROM job_dependencies jd
      JOIN jobs dep ON dep.id = jd.depends_on_job_id
      WHERE jd.job_id = j.id
        AND jd.dependency_kind = 'hard'
        AND dep.status != 'succeeded'
    )`);

  const safeLimit = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 1);
  params.push(safeLimit);

  return db.prepare(`
    SELECT j.* FROM jobs j
    WHERE ${conditions.join("\n        AND ")}
    ORDER BY
      CASE j.priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END,
      CASE
        WHEN j.payload_json IS NOT NULL
          AND json_valid(j.payload_json)
          AND json_extract(j.payload_json, '$._assess_only') IN (1, '1', true)
          THEN 0
        WHEN j.job_type = 'fix' THEN 1
        WHEN j.job_type = 'promote' THEN 2
        ELSE 3
      END,
      j.created_at ASC
    LIMIT ?
  `).all(...params);
}

export function findRunnableJob(opts = {}) {
  const rows = findRunnableJobsBatch(1, opts);
  return rows.length > 0 ? rows[0] : null;
}

export { countJobsByStatus } from "./stats.js";

export function listJobsMinimal(statusFilter = null) {
  const db = getDb();
  const cols = "id, work_item_id, job_type, status, title, payload_json, priority, created_at, updated_at";
  if (statusFilter) {
    if (Array.isArray(statusFilter)) {
      if (statusFilter.length === 0) return [];
      const placeholders = statusFilter.map(() => "?").join(",");
      return db.prepare(`SELECT ${cols} FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statusFilter);
    }
    return db.prepare(`SELECT ${cols} FROM jobs WHERE status = ? ORDER BY created_at`).all(statusFilter);
  }
  return db.prepare(`SELECT ${cols} FROM jobs ORDER BY created_at`).all();
}

export function hasOutstandingHumanInputJobs(workItemId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM jobs
    WHERE work_item_id = ?
      AND job_type = 'human_input'
      AND status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
  `).get(workItemId);
  return row.cnt > 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// DEPENDENCIES
// ═════════════════════════════════════════════════════════════════════════════

// Bridge the in-file requeueExpiredLeases up into the lease-manager
// factory in ./leases.js so it can be called via the LeaseManager
// surface without leases.js needing to statically import this index.
__registerRequeueExpiredLeases(requeueExpiredLeases);

export {
  addDependency,
  removeDependency,
  rewireDependency,
  rewireDependencyChain,
  getDependencies,
  getUnmetDependencies,
  getAllDependencies,
  getDependents,
  findDeadlockedJobs,
} from "./dependencies.js";

export {
  getQueueWakeGeneration,
  notifyQueueStateChanged,
  onQueueStateChanged,
  waitForQueueStateChangeAfter,
} from "./wakeups.js";

// The unused-after-replacement bodies live in dependencies.js; the
// stub below keeps the regex anchor for the next replacement step.

// ═════════════════════════════════════════════════════════════════════════════
// ATTEMPTS
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// ARTIFACTS
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// EVENTS
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// SCHEDULER LOCKS
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// MERGE LOCKS — semantic wrappers over the scheduler_locks table
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// ORPHANED ATTEMPT RECONCILIATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Mark any job_attempts stuck in 'running' status as 'failed'.
 * Called on scheduler startup — if we hold the lock, no worker should have
 * running attempts. These are leftovers from crashed workers.
 */
// ═════════════════════════════════════════════════════════════════════════════
// BULK / UTILITY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Clear session data (work items, jobs) but preserve artifacts and logs.
 * Events, agent_calls, and artifacts are kept.
 * Foreign keys are temporarily disabled so CASCADE doesn't wipe artifacts
 * when parent rows in work_items/jobs are deleted.
 */
export function clearAll() {
  const db = getDb();
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      // Detach preserved history from deleted parents before removing queue rows.
      db.prepare(`UPDATE artifacts SET work_item_id = NULL, job_id = NULL, attempt_id = NULL`).run();
      db.prepare(`UPDATE events SET work_item_id = NULL, job_id = NULL, attempt_id = NULL`).run();
      db.prepare(`UPDATE agent_calls SET work_item_id = NULL, job_id = NULL, attempt_id = NULL`).run();
      db.prepare(`UPDATE job_observations SET work_item_id = NULL, job_id = NULL, attempt_id = NULL`).run();
      db.prepare(`UPDATE run_insights SET work_item_id = NULL, job_id = NULL`).run();
      db.prepare(`DELETE FROM agent_run_hash_ref_aliases`).run();
      db.prepare(`DELETE FROM job_hash_ref_aliases`).run();
      db.prepare(`DELETE FROM work_item_hash_ref_aliases`).run();
      db.prepare(`DELETE FROM agent_run_hash_refs`).run();
      db.prepare(`DELETE FROM job_hash_refs`).run();
      db.prepare(`DELETE FROM work_item_hash_refs`).run();
      db.prepare(`DELETE FROM hash_ref_aliases`).run();
      db.prepare(`DELETE FROM job_file_locks`).run();
      db.prepare(`DELETE FROM work_item_file_locks`).run();
      db.prepare(`DELETE FROM session_recycle_savings`).run();
      db.prepare(`DELETE FROM job_sessions`).run();
      db.prepare(`DELETE FROM session_lanes`).run();
      db.prepare(`DELETE FROM job_attempts`).run();
      db.prepare(`DELETE FROM job_dependencies`).run();
      db.prepare(`DELETE FROM jobs`).run();
      db.prepare(`DELETE FROM work_items`).run();
      db.prepare(`DELETE FROM scheduler_locks`).run();
      db.prepare(`DELETE FROM scheduler_wakeups`).run();
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export { getJobStats, getWorkItemJobStats } from "./stats.js";

export function cancelDeadlockedJobsAtomic(actorId = null) {
  const db = getDb();
  const ts = now();
  return runImmediateTransaction(db, () => {
    const cancelStmt = db.prepare(`
      UPDATE jobs
      SET status = 'canceled',
          updated_at = ?,
          finished_at = ?,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL
      WHERE id = ?
        AND status = 'queued'
        AND EXISTS (
          SELECT 1
          FROM job_dependencies jd
          JOIN jobs dep ON dep.id = jd.depends_on_job_id
          WHERE jd.job_id = jobs.id
            AND jd.dependency_kind = 'hard'
            AND dep.status IN (${DEADLOCK_TERMINAL_STATUSES_SQL})
        )
    `);
    const canceled = [];
    const affectedWIs = new Set();
    // Fixed point: canceling one queued job can deadlock its dependents. Each
    // pass only updates rows still in queued state, so a changed row cannot be
    // canceled twice; if a pass makes no progress, the loop terminates.
    while (true) {
      const deadlocked = findDeadlockedJobs();
      if (deadlocked.length === 0) break;

      let changedThisPass = 0;
      for (const job of deadlocked) {
        const result = cancelStmt.run(ts, ts, job.id);
        if (result.changes <= 0) continue;
        changedThisPass++;
        canceled.push(job);
        if (job.work_item_id) affectedWIs.add(job.work_item_id);
        // Mirror every other terminal transition (updateJobStatus,
        // releaseLeaseInternal): a queued job can carry a prepared cross-WI
        // handoff + merge dependency. Without this rollback, deadlock-canceling
        // it strands a cross_wi_merge_dependencies entry whose syncing job will
        // never run, blocking the target WI's merge while the source stays
        // alive-but-unmerged. Already transaction-safe — we're inside the
        // canceller's runImmediateTransaction. (B1)
        rollbackPendingCrossWiSyncHandoffsForJob(job.id, "job_canceled");
        logEvent({
          work_item_id: job.work_item_id,
          job_id: job.id,
          event_type: EVENT_TYPES.JOB_STATUS_CHANGED,
          actor_type: EVENT_ACTORS.SYSTEM,
          message: "Status -> canceled",
        });
        logEvent({
          job_id: job.id,
          work_item_id: job.work_item_id,
          event_type: EVENT_TYPES.JOB_DEADLOCKED,
          actor_type: EVENT_ACTORS.SCHEDULER,
          actor_id: actorId,
          message: `Job deadlocked: hard dependency failed/dead_letter/canceled -> canceled${job.failed_deps ? ` (blocked by: ${job.failed_deps})` : ""}`,
        });
      }
      if (changedThisPass === 0) break;
    }
    for (const workItemId of affectedWIs) {
      invalidateSessionLanesForWorkItemInternal(workItemId, "deadlock_canceled");
    }
    if (canceled.length > 0) {
      notifyQueueStateChanged({
        reason: "job_deadlocked_canceled",
      });
    }
    return { canceled, affectedWorkItemIds: [...affectedWIs] };
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// AGENT CALLS
// ═════════════════════════════════════════════════════════════════════════════

export {
  createAgentCall,
  completeAgentCall,
  getAgentCalls,
  getAgentCallsByWorkItem,
  getAgentCallStats,
  getResearcherGuardrailStats,
  getScopeContextHealthMetrics,
  cleanupRunningAgentCalls,
  reconcileOrphanedAgentCalls,
  listAgentCalls,
  listWorkItemsWithCallRollups,
  getAgentCallsWithToolCountsByWorkItem,
  getAgentCallById,
  getToolInvocationsForAgentCall,
} from "./agent-calls.js";

export {
  acknowledgeOperatorFeedback,
  answerAgentQuestion,
  applyActiveAgentInteractionsForAttempt,
  buildOperatorGuidanceForAttempt,
  countPendingOperatorFeedbackForJob,
  createAgentInteraction,
  createAgentQuestion,
  createOperatorNudge,
  expireUnackedOperatorFeedbackForJob,
  getOperatorFeedbackForJob,
  hasPendingOperatorFeedbackForJob,
  listActiveAgentGuidanceForJob,
  listAgentInteractions,
  recordAgentActivity,
} from "./agent-interactions.js";


// ═════════════════════════════════════════════════════════════════════════════
// STEP 0 — Historical context for silent pre-flight
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// RUN INSIGHTS — Kaizen feedback loop
// ═════════════════════════════════════════════════════════════════════════════
