// Recovery transitions behind the work-item disposition gates
// (work-item-dispositions.js), and the maintenance sweep that keeps every
// failed or merge-deferred work item owning one.
//
// retry and accept reopen a failed work item without touching its branch or
// its cross-WI merge dependencies: the branch may carry edits handed off from
// an unmerged upstream, which must still merge first. Both act only on the
// failed leaf jobs (failed completion blockers), retire the gates that timed
// out with them, restore the jobs that were canceled only because those
// failed or because a database task was held for the merge, and hold again
// the database tasks that were canceled with the failure.
//
// rebuild discards a completed work item's branch and replans it from the
// target branch: every earlier job's commits went with the branch
// (requeueWorkItemAfterRejection's replan mode, which a review rejection
// that deleted the branch uses too).

import { getDb } from "../../../shared/storage/functions/index.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import {
  CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
  WORK_ITEM_DISPOSITION_REVIEW_TYPES,
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
} from "../../../catalog/human-input.js";
import {
  ACTIVE_LEASE_STATUSES,
  MUTATING_JOB_TYPES,
  NON_COMPLETION_BLOCKING_JOB_TYPES,
  TERMINAL_JOB_STATUSES_SQL,
} from "../../../catalog/job.js";
import { beginJobRetryGeneration, setAssessmentLifecycle } from "./attempts.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { now } from "./common.js";
import { rewireDependency } from "./dependencies.js";
import { flushEventsNow, logEvent } from "./events.js";
import { jobHasLiveLeaseAt } from "./lease-state.js";
import { parseJobPayload } from "./payload.js";
import {
  POST_MERGE_DB_HOLD_KEY,
  postMergeDbHoldRecord,
  rewireDependentAroundDbTask,
  rewiredDependentSummary,
} from "./post-merge-db-tasks.js";
import {
  appendReviewRejectionDescription,
  cancelHeldPostMergeDbTasksForWorkItem,
  completionBlockersForWorkItem,
  createJob,
  forceUpdateJobStatus,
  getJob,
  getIntSetting,
  getWorkItem,
  listJobsByWorkItem,
  listWorkItems,
  openCrossWiUpstreamDispositionGate,
  openWorkItemFailureDispositionGate,
  refreshWorkItemStatus,
  reholdPostMergeDbTasksForWorkItem,
  requeueWorkItemAfterRejection,
  runInTransaction,
  settleCrossWiUpstreamDispositionGate,
  updateJobPayload,
} from "./queue-store.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import {
  WORK_ITEM_DISPOSITION_BACKFILL_WINDOW_MS,
  acceptanceRefusalMessage,
  failedLeafJobs,
  failedWorkItemAcceptance,
  failedWorkItemRestorationPlan,
  recoverableHeldDbTasks,
  staleCrossWiUpstreams,
  supersededFailedGateJobs,
} from "./work-item-dispositions.js";

const ACTIVE_LEASE_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);

function activeRequiredJob(jobs, gateJobId) {
  return jobs.find((job) => (
    ACTIVE_LEASE_STATUS_SET.has(job.status)
    && !NON_COMPLETION_BLOCKING_JOB_TYPES.has(job.job_type)
    && Number(job.id) !== Number(gateJobId)
  )) || null;
}

function failedWorkItemRecoveryContext(workItemId, gateJobId) {
  const workItem = getWorkItem(workItemId);
  if (!workItem) return { ok: false, reason: "no_such_wi" };
  if (workItem.status !== "failed") {
    return { ok: false, reason: "work_item_not_failed", status: workItem.status };
  }
  const jobs = listJobsByWorkItem(workItemId);
  const active = activeRequiredJob(jobs, gateJobId);
  if (active) return { ok: false, reason: "active_required_job", job_id: Number(active.id) };
  const blockers = completionBlockersForWorkItem(workItemId);
  return {
    ok: true,
    workItem,
    jobs,
    leaves: failedLeafJobs(blockers),
    supersededGates: supersededFailedGateJobs(blockers),
  };
}

