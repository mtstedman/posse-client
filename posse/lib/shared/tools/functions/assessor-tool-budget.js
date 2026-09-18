// Assessor tool-call ceiling policy.
//
// Canonical, stateless evaluation of the assessor per-call tool ceiling
// (`assessor_max_tool_calls`). Every transport that runs assessor tool calls
// must decide the ceiling here so the wording, the default, the terminal-tool
// exemption, and the `used > cap` boundary cannot drift between transports.
//
// This module owns no state. Each caller keeps its own counter storage
// (deterministic gateway scope state, persistent-owner session field, or a
// provider tool-loop local) and its own response shaping, and passes the
// post-increment count in.
//
// The assessor fallback-read sublimit is deliberately NOT part of this
// decision: it is a separate, transport-local budget that only some callers
// carry.

import { TOOL_AGENT_HANDOFF } from "../../../catalog/native-tools.js";
import { ASSESSOR_MAX_TOOL_CALLS_DEFAULT } from "../../../catalog/settings.js";

export const ASSESSOR_ROLE_NAME = "assessor";

// The terminal handoff must stay callable after the ceiling triggers, or an
// exhausted assessor could never render its verdict.
export const ASSESSOR_TOOL_BUDGET_EXEMPT_TOOL_NAME = TOOL_AGENT_HANDOFF.name;

export const ASSESSOR_TOOL_CALL_CEILING_REASON = "tool_call_ceiling";

// Appended to a read served past the assessor's read allowance. The read
// still executes: the allowance guides breadth, it does not withhold
// evidence the assessor decided it needs.
export const ASSESSOR_READ_ALLOWANCE_ADVISORY_TEXT =
  "Advisory: this read is past the assessor read allowance. The scoped diff and the evidence already surfaced are sufficient for a verdict; render it now unless a specific unresolved criterion needs one more bounded read.";
export const ASSESSOR_TOOL_CALL_BUDGET_EXHAUSTED_TEXT =
  "Assessor tool-call budget exhausted. Render the verdict from the evidence already provided. If material evidence is genuinely missing, return needs_review; never fabricate a pass.";

/**
 * Whether the assessor tool-call ceiling applies to this role/tool pair.
 * Callers must consult this before incrementing their counter so the counter
 * only advances on calls the ceiling governs.
 *
 * @param {unknown} role
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function assessorToolBudgetApplies(role, toolName) {
  if (String(role || "") !== ASSESSOR_ROLE_NAME) return false;
  return String(toolName || "") !== ASSESSOR_TOOL_BUDGET_EXEMPT_TOOL_NAME;
}

/**
 * Resolve the configured ceiling. Non-integer configuration falls back to the
 * catalogued default; integers are floored at 1.
 *
 * @param {unknown} configuredMaxToolCalls
 * @returns {number}
 */
export function assessorToolCallCap(configuredMaxToolCalls) {
  // An unspecified cap means "use the catalogued default", never "one call".
  // Number(null) is 0 and passes Number.isInteger, so null, undefined, and ""
  // must be rejected before the numeric test or an unconfigured assessor is
  // silently held to a single tool call.
  if (configuredMaxToolCalls == null || configuredMaxToolCalls === "") {
    return ASSESSOR_MAX_TOOL_CALLS_DEFAULT;
  }
  return Number.isInteger(Number(configuredMaxToolCalls))
    ? Math.max(1, Number(configuredMaxToolCalls))
    : ASSESSOR_MAX_TOOL_CALLS_DEFAULT;
}

/**
 * @typedef {object} AssessorToolCallCeilingDecision
 * @property {boolean} blocked   always false: the ceiling is advisory
 * @property {boolean} advisory  true once `used > cap`
 * @property {string|null} reason
 * @property {string|null} text
 * @property {number} used
 * @property {number} cap
 */

/**
 * Evaluate the ceiling for one assessor tool call.
 *
 * `usedToolCalls` is the caller's post-increment count: the ceiling triggers
 * strictly at `used > cap`, so the cap-th call is still allowed.
 *
 * @param {{ role?: unknown, toolName?: unknown, usedToolCalls?: unknown, maxToolCalls?: unknown }} [input]
 * @returns {AssessorToolCallCeilingDecision}
 */
export function assessorToolCallCeilingDecision(input = {}) {
  const { role, toolName, usedToolCalls, maxToolCalls } = input;
  const cap = assessorToolCallCap(maxToolCalls);
  const parsedUsed = Number(usedToolCalls);
  const used = Number.isFinite(parsedUsed) ? parsedUsed : 0;
  if (!assessorToolBudgetApplies(role, toolName) || used <= cap) {
    return { blocked: false, advisory: false, reason: null, text: null, used, cap };
  }
  // The ceiling is advisory. Blocking past it turned a thorough assessor
  // (two inspections per artifact) into a harness "exhaustion" that requeued
  // the job and, for artifact work, re-ran the producer. The count and cap
  // stay reported for telemetry; the provider's own turn limit bounds runaway.
  return {
    blocked: false,
    advisory: true,
    reason: ASSESSOR_TOOL_CALL_CEILING_REASON,
    text: ASSESSOR_TOOL_CALL_BUDGET_EXHAUSTED_TEXT,
    used,
    cap,
  };
}
