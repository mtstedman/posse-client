import { approvePlan, rejectPlan } from "../../planning/functions/plan-approval.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { answerHumanInput } from "./human-input-answer.js";
import { executeGitPushGate } from "./git-push-gate.js";
import { AGENT_CONVERSATION_TIER } from "../../../catalog/agent-conversation.js";
import { BRIDGE_TRANSPORTS } from "../../../catalog/bridge.js";
import { OPERATOR_ACTION_SOURCES } from "../../../catalog/work-item-interactions.js";
import { HUMAN_GATE_FEEDBACK_MAX_CHARS } from "../../../catalog/human-input.js";
import {
  WORK_ITEM_ACTION_PROTOCOL,
  commonEnvelope,
  observedAt,
  validateRepositoryBinding,
} from "./work-item-feed.js";

const OWNER_MODULE = "../../queue/functions/interaction-contract.js";
const TRANSITION_HANDLERS = new Set(["plan", "scope", "review", "human_input", "one_shot", "git_push"]);
const TRANSITION_DESCRIPTOR_KEYS = new Set([
  "handler", "work_item_id", "job_id", "question_id", "question_generation", "choice_id", "decline", "feedback",
]);

function requiredText(value, maxBytes = 128) {
  const text = String(value ?? "").trim();
  return text && Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
}

// The action's recorded source names the surface: Bossy reaches the bridge
// only over loopback HTTP with the local token (the local detail tier); the
// phone and web app arrive over the LAN WebSocket or the relay.
function actionSource(context = {}) {
  return context.detailTier === AGENT_CONVERSATION_TIER.LOCAL
    ? OPERATOR_ACTION_SOURCES.BOSSY
    : OPERATOR_ACTION_SOURCES.BRIDGE;
}

function actionIdentityArgs(args = {}, kind, context = {}) {
  const actionId = requiredText(args.action_id, 128);
  const workItemId = requiredText(args.work_item_id, 128);
  const jobId = requiredText(args.job_id, 128);
  if (!actionId || !workItemId || !jobId) return { ok: false, reason: "invalid_identity" };
  if (kind === "question.answer") {
    const questionId = requiredText(args.question_id, 256);
    const generation = requiredText(args.question_generation, 128);
    const choiceId = requiredText(args.choice_id, 128);
    if (!questionId || !generation || !choiceId) return { ok: false, reason: "invalid_identity" };
    const feedback = args.feedback == null ? "" : String(args.feedback).trim();
    if (Array.from(feedback).length > HUMAN_GATE_FEEDBACK_MAX_CHARS) return { ok: false, reason: "invalid_feedback" };
    return {
      ok: true,
      value: {
        action_id: actionId,
        work_item_id: workItemId,
        job_id: jobId,
        question_id: questionId,
        question_generation: generation,
        choice_id: choiceId,
        ...(feedback ? { feedback } : {}),
        source: actionSource(context),
        author: "operator",
      },
    };
  }
  const body = String(args.body ?? "").trim();
  if (!body || Array.from(body).length > 4000) return { ok: false, reason: "invalid_body" };
  const agentCallId = args.agent_call_id == null ? null : requiredText(args.agent_call_id, 128);
  const replaceId = args.replace_interaction_id == null ? null : requiredText(args.replace_interaction_id, 256);
  if (args.agent_call_id != null && !agentCallId) return { ok: false, reason: "invalid_identity" };
  if (args.replace_interaction_id != null && !replaceId) return { ok: false, reason: "invalid_identity" };
  return {
    ok: true,
    value: {
      action_id: actionId,
      work_item_id: workItemId,
      job_id: jobId,
      ...(agentCallId ? { agent_call_id: agentCallId } : {}),
      body,
      ...(replaceId ? { replace_interaction_id: replaceId } : {}),
      source: actionSource(context),
      author: "operator",
    },
  };
}

async function loadOwnerFunctions(context = {}) {
  if (context.ownerFunctions) return context.ownerFunctions;
  return import(OWNER_MODULE);
}

function validateTransitionDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  if (Object.keys(descriptor).some((key) => !TRANSITION_DESCRIPTOR_KEYS.has(key))) return null;
  if (!TRANSITION_HANDLERS.has(descriptor.handler)) return null;
  const normalized = {
    handler: descriptor.handler,
    work_item_id: requiredText(descriptor.work_item_id, 128),
    job_id: requiredText(descriptor.job_id, 128),
    question_id: requiredText(descriptor.question_id, 256),
    question_generation: requiredText(descriptor.question_generation, 128),
    choice_id: requiredText(descriptor.choice_id, 128),
  };
  if (Object.values(normalized).some((value) => !value)) return null;
  if (descriptor.handler === "git_push") {
    if (descriptor.choice_id === "decline" && descriptor.decline !== true) return null;
    // Reservations stored before Push stopped carrying the flag hold
    // `decline: false`; that agrees with the choice, so it still replays.
    if (descriptor.choice_id !== "decline" && descriptor.decline != null && descriptor.decline !== false) return null;
    if (descriptor.decline === true) normalized.decline = true;
  } else if (descriptor.decline != null) {
    return null;
  }
  if (descriptor.feedback != null) {
    const feedback = typeof descriptor.feedback === "string" ? descriptor.feedback.trim() : "";
    if (!feedback || Array.from(feedback).length > HUMAN_GATE_FEEDBACK_MAX_CHARS || descriptor.handler === "git_push") return null;
    normalized.feedback = feedback;
  }
  return normalized;
}

