import { ONESHOT_SCOPE_SELECTION_SUBTYPE } from "../../../catalog/job.js";
import {
  humanInputChoicesForPayload,
  humanGateNameForPayload,
  isHumanInputCoordinationPayload,
  isHumanInputReviewPayload,
} from "../../../catalog/human-input.js";
import { BRIDGE_COMMANDS } from "../../../catalog/bridge.js";

export function bridgeGateKindForJob(job, payload = {}) {
  if (payload?.subtype === "shared_trunk_provenance") return "shared_trunk_provenance";
  if (payload?.subtype === "push_offer") return "push";
  if (payload?.subtype === "plan_approval") return "plan";
  if (
    payload?.subtype === ONESHOT_SCOPE_SELECTION_SUBTYPE
    || payload?.review_type === ONESHOT_SCOPE_SELECTION_SUBTYPE
  ) return "human_input";
  if (isHumanInputCoordinationPayload(payload)) return "human_input";
  if (isHumanInputReviewPayload(payload)) return "review";
  if (job?.status === "waiting_on_review") return "review";
  return "human_input";
}

export function bridgeGateAnswerContract(payload = {}) {
  const kind = humanGateNameForPayload(payload);
  if (["plan_approval", "push_offer"].includes(kind)) return {};
  const choices = humanInputChoicesForPayload(payload);
  if (choices.length > 0) {
    return {
      answer_mode: "enum",
      choices,
      answer_command: BRIDGE_COMMANDS.ASK,
      answer_schema: {
        type: "string",
        enum: choices,
      },
    };
  }

  // Plan and push gates resolve through their dedicated commands. A typed
  // review with no registered choices is an invalid/legacy closed contract,
  // not a free-form question, so do not advertise `ask` for it either.
  if (
    !["clarification", "planner_clarification"].includes(kind)
  ) return {};

  // Untyped human-input gates are agent/operator clarifications. Make their
  // text capability explicit so bridge clients do not have to infer it from
  // the absence of enum choices.
  return {
    answer_mode: "text",
    answer_command: BRIDGE_COMMANDS.ASK,
    answer_schema: {
      type: "string",
      minLength: 1,
    },
  };
}