// A gate that timed out with the job it decided asks nothing anymore; left
// failed it would fail the recovered work item again.
function retireSupersededGates(gates, { gateJobId }) {
  const retired = [];
  for (const gate of gates) {
    if (!forceUpdateJobStatus(gate.id, "canceled", { expectedStatuses: [gate.status] })) continue;
    getDb().prepare(`
      UPDATE jobs SET last_error = COALESCE(last_error, ?), updated_at = ? WHERE id = ?
    `).run(`Superseded by work-item recovery gate #${gateJobId ?? "?"}`, now(), gate.id);
    retired.push(Number(gate.id));
  }
  return retired;
}

// Move a restored dependent off the held database task (or retired gate) it
// waited on, and record the move in the task's hold record so its post-merge
// gate no longer asks the operator to re-queue a job that already ran.
function applyRestorationRewires(rewires, { ts }) {
  const failed = new Set();
  for (const rewire of rewires) {
    const jobId = Number(rewire.job.id);
    if (rewire.db_task) {
      const result = rewireDependentAroundDbTask(jobId, rewire.db_task, rewire.to_job_ids);
      if (!result.rewired) {
        failed.add(jobId);
        continue;
      }
      const task = getJob(rewire.db_task.id) || rewire.db_task;
      const record = postMergeDbHoldRecord(task) || {};
      const canceled = Array.isArray(record.canceled_dependents) ? record.canceled_dependents : [];
      const rewired = Array.isArray(record.rewired_dependents) ? record.rewired_dependents : [];
      updateJobPayload(task.id, JSON.stringify({
        ...parseJobPayload(task),
        [POST_MERGE_DB_HOLD_KEY]: {
          ...record,
          canceled_dependents: canceled.filter((entry) => Number(entry?.job_id) !== jobId),
          rewired_dependents: [
            ...rewired.filter((entry) => Number(entry?.job_id) !== jobId),
            {
              ...rewiredDependentSummary(rewire.job, { dbJobId: task.id, upstreamJobIds: result.inserted.length > 0 ? result.inserted : rewire.to_job_ids }),
              restored_at: ts,
            },
          ],
        },
      }));
    } else if (!rewireDependency(jobId, rewire.from_job_id, rewire.to_job_ids[0])) {
      failed.add(jobId);
    }
  }
  return failed;
}

/**
 * Requeue what failedWorkItemRestorationPlan restores after `rerunJobIds`.
 * A job whose rewire was refused stays canceled.
 */
function restoreCanceledDependents(workItemId, rerunJobIds, { ts, gateJobId, supersededGates, restoreHeldDependents = true }) {
  const plan = failedWorkItemRestorationPlan(workItemId, rerunJobIds, { supersededGates, restoreHeldDependents });
  const refused = applyRestorationRewires(plan.rewires, { ts });
  const restored = [];
  for (const job of plan.restored) {
    if (refused.has(Number(job.id))) continue;
    if (requeueForRecovery(job, { ts, gateJobId, note: null, key: "_failure_recovery_restored" })) restored.push(job);
  }
  return {
    restored,
    rewired: plan.rewires
      .filter((rewire) => rewire.db_task && !refused.has(Number(rewire.job.id)))
      .map((rewire) => Number(rewire.job.id)),
  };
}

