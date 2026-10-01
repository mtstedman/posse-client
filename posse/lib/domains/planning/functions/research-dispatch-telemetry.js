import { getAgentCalls, logEvent } from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { getAgentHandoffRecord } from "../../handoff/functions/index.js";

// Dispatch attempts the runtime refused before a child could start. They are
// recorded as tool error observations on the planner's job; without them the
// audit line reads "0 research children requested" for a planner that asked.
export function listRejectedDispatchAttempts(jobId, agentCallId) {
  try {
    return getDb().prepare(`
      SELECT created_at, detail_json FROM job_observations
      WHERE job_id = ? AND observation_type IN ('tool.dispatch_agent.error', 'tool.sub_agent.error')
      ORDER BY id
    `).all(jobId).flatMap((row) => {
      let detail = {};
      try { detail = JSON.parse(row.detail_json || "{}"); } catch { return []; }
      if (Number(detail.parent_agent_call_id) !== Number(agentCallId)) return [];
      // The dispatch failed after its child ran; that is not a rejection.
      if (detail.child_agent_call_id != null) return [];
      return [{ code: String(detail.code || "SUB_AGENT_ERROR"), stage: detail.stage || null, at: row.created_at }];
    });
  } catch {
    return [];
  }
}

export function recordResearchDispatchAudit({ jobId, workItemId, agentCallId, requests = [] }) {
  const children = getAgentCalls(jobId).filter((call) => Number(call.parent_agent_call_id) === agentCallId && ["research", "web_research"].includes(call.child_kind));
  const childResults = children.map((call) => {
    let handoff = null;
    try { handoff = getAgentHandoffRecord(call.id); } catch { /* compatibility rows may have no packet */ }
    return {
      call,
      outcome: handoff?.outcome || null,
      evidence_chars: Math.max(0, Number(handoff?.evidence_chars) || 0),
    };
  });
  const partialCount = childResults.filter((entry) => entry.outcome === "partial").length;
  const requested = Math.max(requests.length, children.length);
  const requestRejections = requests.flatMap((entry) => (
    entry?.status === "failed" && !entry?.childAgentCallId && !entry?.usage?.agent_call_id
      ? [{
          code: String(entry?.error?.code || "SUB_AGENT_ERROR"),
          stage: entry?.error?.stage || null,
          at: null,
        }]
      : []
  ));
  // Once a batch exists it is the authoritative one-entry-per-request view.
  // Tool-error observations remain the fallback for failures rejected before
  // the runtime could create a batch at all.
  const rejected = requestRejections.length > 0
    ? requestRejections
    : listRejectedDispatchAttempts(jobId, agentCallId);
  const rejectionCodes = [...new Set(rejected.map((entry) => entry.code))];
  const rejectionNote = rejected.length > 0
    ? `; ${rejected.length} dispatch attempt(s) rejected before a child started (${rejectionCodes.join(", ")})`
    : "";
  logEvent({
    job_id: jobId, work_item_id: workItemId, event_type: EVENT_TYPES.PLANNER_DISPATCH_COMPLETED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Planner call #${agentCallId}: ${requested} research children requested${partialCount ? `; ${partialCount} partial` : ""}${rejectionNote}`,
    event_json: { agent_call_id: agentCallId, children_requested: requested, skipped_research: requested === 0,
      dispatch_rejected: rejected.length, dispatch_rejection_codes: rejectionCodes,
      requests: requests.map((entry) => ({ agent_type: entry.agentType, question: entry.intent, status: entry.status, error_code: entry.error?.code || null })),
      children: childResults.map(({ call, outcome, evidence_chars }) => ({ agent_call_id: call.id, agent_type: call.child_kind === "web_research" ? "web" : "code", question: call.activity, status: call.status, outcome, evidence_chars, effort: call.reasoning_effort, duration_ms: call.duration_ms })) },
  });
  if (children.length > 0 && partialCount === children.length) {
    logEvent({
      job_id: jobId, work_item_id: workItemId, event_type: EVENT_TYPES.PLANNER_DISPATCH_PARTIAL,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Planner call #${agentCallId}: every research child returned a partial handoff`,
      event_json: { agent_call_id: agentCallId, severity: "warn", children: childResults.map(({ call, outcome, evidence_chars }) => ({ agent_call_id: call.id, outcome, evidence_chars })) },
    });
  }
  if (rejected.length > 0 && children.length === 0) {
    // The planner asked for help and got none: say so where the operator
    // looks, because the fallback is the planner reading on itself at full
    logEvent({
      job_id: jobId, work_item_id: workItemId, event_type: EVENT_TYPES.PLANNER_DISPATCH_REJECTED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Planner call #${agentCallId}: research child dispatch rejected (${rejectionCodes.join(", ")}); the planner fell back to reading on itself`,
      event_json: { agent_call_id: agentCallId, severity: "warn", rejected: rejected },
    });
  }
}
