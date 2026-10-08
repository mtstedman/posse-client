// Node owns finalized prompts, model selection inputs, and the signed tool owner.
// Every API protocol and conversation runs in the native dispatch adapter.
import { buildNativeDispatchRequest, runNativeDispatch } from "./native-dispatch.js";
import { nativeIssuedToolIds } from "./native-tool-catalog.js";
import { composeRemoteAssessorPromptForProvider } from "./remote-assessor-prompt.js";
import { getMaxTurnsForProvider, getMaxOutputTokensForProvider } from "./turns.js";
import { normalizeMaxOutputTokens } from "./output-limits.js";
import { resolveProviderStallTimeout } from "./stall-timeout.js";
import { buildExecutionContract, appendExecutionTools, renderExecutionContractBlock, renderProviderPromptContracts } from "../../../../shared/tools/functions/contract.js";
import { buildMcpSurfaceToolDescriptors, buildMcpAtlasSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { issuedToolSurfaceForProviderPolicy, narrowProviderOptionsToRemoteIssuance } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { LIVE_CHANNEL_TOOL_NAMES } from "../../../../shared/tools/functions/tool-suites.js";
import { buildDisabledAtlasAttachment, resolveAtlasAssignmentUnit, resolveAtlasExecutionAttachment, withAtlasExecutionPolicySnapshot, logAtlasAttachment } from "../../../integrations/functions/atlas.js";
import { buildDeterministicReadMcpServerConfigAsync, releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";

export async function callNativeApiProvider(provider, promptText, options = {}) {
  let opts = { role: "planner", modelTier: "standard", reasoningEffort: "medium", allowTests: true, projectDbCapability: "none", ...options };
  const cwd = opts.mcpCwd || opts.cwd || process.cwd();
  if (opts.disableSystemTools === false) throw new Error("Native API providers require issued MCP tools only");
  const attachment = opts.disableAtlas
    ? buildDisabledAtlasAttachment({ role: opts.role, providerName: provider, reason: "artifact route" })
    : resolveAtlasExecutionAttachment({ role: opts.role, providerName: provider, cwd,
      assignmentUnit: resolveAtlasAssignmentUnit({ workItemId: opts.workItemId, fallback: `${opts.activity || ""}\n${String(promptText || "").slice(0, 512)}` }),
      workItemId: opts.workItemId, config: opts.atlasConfig || undefined });
  logAtlasAttachment({ attachment, jobId: opts.jobId, workItemId: opts.workItemId, providerName: provider, role: opts.role });
  if (attachment.failClosed) throw Object.assign(new Error(`ATLAS required mode blocks ${opts.role} on ${provider}.`), { code: "ATLAS_REQUIRED_BLOCKED", atlas: attachment });
  if (!opts.skipRolePrompt && !opts.remoteSystemPrompt) {
    const composed = await composeRemoteAssessorPromptForProvider(promptText, {
      ...opts, providerName: provider, workingDir: cwd, atlasAttachment: attachment,
    });
    if (composed) {
      promptText = composed.promptText;
      opts = { ...opts, ...narrowProviderOptionsToRemoteIssuance({ ...opts, sessionPacket: composed.packet }),
        stableContext: composed.stableContext || opts.stableContext,
        remoteSystemPrompt: composed.remoteSystemPrompt || opts.remoteSystemPrompt, skipRolePrompt: true };
    }
  }
  const maxTurns = opts.maxTurns || getMaxTurnsForProvider(provider, opts);
  const maxOutputTokens = normalizeMaxOutputTokens(opts.maxOutputTokens) || getMaxOutputTokensForProvider(provider, opts);
  const stallTimeoutMs = resolveProviderStallTimeout(opts.stallTimeout) * (["researcher", "planner"].includes(opts.role) ? 2 : 1) * 1000;
  let owner = null;
  try {
    let issuedToolIds = [];
    if (opts.disableAgentTools === true) {
      if (opts.allowWrite) throw new Error("A tool-free native turn cannot have write access");
    } else {
      owner = await buildDeterministicReadMcpServerConfigAsync(opts.role, {
        ...opts, cwd, providerName: provider, promptChars: String(promptText || "").length,
        disableSystemTools: true, isolateProviderHome: false,
        atlasAvailable: !opts.disableAtlas && attachment.active,
        atlasGateEnabled: resolveAtlasToolGateEnabled(),
        atlasConfig: withAtlasExecutionPolicySnapshot(opts.atlasConfig, attachment),
        remoteToolSurface: opts._remoteToolSurface,
      });
      if (!owner?.ready) throw new Error(`Native ${provider} requires a ready MCP gateway`);
      issuedToolIds = await nativeIssuedToolIds(opts.mcpGate);
    }
    const surfaceOptions = { providerName: provider, serverName: owner?.name || "posse" };
    const deterministic = buildMcpSurfaceToolDescriptors(issuedToolIds.filter(id => id.startsWith("tools.")), surfaceOptions);
    const atlas = buildMcpAtlasSurfaceToolDescriptors(owner?.atlasTools || [], surfaceOptions)
      .flatMap(tool => {
        const id = issuedToolIds.includes(tool.mcpName) ? tool.mcpName : issuedToolIds.includes("atlas.query") ? "atlas.query" : null;
        return id ? [{ ...tool, mcpName: id }] : [];
      });
    let contract = buildExecutionContract({ ...opts, provider, projectDir: cwd,
      role: opts._subAgentChild ? "subagent" : opts.role,
      issuedToolSurface: issuedToolSurfaceForProviderPolicy(opts._remoteIssuedPolicy),
      agentHandoffCompactV1: opts._remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV3: opts._remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
      researchInvestigation: opts._remoteIssuedPolicy?.coordination?.researchInvestigationV1 === true,
      atlasCodeWindowPolicy: attachment.codeWindowPolicy || null, includeBaseTools: false,
    });
    contract = appendExecutionTools(contract, [...deterministic, ...atlas].map(tool => ({
      ...tool, providerSurfaceName: tool.mcpName, surfaceName: tool.mcpName, transport: "function",
    })));
    const contractBlock = renderExecutionContractBlock(contract, { remoteComposed: opts.skipRolePrompt, remoteSystemPrompt: opts.remoteSystemPrompt });
    const systemPrompt = [renderProviderPromptContracts(opts.remoteSystemPrompt, contract).trim(), contractBlock, opts.stableContext].filter(Boolean).join("\n\n") || null;
    const userText = [opts.activity ? `ACTIVITY: ${opts.activity}` : null,
      issuedToolIds.length ? `MAX TOOL TURNS: ${maxTurns}` : null, `WORKING DIRECTORY: ${cwd}`,
      opts.jobDir ? `JOB DIR: ${opts.jobDir}` : null, promptText].filter(Boolean).join("\n");
    opts.recordFinalPrompt?.(userText, { systemPrompt });
    const request = buildNativeDispatchRequest(provider, userText, {
      ...opts, cwd, systemPrompt, stableContext: null, maxTurns, maxOutputTokens, stallTimeoutMs,
      issuedToolIds, budgetExemptToolIds: issuedToolIds.filter(id => LIVE_CHANNEL_TOOL_NAMES.has(id.replace(/^tools\./u, ""))),
    });
    const result = await runNativeDispatch(request, { ...opts, projectDir: opts.projectDir || cwd });
    result.stats.atlasMethod = opts.disableAtlas ? null : attachment.method || "baseline";
    result.stats.toolUsesLoggedByToolkit = true;
    return result;
  } finally {
    if (owner?.ownerSession) releaseDeterministicMcpServerSession(owner, { reason: "provider_cleanup", context: { provider, role: opts.role, jobId: opts.jobId, workItemId: opts.workItemId, attemptId: opts.attemptId } });
  }
}

export async function callNativeApiAgentTurn(provider, promptText, options = {}) {
  const tools = (options.tools || []).map(tool => ({
    name: tool.name, description: tool.description || "",
    inputSchema: tool.parameters || tool.input_schema || tool.inputSchema || { type: "object", properties: {} },
  }));
  const request = buildNativeDispatchRequest(provider, promptText, {
    ...options, role: "preflight", systemPrompt: options.systemPrompt,
    maxTurns: 1, maxOutputTokens: normalizeMaxOutputTokens(options.maxOutputTokens) || 2048,
    stallTimeoutMs: resolveProviderStallTimeout(options.stallTimeout) * 1000,
    issuedToolIds: tools.map(tool => tool.name), decision: { tools, allowBatching: options.allowToolBatching === true },
  });
  const result = await runNativeDispatch(request, { abortSignal: options.signal, silent: true });
  return { ...result, toolCalls: result.stats.toolDecisions || [] };
}
