import { RESEARCH_CHILD_PROFILE, RESEARCH_CHILD_PROMPT_PROFILE } from "../../../catalog/sub-agent.js";
import { RESEARCH_CHILD_FALLBACK_MODEL_TIER } from "../../../catalog/planner-dispatch.js";
import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import { AGENT_HANDOFF_PROTOCOL } from "../../../catalog/handoff.js";
import { WEB_SOURCE_SNAPSHOT_STATUSES } from "../../../catalog/web-research.js";
import { webResearchRuntime } from "../../web-research/classes/WebResearchRuntime.js";

// The child receives only its question, so it needs its own budget line to
// know when to wrap up with partial findings, and the planner's seed files so
// its first read lands near the target instead of a cold search.
export function researchChildInstructions(parent, request) {
  const hints = parent?.packet?.context_hints || {};
  const anchors = Array.isArray(request?.anchors) ? request.anchors : [];
  const seeds = [
    ...(Array.isArray(parent?.packet?.research_evidence?.key_files) ? parent.packet.research_evidence.key_files : []),
    ...(Array.isArray(hints.atlas_seed_files) ? hints.atlas_seed_files : []),
  ].map((entry) => (typeof entry === "string" ? entry : entry?.path)).filter((value) => typeof value === "string" && value.trim());
  const symbols = (Array.isArray(hints.atlas_seed_symbols) ? hints.atlas_seed_symbols : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.name)).filter((value) => typeof value === "string" && value.trim());
  const uniqueSeeds = [...new Set(seeds)].slice(0, 12);
  const uniqueSymbols = [...new Set(symbols)].slice(0, 12);
  const workTitle = String(parent?.packet?._raw_payload?.title || parent?.packet?.title || "").trim().slice(0, 300);
  const workDescription = String(parent?.packet?.project_context || "").trim().slice(0, 600);
  const anchorLines = anchors.map((anchor) => {
    if (anchor.ref) return `- ${anchor.ref} (delegated parent evidence; fetch and verify before relying on it)`;
    const range = anchor.lines ? `:${anchor.lines.start}-${anchor.lines.end}` : "";
    return `- ${anchor.path}${range}${anchor.symbol ? ` — symbol ${anchor.symbol}` : ""}`;
  });
  return [
    ...(workTitle || workDescription ? [
      "WORK ITEM CONTEXT:",
      ...(workTitle ? [`Title: ${workTitle}`] : []),
      ...(workDescription ? [`Description: ${workDescription}`] : []),
    ] : []),
    `RESEARCH QUESTION:\n${request.intent}`,
    `Budget: at most ${request.maxTurns} retrieval calls (reads beyond ${request.maxTurns} are blocked; agent_handoff is always available) and ${Math.round(request.timeoutMs / 1000)} seconds; if either runs low, submit partial findings and name the gap instead of continuing.`,
    `Compact report character target: ${request.resultChars} (longer reports are delivered in full and consume more planner context).`,
    ...(uniqueSeeds.length ? [`Starting points (planner seed files, verify before relying on them): ${uniqueSeeds.join(", ")}`] : []),
    ...(uniqueSymbols.length ? [`Seed symbols: ${uniqueSymbols.join(", ")}`] : []),
    ...(anchorLines.length ? ["Anchors from the planner (verify before relying on them):", ...anchorLines] : []),
  ].join("\n");
}

// Every web result reaches the planner as cited claims over durable
// work-item refs: findings, byte-exact source snapshots, and (for a salvaged
// answer) the report itself. The planner cites these refs in its tasks rather
// than restating web content, and downstream agents read them on request.
export function webResearchParentReport(web = {}) {
  const findings = Array.isArray(web.findings) ? web.findings : [];
  const sources = Array.isArray(web.sources) ? web.sources : [];
  const captured = sources.filter((source) => source?.status === WEB_SOURCE_SNAPSHOT_STATUSES.CAPTURED && source.ref);
  const missed = sources.filter((source) => source?.status !== WEB_SOURCE_SNAPSHOT_STATUSES.CAPTURED);
  const claims = [
    ...findings.map((finding) => ({ claim: finding.claim, evidence: [finding.evidence], summary: finding.url })),
    ...captured.map((source) => ({
      claim: `Byte-exact snapshot of ${source.label}: ${source.final_url || source.url} (${source.content_type}, ${source.bytes} bytes, sha256 ${String(source.sha256 || "").slice(0, 12)}). Cite this ref for the data instead of restating it; readers fetch it on request.`,
      evidence: [{ ref: source.ref }],
      summary: source.url,
    })),
    ...(web.report_ref ? [{
      claim: web.salvaged === true
        ? "Salvaged web research answer (uncited final text; verify a claim against its URL before relying on it)."
        : "Full web research report: every finding, source snapshot status, and gap in one durable ref.",
      evidence: [{ ref: web.report_ref }],
      summary: web.salvaged === true ? "salvaged web report" : "web research report",
    }] : []),
  ];
  const summary = [
    web.summary,
    ...(Array.isArray(web.gaps) ? web.gaps : []),
    ...missed.map((source) => `Source not snapshotted: ${source.url} (${source.status}: ${source.reason})`),
  ].filter(Boolean).join("\n");
  const partial = web.salvaged === true || missed.length > 0 || (Array.isArray(web.gaps) && web.gaps.length > 0);
  return { summary, claims, partial };
}

