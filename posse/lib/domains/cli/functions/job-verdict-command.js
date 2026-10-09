import { humanInputChoicesForPayload } from "../../../catalog/human-input.js";
import { PARKED_JOB_STATUSES, TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { WORK_ITEM_QUESTION_CHOICE_IDS } from "../../../catalog/native-tools.js";
import { createJob, getJob, listJobsByWorkItem, runInTransaction, updateJobStatus } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { runGateCommand } from "./gate-command.js";

/** Operator dispositions use the same durable resolver as TUI answers. */
export async function runJobVerdictCommand(argv = [], { projectDir } = {}) {
  const [action, id, ...rest] = argv;
  const jobId = Number(id);
  const validNote = rest.length === 0 || (rest.length === 2 && rest[0] === "--note" && rest[1].trim());
  if (!["pass", "fail"].includes(action) || !Number.isSafeInteger(jobId) || jobId <= 0 || !validNote) {
    return { ok: false, reason: "usage", message: "Usage: posse job pass|fail <job-id> [--note \"reason\"]" };
  }
  const note = rest[1] || "Operator reviewed the parked job.";
  const prepared = runInTransaction(() => {
    const job = getJob(jobId);
    if (!job || job.job_type === "human_input" || !PARKED_JOB_STATUSES.includes(job.status)) {
      return { ok: false, reason: "job_not_parked", message: "Only a parked implementation or assessment job can receive an operator verdict." };
    }
    const gates = listJobsByWorkItem(job.work_item_id).filter((entry) => entry.job_type === "human_input"
      && !TERMINAL_JOB_STATUSES.includes(entry.status)
      && (entry.parent_job_id === job.id || Number(parseJobPayload(entry).original_job_id) === job.id));
    if (gates.length > 0) {
      if (gates.length !== 1 || !humanInputChoicesForPayload(parseJobPayload(gates[0])).includes(action)) {
        return { ok: false, reason: "existing_gate", message: `Answer the existing gate first: ${gates.map((gate) => `#${gate.id}`).join(", ")}.` };
      }
      return { ok: true, gateId: gates[0].id };
    }
    const gate = createJob({ work_item_id: job.work_item_id, job_type: "human_input", parent_job_id: job.id,
      title: `Operator review: ${job.title}`, payload_json: JSON.stringify({ original_job_id: job.id,
        review_type: "needs_review", question_kind: "assessment_review",
        questions: ["Should this work pass or fail?"], context: [note],
        choices: WORK_ITEM_QUESTION_CHOICE_IDS.assessment_review,
      }),
    });
    updateJobStatus(job.id, "waiting_on_review");
    updateJobStatus(gate.id, "waiting_on_human");
    return { ok: true, gateId: gate.id };
  });
  if (!prepared.ok) return prepared;
  return runGateCommand(["answer", String(prepared.gateId), action, "--feedback", note], { projectDir });
}
