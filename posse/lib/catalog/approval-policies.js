import { HUMAN_GATE_ACTIONS, HUMAN_INPUT_BEST_JUDGMENT_ANSWER, SCOPE_MODE_APPROVAL_SOURCE, humanGateContractForPayload, humanGateNameForPayload, humanInputChoicesForPayload } from "./human-input.js";

const EXPLICIT_POLICY_GATES = Object.freeze(["environment_setup", "push_offer"]);
// Thrown by the unattended human-input handler; the human-input job turns it
// into a closed gate and a failed parked original instead of reopening the gate.
export const APPROVAL_POLICY_FAIL_CLOSED_CODE = "APPROVAL_POLICY_FAIL_CLOSED";
export const approvalPolicyKey = (gate) => `approval_policy_${humanGateNameForPayload({ gate_kind: gate })}`;
// ── Flow control groups ──────────────────────────────────────────────────────
// The operator decides per broad kind of interruption, not per gate: approve
// (keep going), reject (stop the gated work) or ask. Each gate in a group
// names the offered action that Approve and Reject select. Approve never
// selects an action that accepts unverified work (pass, explicit_waiver,
// waive_tests, accept); those always need the operator or a per-gate policy.
export const FLOW_GROUP_POLICY_VALUES = Object.freeze(["ask", "approve", "reject"]);
export const FLOW_CLARIFICATION_POLICY_VALUES = Object.freeze(["ask", "best_judgment"]);
export const FLOW_GROUPS = Object.freeze({
  scope_extension: Object.freeze({
    key: "flow_scope_extension", label: "Scope extensions", default: "ask",
    description: "When a job asks to write files outside its planned scope. Approve grants the files, Reject refuses them, Ask stops for you. Routine files (tests, lockfiles) are covered by the setting below.",
    gates: Object.freeze({
      file_scope_approval: Object.freeze({ approve: "approve", reject: "reject" }),
      one_shot_file_scope: Object.freeze({ approve: "plan", reject: "cancel" }),
    }),
  }),
  environment_setup: Object.freeze({
    key: "flow_environment_setup", label: "Installation and setup", default: "ask",
    description: "When a job asks to install tools or packages on this machine. Approve runs the listed commands, Reject refuses them, Ask stops for you.",
    gates: Object.freeze({
      environment_setup: Object.freeze({ approve: "approve", reject: "reject" }),
    }),
  }),
  failure_recovery: Object.freeze({
    key: "flow_failure_recovery", label: "Failures and recovery", default: "ask",
    description: "When work fails, stalls or is blocked. Approve takes the repair action (retry, send back or replan), Reject fails the work, Ask stops for you. Approve never passes or waives failed verification.",
    gates: Object.freeze({
      dirty_worktree_recovery: Object.freeze({ approve: "send_back", reject: "fail" }),
      assessment_evidence_missing: Object.freeze({ approve: "retry_assessment", reject: "fail" }),
      stall_exhausted_recovery: Object.freeze({ approve: "retry", reject: "fail" }),
      failure_threshold_exhausted: Object.freeze({ approve: "retry", reject: "fail" }),
      fix_chain_exhausted: Object.freeze({ approve: "replan", reject: "fail" }),
      assessment_review: Object.freeze({ approve: "send_back", reject: "fail" }),
      assessment_transport_recovery: Object.freeze({ approve: "retry_assessment", reject: "fail" }),
      assessment_retry_limit: Object.freeze({ approve: "send_back", reject: "fail" }),
      unexecuted_replan_recovery: Object.freeze({ approve: "replan", reject: "fail" }),
      blocked_recovery: Object.freeze({ approve: "retry", reject: "fail" }),
      partial_work_recovery: Object.freeze({ approve: "commit", reject: "revert" }),
      dead_letter_recovery: Object.freeze({ approve: "retry", reject: "fail" }),
      pipeline_head_recovery: Object.freeze({ approve: "replan", reject: "fail" }),
      work_item_failure_disposition: Object.freeze({ approve: "retry", reject: "abandon" }),
      cross_wi_upstream_disposition: Object.freeze({ approve: "rebuild", reject: "abandon" }),
      merge_failure_recovery: Object.freeze({ approve: "merge", reject: "send_back" }),
    }),
  }),
  clarification: Object.freeze({
    key: "flow_clarification", label: "Clarifying questions", default: "best_judgment",
    description: "When an agent wants to ask you a question. Best judgement hides the ask tool from the planner and answers any question with stated assumptions; Ask stops for you.",
    gates: Object.freeze({ clarification: Object.freeze({}), planner_clarification: Object.freeze({}) }),
  }),
});

const FLOW_OPTION_LABELS = Object.freeze({ ask: "Ask", approve: "Approve", reject: "Reject", best_judgment: "Best judgement" });
export const FLOW_GROUP_SETTINGS = Object.freeze(Object.entries(FLOW_GROUPS).map(([id, entry]) => ({
  key: entry.key, default: entry.default, label: entry.label, description: entry.description,
  options: (id === "clarification" ? FLOW_CLARIFICATION_POLICY_VALUES : FLOW_GROUP_POLICY_VALUES)
    .map((value) => ({ value, label: FLOW_OPTION_LABELS[value] })),
})));

