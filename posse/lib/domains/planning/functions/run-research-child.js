import { RESEARCH_CHILD_PROFILE, RESEARCH_CHILD_PROMPT_PROFILE } from "../../../catalog/sub-agent.js";
import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import { AGENT_HANDOFF_PROTOCOL } from "../../../catalog/handoff.js";
import { webResearchRuntime } from "../../web-research/classes/WebResearchRuntime.js";

// The child receives only its question, so it needs its own budget line to
// know when to wrap up with partial findings, and the planner's seed files so
// its first read lands near the target instead of a cold search.
export function researchChildInstructions(parent, request) {
  const hints = parent?.packet?.context_hints || {};
  const seeds = [
    ...(Array.isArray(parent?.packet?.research_evidence?.key_files) ? parent.packet.research_evidence.key_files : []),
    ...(Array.isArray(hints.atlas_seed_files) ? hints.atlas_seed_files : []),
  ].map((entry) => (typeof entry === "string" ? entry : entry?.path)).filter((value) => typeof value === "string" && value.trim());
  const symbols = (Array.isArray(hints.atlas_seed_symbols) ? hints.atlas_seed_symbols : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name)).filter((value) => typeof value === "string" && value.trim());
  const uniqueSeeds = [...new Set(seeds)].slice(0, 12);
  const uniqueSymbols = [...new Set(symbols)].slice(0, 12);
  return [
    `RESEARCH QUESTION:\n${request.intent}`,
    `Budget: at most ${request.maxTurns} tool turns and ${Math.round(request.timeoutMs / 1000)} seconds; if either runs low, submit partial findings and name the gap instead of continuing.`,
    `Compact report character limit: ${request.resultChars}.`,
    ...(uniqueSeeds.length ? [`Starting points (planner seed files, verify before relying on them): ${uniqueSeeds.join(", ")}`] : []),
    ...(uniqueSymbols.length ? [`Seed symbols: ${uniqueSymbols.join(", ")}`] : []),
  ].join("\n");
}

export async function runResearchChild(client, parent, request) {
  const { agentType, intent, maxTurns, reasoningEffort, timeoutMs, signal, parentContext } = request;
  if (agentType === "web") {
    const result = await webResearchRuntime.execute({ route: "web", question: intent }, {
      context: parentContext, signal, dispatchId: request.dispatchId,
      budget: { maxTurns, reasoningEffort, timeoutMs, resultChars: request.resultChars, modelTier: request.modelTier || null },
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
  const prompt = await client.deps.composePromptRemoteAware(packet, researchChildInstructions(parent, request), { providerName: parent.provider });
  if (packet.remote_issuance?.coordination?.research_investigation_v1 !== true) {
    throw new Error("Remote does not support investigating research children; use the matching remote workbranch");
  }
  // Children run on the configured (cheaper) tier and let the provider pick
  // that tier's model; the parent's exact model is only inherited when no
  // child tier is configured. The job-level model name must follow the same
  // rule: model selection prefers it over the tier's model, so passing the
  // parent's model there ran every "standard" child on the planner's model
  // at the planner's price (live 2026-09-18: a Fable child on tier standard).
  const childTier = request.modelTier || parent.tier;
  const inheritedModel = request.modelTier ? null : parent.model;
  return await client.call(prompt, {
    role: "researcher", modelTier: childTier, modelName: inheritedModel,
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
    cwd: parent.cwd, jobProvider: parent.provider, jobModelName: inheritedModel,
  });
}
