import { forceUpdateJobStatus, listJobsByWorkItem, logEvent } from "../../queue/functions/index.js";
import { ACTIVE_LEASE_STATUSES, STALE_CANCELABLE_JOB_STATUSES } from "../../queue/functions/common.js";
import { C } from "../../../shared/format/functions/colors.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

export function cancelSupersededPlanChildren(worker, planJob) {
  if (!planJob?.id || !planJob?.work_item_id || planJob.job_type !== "plan") return 0;
  const allJobs = listJobsByWorkItem(planJob.work_item_id);
  const currentPlanId = Number(planJob.id);
  const olderPlanIds = new Set(allJobs
    .filter((job) =>
      job.job_type === "plan"
      && Number(job.id) < currentPlanId
      && job.status !== "canceled")
    .map((job) => job.id));
  if (olderPlanIds.size === 0) return 0;

  const staleStatuses = new Set(STALE_CANCELABLE_JOB_STATUSES);
  const activeStatuses = new Set(ACTIVE_LEASE_STATUSES);
  let canceledCount = 0;
  let activeOlderCount = 0;
  for (const job of allJobs) {
    if (!olderPlanIds.has(job.parent_job_id)) continue;
    if (activeStatuses.has(job.status)) {
      activeOlderCount += 1;
      continue;
    }
    if (!staleStatuses.has(job.status)) continue;
    if (!forceUpdateJobStatus(job.id, "canceled")) continue;
    canceledCount += 1;
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.JOB_CANCELED_BY_SUPERSEDING_PLAN,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Canceled stale queued child of plan #${job.parent_job_id}; superseded by plan #${planJob.id}`,
      event_json: JSON.stringify({ superseding_plan_id: planJob.id, stale_plan_id: job.parent_job_id }),
    });
  }
  if (canceledCount > 0 || activeOlderCount > 0) {
    const parts = [];
    if (canceledCount > 0) parts.push(`canceled ${canceledCount} queued job(s) from older plan wave(s)`);
    if (activeOlderCount > 0) parts.push(`${activeOlderCount} active older-plan job(s) already running`);
    worker?.emit?.(planJob.id, `${C.yellow}[plan-validate]${C.reset} WI#${planJob.work_item_id}: ${parts.join("; ")}`);
  }
  return canceledCount;
}