const FLOW_GROUP_BY_GATE = new Map();
for (const [id, entry] of Object.entries(FLOW_GROUPS)) {
  for (const [gate, actions] of Object.entries(entry.gates)) {
    for (const action of Object.values(actions)) {
      if (!HUMAN_GATE_ACTIONS[gate]?.includes(action)) throw new Error(`Flow group ${id} maps ${gate} to an action it does not offer: ${action}`);
    }
    if (!Object.hasOwn(HUMAN_GATE_ACTIONS, gate)) throw new Error(`Flow group ${id} names an unknown gate: ${gate}`);
    FLOW_GROUP_BY_GATE.set(gate, id);
  }
}
export const flowGroupForGate = (gate) => FLOW_GROUP_BY_GATE.get(gate) || null;

// A gate in a flow group follows its group unless the operator saved a
// policy for that gate alone.
export const APPROVAL_POLICY_GROUP_VALUE = "group";
export const APPROVAL_POLICY_SETTINGS = Object.freeze(Object.entries(HUMAN_GATE_ACTIONS).filter(([gate]) => gate !== "plan_approval").map(([gate, actions]) => ({
  key: approvalPolicyKey(gate), default: flowGroupForGate(gate) ? APPROVAL_POLICY_GROUP_VALUE : "ask",
  options: [...(flowGroupForGate(gate) ? [APPROVAL_POLICY_GROUP_VALUE] : []), "ask",
    ...actions.filter((action) => action !== "respond").map((action) => `auto:${action}`), "fail_closed"],
  description: flowGroupForGate(gate)
    ? `${gate}: follow the ${FLOW_GROUPS[flowGroupForGate(gate)].label} setting, or override it for this gate`
    : `${gate}: ask the operator, select an offered action automatically, or stop unattended execution`,
})));

/**
 * The standing policy for one gate: its own saved policy, else its flow
 * group's. Returns `ask`, `fail_closed`, `auto:<action>`, or for a
 * clarification group set to best judgement, `auto:best_judgment`.
 */
export function effectiveGatePolicy(gate, getSetting = () => null) {
  const groupId = flowGroupForGate(gate);
  const own = getSetting(approvalPolicyKey(gate)) || (groupId ? APPROVAL_POLICY_GROUP_VALUE : "ask");
  if (own !== APPROVAL_POLICY_GROUP_VALUE || !groupId) return own === APPROVAL_POLICY_GROUP_VALUE ? "ask" : own;
  const group = FLOW_GROUPS[groupId];
  const choice = getSetting(group.key) || group.default;
  if (groupId === "clarification") return choice === "best_judgment" ? "auto:best_judgment" : "ask";
  const action = group.gates[gate]?.[choice];
  return action ? `auto:${action}` : "ask";
}

export function approvalPolicyForPayload(payload, { getSetting = () => null, scopeMode = "default", autoApprove = false, autoApprovePlan = false } = {}) {
  const gate = humanGateNameForPayload(payload);
  if (payload.requires_interactive_approval === true) return { gate, policy: "ask", source: "interactive_required", answer: null };
  let policy = gate === "plan_approval"
    ? (getSetting("plan_approval_mode") === "auto_approve" ? "auto:approve" : "ask")
    : effectiveGatePolicy(gate, getSetting);
  let source = "approval_policy";
  // A saved row other than the default is the operator's standing decision for
  // this gate. `--scope-mode auto` and `--auto-approve-plan` name their gate
  // and override it for the run; `--auto-approve` is also implied by
  // `--non-interactive`, so it only fills the default and never turns a saved
  // `auto:reject` or `fail_closed` into an approval.
  const savedPolicy = policy !== "ask";
  if (scopeMode === "auto" && gate === "file_scope_approval") {
    policy = "auto:approve"; source = SCOPE_MODE_APPROVAL_SOURCE;
  } else if ((autoApprovePlan && gate === "plan_approval")
    || (autoApprove && !savedPolicy && !EXPLICIT_POLICY_GATES.includes(gate) && HUMAN_GATE_ACTIONS[gate]?.includes("approve"))) {
    policy = "auto:approve"; source = "cli_auto_approve";
  }
  const action = policy.startsWith("auto:") ? policy.slice(5) : null;
  // A clarification is free text, not a choice: best judgement answers it
  // with the same sentence an operator's escape key sends.
  if (action === "best_judgment") {
    return { gate, policy, source, answer: flowGroupForGate(gate) === "clarification" ? HUMAN_INPUT_BEST_JUDGMENT_ANSWER : null };
  }
  const offered = humanInputChoicesForPayload(payload);
  const allowed = humanGateContractForPayload(payload).allowed_actions;
  return { gate, policy, source, answer: action && offered.includes(action) && allowed.includes(action) ? action : null };
}

// A standing gate policy is explicit authorization. Generic CLI unattended
// flags are not authorization for installers or publication.
export function approvalResolutionAuthorized(payload, resolution, getSetting) {
  if (resolution.source === "human" && resolution.unattended !== true) return true;
  if (resolution.source !== "approval_policy") return false;
  const policy = approvalPolicyForPayload(payload, { getSetting });
  return policy.answer != null && policy.answer === resolution.action;
}