// ask's answer form: "<choice>: note" with the validated selection beside
// it, so a note naming another choice cannot change the selection.
function humanInputAnswer(descriptor) {
  if (!descriptor.feedback) return { job_id: descriptor.job_id, answer: descriptor.choice_id };
  return {
    job_id: descriptor.job_id,
    answer: `${descriptor.choice_id}: ${descriptor.feedback}`,
    answer_metadata: { selected_action: descriptor.choice_id },
  };
}

export function createWorkItemTransitionExecutor(context = {}, deps = {}) {
  const executePlanApprove = deps.approvePlan || approvePlan;
  const executePlanReject = deps.rejectPlan || rejectPlan;
  const executeHumanInput = deps.answerHumanInput || answerHumanInput;
  const executePush = deps.executeGitPushGate || executeGitPushGate;
  const projectDir = context.projectDir || process.cwd();
  return async (input) => {
    const descriptor = validateTransitionDescriptor(input);
    if (!descriptor) return { ok: false, reason: "invalid_transition_descriptor" };
    switch (descriptor.handler) {
      case "plan":
        return descriptor.choice_id === "approve"
          ? executePlanApprove(Number(descriptor.work_item_id), {
              actor: context.actor || "bridge",
              gateJobId: Number(descriptor.job_id),
              gateGeneration: Number(descriptor.question_generation),
            })
          : executePlanReject(Number(descriptor.work_item_id), {
              actor: context.actor || "bridge",
              gateJobId: Number(descriptor.job_id),
              gateGeneration: Number(descriptor.question_generation),
              ...(descriptor.feedback ? { feedback: descriptor.feedback } : {}),
            });
      case "review":
        return executeHumanInput(Number(descriptor.job_id), humanInputAnswer(descriptor),
          { ...context, projectDir, allowReviewGateAnswer: true, allowChoiceFeedback: Boolean(descriptor.feedback) });
      case "scope":
      case "human_input":
      case "one_shot":
        return executeHumanInput(Number(descriptor.job_id), humanInputAnswer(descriptor),
          { ...context, projectDir, allowChoiceFeedback: Boolean(descriptor.feedback) });
      case "git_push":
        return executePush(Number(descriptor.job_id), {
          decline: descriptor.decline === true,
        }, { ...context, projectDir });
      default:
        return { ok: false, reason: "invalid_transition_descriptor" };
    }
  };
}

// The relay and the LAN WebSocket reach a bridge that serves exactly one
// project, and an absolute local path must not cross them (decision D1).
function remoteTransport(context = {}) {
  return context.transport === BRIDGE_TRANSPORTS.RELAY || context.transport === BRIDGE_TRANSPORTS.WEBSOCKET;
}

// question.answer from a remote transport may omit repo_path: the bridge's
// own project is the only one it could name. A supplied path is still
// checked. Loopback HTTP (Bossy, which may serve several repositories)
// keeps requiring it.
function answerRepositoryBinding(args, context) {
  const omitted = typeof args.repo_path !== "string" || !args.repo_path.trim();
  if (remoteTransport(context) && omitted) {
    return validateRepositoryBinding({ ...args, repo_path: context.projectDir || process.cwd() }, context);
  }
  return validateRepositoryBinding(args, context);
}

function actionEnvelope(ownerResult, repoPath, context) {
  const db = context.db || getDb();
  const envelope = {
    ...commonEnvelope(WORK_ITEM_ACTION_PROTOCOL, repoPath, context, db),
    ...ownerResult,
    protocol: WORK_ITEM_ACTION_PROTOCOL,
    repo_path: repoPath,
    observed_at: ownerResult?.observed_at || observedAt(context),
  };
  if (remoteTransport(context)) delete envelope.repo_path;
  return envelope;
}

export async function answerWorkItemQuestion(args = {}, context = {}) {
  const binding = answerRepositoryBinding(args, context);
  if (!binding.ok) return binding;
  const normalized = actionIdentityArgs(args, "question.answer", context);
  if (!normalized.ok) return normalized;
  const owner = await loadOwnerFunctions(context);
  if (typeof owner.answerWorkItemQuestionChoice !== "function") throw new Error("Lane A answer API unavailable");
  const result = await owner.answerWorkItemQuestionChoice(normalized.value, {
    executeTransition: createWorkItemTransitionExecutor(context, context.transitionDeps),
  });
  return actionEnvelope(result, binding.repoPath, context);
}

export async function nudgeWorkItemAgent(args = {}, context = {}) {
  const binding = validateRepositoryBinding(args, context);
  if (!binding.ok) return binding;
  const normalized = actionIdentityArgs(args, "agent.nudge", context);
  if (!normalized.ok) return normalized;
  const owner = await loadOwnerFunctions(context);
  if (typeof owner.replaceOperatorNudge !== "function") throw new Error("Lane A nudge API unavailable");
  const result = owner.replaceOperatorNudge(normalized.value);
  return actionEnvelope(result, binding.repoPath, context);
}

export async function projectWorkItemInteractions(args = {}, context = {}) {
  if (typeof context.interactionProjector === "function") return context.interactionProjector(args);
  const owner = await loadOwnerFunctions(context);
  if (typeof owner.projectWorkItemInteractions !== "function") throw new Error("Lane A projection API unavailable");
  return owner.projectWorkItemInteractions(args);
}
