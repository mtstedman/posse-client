import { PLANNER_EXISTING_JOB_PREFIX } from "../../../catalog/planning.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { getDb } from "../../../shared/storage/functions/index.js";

export function existingJobDependencyId(value) {
  if (typeof value !== "string" || !value.startsWith(PLANNER_EXISTING_JOB_PREFIX)) return null;
  const id = value.slice(PLANNER_EXISTING_JOB_PREFIX.length);
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null;
}

export function validExistingJobDependency(id, { workItemId, planJobId, db = getDb() }) {
  if (!Number.isSafeInteger(id) || id <= 0 || id === Number(planJobId)) return false;
  const job = db.prepare("SELECT work_item_id, status FROM jobs WHERE id = ?").get(id);
  return Boolean(job && Number(job.work_item_id) === Number(workItemId)
    && (job.status === "succeeded" || !TERMINAL_JOB_STATUSES.includes(job.status)));
}

function staleSiblingDependency(id, { workItemId, planJobId, db }) {
  if (!Number.isSafeInteger(id) || id <= 0 || id === Number(planJobId)) return false;
  const job = db.prepare("SELECT work_item_id, status FROM jobs WHERE id = ?").get(id);
  return Boolean(job && Number(job.work_item_id) === Number(workItemId)
    && job.status !== "succeeded" && TERMINAL_JOB_STATUSES.includes(job.status));
}

// A continuation can retain an unfinished predecessor and its prerequisites.
// Cleanup must not cancel those jobs merely because they belong to an old plan.
export function retainedExistingJobDependencies(tasks, { workItemId, planJobId, db = getDb() }) {
  const retained = new Set();
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if (task.depends_on_job_ids != null && !Array.isArray(task.depends_on_job_ids)) {
      throw new Error("depends_on_job_ids must be an array of existing job IDs");
    }
    for (const id of task.depends_on_job_ids || []) {
      if (!validExistingJobDependency(id, { workItemId, planJobId, db })) {
        // A sibling that was valid when the plan was staged can fail or be
        // canceled before compile. That drops only the dependent task (see
        // wirePlannerDependencies); anything else is a malformed plan.
        if (staleSiblingDependency(id, { workItemId, planJobId, db })) continue;
        throw new Error(`Invalid existing job dependency ${PLANNER_EXISTING_JOB_PREFIX}${id}: use a live or successful job from this work item`);
      }
      retained.add(id);
      for (const row of db.prepare(`WITH RECURSIVE predecessors(id) AS (
        SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?
        UNION SELECT d.depends_on_job_id FROM job_dependencies d JOIN predecessors p ON d.job_id = p.id
      ) SELECT id FROM predecessors`).all(id)) retained.add(row.id);
    }
  }
  return retained;
}
