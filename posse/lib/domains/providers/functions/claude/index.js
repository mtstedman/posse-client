// Claude provider prompt projection and Rust dispatch boundary.
import crypto from "node:crypto";
import path from "path";
import { MCP_TOOL_DEADLINE_MODES } from "../../../../catalog/provider.js";
import { getSetting } from "../../../queue/functions/index.js";
import { appendExecutionTools, buildExecutionContract, renderExecutionContractBlock, renderProviderPromptContracts } from "../../../../shared/tools/functions/contract.js";
import { issuedToolSurfaceForProviderPolicy } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { buildMcpAtlasSurfaceToolDescriptors, buildSurfaceNameMap } from "../../../../shared/tools/functions/mcp-surface.js";
import { normalizeProviderPaths } from "../../../runtime/functions/paths.js";
import { logAtlasAttachment, resolveAtlasAssignmentUnit, withAtlasExecutionPolicySnapshot } from "../../../integrations/functions/atlas.js";
import { releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { hasProviderVisibleAtlasMcpTools } from "../shared/atlas-mcp.js";
import { providerRuntimeState } from "../../classes/runtime-state-singleton.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { getUsageSummary, refreshUsageSummary } from "./usage-summary.js";
import { getClaudeReadiness, isReady } from "./cli-discovery.js";
import { escalateModelTier, getMaxOutputTokensForProvider, getMaxTurnsForProvider } from "../shared/turns.js";
import { normalizeMaxOutputTokens } from "../shared/output-limits.js";
import { resolveProviderStallTimeout } from "../shared/stall-timeout.js";
import { classifyProviderError } from "../shared/api-resilience.js";
import { buildClaudeAtlasAttachmentAsync, buildClaudeNativeMcpAttachmentAsync } from "./mcp-config.js";
import { classifyClaudeCliFailure, __testClassifyClaudeCliFailure } from "./failure-classification.js";
import { warmOauthSessionAsync } from "./oauth-warmup.js";
import { buildNativeDispatchRequest, rejectRawCliControlOptions, runNativeDispatch } from "../shared/native-dispatch.js";

export { __testClassifyClaudeCliFailure, getClaudeReadiness, getUsageSummary, isReady, refreshUsageSummary, warmOauthSessionAsync };

// ─── Capabilities ───────────────────────────────────────────────────────────

export const capabilities = Object.freeze({
  images: false,
  sessionResume: true,
  toolAttachment: "mcp",
  mcpToolDeadline: MCP_TOOL_DEADLINE_MODES.SERVER_CONFIG,
});

// ─── Model Tier Config ──────────────────────────────────────────────────────

// Maps the DB schema's model_tier + reasoning_effort to concrete Claude settings.
// Model overrides come from Posse settings, not shell env.
export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("claude").cheap.model,
    thinking: false,
    label: "$ CHEAP",
    color: "dim",
  },
  standard: {
    model: getProviderTierDefaults("claude").standard.model,
    thinking: false,
    label: "STANDARD",
    color: "cyan",
  },
  strong: {
    model: getProviderTierDefaults("claude").strong.model,
    thinking: true,
    label: "STRONG",
    color: "magenta",
  },
};

function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

function getModelOverride() {
  return readModelSetting("claude_model") || null;
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`claude_model_${key}`) || base.model,
  };
}

// ─── Max Turns Config ────────────────────────────────────────────────────────

// Per-role base turns. Role/tier/task modifiers are applied on top.
/**
 * Get max turns for a role, starting from a configurable base turn budget.
 *
 * For dev/artificer: complexity (1-5 from planner) drives the turn budget.
 * Low complexity tasks get fewer turns, high complexity tasks get more.
 * This prevents simple tasks from burning tokens on stuck loops while
 * giving complex tasks room to iterate.
 */
function getMaxTurns(role, modelTier = "standard", complexity = null, deepthink = false, filesToModifyCount = null) {
  return getMaxTurnsForProvider("claude", { role, modelTier, complexity, filesToModifyCount, deepthink });
}

