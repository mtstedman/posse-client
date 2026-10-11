// Codex provider prompt projection and Rust dispatch boundary.
import fs from "fs";
import path from "path";
import { TOOL_REFS } from "../../../../catalog/tool-references.js";
import { ProviderToolRenderer } from "../../../../shared/tools/classes/ProviderToolRenderer.js";
import { adaptExecutionContractForProvider, appendExecutionTools, buildExecutionContract, renderExecutionContractBlock, renderProviderPromptContracts } from "../../../../shared/tools/functions/contract.js";
import { issuedToolSurfaceForProviderPolicy } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { buildMcpAtlasSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { logAtlasAttachment, resolveAtlasAssignmentUnit, withAtlasExecutionPolicySnapshot } from "../../../integrations/functions/atlas.js";
import { releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { normalizeProviderPaths } from "../../../runtime/functions/paths.js";
import { hasProviderVisibleAtlasMcpTools } from "../shared/atlas-mcp.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { resolveProviderStallTimeout } from "../shared/stall-timeout.js";
import { getMaxOutputTokensForProvider } from "../shared/turns.js";
import { normalizeMaxOutputTokens } from "../shared/output-limits.js";
import { buildCodexResearchMcpGuidance } from "./prompt-blocks.js";
import { getConfiguredCodexAuthMode, resolveCodexAuthModeInternal } from "./auth.js";
import { getMaxTurns, getModelOverride, getModelTierConfig, normalizeModelForAuthMode } from "./model-config.js";
import { buildCodexAtlasAttachmentAsync, buildCodexDeveloperInstructionRoute, buildCodexNativeMcpAttachmentAsync, CODEX_RESEARCH_BASE_INSTRUCTIONS_PATH } from "./request-builders.js";
import { normalizeCodexSessionHandle } from "./session.js";
import { runWithTerminalUsageFlush } from "./terminal-usage-flush.js";
import { buildNativeDispatchRequest, rejectRawCliControlOptions, runNativeDispatch } from "../shared/native-dispatch.js";

export function buildCodexRuntimeContractBlock(executionContract, {
  skipRolePrompt = false,
  remoteSystemPrompt = "",
} = {}) {
  const renderedContract = renderExecutionContractBlock(executionContract, {
    remoteComposed: skipRolePrompt,
    remoteSystemPrompt,
  });
  const contractBlock = [renderedContract, buildCodexResearchMcpGuidance(executionContract)]
    .filter(Boolean).join("\n");
  if (!skipRolePrompt) return contractBlock;

  // Remote-composed prompts already carry the provider-independent contract,
  // but this process alone knows the exact callable names issued to Codex.
  // The shared renderer supplies provider-local guidance for every provider;
  // writable Codex roles additionally need Codex's local mutation route.
  if (executionContract?.allowWrite !== true) return contractBlock;
  const tools = new ProviderToolRenderer({
    providerName: "codex",
    toolAttachmentMode: "deterministic-bridge",
    issuedSurface: executionContract,
  });
  const editFile = tools.tryRender(TOOL_REFS.tools.editFile);
  const writeFile = tools.tryRender(TOOL_REFS.tools.writeFile);
  const routes = [
    editFile ? `${editFile} for scoped edits` : null,
    writeFile ? `${writeFile} for full-file output` : null,
  ].filter(Boolean);
  let mutationRoute;
  if (routes.length === 0) {
    mutationRoute = "CODEX MUTATION ROUTE: no Posse file-mutation tool was issued. Native apply_patch and shell writes are unavailable; report the missing capability.";
  } else {
    mutationRoute = `CODEX MUTATION ROUTE: use ${routes.join(" and ")}. Native apply_patch and shell writes are unavailable.`;
  }
  return [contractBlock, mutationRoute].filter(Boolean).join("\n");
}

export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  allowWrite = false,
  allowTests = true,
  projectDbWrite = false,
  projectDbCapability = "none",
  modelTier = "standard",
  modelName = null,
  reasoningEffort = "medium",
  activity = "",
  silent = false,
  autoApprove = false,
  scopedFiles = null,
  createFiles = null,
  createRoots = null,
  readRoots = null,
  deleteFiles = null,
  stableContext = null,
  remoteSystemPrompt = null,
  maxTurns = null,
  maxOutputTokens = null,
  complexity = null,
  filesToModifyCount = null,
  deepthink = false,
  onLine = null,
  onAgentCommentary = null,
  onProviderToolUse = null,
  onProviderToolResult = null,
  cwd = null,          // real repo / worktree — codex sandbox root + MCP workspace
  mcpCwd = null,       // optional override for MCP workspace root. Falls back to cwd.
  projectDir = null,
  abortSignal = null,
  stallTimeout = null,
  fallbackReads = null,
  assessorMaxToolCalls = null,
  needsImageGeneration = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  atlasPrefetchStatus = null,
  skipRolePrompt = false,
  priorSessionHandle = null,
  recordFinalPrompt = null,
  onUsageSegment = null,
  onUsageProgress = null,
  disableAtlas = false,
  atlasConfig = null,
  _remoteIssuedPolicy = null,
  _remoteToolSurface = null,
  mcpGate = null,
  disableAgentTools = false,
  ...otherOptions      // checked only for retired raw CLI controls
} = {}) {
  rejectRawCliControlOptions("codex", otherOptions);
  const providerPathsForAtlas = normalizeProviderPaths({ cwd, projectDir });
  const mcpWorkspaceCwdForAtlas = mcpCwd ? path.resolve(mcpCwd) : providerPathsForAtlas.cwd;
  const assignmentUnitForAtlas = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const preparedAtlasConfig = await buildCodexAtlasAttachmentAsync(
    role,
    mcpWorkspaceCwdForAtlas,
    { assignmentUnit: assignmentUnitForAtlas, workItemId, disableAtlas, atlasConfig },
  );

  let cleanupDeterministicMcpSession = () => {};
  try {
    const tierConfig = getModelTierConfig(modelTier);
    const authResolution = resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() });
    if (!authResolution.ok) throw new Error(authResolution.reason);
    const preferredAuthMode = authResolution.mode;
    const requestedModel = selectExecutionModel({ jobModelName: modelName, globalModelOverride: getModelOverride(), tierModel: tierConfig.model });
    const modelToUse = normalizeModelForAuthMode(requestedModel, preferredAuthMode);
    const turnLimit = maxTurns || getMaxTurns(role, modelTier, complexity, filesToModifyCount, deepthink);
    const outputTokenLimit = normalizeMaxOutputTokens(maxOutputTokens)
      || getMaxOutputTokensForProvider("codex", { role });
    const providerPaths = normalizeProviderPaths({ cwd, projectDir });
    const workingDir = providerPaths.cwd;
    const mcpWorkspaceCwd = mcpCwd ? path.resolve(mcpCwd) : workingDir;
    const resumeSessionHandle = normalizeCodexSessionHandle(priorSessionHandle);
    const assignmentUnit = assignmentUnitForAtlas;
    const { attachment: atlasAttachment } = preparedAtlasConfig;
    const executionAtlasConfig = withAtlasExecutionPolicySnapshot(atlasConfig, atlasAttachment);
    const atlasMethodForStats = disableAtlas ? null : (atlasAttachment?.method || "baseline");
    logAtlasAttachment({
      attachment: atlasAttachment,
      jobId,
      workItemId,
      providerName: "codex",
      role,
    });
    if (atlasAttachment.failClosed) {
      const err = new Error(
        `ATLAS required mode blocks ${role} on codex (${atlasAttachment.requiredFailureReason || "unavailable"}).`
      );
      err.code = "ATLAS_REQUIRED_BLOCKED";
      err.atlas = atlasAttachment;
      throw err;
    }
    const atlasToolGateEnabled = resolveAtlasToolGateEnabled();
    const atlasReadyForMcp = hasProviderVisibleAtlasMcpTools({
      disableAtlas,
      atlasPrefetchStatus,
      atlasAttachment,
    });
    const deterministicReadMcp = await buildCodexNativeMcpAttachmentAsync(role, mcpWorkspaceCwd, {
      scopedFiles,
      createFiles,
      deleteFiles,
      createRoots,
      readRoots,
      allowWrite,
      projectDbWrite,
      projectDbCapability,
      needsImageGeneration,
      jobId,
      workItemId,
      attemptId,
      agentCallId,
      promptChars,
      fallbackReads,
      assessorMaxToolCalls,
      atlasPrefetchStatus,
      atlasAvailable: atlasReadyForMcp,
      atlasGateEnabled: atlasToolGateEnabled,
      atlasConfig: executionAtlasConfig,
      remoteToolSurface: _remoteToolSurface,
      mcpGate,
      disableAgentTools,
    });
    let deterministicMcpSessionReleased = false;
    cleanupDeterministicMcpSession = () => {
      if (!deterministicReadMcp.serverConfig?.ownerSession) {
        return { released: false, reason: "missing_session" };
      }
      if (deterministicMcpSessionReleased) {
        return { released: false, reason: "already_released" };
      }
      deterministicMcpSessionReleased = true;
      try {
        return releaseDeterministicMcpServerSession(deterministicReadMcp.serverConfig, {
          reason: "provider_cleanup",
          context: { provider: "codex", role, jobId, workItemId, attemptId },
        });
      } catch (err) {
        return {
          released: false,
          reason: "release_error",
          error: { message: String(err?.message || err) },
        };
      }
    };
    const atlasServerName = deterministicReadMcp.active
      ? deterministicReadMcp.serverKey
      : null;
    const remoteAtlasToolNames = Array.isArray(deterministicReadMcp.atlasTools)
      ? deterministicReadMcp.atlasTools
      : [];
    const atlasContractTools = atlasReadyForMcp && remoteAtlasToolNames.length > 0
      ? deterministicReadMcp.atlasContractTools ?? buildMcpAtlasSurfaceToolDescriptors(remoteAtlasToolNames, {
        providerName: "codex",
        serverName: atlasServerName,
        codexNestedMcp: deterministicReadMcp.codexCodeMode === true,
      })
      : [];
    const remoteSystemPromptText = String(remoteSystemPrompt || "").trim();
    let executionContract = buildExecutionContract({
      provider: "codex",
      role,
      roleMode,
      allowWrite,
      allowTests,
      projectDbWrite,
      projectDbCapability,
      issuedToolSurface: issuedToolSurfaceForProviderPolicy(_remoteIssuedPolicy),
      agentHandoffCompactV1: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV3: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
      atlasCodeWindowPolicy: atlasAttachment?.codeWindowPolicy || null,
      scopedFiles,
      createFiles,
      createRoots,
      deleteFiles,
      readRoots,
      needsImageGeneration,
      fallbackReads,
      platform: process.platform,
      includeBaseTools: false,
      projectDir: workingDir,
    });
    executionContract = appendExecutionTools(executionContract, deterministicReadMcp.contractTools || deterministicReadMcp.tools);
    executionContract = appendExecutionTools(executionContract, atlasContractTools);
    executionContract = adaptExecutionContractForProvider(executionContract, "codex");
    const promptPrelude = renderProviderPromptContracts(remoteSystemPromptText, executionContract);
    // Remote owns provider-independent behavior. The shared renderer keeps
    // provider-local guidance aligned with the exact issued Codex surface.
    const contractBlock = buildCodexRuntimeContractBlock(executionContract, {
      skipRolePrompt,
      remoteSystemPrompt: remoteSystemPromptText,
      nativeSystemToolsEnabled: false,
      codexCodeMode: false,
      codexNativeBatching: true,
      coreDeclarations: deterministicReadMcp.coreDeclarations || [],
    });
    const developerInstructionRoute = buildCodexDeveloperInstructionRoute({
      promptPrelude,
      contractBlock,
      stableContext: skipRolePrompt ? null : stableContext,
    });
    const finalPrompt = promptText;

    if (typeof recordFinalPrompt === "function") {
      recordFinalPrompt(finalPrompt, { systemPrompt: developerInstructionRoute.developerInstructions });
    }

    const request = buildNativeDispatchRequest("codex", finalPrompt, {
          jobId, workItemId, attemptId, agentCallId,
          authMode: preferredAuthMode,
          baseInstructions: role === "researcher" ? fs.readFileSync(CODEX_RESEARCH_BASE_INSTRUCTIONS_PATH, "utf8") : null,
          systemPrompt: developerInstructionRoute.developerInstructions,
          modelTier, modelName: modelToUse, reasoningEffort, role, roleMode,
          allowWrite, allowTests, projectDbCapability,
          issuedToolIds: deterministicReadMcp.issuedToolIds || [],
          cwd: mcpWorkspaceCwd, readRoots, createRoots, scopedFiles, createFiles, deleteFiles,
          maxTurns: turnLimit, maxOutputTokens: outputTokenLimit,
          stallTimeoutMs: resolveProviderStallTimeout(stallTimeout) * (["researcher", "planner"].includes(role) ? 2 : 1) * 1000,
          priorSessionHandle: resumeSessionHandle,
          recyclingMode: resumeSessionHandle ? "resume" : "fresh",
        });
        // A terminal handoff stop lands before Codex records the usage of the
        // request that made the handoff call; give that segment a bounded wait.
        const result = await runWithTerminalUsageFlush(abortSignal, ({ signal, onUsage }) => runNativeDispatch(request, {
          abortSignal: signal, mcpGate, projectDir: providerPaths.projectDir, silent, onLine,
          onAgentCommentary, onProviderToolUse, onProviderToolResult, onUsageProgress,
          onUsageSegment: (segment) => {
            onUsage();
            onUsageSegment?.(segment);
          },
        }));
        result.stats.atlasMethod = atlasMethodForStats;
        return result;
  } finally {
    cleanupDeterministicMcpSession();
  }
}
