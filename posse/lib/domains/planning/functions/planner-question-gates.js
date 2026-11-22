// Planner human_input tasks and the gate that asks them.
//
// A plan has one open clarification gate: createJob returns the plan's open
// gate for a second human_input task instead of creating another. That task's
// questions are appended to the gate, and the gate payload records which
// question ids (`gate:<job>:<index>`, the bridge's question identity) belong
// to which planner task. Answering the gate answers all of its questions at
// once, so a task's dependents, which wait on the gate, are released only
// with their own questions answered.

import { humanGateStateAllowsAnswer } from "../../../catalog/human-input.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { now, runImmediateTransaction } from "../../queue/functions/common.js";
import { getHumanGate, reviseOpenHumanGateGeneration } from "../../queue/functions/human-gates.js";
import { getJob, updateJobPayload } from "../../queue/functions/index.js";
import { jobHasLiveLeaseAt } from "../../queue/functions/lease-state.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { AWAITING_ANSWER_GATE_JOB_STATUSES } from "../../../catalog/job.js";

// A gate in these states is not being presented or answered.
const AMENDABLE_GATE_JOB_STATUSES = new Set(AWAITING_ANSWER_GATE_JOB_STATUSES);

function gateQuestionId(gateJobId, index) {
  return `gate:${gateJobId}:${index}`;
}

// Questions compare by value: the gate holds a JSON copy of each one.
function questionKey(question) {
  return typeof question === "string" ? question : JSON.stringify(question);
}

/**
 * Put one planner task's questions on a gate and record them as the task's.
 * Questions the gate already carries are shared, not repeated. Returns
 * `{ ok: false, reason }` without changing anything when new questions would
 * have to be added to a gate that is being answered.
 */
export function placePlannerTaskQuestions(gateJobId, { questions = [], taskIndex = null, title = null } = {}) {
  return runImmediateTransaction(getDb(), () => {
    const job = getJob(gateJobId);
    const gate = getHumanGate(gateJobId);
    if (!job || !gate) return { ok: false, reason: "gate_not_found" };
    const payload = parseJobPayload(job);
    const existing = Array.isArray(payload.questions) ? payload.questions : [];
    const own = [...new Map(questions.map((question) => [questionKey(question), question])).values()];
    const existingKeys = existing.map(questionKey);
    const appended = own.filter((question) => !existingKeys.includes(questionKey(question)));
    if (appended.length > 0) {
      if (!humanGateStateAllowsAnswer(gate.gate_state)) return { ok: false, reason: `gate_${gate.gate_state}` };
      if (!AMENDABLE_GATE_JOB_STATUSES.has(job.status) || jobHasLiveLeaseAt(job, now())) {
        return { ok: false, reason: "gate_being_answered" };
      }
    }
    const nextQuestions = [...existing, ...appended];
    const nextKeys = nextQuestions.map(questionKey);
    const idOf = (question) => gateQuestionId(job.id, nextKeys.indexOf(questionKey(question)));
    const questionIds = own.map(idOf);
    const otherTasks = (Array.isArray(payload.planner_task_questions) ? payload.planner_task_questions : [])
      .filter((entry) => !(entry?.task_index === taskIndex && entry?.title === title));
    updateJobPayload(job.id, JSON.stringify({
      ...payload,
      questions: nextQuestions,
      planner_task_questions: [...otherTasks, { task_index: taskIndex, title, question_ids: questionIds }],
    }));
    if (appended.length > 0) {
      // A prompt rendered from the shorter question list must not answer it.
      const revision = reviseOpenHumanGateGeneration(job.id);
      if (!revision.ok) throw new Error(`gate #${job.id} could not invalidate its stale prompt: ${revision.reason}`);
    }
    return {
      ok: true,
      // Another task's questions were already on the gate.
      shared: otherTasks.length > 0 || (appended.length > 0 && existing.length > 0),
      question_ids: questionIds,
      appended_question_ids: appended.map(idOf),
    };
  });
}