export function __testGetMaxTurns(role, modelTier = "standard", complexity = null, deepthink = false, filesToModifyCount = null) {
  return getMaxTurns(role, modelTier, complexity, deepthink, filesToModifyCount);
}

// ─── Claude provider turn ────────────────────────────────────────────────────

export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  taskMode = null,
  allowWrite = false,
  allowTests = true,
  projectDbWrite = false, // db-mode dev: project_db_query gets the write lane while file tools stay read-only
  projectDbCapability = "none",
  modelTier = "standard",
  modelName = null,    // explicit per-job model from delegation; beats provider-wide default
  reasoningEffort = "medium",
  activity = "",
  silent = false,
  autoApprove = false,
  scopedFiles = null,  // string[] — files_to_modify: Write/Edit scoped to these exact paths
  createFiles = null,  // string[] — files_to_create: Write scoped to these exact new file paths
  createRoots = null,  // string[] — directories where Write is allowed for any path under them
  readRoots = null,    // string[] — directories readable outside cwd, never writable
  deleteFiles = null,
  stableContext = null,
  remoteSystemPrompt = null,
  maxTurns = null,
  maxOutputTokens = null,
  deepthink = false,
  complexity = null,   // 1-5 planner complexity score — drives dynamic turn budget for dev/artificer
  filesToModifyCount = null, // dev turn scaling input from planner scope size
  jobDir = null,       // per-job scratch dir noted in the prompt
  onLine = null,       // (line: string) => void — routes output lines externally (implies silent stdout)
  cwd = null,          // real repo / worktree — used for MCP workspace + git ops
  mcpCwd = null,       // optional override for MCP workspace root. Falls back to cwd.
  projectDir = null,   // project root for runtime path resolution
  abortSignal = null,  // AbortSignal — cancels the Rust dispatch
  stallTimeout = null, // Override stall timeout in seconds (default: 600)
  needsImageGeneration = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  fallbackReads = null,
  assessorMaxToolCalls = null,
  skipRolePrompt = false,
  recyclingMode = "fresh",
  priorSessionHandle = null,
  recordFinalPrompt = null, // (finalPrompt, { systemPrompt?, systemPromptFiles? }) => void
  onUsageSegment = null,
  disableAtlas = false,
  atlasPrefetchStatus = null,
  atlasConfig = null,
  _remoteIssuedPolicy = null,
  _remoteToolSurface = null,
  mcpGate = null,
  disableAgentTools = false,
  skillsAttached = null,
  onAgentCommentary = null, // (text: string) => void — visible assistant text, like Codex agent messages
  onProviderToolUse = null, // (toolUse) => void — each completed tool_use block as it streams
  onProviderToolResult = null, // ({ id, isError }) => void — each tool_result block as it streams
  ...otherOptions      // checked only for retired raw CLI controls
} = {}) {
  rejectRawCliControlOptions("claude", otherOptions);
  const providerPathsForAtlas = normalizeProviderPaths({ cwd, projectDir });
  const mcpWorkspaceCwdForAtlas = mcpCwd ? path.resolve(mcpCwd) : providerPathsForAtlas.cwd;
  const assignmentUnitForAtlas = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const preparedAtlasMcp = await buildClaudeAtlasAttachmentAsync(
    role,
    mcpWorkspaceCwdForAtlas,
    { assignmentUnit: assignmentUnitForAtlas, workItemId, disableAtlas, atlasConfig },
  );
  let cleanupDeterministicMcpSession = () => null;
  try {
    const remoteSystemPromptText = recyclingMode === "resume" ? "" : String(remoteSystemPrompt || "").trim();
    const modelToUse = selectExecutionModel({ jobModelName: modelName, globalModelOverride: getModelOverride(), tierModel: getModelTierConfig(modelTier).model });
    const turns = maxTurns || getMaxTurns(role, modelTier, complexity, deepthink, filesToModifyCount);
    const outputTokenLimit = normalizeMaxOutputTokens(maxOutputTokens)
      || getMaxOutputTokensForProvider("claude", { role });
    const providerPaths = normalizeProviderPaths({ cwd, projectDir });
    const mcpWorkspaceCwd = mcpCwd ? path.resolve(mcpCwd) : providerPaths.cwd;
    const { attachment: atlasAttachment } = preparedAtlasMcp;
    const executionAtlasConfig = withAtlasExecutionPolicySnapshot(atlasConfig, atlasAttachment);
    const atlasMethodForStats = disableAtlas ? null : (atlasAttachment?.method || "baseline");
    logAtlasAttachment({
      attachment: atlasAttachment,
      jobId,
      workItemId,
      providerName: "claude",
      role,
    });
    if (atlasAttachment.failClosed) {
      const err = new Error(
        `ATLAS required mode blocks ${role} on claude (${atlasAttachment.requiredFailureReason || "unavailable"}).`
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
    const deterministicReadMcp = await buildClaudeNativeMcpAttachmentAsync(role, mcpWorkspaceCwd, {
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
    if (deterministicReadMcp.serverConfig?.ownerSession) {
      let released = false;
      cleanupDeterministicMcpSession = () => {
        if (released) return { released: false, reason: "already_released" };
        released = true;
        try {
          return releaseDeterministicMcpServerSession(deterministicReadMcp.serverConfig, {
            reason: "provider_cleanup",
            context: { provider: "claude", role, jobId, workItemId, attemptId },
          });
        } catch (err) {
          return {
            released: false,
            reason: "release_error",
            error: { message: String(err?.message || err) },
          };
        }
      };
    }
    const atlasServerName = deterministicReadMcp.active
      ? deterministicReadMcp.serverName
      : null;
    const remoteAtlasToolNames = Array.isArray(deterministicReadMcp.atlasTools)
      ? deterministicReadMcp.atlasTools
      : [];
    const atlasContractTools = atlasReadyForMcp && remoteAtlasToolNames.length > 0
      ? buildMcpAtlasSurfaceToolDescriptors(remoteAtlasToolNames, {
        providerName: "claude",
        serverName: atlasServerName,
      })
      : [];
    const promptAtlasAttachment = atlasReadyForMcp && remoteAtlasToolNames.length > 0
      ? { ...atlasAttachment, tools: remoteAtlasToolNames, surfaceToolNames: buildSurfaceNameMap(atlasContractTools) }
      : { ...atlasAttachment, active: false, tools: [] };

    let executionContract = buildExecutionContract({
      provider: "claude",
      role,
      roleMode,
      allowWrite,
      allowTests,
      projectDbWrite,
      projectDbCapability,
      issuedToolSurface: issuedToolSurfaceForProviderPolicy(_remoteIssuedPolicy),
      agentHandoffCompactV1: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV3: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
      atlasCodeWindowPolicy: promptAtlasAttachment?.codeWindowPolicy || null,
      scopedFiles,
      createFiles,
      createRoots,
      deleteFiles,
      readRoots,
      needsImageGeneration,
      platform: process.platform,
      includeBaseTools: false,
      projectDir: providerPaths.cwd,
    });
    executionContract = appendExecutionTools(executionContract, deterministicReadMcp.contractTools || deterministicReadMcp.tools);
    executionContract = appendExecutionTools(executionContract, atlasContractTools);
    const contractBlock = renderExecutionContractBlock(executionContract, {
      remoteComposed: skipRolePrompt,
      remoteSystemPrompt: remoteSystemPromptText,
    });
    const stablePromptText = recyclingMode === "resume"
      ? ""
      : [contractBlock, stableContext].filter(Boolean).join("\n\n");
    const systemPromptInline = [renderProviderPromptContracts(remoteSystemPromptText, executionContract), stablePromptText].filter(Boolean).join("\n\n");
    const finalPrompt = promptText;

    if (typeof recordFinalPrompt === "function") {
      recordFinalPrompt(finalPrompt, { systemPrompt: systemPromptInline || null, systemPromptFiles: [] });
    }

      const issuedToolIds = deterministicReadMcp.issuedToolIds || [];
      const stallRoleMultiplier = { researcher: 2, planner: 2 };
      const stallTimeoutMs = resolveProviderStallTimeout(stallTimeout)
        * (stallRoleMultiplier[role] || 1)
        * 1_000;
      const request = buildNativeDispatchRequest("claude", finalPrompt, {
        dispatchId: `claude-${agentCallId || crypto.randomUUID()}`,
        jobId,
        workItemId,
        attemptId,
        agentCallId,
        systemPrompt: systemPromptInline || null,
        modelTier,
        modelName: modelToUse,
        reasoningEffort,
        role,
        roleMode,
        taskMode,
        allowWrite,
        allowTests,
        projectDbCapability,
        issuedToolIds,
        resolvedSkillIds: skillsAttached,
        cwd: mcpWorkspaceCwd,
        readRoots,
        createRoots,
        scopedFiles,
        createFiles,
        deleteFiles,
        maxTurns: turns,
        maxOutputTokens: outputTokenLimit,
        stallTimeoutMs,
        priorSessionHandle,
        recyclingMode,
      });
      const nativeResult = await runNativeDispatch(request, {
        abortSignal,
        mcpGate,
        projectDir: providerPaths.projectDir,
        silent,
        onLine,
        onAgentCommentary,
        onProviderToolUse,
        onProviderToolResult,
        onUsageSegment,
      });
      nativeResult.stats.atlasMethod = atlasMethodForStats;
      return nativeResult;
  } finally {
    cleanupDeterministicMcpSession();
  }
}

// ─── Model Escalation ───────────────────────────────────────────────────────

/**
 * Given a current model_tier and attempt count, return the escalated tier.
 * Attempt 1: same tier. Attempt 2: tier+1. Attempt 3+: strong.
 */
export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

// ─── Rate Limit State ──────────────────────────────────────────────────────
// Global, shared across all workers in the same process. When one worker hits
// a rate limit, all others see it immediately and back off.

/**
 * Trip the global rate limit. All workers will see this and back off.
 * @param {number} backoffSec - How long to block (from now).
 * @param {string} reason - Human-readable reason for logging.
 */
export function tripRateLimit(backoffSec, reason = "") {
  providerRuntimeState.tripRateLimit("claude", backoffSec, reason);
}

/**
 * Check if the Claude provider is currently rate-limited.
 * @returns {{ blocked: boolean, retryInSec: number, reason: string }}
 */
export function getRateLimitState() {
  return providerRuntimeState.getRateLimitState("claude");
}

/**
 * Parse a provider error and return the recommended backoff.
 * Extracts real retry-after from error messages when available.
 *
 * Claude CLI error patterns:
 *   "overloaded_error"          → server busy, short wait (10s)
 *   "rate_limit_error"          → RPM/TPM limit, longer wait (30s)
 *   "Please retry after Xs"     → explicit retry-after
 *   "429"                       → HTTP rate limit (30s)
 *   "API Error: 529"            → overloaded (15s)
 *   "API Error: 5xx"            → server error (10s)
 *   "ECONNREFUSED/RESET/TIMEOUT"→ connection issue (5s)
 *
 * @param {Error} err
 * @returns {{ backoffSec: number, isRateLimit: boolean, source: string }}
 */
export function parseErrorBackoff(err) {
  const failure = classifyClaudeCliFailure(err);
  if (failure?.classification === "invalid_client") {
    return { backoffSec: 0, isRateLimit: false, source: "invalid_client" };
  }

  return classifyProviderError(err, { defaultBackoffSec: 15 });
}