function requeueForRecovery(job, { ts, gateJobId, note, key }) {
  const fresh = getJob(job.id) || job;
  const payload = parseJobPayload(fresh);
  delete payload._assess_only;
  if (note) {
    const instructionKey = fresh.job_type === "fix" && String(payload.fix_instructions || "").trim()
      ? "fix_instructions"
      : "task_spec";
    payload[instructionKey] = [
      String(payload[instructionKey] || payload.task_spec || fresh.title || "").trim(),
      `OPERATOR RECOVERY NOTE:\n${note}`,
    ].filter(Boolean).join("\n\n");
  }
  payload[key] = { at: ts, gate_job_id: gateJobId, prior_status: fresh.status };
  beginJobRetryGeneration(fresh.id, {
    payload,
    attemptBudget: getIntSetting(SETTING_KEYS.DEFAULT_MAX_ATTEMPTS, 3),
  });
  if (!forceUpdateJobStatus(fresh.id, "queued", { expectedStatuses: [fresh.status] })) return false;
  getDb().prepare(`
    UPDATE jobs
    SET assessor_verdict = 'not_assessed',
        assessor_confidence = NULL,
        result_json = NULL,
        last_error = NULL,
        ready_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(ts, ts, fresh.id);
  setAssessmentLifecycle(fresh.id, "not_started");
  return true;
}

function reopenFailedWorkItem(workItemId, status, reason) {
  const ts = now();
  const result = getDb().prepare(`
    UPDATE work_items
    SET status = ?, merge_state = NULL, completed_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'failed'
  `).run(status, ts, workItemId);
  if (result.changes !== 1) throw new Error(`WI#${workItemId} left failed status during recovery`);
  logEvent({
    work_item_id: workItemId,
    event_type: EVENT_TYPES.WORK_ITEM_STATUS_CHANGED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Status -> ${status} (${reason})`,
  });
  notifyQueueStateChanged({ reason: `work_item_status_${status}`, workItemId });
}

/**
 * "retry": requeue the failed leaf jobs on the existing branch, keeping its
 * commits. With no failed job left (a failed completion contract), replan.
 */
export function retryFailedWorkItem(workItemId, {
  gateJobId = null,
  note = null,
  actorType = EVENT_ACTORS.HUMAN,
  actorLabel = "Human",
} = {}) {
  flushEventsNow();
  return runInTransaction(() => {
    const context = failedWorkItemRecoveryContext(workItemId, gateJobId);
    if (!context.ok) return context;
    const { workItem, leaves, supersededGates } = context;
    const ts = now();
    const trimmedNote = String(note || "").trim().slice(0, 2000) || null;
    const requeued = [];
    for (const job of leaves) {
      if (requeueForRecovery(job, { ts, gateJobId, note: trimmedNote, key: "_failure_recovery_retry" })) {
        requeued.push(Number(job.id));
      }
    }
    const retiredGates = retireSupersededGates(supersededGates, { gateJobId });
    const replanned = leaves.length === 0 && supersededGates.length === 0;
    if (replanned) {
      const plan = createJob({
        work_item_id: workItemId,
        job_type: "plan",
        title: `Replan after failure recovery: ${String(workItem.title || `WI#${workItemId}`).slice(0, 80)}`,
        priority: workItem.priority || "normal",
        payload_json: JSON.stringify({
          task_spec: [workItem.description || workItem.title || `Replan WI#${workItemId}`, trimmedNote]
            .filter(Boolean).join("\n\nOPERATOR RECOVERY NOTE:\n"),
          replan_after_failure_recovery: true,
        }),
      });
      requeued.push(Number(plan.id));
    }
    // A replan plans the remaining work afresh; it does not bring back the
    // old plan's jobs that a database hold canceled.
    const { restored, rewired } = restoreCanceledDependents(workItemId, requeued, {
      ts,
      gateJobId,
      supersededGates,
      restoreHeldDependents: !replanned,
    });
    const reheld = reholdPostMergeDbTasksForWorkItem(workItemId);
    reopenFailedWorkItem(workItemId, "queued", "failure recovery retry");
    logEvent({
      work_item_id: workItemId,
      job_id: gateJobId,
      event_type: EVENT_TYPES.WORK_ITEM_DISPOSITION_RESOLVED,
      actor_type: actorType,
      message: `${actorLabel} retried failed WI#${workItemId}: ${requeued.length > 0 ? `requeued ${requeued.map((id) => `#${id}`).join(", ")}` : "nothing to requeue"}${restored.length > 0 ? `; restored ${restored.map((job) => `#${job.id}`).join(", ")}` : ""}${retiredGates.length > 0 ? `; retired timed-out gate(s) ${retiredGates.map((id) => `#${id}`).join(", ")}` : ""}`,
      event_json: JSON.stringify({
        gate_job_id: gateJobId,
        review_type: WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
        action: "retry",
        requeued_job_ids: requeued,
        restored_job_ids: restored.map((job) => Number(job.id)),
        rewired_held_dependent_ids: rewired,
        retired_gate_job_ids: retiredGates,
        reheld_db_task_ids: reheld,
        branch_name: workItem.branch_name || null,
      }),
    });
    refreshWorkItemStatus(workItemId);
    return {
      ok: true,
      requeued_job_ids: requeued,
      restored_job_ids: restored.map((job) => Number(job.id)),
      rewired_held_dependent_ids: rewired,
      retired_gate_job_ids: retiredGates,
      reheld_db_task_ids: reheld,
      status: getWorkItem(workItemId)?.status || null,
    };
  });
}

