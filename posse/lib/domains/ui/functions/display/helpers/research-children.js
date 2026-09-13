import { getAgentCalls, listAgentInteractions } from "../../../../queue/functions/index.js";

export function appendResearchChildMonitorRows(parents, { callsForJob = getAgentCalls, interactionsForJob = listAgentInteractions, toolRows = [] } = {}) {
  return parents.flatMap((parent) => {
    let calls = [];
    try { calls = callsForJob(parent.jobId).filter((call) => call.parent_agent_call_id && ["research", "web_research", "citation"].includes(call.child_kind)); } catch { return [parent]; }
    const childIds = new Set(calls.map((call) => Number(call.id)));
    const parentRows = (parent.interactionRows || []).filter((row) => !childIds.has(Number(row.agent_call_id)));
    const parentTools = toolRows.filter((row) => Number(row.job_id) === parent.jobId && !childIds.has(Number(row.agent_call_id)));
    const cleanParent = { ...parent, excludeCallIds: [...childIds], interactionRows: parentRows,
      activityRows: (parent.activityRows || []).filter((row) => !childIds.has(Number(row.agent_call_id))),
      guidance: (parent.guidance || []).filter((row) => !childIds.has(Number(row.agent_call_id))),
      pendingGuidance: (parent.pendingGuidance || []).filter((row) => !childIds.has(Number(row.agent_call_id))),
      inFlightTool: !!parentTools[0]?.in_flight,
    };
    if (cleanParent.state === "nudge" && !cleanParent.pendingGuidance.length) cleanParent.state = "live";
    if (calls.length) cleanParent.activity = cleanParent.activityRows[0]?.body || parent.wiTitle || parent.role;
    const children = calls.map((call) => {
      let rows = [];
      try { rows = interactionsForJob({ job_id: parent.jobId, agent_call_id: call.id, limit: 60 }); } catch { /* historical calls may have no interactions */ }
      rows = [...rows, ...(parent.interactionRows || []).filter((row) => row._kind === "agent_activity" && Number(row.agent_call_id) === Number(call.id))];
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const activityRows = rows.filter((row) => row.direction === "agent_to_user" && row.kind === "activity");
      const guidance = rows.filter((row) => row.direction === "user_to_agent" && row.kind === "nudge");
      const pending = guidance.filter((row) => row.status === "active" && row.ack_state === "pending");
      const tools = toolRows.filter((row) => Number(row.agent_call_id) === Number(call.id));
      const running = call.status === "running";
      return {
        ...parent, agentCallId: Number(call.id), parentAgentCallId: call.parent_agent_call_id,
        role: `↳ ${call.child_kind === "web_research" ? "web researcher" : call.child_kind === "research" ? "code researcher" : "citation child"}`,
        researchQuestion: call.activity, activity: activityRows[0]?.body || call.activity || "Researching",
        state: running ? pending.length ? "nudge" : "live" : call.status === "succeeded" ? "done" : call.status === "canceled" ? "canceled" : "failed", status: call.status,
        provider: call.provider, modelName: call.model_name, effort: call.reasoning_effort, tier: call.model_tier,
        elapsed: `${Math.round((call.duration_ms ?? (Date.now() - Date.parse(call.started_at))) / 1000)}s`,
        interactionRows: rows, activityRows, guidance, pendingGuidance: pending,
        lastActivityAt: Math.max(Date.parse(tools[0]?.created_at || "") || 0, Date.parse(rows[0]?.created_at || call.started_at) || 0),
        inFlightTool: running && !!tools[0]?.in_flight,
      };
    });
    return [cleanParent, ...children];
  });
}
