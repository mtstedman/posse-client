import {
  BRIDGE_ALLOWED_COMMANDS,
  BRIDGE_COMMANDS,
  BRIDGE_FRAME_TYPES,
  BRIDGE_PROTOCOL_VERSION,
} from "../../../catalog/bridge.js";
import {
  approvePlan,
  rejectPlan,
  respawnAfterRejection,
} from "../../planning/functions/plan-approval.js";
import { getJob, logEvent, updateWorkItemStatus } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  collectStateSnapshot,
  getWorkItemState,
  listGatesState,
  listJobsState,
  listQueueState,
  tailEventsEnvelope,
} from "./state-snapshot.js";
import { answerHumanInput } from "./human-input-answer.js";
import { approveReview, rejectReview, resolveReviewGateJob } from "./review-decision.js";
import { executeGitPushGate } from "./git-push-gate.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

const ALLOWED_COMMAND_SET = new Set(BRIDGE_ALLOWED_COMMANDS);
const MUTATING_COMMAND_SET = new Set([
  BRIDGE_COMMANDS.ASK,
  BRIDGE_COMMANDS.REVIEW_APPROVE,
  BRIDGE_COMMANDS.REVIEW_REJECT,
  BRIDGE_COMMANDS.PLAN_APPROVE,
  BRIDGE_COMMANDS.PLAN_REJECT,
  BRIDGE_COMMANDS.GIT_PUSH,
]);

function commandIdFromFrame(frame = {}) {
  return frame.command_id ?? frame.commandId ?? frame.id ?? frame.command?.id ?? null;
}

function normalizedCommandId(commandId) {
  const text = String(commandId ?? "").trim();
  return text || "unknown";
}

export function normalizeCommandFrame(frame = {}) {
  const command = frame.command && typeof frame.command === "object" ? frame.command : frame;
  return {
    commandId: commandIdFromFrame(frame),
    name: String(command.name ?? frame.name ?? "").trim(),
    args: command.args && typeof command.args === "object"
      ? command.args
      : frame.args && typeof frame.args === "object"
        ? frame.args
        : {},
  };
}

function errorCodeFromReason(reason) {
  const code = String(reason || "command_failed");
  if (/^invalid_|^missing_/.test(code)) return "invalid_args";
  if (/^no_such_|not_found|^no_pending_/.test(code)) return "not_found";
  if (code === "job_not_claimable") return "gate_closed";
  return code;
}

function errorMessageForCode(code, fallback = null) {
  return String(fallback || code || "command_failed");
}

export function createAckFrame(commandId, result = null) {
  const ok = !(result && typeof result === "object" && result.ok === false);
  const frame = {
    v: BRIDGE_PROTOCOL_VERSION,
    type: BRIDGE_FRAME_TYPES.ACK,
    command_id: normalizedCommandId(commandId),
    ok,
  };
  if (ok) {
    if (result !== undefined) frame.result = result;
  } else {
    const reason = result.reason || result.err || result.error?.code || result.error || "command_failed";
    const code = errorCodeFromReason(reason);
    frame.error = {
      code,
      message: errorMessageForCode(code, result.message || result.error?.message || reason),
    };
  }
  return frame;
}

export function createErrorAck(commandId, err, details = null) {
  const code = errorCodeFromReason(err);
  const frame = {
    v: BRIDGE_PROTOCOL_VERSION,
    type: BRIDGE_FRAME_TYPES.ACK,
    command_id: normalizedCommandId(commandId),
    ok: false,
    error: {
      code,
      message: errorMessageForCode(code, details || err),
    },
  };
  return frame;
}