export async function runResearchChild(client, parent, request) {
  const { agentType, intent, maxTurns, reasoningEffort, timeoutMs, signal, parentContext } = request;
  if (agentType === "web") {
    const result = await webResearchRuntime.execute({ route: "web", question: intent }, {
      context: parentContext, signal, dispatchId: request.dispatchId,
      budget: { maxTurns, reasoningEffort, timeoutMs, resultChars: request.resultChars, modelTier: request.modelTier || null },
    });
    const web = result.result;
    const report = webResearchParentReport(web);
    return {
      agentCallId: result.usage.agent_call_id,
      stats: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, durationMs: result.usage.duration_ms },
      webPacket: {
        protocol: AGENT_HANDOFF_PROTOCOL, profile: RESEARCH_CHILD_PROFILE, outcome: report.partial ? "partial" : "complete",
        handoffs: [{ target: { kind: "parent", role: "$parent" }, report: { summary: report.summary, claims: report.claims } }],
      },
    };
  }
  const anchors = Array.isArray(request.anchors) ? request.anchors : [];
  const anchorFiles = anchors.filter((anchor) => anchor?.path).map((anchor) => anchor.path).slice(0, 8);
  const anchorSymbols = anchors.filter((anchor) => anchor?.symbol).map((anchor) => anchor.symbol).slice(0, 8);
  const packet = {
    recipient: "researcher", job_type: "research", prompt_profile: RESEARCH_CHILD_PROMPT_PROFILE,
    title: intent, work_item_id: parent.workItemId, job_id: parent.jobId, cwd: parent.cwd,
    tool_policy: { allow_read: true, allow_write: false, allow_shell: false, allow_tests: false },
    budgets: { fallback_reads_remaining: maxTurns },
    atlas: parent.packet.atlas || { active: false },
    context_hints: {
      ...(anchorFiles.length ? { atlas_seed_files: anchorFiles } : {}),
      ...(anchorSymbols.length ? { atlas_seed_symbols: anchorSymbols } : {}),
    },
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
  // Children run on the requested or configured child tier and let the
  // provider pick that tier's model; they never inherit the planner's model.
  // The job-level model name follows the same rule: model selection prefers
  // it over the tier's model, so passing the parent's model there ran
  // "standard" children on the planner's model at the planner's price
  // (live 2026-09-18 and, on the web path, 2026-09-30: Fable children).
  const childTier = request.modelTier || RESEARCH_CHILD_FALLBACK_MODEL_TIER;
  const inheritedModel = null;
  // The child's budget is a retrieval-call count enforced by the researcher
  // physical-call rail (researchWorkBudgetCalls). The provider's own turn
  // limit sits two turns above it so the rail's closing notice and the
  // terminal agent_handoff turn land before a CLI hard stop.
  return await client.call(prompt, {
    role: "researcher", modelTier: childTier, modelName: inheritedModel,
    reasoningEffort, activity: intent, maxTurns: Number.isSafeInteger(maxTurns) ? maxTurns + 2 : maxTurns, maxOutputTokens: 4096,
    allowWrite: false, allowShell: false, allowTests: false, projectDbCapability: "none", projectDbWrite: false,
    disableAtlas: parent.disableAtlas, disableSystemTools: true,
    fallbackReads: maxTurns, researchWorkBudgetCalls: maxTurns, skipRolePrompt: true, recyclingMode: "fresh",
    sessionPacket: packet, remoteSystemPrompt: packet.remote_system_prompt,
    allowedProviders: [parent.provider], abortSignal: signal,
    _researchChild: true, _parentAgentCallId: parent.agentCallId, _childKind: AGENT_CALL_CHILD_KINDS.RESEARCH,
    _subAgentCursor: { batchId: request.batchId, dispatchId: request.dispatchId },
  }, {
    job_id: parent.jobId, work_item_id: parent.workItemId, attempt_id: parent.attemptId,
    cwd: parent.cwd, jobProvider: parent.provider, jobModelName: inheritedModel,
  });
}
