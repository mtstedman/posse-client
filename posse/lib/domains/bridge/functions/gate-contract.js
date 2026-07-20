import { ONESHOT_SCOPE_SELECTION_SUBTYPE } from "../../../catalog/job.js";
import {
  humanInputChoicesForPayload,
  isHumanInputCoordinationPayload,
  isHumanInputReviewPayload,
} from "../../../catalog/human-input.js";
import { BRIDGE_COMMANDS } from "../../../catalog/bridge.js";

export function bridgeGateKindForJob(job, payload = {}) {
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
  const choices = humanInputChoicesForPayload(payload);
  if (choices.length === 0) return {};
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
