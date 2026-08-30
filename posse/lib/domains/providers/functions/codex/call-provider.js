// lib/domains/providers/functions/codex/call-provider.js

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { TOOL_REFS } from "../../../../catalog/tool-references.js";
import { ProviderToolRenderer } from "../../../../shared/tools/classes/ProviderToolRenderer.js";
import { adaptExecutionContractForProvider, appendExecutionTools, buildExecutionContract, renderExecutionContractBlock } from "../../../../shared/tools/functions/contract.js";
import { issuedToolSurfaceForProviderPolicy, issuedWebAccessEnabled } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { buildMcpAtlasSurfaceToolDescriptors } from "../../../../shared/tools/functions/mcp-surface.js";
import { logAtlasAttachment, resolveAtlasAssignmentUnit, withAtlasExecutionPolicySnapshot } from "../../../integrations/functions/atlas.js";
import { releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { resolveDisableSystemTools, resolveWebToolsEnabled } from "../shared/tool-policy-settings.js";
import { buildRuntimeEnv, normalizeProviderPaths } from "../../../runtime/functions/paths.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { hasProviderVisibleAtlasMcpTools } from "../shared/atlas-mcp.js";
import { logProviderMcpSurfaceTelemetry, logProviderCliStderrTelemetry, logProviderMcpAttachProofTelemetry } from "../shared/mcp-telemetry.js";
import { buildWindowsSpawn, trackSpawnedProcess } from "../shared/windows-spawn.js";
import { ProviderProcessTerminator } from "../../classes/ProviderProcessTerminator.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { liveScopeWaitPausesProviderStall, resolveProviderStallTimeout } from "../shared/stall-timeout.js";
import { getMaxOutputTokensForProvider } from "../shared/turns.js";
import { normalizeMaxOutputTokens } from "../shared/output-limits.js";
import { roleBrandColor, roleBrandIcon } from "../../../ui/functions/display/helpers/brand.js";
import { isWebToolName, recordToolUseObservations } from "../../../observability/functions/observations.js";
import {
  buildCodexWebToolsOverrides,
} from "./prompt-blocks.js";
import { getConfiguredCodexAuthMode, resolveCodexAuthModeInternal } from "./auth.js";
import { buildCodexWindowsLaunchEnv, formatSpawnLaunchForError, getCodexLaunchState, isReadyAsync } from "./cli-discovery.js";
import { buildCodexExecArgs, cleanupTempDir, collectCodexExtraDirs, makeTempOutputFile, prepareCodexConfigForSpawn } from "./cli-spawn.js";
import { isCodexResumeHandleExpiredError } from "./errors.js";
import { getMaxTurns, getModelOverride, getModelTierConfig, normalizeModelForAuthMode } from "./model-config.js";
import { buildCodexAtlasConfigOverridesAsync, buildCodexDeveloperInstructionRoute, buildCodexDeterministicReadConfigOverridesAsync, buildCodexSystemToolLockdownOverrides } from "./request-builders.js";
import { codexExitCleanupRegistry, normalizeCodexSessionHandle, extractCodexSessionHandleFromStreamMessage } from "./session.js";
import { __testBuildCloseStats, __testClassifyCodexStderrLine, _appendCodexToolUse, _extractCodexToolUse, appendBoundedCodexOutput, codexUsageEventDedupeKey, createCodexUsageAccumulator, extractLiveRequestUsageFromEvent, extractTurnCountFromEvent, extractUsageFromEvent, isTurnCompletedEvent, summarizeJsonEvent } from "./stream-events.js";
import { CodexTerminalUsageFlush } from "./terminal-usage-flush.js";
import { createCodexRolloutUsageTailer, reconcileCodexFreshSessionUsage, recoverCodexRolloutUsage, resolveCodexCloseTurns, sliceCodexResumedSessionUsage } from "./rollout-usage.js";
import { recoverCodexNativeSubagentTelemetry } from "./native-subagent-telemetry.js";

export function buildCodexRuntimeContractBlock(executionContract, {
  skipRolePrompt = false,
  nativeSystemToolsEnabled = false,
} = {}) {
  const contractBlock = renderExecutionContractBlock(executionContract, {
    remoteComposed: skipRolePrompt,
  });
  if (!skipRolePrompt) return contractBlock;

  // Remote-composed prompts already carry the provider-independent contract,
  // but this process alone knows the exact callable names issued to Codex.
  // The shared renderer supplies provider-local guidance for every provider;
  // writable Codex roles additionally need Codex's local mutation route.
  if (executionContract?.allowWrite !== true) return contractBlock;
  if (nativeSystemToolsEnabled) {
    return [
      contractBlock,
      "CODEX MUTATION ROUTE: native repository tools are enabled for this isolated direct session. Use native apply_patch for file edits.",
    ].filter(Boolean).join("\n");
  }

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
  cwd = null,          // real repo / worktree — codex sandbox root + MCP workspace
  loaderCwd = null,    // optional empty dir to spawn codex in (suppresses AGENTS.md parent-walk). Falls back to cwd.
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
  sandboxModeOverride = null,
  disableSystemTools: disableSystemToolsOverride = null,
  captureNativeSubagents = false,
} = {}) {
  const readiness = await isReadyAsync();
  if (!readiness.ready) {
    throw new Error(`Codex provider is not ready: ${readiness.reason}`);
  }
  const { cmd: codexCmd, args: codexArgs } = getCodexLaunchState();
  const providerPathsForAtlas = normalizeProviderPaths({ cwd, projectDir });
  const mcpWorkspaceCwdForAtlas = mcpCwd ? path.resolve(mcpCwd) : providerPathsForAtlas.cwd;
  const assignmentUnitForAtlas = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const preparedAtlasConfig = await buildCodexAtlasConfigOverridesAsync(
    role,
    mcpWorkspaceCwdForAtlas,
    { assignmentUnit: assignmentUnitForAtlas, workItemId, disableAtlas, atlasConfig },
  );

  return new Promise((resolve, reject) => {
    void (async () => {
    try {
    const tierConfig = getModelTierConfig(modelTier);
    const authResolution = resolveCodexAuthModeInternal({ configuredMode: getConfiguredCodexAuthMode() });
    if (!authResolution.ok) {
      reject(new Error(authResolution.reason));
      return;
    }
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
    const spawnCwd = resumeSessionHandle ? workingDir : (loaderCwd ? path.resolve(loaderCwd) : workingDir);
    const assignmentUnit = assignmentUnitForAtlas;
    const { attachment: atlasAttachment, configOverrides: atlasConfigOverrides, serverKey: atlasMcpServerKey } = preparedAtlasConfig;
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
      reject(err);
      return;
    }
    const atlasToolGateEnabled = resolveAtlasToolGateEnabled();
    const disableSystemTools = typeof disableSystemToolsOverride === "boolean"
      ? disableSystemToolsOverride
      : resolveDisableSystemTools();
    const atlasReadyForMcp = hasProviderVisibleAtlasMcpTools({
      disableAtlas,
      atlasPrefetchStatus,
      atlasAttachment,
    });
    const deterministicReadMcp = await buildCodexDeterministicReadConfigOverridesAsync(role, mcpWorkspaceCwd, {
      scopedFiles,
      createFiles,
      deleteFiles,
      createRoots,
      readRoots,
      allowWrite,
      projectDbWrite,
      projectDbCapability,
      needsImageGeneration,
      disableSystemTools,
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
    const cleanupDeterministicMcpSession = () => {
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
      : atlasMcpServerKey;
    const remoteAtlasToolNames = Array.isArray(deterministicReadMcp.atlasTools)
      ? deterministicReadMcp.atlasTools
      : [];
    const atlasContractTools = atlasReadyForMcp && remoteAtlasToolNames.length > 0
      ? buildMcpAtlasSurfaceToolDescriptors(remoteAtlasToolNames, {
        providerName: "codex",
        serverName: atlasServerName,
      })
      : [];
    // Disable AGENTS.md auto-discovery (parent-walk + fallback filenames).
    // Agents access the real repo via the deterministic MCP, not via auto-loaded project docs.
    const memorySuppressionOverrides = ["project_doc_max_bytes=0"];
    const systemToolLockdownOverrides = buildCodexSystemToolLockdownOverrides({
      disableSystemTools,
      disableNativeImageGeneration: deterministicReadMcp.tools.includes("generate_image"),
      disableResearcherUtilities: deterministicReadMcp.atlasResearcherDispatcher === true,
    });
    const webTools = buildCodexWebToolsOverrides({
      role,
      roleMode,
      webToolsEnabled: resolveWebToolsEnabled() && issuedWebAccessEnabled(_remoteIssuedPolicy),
    });
    // The Posse MCP gateway exposes deterministic and atlas.* suites from a
    // single process, so do not attach a second ATLAS MCP server when the
    // gateway is already active.
    const atlasServedByGateway = !!deterministicReadMcp.active;
    const combinedConfigOverrides = [
      ...memorySuppressionOverrides,
      ...systemToolLockdownOverrides,
      ...deterministicReadMcp.configOverrides,
      ...(atlasServedByGateway || !atlasReadyForMcp ? [] : atlasConfigOverrides),
      ...webTools.configOverrides,
    ];
    const remoteSystemPromptText = String(remoteSystemPrompt || "").trim();
    const promptPrelude = remoteSystemPromptText;
    let executionContract = buildExecutionContract({
      provider: "codex",
      role,
      roleMode,
      allowWrite,
      allowTests,
      projectDbWrite,
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
      includeBaseTools: !(deterministicReadMcp.active || disableSystemTools),
      projectDir: workingDir,
    });
    executionContract = appendExecutionTools(executionContract, deterministicReadMcp.contractTools || deterministicReadMcp.tools);
    executionContract = appendExecutionTools(executionContract, atlasContractTools);
    executionContract = adaptExecutionContractForProvider(executionContract, "codex");
    // Remote owns provider-independent behavior. The shared renderer keeps
    // provider-local guidance aligned with the exact issued Codex surface.
    const contractBlock = buildCodexRuntimeContractBlock(executionContract, {
      skipRolePrompt,
      nativeSystemToolsEnabled: !disableSystemTools && !deterministicReadMcp.active,
    });
    const developerInstructionRoute = buildCodexDeveloperInstructionRoute({
      promptPrelude,
      contractBlock,
      stableContext: skipRolePrompt ? null : stableContext,
    });
    if (developerInstructionRoute.configOverride) {
      combinedConfigOverrides.push(developerInstructionRoute.configOverride);
    }
    const finalPrompt = [
      developerInstructionRoute.inlinePromptPrelude ? `ROLE INSTRUCTIONS:\n${developerInstructionRoute.inlinePromptPrelude}` : null,
      promptText,
    ].filter(Boolean).join("\n\n");

    if (typeof recordFinalPrompt === "function") {
      recordFinalPrompt(finalPrompt, { systemPrompt: developerInstructionRoute.developerInstructions });
    }

    const configRoute = prepareCodexConfigForSpawn(combinedConfigOverrides, {
      authMode: preferredAuthMode,
    });
    // Clean, Posse-owned provider home computed generically by the MCP helper
    // (so it applies to every provider). The Windows config-spill path already
    // owns CODEX_HOME, so only apply the isolated home when it did not.
    const providerHomeEnv = deterministicReadMcp.providerHomeEnv
      || deterministicReadMcp.serverConfig?.providerHomeEnv
      || null;
    const temp = makeTempOutputFile();
    const cleanupRunTemps = (mcpAttachProofContext = null, { syncConfigCleanup = false } = {}) => {
      const releaseResult = cleanupDeterministicMcpSession();
      let attachProofResult = null;
      if (mcpAttachProofContext) {
        try {
          attachProofResult = logProviderMcpAttachProofTelemetry({
            providerName: "codex",
            role,
            workItemId,
            jobId,
            attemptId,
            deterministicReadMcp: mcpAttachProofContext.deterministicReadMcp || deterministicReadMcp,
            releaseResult,
            exitCode: mcpAttachProofContext.exitCode ?? null,
            phase: mcpAttachProofContext.phase || "provider_cleanup",
          });
        } catch {
          attachProofResult = null;
        }
      }
      cleanupTempDir(temp.dir);
      if (syncConfigCleanup) {
        configRoute.cleanup();
      } else {
        void Promise.resolve(configRoute.cleanupAsync?.()).catch(() => {});
      }
      return { releaseResult, attachProofResult };
    };
    const clearExitCleanup = codexExitCleanupRegistry.register(
      () => cleanupRunTemps(null, { syncConfigCleanup: true }),
    );
    const forceReadOnlySandbox = !!(deterministicReadMcp.active && allowWrite);
    const args = buildCodexExecArgs({
      codexArgs,
      outputFile: temp.file,
      workingDir,
      allowWrite,
      modelToUse,
      reasoningEffort,
      configOverrides: configRoute.configOverrides,
      forceReadOnlySandbox,
      sandboxModeOverride,
      priorSessionHandle: resumeSessionHandle,
    });
    logProviderMcpSurfaceTelemetry({
      providerName: "codex",
      role,
      workItemId,
      jobId,
      attemptId,
      deterministicReadMcp,
      atlasReadyForMcp,
      atlasContractTools,
      mcpServerNames: [
        deterministicReadMcp.active ? deterministicReadMcp.serverKey : null,
        (!atlasServedByGateway && atlasReadyForMcp) ? atlasMcpServerKey : null,
      ].filter(Boolean),
      emittedCliArgs: args,
      configOverrideCount: combinedConfigOverrides.length,
      forceReadOnlySandbox,
    });

    const extraDirs = collectCodexExtraDirs({ workingDir, scopedFiles, createFiles, createRoots, readRoots });
    if (resumeSessionHandle && extraDirs.size > 0) {
      clearExitCleanup();
      cleanupRunTemps();
      const err = new Error("Codex session resume cannot enforce --add-dir scope; falling back to fresh execution is required.");
      err.code = "CODEX_RESUME_CONTRACT_UNSUPPORTED";
      reject(err);
      return;
    }
    for (const dir of extraDirs) {
      args.splice(args.length - 1, 0, "--add-dir", dir);
    }

    const color = roleBrandColor(role, C.cyan);
    const icon = roleBrandIcon(role);
    const directOutput = !onLine && !silent;
    const showHeader = directOutput && role !== "assessor";

    if (showHeader) {
      const tierLabel = ` ${C[tierConfig.color] || ""}[${tierConfig.label}]${C.reset}`;
      const modelLabel = modelToUse ? ` ${C.dim}model:${modelToUse}${C.reset}` : "";
      const actLabel = activity ? `  ${C.dim}-- ${activity}${C.reset}` : "";
      console.log(`\n${color}+${"---".repeat(20)}+${C.reset}`);
      console.log(`${color}|${C.reset} [${icon}] ${color}${C.bold}${role.toUpperCase()}${C.reset}${tierLabel}${modelLabel} ${C.dim}(codex)${C.reset}${actLabel}`);
      console.log(`${color}+${"---".repeat(20)}+${C.reset}`);
    }

    const emit = (line) => {
      if (!line) return;
      if (directOutput) process.stdout.write(`${color}|${C.reset} ${line}\n`);
      else if (onLine) onLine(line);
    };

    const childEnv = buildCodexWindowsLaunchEnv(
      buildRuntimeEnv(providerPaths.projectDir, providerPaths.cwd, process.env),
      codexCmd,
    );
    if (preferredAuthMode === "oauth") {
      delete childEnv.CODEX_API_KEY;
      delete childEnv.OPENAI_API_KEY;
    }
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete childEnv.XAI_API_KEY;
    delete childEnv.GITHUB_TOKEN;
    Object.assign(
      childEnv,
      deterministicReadMcp.providerChildEnv
        || deterministicReadMcp.serverConfig?.providerChildEnv
        || {},
    );
    if (configRoute.codexHome) childEnv.CODEX_HOME = configRoute.codexHome;
    else if (providerHomeEnv?.isolated && providerHomeEnv.envVar) childEnv[providerHomeEnv.envVar] = providerHomeEnv.home;
    // Codex defaults to ~/.codex when CODEX_HOME is absent. Use the same
    // resolved location for live and close-time rollout recovery; passing an
    // undefined CODEX_HOME silently loses native-child and request telemetry.
    const rolloutCodexHome = childEnv.CODEX_HOME
      || process.env.CODEX_HOME
      || path.join(os.homedir(), ".codex");

    const launch = buildWindowsSpawn(codexCmd, args);
    const startTime = Date.now();
    // Capture the durable ordinal boundary before a resumed process can append
    // to its existing rollout. If this baseline cannot be established, the
    // call must not account the session's historical cumulative totals.
    const resumedRolloutBaseline = resumeSessionHandle
      ? recoverCodexRolloutUsage({
          codexHome: rolloutCodexHome,
          sessionHandle: resumeSessionHandle,
        })
      : null;
    let stdout = "";
    let stderr = "";
    let totalInputTokens = null;
    let totalOutputTokens = null;
    let totalCachedInputTokens = null;
    let reasoningOutputTokens = null;
    let longContextInputTokens = null;
    let latestSessionHandle = resumeSessionHandle || null;
    let latestTurnCount = null;
    const buildSpawnError = (err) => {
      const durationMs = Date.now() - startTime;
      const wrapped = new Error(
        `Failed to spawn codex at: ${formatSpawnLaunchForError(launch)}\n${err.message}`
      );
      wrapped.code = err.code || null;
      wrapped.stats = {
        role,
        modelTier,
        reasoningEffort,
        modelName: modelToUse,
        provider: "codex",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cachedInputTokens: totalCachedInputTokens,
        reasoningOutputTokens,
        longContextInputTokens,
        durationMs,
        maxTurns: turnLimit,
        maxOutputTokens: outputTokenLimit,
        outputTruncated: false,
        outputLimitReason: null,
      };
      wrapped.stdout = stdout;
      wrapped.stderr = stderr;
      return wrapped;
    };
    let proc;
    try {
      proc = spawn(launch.command, launch.args, {
        cwd: spawnCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      trackSpawnedProcess(proc, launch.command, {
        label: `codex:${role || "provider"}`,
        cwd: spawnCwd,
      });
    } catch (err) {
      clearExitCleanup();
      cleanupRunTemps();
      reject(buildSpawnError(err));
      return;
    }

    const processTerminator = new ProviderProcessTerminator(proc);
    const terminalUsageFlush = new CodexTerminalUsageFlush(
      (reason) => processTerminator.requestAbort(reason),
    );

    if (abortSignal) {
      const onAbort = () => {
        terminalUsageFlush.request(abortSignal.reason);
      };
      if (abortSignal.aborted) onAbort();
      else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => abortSignal.removeEventListener("abort", onAbort));
      }
    }

    proc.stdin.on("error", () => {});
    proc.stdin.write(finalPrompt);
    proc.stdin.end();

    const usageAccumulator = createCodexUsageAccumulator();
    let usageProgressSequence = 0;
    let previousUsageProgress = null;
    const emitUsageProgress = (progress) => {
      const progressKey = JSON.stringify(progress);
      if (progressKey === previousUsageProgress) return;
      previousUsageProgress = progressKey;
      try {
        onUsageProgress?.({
          sequenceId: ++usageProgressSequence,
          ...progress,
        });
      } catch { /* progress telemetry cannot break provider execution */ }
    };
    // Per-request usage never rides the live `exec --json` stream (a codex
    // turn spans the whole tool loop, and its single terminal turn.completed
    // is usually lost to the handoff kill). The rollout file appends a
    // token_count event after every provider request — tail it so context
    // checkpoints exist while the call is still running.
    const rolloutUsageTailer = createCodexRolloutUsageTailer({
      codexHome: rolloutCodexHome,
      startedAtMs: startTime,
      startAtEnd: !!resumeSessionHandle,
    });
    let lastRolloutUsagePollMs = 0;
    let killedByStallDetector = false;
    let stallKillReason = "no_output";
    let lastActivity = Date.now();
    let lastMeaningfulActivity = lastActivity;
    const seenStderrNotices = new Set();
    const toolUses = [];
    let completedTurnEvents = 0;
    let stdoutLineBuffer = "";
    const LINE_BUF_MAX = 16 * 1024 * 1024;
    const handleStdoutLine = (raw) => {
      if (!raw) return;
      try {
        const msg = JSON.parse(raw);
        latestSessionHandle = extractCodexSessionHandleFromStreamMessage(msg) || latestSessionHandle;
        const usage = extractUsageFromEvent(msg);
        const totals = usageAccumulator.add(usage, { eventKey: codexUsageEventDedupeKey(msg) });
        if (!resumeSessionHandle) {
          if (totals.inputTokens != null) totalInputTokens = totals.inputTokens;
          if (totals.outputTokens != null) totalOutputTokens = totals.outputTokens;
          if (totals.cachedInputTokens != null) totalCachedInputTokens = totals.cachedInputTokens;
          if (totals.longContextInputTokens != null) longContextInputTokens = totals.longContextInputTokens;
        }
        if (usage.inputTokens != null || usage.outputTokens != null || usage.cachedInputTokens != null) {
          terminalUsageFlush.noteUsage();
        }
        const liveRequestUsage = extractLiveRequestUsageFromEvent(msg);
        if (process.env.POSSE_DEBUG_CTX_CHECKPOINT) {
          try {
            const bodyType = msg?.msg?.type || msg?.payload?.type || msg?.type || "?";
            console.error(`[ctx-debug] stdout event type=${bodyType} live=${liveRequestUsage ? JSON.stringify(liveRequestUsage) : "null"}`);
          } catch { /* debug only */ }
        }
        const aggregateProgressAvailable = !resumeSessionHandle
          && (totals.inputTokens != null || totals.outputTokens != null);
        if (liveRequestUsage || aggregateProgressAvailable) {
          const progress = liveRequestUsage
            ? {
              provider: "codex",
              modelName: modelToUse,
              ...totals,
              ...liveRequestUsage,
            }
            : {
              provider: "codex",
              modelName: modelToUse,
              ...totals,
              precision: "aggregate_only",
            };
          emitUsageProgress(progress);
        }
        const turnCount = extractTurnCountFromEvent(msg);
        if (turnCount != null) latestTurnCount = Math.max(latestTurnCount ?? 0, turnCount);
        if (isTurnCompletedEvent(msg)) completedTurnEvents++;
        const extracted = _extractCodexToolUse(msg);
        const extractedEntries = Array.isArray(extracted) ? extracted : (extracted ? [extracted] : []);
        const webToolUses = extractedEntries.filter((entry) => entry && isWebToolName(entry.tool));
        if (webToolUses.length > 0) {
          recordToolUseObservations({
            tool_uses: webToolUses,
            cwd: workingDir,
          });
        }
        _appendCodexToolUse(toolUses, extracted);
        const summary = summarizeJsonEvent(msg, { onAgentCommentary });
        if (extractedEntries.length > 0 || summary) lastMeaningfulActivity = Date.now();
        if (summary) emit(`${C.dim}${summary}${C.reset}`);
      } catch {
        lastMeaningfulActivity = Date.now();
        emit(`${C.dim}${raw}${C.reset}`);
      }
    };

    const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
    const baseTimeout = resolveProviderStallTimeout(stallTimeout);
    const stallMs = baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;
    const semanticStallMs = role === "assessor" ? Math.min(stallMs, 300_000) : stallMs;

    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastRolloutUsagePollMs >= 2_000) {
        lastRolloutUsagePollMs = now;
        try {
          rolloutUsageTailer.setSessionHandle(latestSessionHandle);
          for (const usage of rolloutUsageTailer.poll()) {
            if (process.env.POSSE_DEBUG_CTX_CHECKPOINT) {
              console.error(`[ctx-debug] rollout tail usage ${JSON.stringify(usage)}`);
            }
            emitUsageProgress({ provider: "codex", modelName: modelToUse, ...usage });
          }
        } catch { /* rollout tailing must not break provider execution */ }
      }
      if (liveScopeWaitPausesProviderStall(jobId)) {
        lastActivity = now;
        lastMeaningfulActivity = now;
        return;
      }
      const noByteOutput = now - lastActivity > stallMs;
      const noMeaningfulProgress = role === "assessor" && now - lastMeaningfulActivity > semanticStallMs;
      if (noByteOutput || noMeaningfulProgress) {
        clearInterval(heartbeat);
        killedByStallDetector = true;
        stallKillReason = noMeaningfulProgress
          ? `no assessor progress for ${(semanticStallMs / 1000)}s`
          : `no output for ${(stallMs / 1000)}s`;
        emit(`${C.red}!! Stalled (${stallKillReason}) -- killing process${C.reset}`);
        processTerminator.requestTermination("stall_detector");
      }
    }, 500);

    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");

    proc.stdout.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        stdout = appendBoundedCodexOutput(stdout, text);
        lastActivity = Date.now();
        const parts = `${stdoutLineBuffer}${text}`.split(/\r?\n/);
        stdoutLineBuffer = parts.pop() || "";
        if (stdoutLineBuffer.length > LINE_BUF_MAX) {
          emit(`${C.yellow}Codex stdout line exceeded ${LINE_BUF_MAX} bytes without newline -- dropping buffer${C.reset}`);
          stdoutLineBuffer = "";
        }
        for (const raw of parts.filter(Boolean)) handleStdoutLine(raw);
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stream handler error");
        emit(`${C.yellow}[provider] Codex stdout handler error: ${msg}${C.reset}`);
      }
    });

    proc.stderr.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        stderr = appendBoundedCodexOutput(stderr, text);
        lastActivity = Date.now();
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          const classified = __testClassifyCodexStderrLine(line);
          if (!classified.display) continue;
          if (classified.dedupeKey && seenStderrNotices.has(classified.dedupeKey)) continue;
          if (classified.dedupeKey) seenStderrNotices.add(classified.dedupeKey);
          lastMeaningfulActivity = Date.now();
          emit(classified.display);
        }
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stream handler error");
        emit(`${C.yellow}[provider] Codex stderr handler error: ${msg}${C.reset}`);
      }
    });

    proc.on("error", (err) => {
      clearInterval(heartbeat);
      processTerminator.cancelTimer();
      terminalUsageFlush.cancel();
      clearExitCleanup();
      cleanupRunTemps({ deterministicReadMcp, exitCode: null, phase: "provider_error" });
      reject(buildSpawnError(err));
    });

    proc.on("close", (code) => {
      clearInterval(heartbeat);
      terminalUsageFlush.cancel();
      clearExitCleanup();
      const durationMs = Date.now() - startTime;
      const termination = processTerminator.noteClose();
      if (stdoutLineBuffer.trim()) {
        handleStdoutLine(stdoutLineBuffer.trim());
        stdoutLineBuffer = "";
      }
      let rolloutUsage = null;
      let rolloutUsageApplied = false;
      let rolloutUsageMismatches = [];
      let rolloutUsageSource = null;
      let rolloutRecoveryIncomplete = false;
      if (latestSessionHandle) {
        const currentRolloutUsage = recoverCodexRolloutUsage({
          codexHome: rolloutCodexHome,
          sessionHandle: latestSessionHandle,
          startedAtMs: startTime,
        });
        rolloutUsage = resumeSessionHandle
          ? sliceCodexResumedSessionUsage(resumedRolloutBaseline, currentRolloutUsage)
          : currentRolloutUsage;
        rolloutRecoveryIncomplete = currentRolloutUsage != null && currentRolloutUsage.complete !== true;
        if (resumeSessionHandle && !rolloutUsage) rolloutRecoveryIncomplete = true;
        if (rolloutUsage?.usage && rolloutUsage.complete === true) {
          const reconciled = resumeSessionHandle
            ? { usage: rolloutUsage.usage, mismatches: [], source: "codex_rollout" }
            : reconcileCodexFreshSessionUsage({
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cachedInputTokens: totalCachedInputTokens,
            reasoningOutputTokens,
            longContextInputTokens,
          }, rolloutUsage.usage);
          totalInputTokens = reconciled.usage.inputTokens;
          totalOutputTokens = reconciled.usage.outputTokens;
          totalCachedInputTokens = reconciled.usage.cachedInputTokens;
          reasoningOutputTokens = reconciled.usage.reasoningOutputTokens;
          longContextInputTokens = reconciled.usage.longContextInputTokens;
          rolloutUsageApplied = true;
          rolloutUsageMismatches = reconciled.mismatches;
          rolloutUsageSource = reconciled.source;
          for (const [index, segment] of (rolloutUsage.segments || []).entries()) {
            try {
              onUsageSegment?.({
                ...segment,
                requestOrdinal: index + 1,
                provider: "codex",
                modelName: modelToUse,
                durationMs: null,
                usageSource: "rollout_recovered",
                precision: "recovered_exact",
              });
            } catch { /* accounting persistence cannot break provider execution */ }
          }
        }
      }
      let nativeSubagentTelemetry = null;
      if (captureNativeSubagents && latestSessionHandle) {
        nativeSubagentTelemetry = recoverCodexNativeSubagentTelemetry({
          codexHome: rolloutCodexHome,
          parentSessionHandle: latestSessionHandle,
          startedAtMs: startTime,
        });
      }
      let finalOutput = "";
      let mcpCleanup = null;
      try {
        finalOutput = fs.existsSync(temp.file) ? fs.readFileSync(temp.file, "utf-8").trim() : "";
      } catch {
        finalOutput = "";
      } finally {
        mcpCleanup = cleanupRunTemps({ deterministicReadMcp, exitCode: code, phase: "provider_close" });
      }

      const stats = __testBuildCloseStats({
        role,
        modelTier,
        reasoningEffort,
        modelName: modelToUse,
        totalInputTokens,
        totalOutputTokens,
        totalCachedInputTokens,
        reasoningOutputTokens,
        longContextInputTokens,
        durationMs,
        finalOutput,
        stdout,
        code,
        atlasMethod: atlasMethodForStats,
        toolUses,
        toolUsesLoggedByToolkit: !!deterministicReadMcp.active,
        sessionHandle: latestSessionHandle,
        priorSessionHandle: resumeSessionHandle,
        // Current Codex JSONL emits turn.completed without a numeric count.
        // Count those lifecycle events; tool calls are not turns and can be
        // absent when the deterministic MCP gateway owns their telemetry.
        numTurns: resolveCodexCloseTurns({
          latestTurnCount,
          completedTurnEvents,
          rolloutUsageApplied,
          rolloutUsage,
        }),
        maxTurns: turnLimit,
        maxOutputTokens: outputTokenLimit,
        outputTruncated: false,
        outputLimitReason: null,
      });
      stats.mcpAttachProof = mcpCleanup?.attachProofResult?.proof || null;
      stats.mcpAttachMissingProof = mcpCleanup?.attachProofResult?.missingProof === true;
      stats.mcpAttachProjectionMismatch = mcpCleanup?.attachProofResult?.projectionMismatch === true;
      Object.assign(stats, termination);
      Object.assign(stats, terminalUsageFlush.snapshot());
      if (rolloutUsageApplied) {
        stats.tokenUsageSource = rolloutUsageSource;
        stats.rolloutFile = rolloutUsage.file;
        stats.providerRequestCount = rolloutUsage.providerRequestCount;
        stats.usageCapturePrecision = "recovered_exact";
        if (rolloutUsageMismatches.length > 0) {
          stats.rolloutUsageMismatches = rolloutUsageMismatches;
        }
        // This is durable measured usage through the last flushed token event,
        // not evidence that Codex emitted its terminal turn.completed event.
        stats.usageFinalized = stats.inputTokens != null && stats.outputTokens != null;
      } else if (rolloutRecoveryIncomplete) {
        stats.usageCapturePrecision = "incomplete";
      } else if (stats.inputTokens != null && stats.outputTokens != null) {
        stats.usageCapturePrecision = "aggregate_only";
      } else {
        stats.usageCapturePrecision = "unknown";
      }
      if (captureNativeSubagents) stats.nativeSubagentTelemetry = nativeSubagentTelemetry;

      // Persist MCP-relevant CLI stderr (only when present) so a gateway
      // attach-under-load failure leaves a trace even on a clean exit.
      try {
        logProviderCliStderrTelemetry({
          providerName: "codex",
          role,
          workItemId,
          jobId,
          attemptId,
          exitCode: code,
          stderr,
          attachProof: stats.mcpAttachProof,
        });
      } catch { /* telemetry only */ }

      if (code === 0) {
        if (stats.mcpAttachMissingProof) {
          const err = new Error("Codex deterministic MCP attach proof missing: provider exited without owner-observed initialize/tools-list.");
          err.code = "MCP_ATTACH_PROOF_MISSING";
          err.stats = stats;
          err.stdout = stdout;
          err.stderr = stderr;
          err.output = finalOutput || stdout.trim() || null;
          err.partialOutput = err.output;
          err.toolUses = toolUses;
          err.mcpAttachMissingProof = true;
          reject(err);
          return;
        }
        if (stats.mcpAttachProjectionMismatch) {
          const err = new Error("Codex deterministic MCP projection mismatch: the thin gate did not surface its required tool contract.");
          err.code = "MCP_ATTACH_PROJECTION_MISMATCH";
          err.stats = stats;
          err.stdout = stdout;
          err.stderr = stderr;
          err.output = finalOutput || stdout.trim() || null;
          err.partialOutput = err.output;
          err.toolUses = toolUses;
          err.mcpAttachProjectionMismatch = true;
          reject(err);
          return;
        }
        resolve({ output: finalOutput || stdout.trim(), stats });
        return;
      }

      const err = new Error(
        killedByStallDetector
          ? `Codex CLI stalled after ${(durationMs / 1000).toFixed(1)}s and was killed (${stallKillReason})`
          : `Codex CLI exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      );
      err.code = code;
      err.stats = stats;
      err.stallKill = killedByStallDetector;
      err.stallReason = stallKillReason;
      err.sessionExpired = !!resumeSessionHandle && isCodexResumeHandleExpiredError(`${stderr}\n${stdout}\n${finalOutput}`);
      if (err.sessionExpired) err.stats.sessionExpired = true;
      err.stdout = stdout;
      err.stderr = stderr;
      err.output = finalOutput || stdout.trim() || null;
      err.partialOutput = err.output;
      err.toolUses = toolUses;
      err.mcpAttachMissingProof = stats.mcpAttachMissingProof;
      err.mcpAttachProjectionMismatch = stats.mcpAttachProjectionMismatch;
      reject(err);
    });
    } catch (err) {
      reject(err);
    }
    })();
  });
}
