import { setTimeout as delay } from "node:timers/promises";
import {
  createJob, getJob, getLatestAttempt, getHumanGate, listJobsByWorkItem,
  runInTransaction, updateJobPayload, supersedeHumanGate, forceUpdateJobStatus,
  requestEnvironmentSetupResume, environmentSetupResumeGranted, readRuntimeStatus, RUNTIME_STATUS_KEYS,
} from "../../queue/functions/index.js";
import { ENVIRONMENT_SETUP_REVIEW_TYPE, ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS, ENVIRONMENT_SETUP_LIVE_MAX_MS, ENVIRONMENT_SETUP_RESUME_WAIT_MAX_MS } from "../../../catalog/tools/environment-setup.js";
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
  assertActive(context);
  const proposal = await prepareEnvironmentSetup(tool, args, context);
  return runInTransaction(() => {
    const job = assertActive(context);
    const open = listJobsByWorkItem(job.work_item_id).filter((entry) => entry.job_type === "human_input"
      && payload(entry).review_type === ENVIRONMENT_SETUP_REVIEW_TYPE
      && Number(payload(entry).original_job_id) === job.id
      && ["open", "resolving"].includes(getHumanGate(entry.id)?.gate_state));
    // An earlier attempt's approval can never run; retire it instead of making
    // the user answer a question nobody is waiting on.
    for (const stale of open.filter((entry) => Number(payload(entry).attempt_id) !== Number(context.attemptId))) {
      supersedeHumanGate(stale.id, "A newer attempt of the requesting job replaced this setup request.");
      forceUpdateJobStatus(stale.id, "canceled");
    }
    const pending = open.find((entry) => Number(payload(entry).attempt_id) === Number(context.attemptId));
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
    // Only a proposal the user can actually decide makes planning wait for
    // setup; a rejected request leaves the caller free to revise or continue.
    const requestedAt = Date.now();
    updateJobPayload(job.id, JSON.stringify({
      ...payload(job),
      ...(tool === "setup_environment" && job.job_type === "plan" ? { _environment_setup_pending: true } : {}),
      _environment_setup_live: {
        approval_job_id: gate.id,
        attempt_id: context.attemptId,
        requested_at: new Date(requestedAt).toISOString(),
        deadline_at: new Date(requestedAt + ENVIRONMENT_SETUP_LIVE_MAX_MS).toISOString(),
      },
    }));
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

export async function awaitEnvironmentSetupDecision({ request, context, signal, timeoutMs = ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS, pollMs = 200 }) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Environment setup approval canceled.");
      if (Date.now() >= deadline) throw new Error("Environment setup approval expired. Request a new approval to retry.");
      const { job, gate } = approvedRequest(request, context);
      if (gate?.gate_state === "resolved") {
        const resolution = JSON.parse(gate.resolution_payload_json || "{}");
        const explicit = resolution.source === "human" && resolution.unattended !== true;
        if (gate.resolution_action !== "approve" || !explicit) {
          return explicit
            ? { ok: false, approved: false, status: "rejected", explicit: true, message: "The user rejected this setup; no installer ran. Plan without it, or propose a revised batch." }
            : { ok: false, approved: false, status: "rejected", message: "No installer ran. Explicit user approval is required." };
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

function clearLiveEnvironmentSetup(jobId, approvalJobId, { declined = false } = {}) {
  runInTransaction(() => {
    const job = getJob(jobId);
    const data = payload(job);
    if (!job || Number(data._environment_setup_live?.approval_job_id) !== Number(approvalJobId)) return;
    const { _environment_setup_live: _settled, ...rest } = data;
    // The user's explicit rejection is an answer: the plan proceeds without
    // that setup instead of asking again before development.
    updateJobPayload(job.id, JSON.stringify(declined && rest._environment_setup_pending === true ? { ...rest, _environment_setup_pending: false } : rest));
  });
}

// The scheduler heartbeat is written about every ten seconds; a heartbeat
// older than this means no scheduler is running to grant a resume.
const SCHEDULER_HEARTBEAT_FRESH_MS = 60_000;

function schedulerHeartbeatFresh(nowMs = Date.now()) {
  try {
    const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER);
    const heartbeat = Date.parse(String(status?.heartbeat_at || ""));
    return Number.isFinite(heartbeat) && nowMs - heartbeat <= SCHEDULER_HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

// The call parked its agent's compute slot while it waited; before the agent
// resumes it takes a slot back from the scheduler, which grants one per free
// slot. The wait is bounded by the resume budget and by the marker's own
// deadline, and skipped when no scheduler is alive to grant, so a missing
// scheduler never deadlocks the call: the agent then resumes over
// concurrency by one until a worker finishes, as it always did.
export async function awaitComputeSlotForResume(request, context, { signal = null, timeoutMs = ENVIRONMENT_SETUP_RESUME_WAIT_MAX_MS, pollMs = 250 } = {}) {
  const started = Date.now();
  if (!requestEnvironmentSetupResume(context.jobId, request.approval_job_id)) return { granted: false, waited_ms: 0, reason: "marker_missing" };
  const live = payload(getJob(context.jobId))._environment_setup_live;
  const deadline = Math.min(started + timeoutMs, Date.parse(String(live?.deadline_at || "")) - 30_000 || Infinity);
  while (true) {
    if (environmentSetupResumeGranted(getJob(context.jobId), request.approval_job_id)) return { granted: true, waited_ms: Date.now() - started, reason: null };
    if (signal?.aborted) return { granted: false, waited_ms: Date.now() - started, reason: "aborted" };
    if (Date.now() >= deadline) return { granted: false, waited_ms: Date.now() - started, reason: "timeout" };
    if (!schedulerHeartbeatFresh()) return { granted: false, waited_ms: Date.now() - started, reason: "scheduler_inactive" };
    try { await delay(pollMs, undefined, { signal }); } catch { /* aborted: reported on the next check */ }
  }
}

// One live setup call: wait for the user's decision, then run the approved
// request, then wait for a compute slot. The waiting job stops earning
// watchdog exemption when it settles.
export async function runEnvironmentSetupRequest(request, context, { signal = null, approvalTimeoutMs = ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS, resumeWaitMs = ENVIRONMENT_SETUP_RESUME_WAIT_MAX_MS } = {}) {
  let declined = false;
  try {
    const decision = await awaitEnvironmentSetupDecision({ request, context, signal, timeoutMs: approvalTimeoutMs });
    declined = decision.explicit === true;
    const result = decision.approved ? await executeApprovedEnvironmentSetup(request, context, { signal }) : decision;
    const resume = await awaitComputeSlotForResume(request, context, { signal, timeoutMs: resumeWaitMs });
    return { ...result, compute_resume: resume };
  } finally {
    try { clearLiveEnvironmentSetup(context.jobId, request.approval_job_id, { declined }); } catch { /* the marker's deadline bounds it */ }
  }
}
