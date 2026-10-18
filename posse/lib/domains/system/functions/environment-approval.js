import { setTimeout as delay } from "node:timers/promises";
import {
  createJob, getJob, getLatestAttempt, getHumanGate, listJobsByWorkItem,
  runInTransaction, updateJobPayload, supersedeHumanGate, forceUpdateJobStatus,
} from "../../queue/functions/index.js";
import { ENVIRONMENT_SETUP_REVIEW_TYPE } from "../../../catalog/tools/environment-setup.js";
import { environmentSetupQuestion, executeEnvironmentSetup, prepareEnvironmentSetup } from "./project-environment.js";

function payload(job) { return JSON.parse(job?.payload_json || "{}"); }

function assertActive(context) {
  const job = getJob(context.jobId);
  const attempt = getLatestAttempt(context.jobId);
  if (!job || job.status !== "running" || !context.attemptId || Number(attempt?.id) !== Number(context.attemptId) || attempt.status !== "running") {
    throw new Error("Environment setup requires the current running job attempt; this request is stale.");
  }
  return job;
}

export async function requestEnvironmentSetup(tool, args, context) {
  const source = assertActive(context);
  if (tool === "setup_environment" && source.job_type === "plan") {
    updateJobPayload(source.id, JSON.stringify({ ...payload(source), _environment_setup_pending: true }));
  }
  const proposal = await prepareEnvironmentSetup(tool, args, context);
  return runInTransaction(() => {
    const job = assertActive(context);
    const pending = listJobsByWorkItem(job.work_item_id).find((entry) => entry.job_type === "human_input"
      && payload(entry).review_type === ENVIRONMENT_SETUP_REVIEW_TYPE
      && Number(payload(entry).original_job_id) === job.id
      && ["open", "resolving"].includes(getHumanGate(entry.id)?.gate_state));
    if (pending) throw new Error(`Environment setup approval #${pending.id} is already pending. Wait for its result before requesting another installer.`);
    const gate = createJob({
      work_item_id: job.work_item_id, parent_job_id: job.id, job_type: "human_input",
      title: `Approve environment setup: ${tool} ${args.path || "."}`.slice(0, 180),
      priority: "high", model_tier: "cheap",
      payload_json: JSON.stringify({
        original_job_id: job.id, review_type: ENVIRONMENT_SETUP_REVIEW_TYPE,
        requires_interactive_approval: true, attempt_id: context.attemptId,
        proposal, execution: null, questions: [environmentSetupQuestion(proposal)],
        context: "An installer is waiting for your decision. This approval is separate from file-scope approval and cannot be granted automatically.",
      }),
    });
    return { kind: ENVIRONMENT_SETUP_REVIEW_TYPE, request_id: `environment-${gate.id}`, approval_job_id: gate.id, digest: proposal.digest };
  });
}

function approvedRequest(request, context) {
  assertActive(context);
  const job = getJob(request.approval_job_id);
  const data = payload(job);
  const gate = getHumanGate(request.approval_job_id);
  if (data.review_type !== ENVIRONMENT_SETUP_REVIEW_TYPE || data.original_job_id !== context.jobId
    || Number(data.attempt_id) !== Number(context.attemptId) || data.proposal?.digest !== request.digest) {
    throw new Error("Environment setup approval does not match this job, attempt, and proposal.");
  }
  return { job, data, gate };
}

function requireHumanApproval(request, context) {
  const record = approvedRequest(request, context);
  const { job, data, gate } = record;
  const resolution = JSON.parse(gate?.resolution_payload_json || "{}");
  if (gate?.gate_state !== "resolved" || gate.resolution_action !== "approve"
    || resolution.source !== "human" || resolution.unattended === true
    || ["failed", "canceled"].includes(job.status)) throw new Error("Explicit user approval is missing.");
  if (data.execution) throw new Error("This installer approval has already been used. Inspect the result before requesting a new approval.");
  return record;
}

export async function awaitEnvironmentSetupDecision({ request, context, signal, timeoutMs = 60 * 60 * 1000, pollMs = 200 }) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Environment setup approval canceled.");
      if (Date.now() >= deadline) throw new Error("Environment setup approval expired. Request a new approval to retry.");
      const { job, gate } = approvedRequest(request, context);
      if (gate?.gate_state === "resolved") {
        const resolution = JSON.parse(gate.resolution_payload_json || "{}");
        if (gate.resolution_action !== "approve" || resolution.unattended === true || resolution.source !== "human") {
          return { ok: false, approved: false, status: "rejected", message: "No installer ran. Explicit user approval is required." };
        }
        return { ok: true, approved: true };
      }
      if (!gate || !["open", "resolving"].includes(gate.gate_state) || ["failed", "canceled"].includes(job.status)) {
        throw new Error("Environment setup approval is no longer active.");
      }
      await delay(pollMs, undefined, { signal });
    }
  } catch (error) {
    supersedeHumanGate(request.approval_job_id, error.message);
    const gateJob = getJob(request.approval_job_id);
    if (gateJob && ["queued", "running", "waiting_on_human"].includes(gateJob.status)) forceUpdateJobStatus(gateJob.id, "canceled");
    return { ok: false, approved: false, status: "canceled", message: error.message };
  }
}

export async function executeApprovedEnvironmentSetup(request, context, { execute = executeEnvironmentSetup, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setInterval(() => {
    try { assertActive(context); } catch { controller.abort(); }
  }, 200);
  timer.unref?.();
  const claim = () => runInTransaction(() => {
    const { job, data } = requireHumanApproval(request, context);
    // Persist BEFORE launching. A crash or retry never silently replays an
    // approved installer whose effects may already exist.
    updateJobPayload(job.id, JSON.stringify({ ...data, execution: { status: "started", at: new Date().toISOString() } }));
  });
  try {
    const { data } = requireHumanApproval(request, context);
    const result = await execute(data.proposal, context, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, beforeExecute: claim });
    runInTransaction(() => {
      const job = getJob(request.approval_job_id);
      const current = payload(job);
      updateJobPayload(job.id, JSON.stringify({ ...current, execution: { status: result.ok ? "completed" : "failed", at: new Date().toISOString(), result } }));
    });
    if (result.ok && data.proposal.tool === "setup_environment") {
      const source = getJob(context.jobId);
      updateJobPayload(source.id, JSON.stringify({ ...payload(source), _environment_setup_pending: false }));
    }
    return result;
  } catch (error) {
    return { ok: false, status: "blocked", message: error.message };
  } finally { clearInterval(timer); }
}
