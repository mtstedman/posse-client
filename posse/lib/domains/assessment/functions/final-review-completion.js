import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import { FINAL_REVIEW_TOOL_NAME } from "../../../catalog/final-review.js";
import { agentHandoffTerminator } from "../../handoff/classes/AgentHandoffTerminator.js";
import { getAgentHandoffRecord, stageAgentHandoff } from "../../handoff/functions/agent-handoff.js";
import { getAgentCallById } from "../../queue/functions/agent-calls.js";
import { runImmediateTransaction } from "../../queue/functions/common.js";
import { getDb } from "../../../shared/storage/functions/index.js";

// A validated pass owns close-out. Save the ordinary completion packets before
// stopping either provider, so the worker keeps its existing handoff/assessment
// path without asking either model for another turn.
export function completeFinalReview({ agentCallId, reviewerAgentCallId, cwd, summary }) {
  const receipts = runImmediateTransaction(getDb(), () => {
    const saved = [];
    const reviewer = reviewerAgentCallId ? getAgentCallById(reviewerAgentCallId) : null;
    if (reviewer?.parent_agent_call_id === agentCallId
      && reviewer.child_kind === AGENT_CALL_CHILD_KINDS.FINAL_REVIEW) {
      const existing = getAgentHandoffRecord(reviewerAgentCallId);
      // A one-shot reviewer may have already committed its terminal report.
      // Preserve that accepted packet instead of replacing its proof.
      const receipt = existing?.status === "committed" && existing.packet?.outcome === "pass"
        ? { digest: existing.packet_digest }
        : stageAgentHandoff({
        verdict: "pass", confidence: "high", proof: String(summary || "The change meets the task contract.").slice(0, 500),
      }, { context: { agentCallId: reviewerAgentCallId }, role: "assessor", projectDir: cwd });
      saved.push({ agentCallId: reviewerAgentCallId, receipt });
    }
    saved.push({ agentCallId, receipt: stageAgentHandoff({ status: "COMPLETE" }, {
      context: { agentCallId }, role: "dev", projectDir: cwd,
    }) });
    return saved;
  });
  for (const saved of receipts) {
    agentHandoffTerminator.acknowledge(saved.agentCallId, {
      source: FINAL_REVIEW_TOOL_NAME, digest: saved.receipt.digest,
    });
  }
}
