import { getAgentCalls, logEvent } from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

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
      return [{ code: String(detail.code || "SUB_AGENT_ERROR"), stage: detail.stage || null, at: row.created_at }];
    });
  } catch {
    return [];
  }
}

export function recordResearchDispatchAudit({ jobId, workItemId, agentCallId, requests = [] }) {
  const children = getAgentCalls(jobId).filter((call) => Number(call.parent_agent_call_id) === agentCallId && ["research", "web_research"].includes(call.child_kind));
  const requested = Math.max(requests.length, children.length);
  const rejected = listRejectedDispatchAttempts(jobId, agentCallId);
  const rejectionCodes = [...new Set(rejected.map((entry) => entry.code))];
  const rejectionNote = rejected.length > 0
    ? `; ${rejected.length} dispatch attempt(s) rejected before a child started (${rejectionCodes.join(", ")})`
    : "";
  logEvent({
    job_id: jobId, work_item_id: workItemId, event_type: EVENT_TYPES.PLANNER_DISPATCH_COMPLETED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Planner call #${agentCallId}: ${requested} research children requested${rejectionNote}`,
    event_json: { agent_call_id: agentCallId, children_requested: requested, skipped_research: requested === 0,
      dispatch_rejected: rejected.length, dispatch_rejection_codes: rejectionCodes,
      requests: requests.map((entry) => ({ agent_type: entry.agentType, question: entry.intent, status: entry.status, error_code: entry.error?.code || null })),
      children: children.map((call) => ({ agent_call_id: call.id, agent_type: call.child_kind === "web_research" ? "web" : "code", question: call.activity, status: call.status, effort: call.reasoning_effort, duration_ms: call.duration_ms })) },
  });
  if (rejected.length > 0 && requested === 0) {
    // The planner asked for help and got none: say so where the operator
    // looks, because the fallback is the planner reading on itself at full
    // price.
    logEvent({
      job_id: jobId, work_item_id: workItemId, event_type: EVENT_TYPES.PLANNER_DISPATCH_REJECTED,
      actor_type: EVENT_ACTORS.WORKER,
      message: `Planner call #${agentCallId}: research child dispatch rejected (${rejectionCodes.join(", ")}); the planner fell back to reading on itself`,
      event_json: { agent_call_id: agentCallId, severity: "warn", rejected: rejected },
    });
  }
}
