import { getJob, getWorkItem, parseJobPayload } from "../../../queue/functions/index.js";
import { researchUsesReportProfile } from "../../../research/functions/output-routing.js";

// Derive the projection from the current authenticated job binding, using the
// same workflow facts as researcher prompt selection. Missing/legacy context
// retains the general schema. Never infer a workflow from request prose.
export function researcherReportOnlyForSession({ role, jobId, workItemId } = {}) {
  if (role !== "researcher" || !(Number(jobId) > 0) || !(Number(workItemId) > 0)) return false;
  try {
    const job = getJob(Number(jobId));
    if (job?.job_type !== "research" || Number(job.work_item_id) !== Number(workItemId)) return false;
    const workItem = getWorkItem(Number(workItemId));
    return !!workItem && researchUsesReportProfile(workItem, parseJobPayload(job));
  } catch {
    // Schema narrowing is optional when the local workflow cannot be read.
    return false;
  }
}