/** Whether "accept" can apply now; the refusal message names what blocks it. */
export function failedWorkItemAcceptancePlan(workItemId, { gateJobId = null } = {}) {
  const context = failedWorkItemRecoveryContext(workItemId, gateJobId);
  if (!context.ok) return context;
  const acceptance = failedWorkItemAcceptance(context.leaves);
  return acceptance.ok
    ? { ok: true, acceptable: acceptance.acceptable, supersededGates: context.supersededGates }
    : { ok: false, reason: acceptance.reason, message: acceptanceRefusalMessage(workItemId, acceptance) };
}

/**
 * "accept": operator-pass the failed leaf jobs whose failure was
 * assessment-only, mark their assessment waived, and let the work item
 * complete into the normal pending_review -> merge flow. This is what the
 * WI 167 operator script did by hand.
 */
export function acceptFailedWorkItem(workItemId, {
  gateJobId = null,
  actorType = EVENT_ACTORS.HUMAN,
  actorLabel = "Human",
} = {}) {
  flushEventsNow();
  return runInTransaction(() => {
    const plan = failedWorkItemAcceptancePlan(workItemId, { gateJobId });
    if (!plan.ok) return plan;
    const ts = now();
    const retiredGates = retireSupersededGates(plan.supersededGates, { gateJobId });
    const accepted = [];
    for (const job of plan.acceptable) {
      if (!forceUpdateJobStatus(job.id, "succeeded", { expectedStatuses: ["failed"] })) {
        throw new Error(`Job #${job.id} changed state while it was being accepted`);
      }
      setAssessmentLifecycle(job.id, "assessment_waived", { completed: true });
      logEvent({
        work_item_id: workItemId,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_REVIEW_RESOLVED,
        actor_type: actorType,
        message: `${actorLabel} accepted job #${job.id} via work-item recovery gate${gateJobId ? ` #${gateJobId}` : ""}; its failure was assessment-only and the assessor verdict is preserved`,
        event_json: JSON.stringify({
          human_resolution: "pass",
          resolution_job_id: gateJobId,
          recovery: WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
          assessor_verdict_preserved: job.assessor_verdict,
          assessor_confidence_preserved: job.assessor_confidence || null,
          assessor_state_version: getJob(job.id)?.state_version || job.state_version || 0,
        }),
      });
      accepted.push(Number(job.id));
    }
    const { restored, rewired } = restoreCanceledDependents(workItemId, accepted, {
      ts,
      gateJobId,
      supersededGates: plan.supersededGates,
    });
    const reheld = reholdPostMergeDbTasksForWorkItem(workItemId);
    reopenFailedWorkItem(workItemId, "running", "failure recovery accept");
    logEvent({
      work_item_id: workItemId,
      job_id: gateJobId,
      event_type: EVENT_TYPES.WORK_ITEM_DISPOSITION_RESOLVED,
      actor_type: actorType,
      message: `${actorLabel} accepted failed WI#${workItemId}: passed ${accepted.map((id) => `#${id}`).join(", ")}${restored.length > 0 ? `; restored ${restored.map((job) => `#${job.id}`).join(", ")}` : ""}`,
      event_json: JSON.stringify({
        gate_job_id: gateJobId,
        review_type: WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
        action: "accept",
        accepted_job_ids: accepted,
        restored_job_ids: restored.map((job) => Number(job.id)),
        rewired_held_dependent_ids: rewired,
        retired_gate_job_ids: retiredGates,
        reheld_db_task_ids: reheld,
      }),
    });
    refreshWorkItemStatus(workItemId);
    const fresh = getWorkItem(workItemId);
    return {
      ok: true,
      accepted_job_ids: accepted,
      restored_job_ids: restored.map((job) => Number(job.id)),
      rewired_held_dependent_ids: rewired,
      retired_gate_job_ids: retiredGates,
      reheld_db_task_ids: reheld,
      status: fresh?.status || null,
      merge_state: fresh?.merge_state || null,
    };
  });
}

