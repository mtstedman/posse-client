import { RESEARCH_CHILD_PROFILE, RESEARCH_CHILD_PROMPT_PROFILE } from "../../../catalog/sub-agent.js";
import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import { AGENT_HANDOFF_PROTOCOL } from "../../../catalog/handoff.js";
import { webResearchRuntime } from "../../web-research/classes/WebResearchRuntime.js";

export async function runResearchChild(client, parent, request) {
  const { agentType, intent, maxTurns, reasoningEffort, timeoutMs, signal, parentContext } = request;
  if (agentType === "web") {
    const result = await webResearchRuntime.execute({ route: "web", question: intent }, {
      context: parentContext, signal, budget: { maxTurns, reasoningEffort, timeoutMs },
    });
    return {
      agentCallId: result.usage.agent_call_id,
      stats: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, durationMs: result.usage.duration_ms },
      webPacket: {
        protocol: AGENT_HANDOFF_PROTOCOL, profile: RESEARCH_CHILD_PROFILE, outcome: result.result.gaps?.length ? "partial" : "complete",
        handoffs: [{ target: { kind: "parent", role: "$parent" }, report: {
          summary: [result.result.summary, ...(result.result.gaps || [])].join("\n"),
          claims: result.result.findings.map((finding) => ({ claim: finding.claim, evidence: [finding.evidence], summary: finding.url })),
        } }],
      },
    };
  }
  const packet = {
    recipient: "researcher", job_type: "research", prompt_profile: RESEARCH_CHILD_PROMPT_PROFILE,
    title: intent, work_item_id: parent.workItemId, job_id: parent.jobId, cwd: parent.cwd,
    tool_policy: { allow_read: true, allow_write: false, allow_shell: false, allow_tests: false },
    budgets: { fallback_reads_remaining: maxTurns },
    atlas: parent.packet.atlas || { active: false },
    agent_coordination: {
      mode: "handoff", agent_handoff_v1: true,
      agent_handoff_compact_v1: false, agent_handoff_compact_v2: false, agent_handoff_compact_v3: false,
      sub_agent_v1: false, dispatch_agent_v1: false, web_research_handoff_v1: false,
      research_investigation_v1: true,
    },
  };
  const prompt = await client.deps.composePromptRemoteAware(packet, `RESEARCH QUESTION:\n${intent}\nCompact report character limit: ${request.resultChars}.`, { providerName: parent.provider });
  if (packet.remote_issuance?.coordination?.research_investigation_v1 !== true) {
    throw new Error("Remote does not support investigating research children; use the matching remote workbranch");
  }
  return await client.call(prompt, {
    role: "researcher", modelTier: parent.tier, modelName: parent.model,
    reasoningEffort, activity: intent, maxTurns, maxOutputTokens: 4096,
    allowWrite: false, allowShell: false, allowTests: false, projectDbCapability: "none", projectDbWrite: false,
    disableAtlas: parent.disableAtlas, disableSystemTools: true,
    fallbackReads: maxTurns, skipRolePrompt: true, recyclingMode: "fresh",
    sessionPacket: packet, remoteSystemPrompt: packet.remote_system_prompt,
    allowedProviders: [parent.provider], abortSignal: signal,
    _researchChild: true, _parentAgentCallId: parent.agentCallId, _childKind: AGENT_CALL_CHILD_KINDS.RESEARCH,
    _subAgentCursor: { batchId: request.batchId, dispatchId: request.dispatchId },
  }, {
    job_id: parent.jobId, work_item_id: parent.workItemId, attempt_id: parent.attemptId,
    cwd: parent.cwd, jobProvider: parent.provider, jobModelName: parent.model,
  });
}
