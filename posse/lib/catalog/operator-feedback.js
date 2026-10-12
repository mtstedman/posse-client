// @ts-check
import { readonlySet } from "./readonly-collections.js";

export const OPERATOR_FEEDBACK_DELIVERY_PROTOCOL = "posse.operator_feedback.v1";
export const OPERATOR_FEEDBACK_DELIVERY_MARKER = "OPERATOR_FEEDBACK_DELIVERY";
export const OPERATOR_FEEDBACK_DELIVERY_EXCLUDED_TOOLS = readonlySet([
  "get_operator_feedback",
  "ack_operator_feedback",
]);