/**
 * "rebuild": replan a completed work item whose upstream failed or was
 * canceled, after the caller deleted its branch.
 *
 * The branch took every earlier job's commits with it, so requeuing only the
 * leaf jobs (the review-rejection default) would re-run fix jobs against code
 * that no longer exists and leave their parents' work undone (WI 169: API
 * 2184 and UI 2185 stayed failed while fixes 2238/2243 started on a fresh
 * branch). Requeuing every planned job instead would have to undo the
 * dependency rewires of fixes, database holds and dead-letter recovery, and
 * scrub per-job state accumulated on the old branch. A new plan job rebuilds
 * a consistent job graph from the work item and its research at the price of
 * one planner call, so that is what rebuild does, through the replan mode of
 * requeueWorkItemAfterRejection: every pending job and every implementation
 * job of the old plan is canceled (a succeeded one's commits are gone, and a
 * later replan must not count it as retained work), the plan is the only
 * work left, and the work item description carries the rebuild note for the
 * planner and every later job. The plan's task names the discarded plan and
 * every database task that already ran, including ones an earlier rebuild
 * canceled (recorded on the work item).
 *
 * Database tasks held for the discarded branch's merge are canceled and
 * marked superseded, so no recovery holds them again and no post-merge gate
 * opens for them: the replan plans its own. The cross-WI file syncs the
 * branch applied are forgotten too: otherwise a later handoff out of this
 * work item would still claim to carry the failed upstream's edits and make
 * its taker wait on that merge.
 */
export function rebuildWorkItemOnTarget(workItemId, { gateJobId = null, feedback = null } = {}) {
  flushEventsNow();
  return runInTransaction(() => {
    const workItem = getWorkItem(workItemId);
    if (!workItem) return { ok: false, reason: "no_such_wi" };
    if (String(workItem.branch_name || "").trim()) return { ok: false, reason: "branch_not_deleted" };
    const jobsBefore = listJobsByWorkItem(workItemId);
    const preserved = gateJobId == null ? null : Number(gateJobId);
    const heldDbTasks = recoverableHeldDbTasks(jobsBefore.filter((job) => Number(job.id) !== preserved));
    const droppedSyncRecords = jobsBefore.reduce((count, job) => {
      const applied = parseJobPayload(job)._cross_wi_file_syncs_applied;
      return count + (Array.isArray(applied) ? applied.length : 0);
    }, 0);
    const note = String(feedback || "REBUILD ON THE TARGET BRANCH: the branch was deleted; re-implement this work item on the current target branch.").trim();
    const description = appendReviewRejectionDescription(workItem.description, note);
    const ts = now();
    const planJobId = requeueWorkItemAfterRejection(workItemId, {
      description,
      feedback: note,
      preserveJobIds: gateJobId == null ? [] : [gateJobId],
      replan: {
        title: `Rebuild on the target branch: ${String(workItem.title || `WI#${workItemId}`).slice(0, 80)}`,
        gateJobId,
        payload: {
          replan_after_rebuild: true,
          rebuild_on_target: {
            at: ts,
            gate_job_id: gateJobId == null ? null : Number(gateJobId),
            previous_job_ids: jobsBefore
              .filter((job) => MUTATING_JOB_TYPES.has(job.job_type))
              .map((job) => Number(job.id)),
            superseded_db_task_ids: heldDbTasks.map((job) => Number(job.id)),
          },
        },
      },
    });
    if (!planJobId || planJobId === true) return { ok: false, reason: "requeue_failed" };
    return {
      ok: true,
      plan_job_id: planJobId,
      superseded_db_task_ids: heldDbTasks
        .filter((job) => postMergeDbHoldRecord(getJob(job.id) || job)?.superseded_by_rebuild)
        .map((job) => Number(job.id)),
      dropped_sync_records: droppedSyncRecords,
    };
  });
}

