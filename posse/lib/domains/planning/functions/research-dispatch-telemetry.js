import { getAgentCalls, logEvent } from "../../queue/functions/index.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

export function recordResearchDispatchAudit({ jobId, workItemId, agentCallId, requests = [] }) {
  const children = getAgentCalls(jobId).filter((call) => Number(call.parent_agent_call_id) === agentCallId && ["research", "web_research"].includes(call.child_kind));
  const requested = Math.max(requests.length, children.length);
  logEvent({
    job_id: jobId, work_item_id: workItemId, event_type: EVENT_TYPES.PLANNER_DISPATCH_COMPLETED,
    actor_type: EVENT_ACTORS.WORKER,
    message: `Planner call #${agentCallId}: ${requested} research children requested`,
    event_json: { agent_call_id: agentCallId, children_requested: requested, skipped_research: requested === 0,
      requests: requests.map((entry) => ({ agent_type: entry.agentType, question: entry.intent, status: entry.status, error_code: entry.error?.code || null })),
      children: children.map((call) => ({ agent_call_id: call.id, agent_type: call.child_kind === "web_research" ? "web" : "code", question: call.activity, status: call.status, effort: call.reasoning_effort, duration_ms: call.duration_ms })) },
  });
}
