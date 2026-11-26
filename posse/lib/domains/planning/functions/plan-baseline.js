import { DEV_ROLE_JOB_TYPES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { getJob, updateJobPayload } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";

// Register the starting points with the compiled plan, before any child can
// be leased. Execution belongs to the worker; the compiler remains synchronous.
export function registerPlanBaseline(planJob, jobIds) {
  const groups = new Map();
  for (const id of jobIds) {
    const job = getJob(id);
    const payload = parseJobPayload(job);
    if (!job || !DEV_ROLE_JOB_TYPES.has(job.job_type) || TERMINAL_JOB_STATUSES.includes(job.status)
      || (payload.task_mode || "code") !== "code" || !/^[a-f0-9]{40}$/i.test(payload._plan_base_commit || "")) continue;
    const commit = payload._plan_base_commit;
    if (!groups.has(commit)) groups.set(commit, []);
    groups.get(commit).push(job.id);
    updateJobPayload(job.id, JSON.stringify({ ...payload, _plan_baseline_job_id: planJob.id }));
  }
  if (!groups.size) return;
  const payload = parseJobPayload(getJob(planJob.id));
  updateJobPayload(planJob.id, JSON.stringify({ ...payload, _development_baseline: {
    groups: [...groups].map(([commit, job_ids]) => ({ commit, job_ids })),
  } }));
}
