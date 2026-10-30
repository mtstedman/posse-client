import { setTimeout as delay } from "node:timers/promises";
import { createJob, getJob, getLatestAttempt, getHumanGate, runInTransaction, updateJobPayload,
  supersedeHumanGate, forceUpdateJobStatus } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { awaitComputeSlotForResume } from "../../system/functions/environment-approval.js";
import { PLANNER_CLARIFICATION_REVIEW_TYPE, PLANNER_CLARIFICATION_TIMEOUT_MS,
  PLANNER_CLARIFICATION_LIVE_MAX_MS } from "../../../catalog/tools/planner-clarification.js";

function activePlanner(context) {
  const job = getJob(context.jobId);
  const attempt = getLatestAttempt(context.jobId);
  if (context.role !== "planner" || job?.job_type !== "plan" || job.status !== "running"
    || !context.attemptId || Number(attempt?.id) !== Number(context.attemptId) || attempt.status !== "running") {
    throw new Error("Clarification requires the current running planner attempt.");
  }
  return job;
}

export function requestPlannerClarification(args, context) {
  if (!Array.isArray(args?.questions) || args.questions.length < 1 || args.questions.length > 3
    || args.questions.some((q) => typeof q !== "string" || !q.trim() || q.length > 1000)
    || typeof args.context !== "string" || !args.context.trim() || args.context.length > 2000) {
    throw new Error("Supply one to three concise questions and their context.");
  }
  return runInTransaction(() => {
    const job = activePlanner(context);
    const payload = parseJobPayload(job);
    const old = payload._environment_setup_live;
    if (old && Number(old.attempt_id) === Number(context.attemptId) && Date.parse(old.deadline_at) > Date.now()) {
      throw new Error("A human decision is already pending for this planner. Wait for its result.");
    }
    if (old?.approval_job_id && Number(old.attempt_id) !== Number(context.attemptId)) {
      supersedeHumanGate(old.approval_job_id, "The requesting planner attempt was replaced.");
      if (["queued", "running", "waiting_on_human"].includes(getJob(old.approval_job_id)?.status)) {
        forceUpdateJobStatus(old.approval_job_id, "canceled");
      }
    }
    const gate = createJob({ work_item_id: job.work_item_id, parent_job_id: job.id, job_type: "human_input",
      title: `Clarify: ${job.title}`.slice(0, 180), priority: "high", model_tier: "cheap",
      payload_json: JSON.stringify({ review_type: PLANNER_CLARIFICATION_REVIEW_TYPE, gate_kind: PLANNER_CLARIFICATION_REVIEW_TYPE,
        original_job_id: job.id, attempt_id: context.attemptId, questions: args.questions, context: args.context }),
    });
    const now = Date.now();
    // Reuse the attempt-bound parking protocol used by installer approvals;
    // no installer is proposed, approved, or run by a clarification.
    updateJobPayload(job.id, JSON.stringify({ ...payload, _environment_setup_live: {
      approval_job_id: gate.id, attempt_id: context.attemptId,
      requested_at: new Date(now).toISOString(), deadline_at: new Date(now + PLANNER_CLARIFICATION_LIVE_MAX_MS).toISOString(),
    } }));
    return { kind: PLANNER_CLARIFICATION_REVIEW_TYPE, request_id: `clarification-${gate.id}`, approval_job_id: gate.id };
  });
}

export async function runPlannerClarification(request, context, {
  signal = null, timeoutMs = PLANNER_CLARIFICATION_TIMEOUT_MS, pollMs = 200,
  resume = awaitComputeSlotForResume,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let result;
  try {
    while (true) {
      signal?.throwIfAborted();
      activePlanner(context);
      const gateJob = getJob(request.approval_job_id);
      const data = parseJobPayload(gateJob);
      const gate = getHumanGate(request.approval_job_id);
      if (data.review_type !== PLANNER_CLARIFICATION_REVIEW_TYPE || data.original_job_id !== context.jobId
        || Number(data.attempt_id) !== Number(context.attemptId)) throw new Error("Clarification does not belong to this planner attempt.");
      if (gate?.gate_state === "resolved") {
        const resolution = JSON.parse(gate.resolution_payload_json || "{}");
        result = { ok: true, status: "answered", answer: resolution.answer || "", source: resolution.source,
          unattended: resolution.unattended === true, gate_job_id: gateJob.id };
        break;
      }
      if (!gate || !["open", "resolving"].includes(gate.gate_state) || ["failed", "canceled"].includes(gateJob.status)) {
        throw new Error("Clarification is no longer active.");
      }
      if (Date.now() >= deadline) throw new Error("Clarification wait expired; use the terminal human-input fallback if an answer is still required.");
      await delay(pollMs, undefined, signal ? { signal } : {});
    }
  } catch (error) {
    supersedeHumanGate(request.approval_job_id, error.message);
    const gateJob = getJob(request.approval_job_id);
    if (gateJob && ["queued", "running", "waiting_on_human"].includes(gateJob.status)) forceUpdateJobStatus(gateJob.id, "canceled");
    result = { ok: false, status: "canceled", message: error.message };
  }
  try {
    const computeResume = await resume(request, context, { signal });
    return { ...result, compute_resume: computeResume };
  } finally {
    runInTransaction(() => {
      const job = getJob(context.jobId);
      const payload = parseJobPayload(job);
      if (Number(payload._environment_setup_live?.approval_job_id) !== Number(request.approval_job_id)) return;
      delete payload._environment_setup_live;
      updateJobPayload(job.id, JSON.stringify(payload));
    });
  }
}
