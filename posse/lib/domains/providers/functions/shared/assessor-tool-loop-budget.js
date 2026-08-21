// Assessor tool-call ceiling for the embedded provider tool loops.
//
// The OpenAI/Grok Responses loops execute function calls themselves instead of
// going through an MCP transport, so they need their own counter storage. The
// ceiling *decision* is not theirs to make: it belongs to the canonical shared
// policy in lib/shared/tools/functions/assessor-tool-budget.js, which the MCP
// transports also consume. This module owns only the per-provider-call counter,
// so the cap, the `used > cap` boundary, the agent_handoff exemption, and the
// exhaustion wording cannot drift between transports.
//
// The budget counts physical tool calls, not provider turns: a single provider
// response can carry a batch of function calls, and the excess inside one batch
// must be blocked before it reaches an executor.

import {
  assessorToolBudgetApplies,
  assessorToolCallCeilingDecision,
} from "../../../../shared/tools/functions/assessor-tool-budget.js";

/**
 * Create the per-provider-call assessor tool budget for an embedded tool loop.
 *
 * `evaluate(toolName)` returns `null` when the call may execute, and the
 * canonical blocked decision (reason, text, used, cap) when it may not. Calls
 * the ceiling does not govern - any non-assessor role, and the terminal
 * `agent_handoff` at any point - never advance the counter and are never
 * blocked here.
 *
 * @param {{ role?: unknown, maxToolCalls?: unknown }} [input]
 * @returns {{ usedToolCalls: () => number, evaluate: (toolName: unknown) => (object|null) }}
 */
export function createAssessorToolLoopBudget({ role, maxToolCalls } = {}) {
  let used = 0;
  return {
    usedToolCalls() {
      return used;
    },
    evaluate(toolName) {
      if (!assessorToolBudgetApplies(role, toolName)) return null;
      used += 1;
      const decision = assessorToolCallCeilingDecision({
        role,
        toolName,
        usedToolCalls: used,
        maxToolCalls,
      });
      return decision.blocked ? decision : null;
    },
  };
}
