// Durable tombstone and bounded child settlement shared by terminal cleanup
// and startup GC. Physical inspection/removal is forbidden until `ready` is
// true; this keeps a preparatory child from recreating an asset after cleanup.

import { ACTIVE_LEASE_STATUSES, TERMINAL_JOB_STATUSES } from "../../queue/functions/common.js";
import {
  forceUpdateJobStatus,
  getJob,
  getWaitingLanePreparation,
  retireWaitingLanePreparation,
} from "../../queue/functions/index.js";
import { sleepMsAsync } from "./worktree-locks.js";

const ACTIVE_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);
const TERMINAL_STATUS_SET = new Set(TERMINAL_JOB_STATUSES);
const DEFAULT_WAIT_MS = 2_000;
const POLL_MS = 50;

function childIds(preparation) {
  return [...new Set([preparation?.git_job_id, preparation?.atlas_job_id]
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
}

export async function tombstoneWaitingLanePreparationForCleanup(preparation, {
  signal = null,
  waitMs = DEFAULT_WAIT_MS,
} = {}) {
  if (!preparation) return { ready: true, preparation: null, job_ids: [] };
  if (preparation.state === "active") {
    return { ready: false, active: true, preparation, job_ids: childIds(preparation) };
  }
  if (preparation.state === "poisoned") {
    return { ready: false, poisoned: true, preparation, job_ids: childIds(preparation) };
  }

  let retired = preparation;
  if (preparation.state !== "retired") {
    const transition = retireWaitingLanePreparation({
      workItemId: preparation.work_item_id,
      expectedVersion: preparation.version,
      reason: "physical_cleanup_tombstone",
    });
    if (transition.outcome !== "retired" || transition.preparation?.state !== "retired") {
      return {
        ready: false,
        conflict: true,
        preparation: transition.preparation || getWaitingLanePreparation(preparation.work_item_id),
        job_ids: childIds(transition.preparation || preparation),
      };
    }
    retired = transition.preparation;
  }

  const ids = childIds(retired);
  for (const id of ids) {
    const job = getJob(id);
    if (!job || TERMINAL_STATUS_SET.has(job.status) || ACTIVE_STATUS_SET.has(job.status)) continue;
    forceUpdateJobStatus(id, "canceled", { expectedStatuses: [job.status] });
  }

  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  while (Date.now() < deadline) {
    if (!ids.some((id) => ACTIVE_STATUS_SET.has(getJob(id)?.status))) {
      return { ready: true, preparation: retired, job_ids: ids };
    }
    await sleepMsAsync(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
  }
  const settled = !ids.some((id) => ACTIVE_STATUS_SET.has(getJob(id)?.status));
  return {
    ready: settled,
    deferred: !settled,
    preparation: retired,
    job_ids: ids,
  };
}