function activeDispositionGates() {
  const placeholders = WORK_ITEM_DISPOSITION_REVIEW_TYPES.map(() => "?").join(",");
  return getDb().prepare(`
    SELECT j.*, hg.gate_state
    FROM jobs j
    JOIN human_gates hg ON hg.gate_job_id = j.id
    WHERE j.job_type = 'human_input'
      AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      AND hg.gate_state = 'open'
      AND CASE WHEN json_valid(j.payload_json)
        THEN json_extract(j.payload_json, '$.review_type')
        ELSE NULL END IN (${placeholders})
  `).all(...WORK_ITEM_DISPOSITION_REVIEW_TYPES);
}

function retireDispositionGate(gate, reason) {
  if (!forceUpdateJobStatus(gate.id, "canceled", { expectedStatuses: [gate.status] })) return false;
  getDb().prepare(`
    UPDATE jobs SET last_error = COALESCE(last_error, ?), updated_at = ? WHERE id = ?
  `).run(reason, now(), gate.id);
  return true;
}

/**
 * Gate maintenance, run at startup and with the scheduler's human-gate sweep:
 * cancel database tasks orphaned behind a failed or canceled work item,
 * retire or settle disposition gates whose question went away, and open the
 * gates a transition missed (a crash, or a queue from before these gates).
 */
export function reconcileWorkItemDispositionGates({
  backfillWindowMs = WORK_ITEM_DISPOSITION_BACKFILL_WINDOW_MS,
  nowMs = Date.now(),
} = {}) {
  flushEventsNow();
  return runInTransaction(() => {
    const result = {
      held_db_tasks_canceled: 0,
      failure_gates_opened: 0,
      upstream_gates_opened: 0,
      gates_settled: 0,
      gates_retired: 0,
    };
    for (const row of getDb().prepare(`
      SELECT DISTINCT wi.id, wi.status
      FROM jobs j
      JOIN work_items wi ON wi.id = j.work_item_id
      WHERE wi.status IN ('failed', 'canceled')
        AND j.status = 'waiting_on_human'
        AND j.job_type = 'dev'
        AND CASE WHEN json_valid(j.payload_json)
          THEN json_extract(j.payload_json, '$.${POST_MERGE_DB_HOLD_KEY}') IS NOT NULL
          ELSE 0 END
    `).all()) {
      result.held_db_tasks_canceled += cancelHeldPostMergeDbTasksForWorkItem(row.id, row.status);
    }

    const observedAt = now();
    for (const gate of activeDispositionGates()) {
      if (jobHasLiveLeaseAt(gate, observedAt)) continue;
      const workItem = getWorkItem(gate.work_item_id);
      const reviewType = parseJobPayload(gate).review_type;
      if (reviewType === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE) {
        if (workItem?.status === "failed") continue;
        if (retireDispositionGate(gate, `Work item is ${workItem?.status || "gone"}; its failure recovery question no longer applies`)) {
          result.gates_retired += 1;
        }
      } else if (reviewType === CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE) {
        if (!workItem || workItem.status !== "complete" || workItem.merge_state === "merged") {
          if (retireDispositionGate(gate, "Work item is no longer waiting to merge")) result.gates_retired += 1;
        } else if (staleCrossWiUpstreams(workItem).length === 0
          && settleCrossWiUpstreamDispositionGate(gate.id, { reason: "upstream_merged_or_dependency_removed" })) {
          result.gates_settled += 1;
        }
      }
    }

    const cutoffMs = nowMs - Math.max(0, Number(backfillWindowMs) || 0);
    for (const workItem of listWorkItems(["failed"])) {
      const failedAtMs = Date.parse(workItem.completed_at || workItem.updated_at || "");
      if (Number.isFinite(failedAtMs) && failedAtMs < cutoffMs) continue;
      if (openWorkItemFailureDispositionGate(workItem.id)) result.failure_gates_opened += 1;
    }
    for (const workItem of listWorkItems(["complete"])) {
      if (workItem.merge_state === "merged") continue;
      if (openCrossWiUpstreamDispositionGate(workItem.id)) result.upstream_gates_opened += 1;
    }
    return result;
  });
}
