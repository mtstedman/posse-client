import { HUMAN_GATE_ACTIONS, SCOPE_MODE_APPROVAL_SOURCE, humanGateContractForPayload, humanGateNameForPayload, humanInputChoicesForPayload } from "./human-input.js";

export const PINNED_APPROVAL_GATES = Object.freeze(["environment_setup", "push_offer"]);
export const approvalPolicyKey = (gate) => `approval_policy_${gate}`;
export const APPROVAL_POLICY_SETTINGS = Object.freeze(Object.entries(HUMAN_GATE_ACTIONS).filter(([gate]) => gate !== "plan_approval").map(([gate, actions]) => ({
  key: approvalPolicyKey(gate), default: "ask",
  options: PINNED_APPROVAL_GATES.includes(gate) ? ["ask"]
    : ["ask", ...actions.filter((action) => action !== "respond").map((action) => `auto:${action}`), "fail_closed"],
  description: `${gate}: ask the operator, select an offered action automatically, or stop unattended execution`,
})));

export function approvalPolicyForPayload(payload, { getSetting = () => null, scopeMode = "default", autoApprove = false, autoApprovePlan = false } = {}) {
  const gate = humanGateNameForPayload(payload);
  if (PINNED_APPROVAL_GATES.includes(gate) || payload.requires_interactive_approval === true) return { gate, policy: "ask", source: "interactive_required", answer: null };
  let policy = gate === "plan_approval"
    ? (getSetting("plan_approval_mode") === "auto_approve" ? "auto:approve" : "ask")
    : getSetting(approvalPolicyKey(gate)) || "ask";
  let source = "approval_policy";
  if (scopeMode === "auto" && ["scope_expansion_request", "scope_expansion_required"].includes(gate)) {
    policy = "auto:approve"; source = SCOPE_MODE_APPROVAL_SOURCE;
  } else if ((autoApprovePlan && gate === "plan_approval") || (autoApprove && HUMAN_GATE_ACTIONS[gate]?.includes("approve"))) {
    policy = "auto:approve"; source = "cli_auto_approve";
  }
  const action = policy.startsWith("auto:") ? policy.slice(5) : null;
  const offered = humanInputChoicesForPayload(payload);
  const allowed = humanGateContractForPayload(payload).allowed_actions;
  return { gate, policy, source, answer: action && offered.includes(action) && allowed.includes(action) ? action : null };
}