function numberArg(args, ...names) {
  for (const name of names) {
    const value = args?.[name];
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function workItemIdArg(args = {}) {
  return numberArg(args, "work_item_id", "workItemId", "wi_id", "wiId", "id");
}

function jobIdArg(args = {}) {
  return numberArg(args, "job_id", "jobId", "id");
}

function explicitJobIdArg(args = {}) {
  return numberArg(args, "job_id", "jobId");
}

function auditMutatingCommand(name, args = {}, context = {}, result = {}) {
  if (!MUTATING_COMMAND_SET.has(name)) return;
  const jobId = explicitJobIdArg(args);
  let wiId = workItemIdArg(args);
  if (!wiId && jobId) {
    const job = getJob(jobId);
    wiId = Number(job?.work_item_id) || null;
  }
  const ok = !(result && typeof result === "object" && result.ok === false);
  try {
    logEvent({
      ...(wiId ? { work_item_id: wiId } : {}),
      event_type: EVENT_TYPES.BRIDGE_COMMAND_MUTATION,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Bridge command ${name} ${ok ? "accepted" : "rejected"}`,
      event_json: JSON.stringify({
        command: name,
        ok,
        reason: ok ? null : (result.reason || result.error?.code || result.error || "command_failed"),
        actor: String(context.actor || "bridge"),
        work_item_id: wiId || null,
        job_id: jobId || null,
        arg_keys: Object.keys(args || {}).sort(),
      }),
    });
  } catch {
    // Audit events must not change command behavior.
  }
}

function workItemIdFromGateJob(jobId, expectedSubtype = null) {
  const job = getJob(jobId);
  if (!job) return { ok: false, reason: "no_such_job" };
  if (job.job_type !== "human_input") return { ok: false, reason: "not_gate_job" };
  const payload = parseJobPayload(job);
  if (expectedSubtype && payload?.subtype !== expectedSubtype) {
    return { ok: false, reason: "wrong_gate_kind" };
  }
  const wiId = Number(job.work_item_id);
  if (!Number.isInteger(wiId) || wiId <= 0) return { ok: false, reason: "invalid_work_item_id" };
  return { ok: true, workItemId: wiId, job, payload };
}

async function executeAllowedCommand(name, args = {}, context = {}) {
  switch (name) {
    case BRIDGE_COMMANDS.STATE_SNAPSHOT: {
      const headEventId =
        typeof context.getHeadEventId === "function"
          ? Number(context.getHeadEventId() || 0)
          : Number(args.headEventId || args.head_event_id || 0);
      return collectStateSnapshot({ ...args, headEventId });
    }

    case BRIDGE_COMMANDS.QUEUE_LIST:
      return listQueueState(args);

    case BRIDGE_COMMANDS.WORK_ITEM_GET: {
      const wiId = workItemIdArg(args);
      if (!wiId) return { ok: false, reason: "invalid_work_item_id" };
      const state = getWorkItemState(wiId, args);
      return state || { ok: false, reason: "no_such_wi" };
    }

    case BRIDGE_COMMANDS.JOBS_LIST:
      return listJobsState(args);

    case BRIDGE_COMMANDS.EVENTS_TAIL:
      if (typeof context.tailBridgeEvents === "function") {
        return context.tailBridgeEvents({
          sinceEventId: args.since_event_id ?? args.sinceEventId ?? args.since_id ?? args.sinceId ?? null,
          limit: args.limit,
        });
      }
      return tailEventsEnvelope({
        workItemId: args.work_item_id ?? args.workItemId ?? null,
        sinceId: args.since_event_id ?? args.sinceEventId ?? args.since_id ?? args.sinceId ?? null,
        limit: args.limit,
      });

    case BRIDGE_COMMANDS.GATES_LIST:
      return listGatesState(args);

    case BRIDGE_COMMANDS.ASK: {
      const jobId = jobIdArg(args);
      return answerHumanInput(jobId, args, context);
    }

    case BRIDGE_COMMANDS.GIT_PUSH: {
      const jobId = explicitJobIdArg(args);
      if (!jobId) return { ok: false, reason: "invalid_job_id" };
      return executeGitPushGate(jobId, args, context);
    }

    case BRIDGE_COMMANDS.PLAN_APPROVE: {
      const gateJobId = explicitJobIdArg(args);
      const resolved = gateJobId ? workItemIdFromGateJob(gateJobId, "plan_approval") : null;
      if (resolved && !resolved.ok) return resolved;
      const wiId = resolved?.workItemId || workItemIdArg(args);
      if (!wiId) return { ok: false, reason: "invalid_work_item_id" };
      return approvePlan(wiId, { actor: context.actor || "bridge" });
    }

    case BRIDGE_COMMANDS.PLAN_REJECT: {
      const gateJobId = explicitJobIdArg(args);
      const resolved = gateJobId ? workItemIdFromGateJob(gateJobId, "plan_approval") : null;
      if (resolved && !resolved.ok) return resolved;
      const wiId = resolved?.workItemId || workItemIdArg(args);
      if (!wiId) return { ok: false, reason: "invalid_work_item_id" };
      const feedback = args.feedback ?? args.reason ?? null;
      const rejected = rejectPlan(wiId, { feedback, actor: context.actor || "bridge" });
      if (!rejected.ok) return rejected;
      if (!args.replan) return rejected;
      const replan = respawnAfterRejection(wiId, {
        feedback,
        rejectedArtifactIds: rejected.rejectedArtifactIds,
      });
      if (replan.ok) updateWorkItemStatus(wiId, "planning");
      return {
        ...rejected,
        replan,
      };
    }

    case BRIDGE_COMMANDS.REVIEW_APPROVE: {
      const reviewJobId = explicitJobIdArg(args);
      if (reviewJobId) {
        const resolved = resolveReviewGateJob(reviewJobId);
        if (!resolved.ok) return resolved;
        const note = String(args.note || args.response || "").trim();
        return answerHumanInput(reviewJobId, {
          job_id: reviewJobId,
          lease_seconds: args.lease_seconds,
          answer: note ? `pass: ${note}` : "pass",
        }, { ...context, allowReviewGateAnswer: true });
      }
      const wiId = workItemIdArg(args);
      if (!wiId) return { ok: false, reason: "invalid_work_item_id" };
      return approveReview(wiId, { actor: context.actor || "bridge" });
    }

    case BRIDGE_COMMANDS.REVIEW_REJECT: {
      const reviewJobId = explicitJobIdArg(args);
      if (reviewJobId) {
        const resolved = resolveReviewGateJob(reviewJobId);
        if (!resolved.ok) return resolved;
        const feedback = String(args.feedback ?? args.reason ?? args.response ?? "").trim();
        if (!feedback) return { ok: false, reason: "missing_feedback" };
        return answerHumanInput(reviewJobId, {
          job_id: reviewJobId,
          lease_seconds: args.lease_seconds,
          answer: `fail: ${feedback}`,
        }, { ...context, allowReviewGateAnswer: true });
      }
      const wiId = workItemIdArg(args);
      if (!wiId) return { ok: false, reason: "invalid_work_item_id" };
      const feedback = String(args.feedback ?? args.reason ?? args.response ?? "").trim();
      if (!feedback) return { ok: false, reason: "missing_feedback" };
      return rejectReview(wiId, {
        actor: context.actor || "bridge",
        reason: feedback,
        allowBranchWithoutCleanup: args.allow_branch_without_cleanup === true,
      });
    }

    default:
      return { ok: false, reason: "command_not_allowed" };
  }
}

export async function dispatchBridgeCommandFrame(frame, context = {}) {
  const { commandId, name, args } = normalizeCommandFrame(frame);
  if (Number(frame?.v) !== BRIDGE_PROTOCOL_VERSION) {
    return createErrorAck(commandId, "unsupported_version");
  }
  if (!name) return createErrorAck(commandId, "missing_command_name");
  if (!ALLOWED_COMMAND_SET.has(name)) return createErrorAck(commandId, "command_not_allowed");
  try {
    const result = await executeAllowedCommand(name, args, context);
    auditMutatingCommand(name, args, context, result);
    return createAckFrame(commandId, result);
  } catch (err) {
    auditMutatingCommand(name, args, context, { ok: false, reason: "internal" });
    return createErrorAck(commandId, "internal");
  }
}

export function listAllowedBridgeCommands() {
  return BRIDGE_ALLOWED_COMMANDS.slice();
}
