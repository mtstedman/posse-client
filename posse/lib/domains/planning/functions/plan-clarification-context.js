import { listJobsByWorkItem } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { promptLiteral } from "../../../shared/format/functions/prompt-literals.js";

export function buildPlanClarificationContext(job) {
  const payload = parseJobPayload(job);
  if (!payload._planner_human_input_origin_plan_id) return "";
  const existingWork = listJobsByWorkItem(job.work_item_id)
    .filter((candidate) => !["plan", "research", "human_input", "atlas_warm", "preflight", "waiting_lane_prepare"].includes(candidate.job_type)
      && candidate.status !== "canceled")
    .map((candidate) => {
      const task = parseJobPayload(candidate);
      return {
        job_id: candidate.id,
        title: candidate.title,
        status: candidate.status,
        assessment_state: candidate.assessment_state,
        assessor_verdict: candidate.assessor_verdict,
        task_spec: String(task.task_spec || "").slice(0, 2000),
        files_to_modify: task.files_to_modify || [],
        files_to_create: task.files_to_create || [],
      };
    });
  return [
    "PLANNING AFTER HUMAN CLARIFICATION:",
    `Continue plan job #${payload._planner_human_input_origin_plan_id} with the HUMAN ANSWERS below incorporated.`,
    "Plan the remaining implementation and verification implied by those answers. A resolved question is not completed implementation.",
    "Existing jobs below remain owned by their current execution lanes; do not duplicate completed or scheduled work.",
    "If a necessary decision remains unresolved, ask a focused follow-up question. If no implementation remains, plan the necessary verification of the agreed scope.",
    promptLiteral("EXISTING WORK ITEM JOBS", JSON.stringify(existingWork, null, 2)),
  ].join("\n");
}
