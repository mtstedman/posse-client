// Claude provider entry point.
//
// Owns provider contract assembly, tool wiring, stats accounting, and
// print-mode CLI execution. Provider-specific lifecycle and parsing helpers
// live under the providers class/function split.

import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getSetting } from "../../../queue/functions/index.js";
import { appendExecutionTools, buildClaudeCliToolConfig, buildExecutionContract, renderExecutionContractBlock } from "../../../../shared/tools/functions/contract.js";
import { issuedToolSurfaceForProviderPolicy, issuedWebAccessEnabled } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { buildMcpAtlasSurfaceToolDescriptors, buildSurfaceNameMap, formatAtlasToolUseDisplayName } from "../../../../shared/tools/functions/mcp-surface.js";
import { buildRuntimeEnv, normalizeProviderPaths } from "../../../runtime/functions/paths.js";
import { logAtlasAttachment, resolveAtlasAssignmentUnit } from "../../../integrations/functions/atlas.js";
import { releaseDeterministicMcpServerSession } from "../../../integrations/functions/deterministic-mcp.js";
import { resolveAtlasToolGateEnabled } from "../../../integrations/functions/deterministic-mcp/gate-settings.js";
import { stripPosseMcpGatewayPrefix } from "../../../integrations/functions/mcp-gateway.js";
import { summarizeObservedToolUse } from "../shared/tool-runtime.js";
import { buildWindowsSpawn, terminateSpawnedProcess, trackSpawnedProcess } from "../shared/windows-spawn.js";
import { hasProviderVisibleAtlasMcpTools } from "../shared/atlas-mcp.js";
import { logProviderMcpSurfaceTelemetry, logProviderCliStderrTelemetry, logProviderMcpAttachProofTelemetry } from "../shared/mcp-telemetry.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { appendBoundedText } from "../../../../shared/format/functions/bounded-text.js";
import { providerRuntimeState } from "../../classes/runtime-state-singleton.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { normalizeProviderUsage } from "../shared/usage-normalization.js";
import { resolveDisableSystemTools, resolveWebToolsEnabled } from "../shared/tool-policy-settings.js";
import {
  getUsageSummary,
  refreshUsageSummary,
} from "./usage-summary.js";
import {
  getClaudeCommandAsync,
  getClaudeInfo,
  getClaudeReadiness,
  isReady,
} from "./cli-discovery.js";
import { InteractiveCliUnavailableError } from "../../classes/InteractiveCliSession.js";
import { ClaudeInteractiveSession } from "../../classes/claude/ClaudeInteractiveSession.js";
import { stripTerminalControls } from "../shared/interactive-cli-session.js";
import {
  extractClaudeSessionHandleFromStreamMessage,
  isClaudeResumeHandleExpiredError,
} from "./session-handles.js";
import { escalateModelTier, getMaxOutputTokensForProvider, getMaxTurnsForProvider } from "../shared/turns.js";
import { normalizeMaxOutputTokens } from "../shared/output-limits.js";
import { resolveProviderStallTimeout } from "../shared/stall-timeout.js";
import { roleBrandColor, roleBrandIcon } from "../../../ui/functions/display/helpers/brand.js";
import { classifyProviderError } from "../shared/api-resilience.js";
import {
  buildClaudeAtlasMcpConfigPayloadAsync,
  buildClaudeDeterministicReadMcpConfigPayloadAsync,
  __testBuildClaudeAtlasMcpConfigPayload,
  __testBuildClaudeDeterministicReadMcpConfigPayload,
} from "./mcp-config.js";
import {
  CLAUDE_EXECUTION_MODE_INTERACTIVE,
  CLAUDE_EXECUTION_MODE_PRINT,
  resolveClaudeExecutionMode,
} from "./execution-mode.js";
import { classifyClaudeCliFailure, __testClassifyClaudeCliFailure } from "./failure-classification.js";
import {
  __testRunClaudeWarmupViaInteractiveCli,
  warmOauthSession,
  warmOauthSessionAsync,
  warmOauthSessionInteractive,
} from "./oauth-warmup.js";
import {
  __testExtractClaudeToolUsesFromStreamMessage,
  _estimateClaudeApiEquivalentCostUsd,
  _extractClaudeToolUsesFromStreamMessage,
  _extractStreamUsage,
  _normalizeClaudeToolUseBlock,
  _usageNumberOrNull,
  estimateTokensFromText,
  parseTokenUsage,
} from "./stream-usage.js";

export { __testBuildClaudeAtlasMcpConfigPayload, __testBuildClaudeDeterministicReadMcpConfigPayload, __testClassifyClaudeCliFailure, __testExtractClaudeToolUsesFromStreamMessage, __testRunClaudeWarmupViaInteractiveCli, getClaudeInfo, getClaudeReadiness, getUsageSummary, isReady, refreshUsageSummary, warmOauthSession, warmOauthSessionAsync, warmOauthSessionInteractive };

export function scrubClaudeChildEnv(childEnv = {}) {
  delete childEnv.CODEX_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.XAI_API_KEY;
  delete childEnv.GITHUB_TOKEN;
  // Force a blocking MCP attach so the gateway's tools are registered before
  // the first inference turn. Claude 2.x connects --mcp-config servers async
  // ("running fully async (nonblocking)") by default, so a fast first turn can
  // be dispatched before tools/list completes — the attach-under-load race
  // that surfaces as MCP_ATTACH_PROOF_MISSING / "No such tool available".
  // MCP_CONNECTION_NONBLOCKING=0 makes the connection blocking. Respect an
  // explicit operator override if one is already present.
  // NOTE: we deliberately do NOT set ANTHROPIC_API_KEY here — the child must
  // keep using the inherited OAuth credentials, not an API key.
  if (childEnv.MCP_CONNECTION_NONBLOCKING === undefined) {
    childEnv.MCP_CONNECTION_NONBLOCKING = "0";
  }
  return childEnv;
}

// Translate a tool-contract decision + the attached MCP server names into the
// CLI's positive permission flags ({ toolsArg, allowedToolsArg }). We never emit
// --dangerously-skip-permissions (refused as root on Linux): --tools pins the
// built-in surface positively and --allowedTools grants exactly the Posse-owned
// MCP servers plus any surfaced read/web native tools.
//
// toClaudeCliFlags expresses the MCP-active branches as a blocklist
// (tools === null = "all built-ins minus disallowedTools"). The only built-ins
// meant to survive that blocklist are the web tools, and only for web-enabled
// roles (researcher/artificer) — where toClaudeCliFlags strips WebFetch/WebSearch
// out of disallowedTools. We reconstruct those survivors positively so --tools
// never silently drops web access (the artificer+MCP+web case, whose null branch
// precedes its web branch), while still disabling the rest of the native surface
// (no DesignSync/Workflow/TaskCreate leak a raw blocklist would let through).
export function buildClaudeToolPermissionArgs(cliToolConfig = {}, mcpServerNames = []) {
  let toolsArg;
  if (cliToolConfig.tools != null) {
    toolsArg = cliToolConfig.tools;
  } else {
    const disallowed = new Set(
      String(cliToolConfig.disallowedTools || "")
        .split(",").map((t) => t.trim()).filter(Boolean),
    );
    toolsArg = ["WebFetch", "WebSearch"].filter((t) => !disallowed.has(t)).join(",");
  }
  const allowRules = [];
  if (cliToolConfig.dangerouslySkipPermissions) {
    // Previously-bypassed branches surface only read-only (Read/Glob/Grep), web
    // (WebFetch/WebSearch), or — in the gateway-down fallback — operator-opted-in
    // autoApprove tools. A bare allow of the surfaced set reproduces the prior
    // permissiveness without the flag, and unlike the flag it runs as root.
    if (toolsArg) allowRules.push(toolsArg);
  } else if (cliToolConfig.allowedTools) {
    // Scoped branches carry precise Write(...)/Edit(...)/Bash(...) rules; keep
    // them verbatim so file scoping is preserved (do not widen with bare tools).
    allowRules.push(cliToolConfig.allowedTools);
  }
  for (const name of (mcpServerNames || [])) allowRules.push(`mcp__${name}`);
  return { toolsArg, allowedToolsArg: allowRules.filter(Boolean).join(",") };
}

const ISOLATED_SYSTEM_PROMPT = [
  "You are an isolated Posse runtime worker.",
  "Use only the instructions, context, and tools explicitly provided by Posse for this job.",
  "Do not use user memory, user settings, local Claude project state, slash-command skills, prior sessions, or ambient workspace context.",
  "If needed context is not present in the prompt or available through the attached Posse tools, report that it is unavailable.",
].join("\n");

// ─── Colors ──────────────────────────────────────────────────────────────────

// ─── Capabilities ───────────────────────────────────────────────────────────

export const capabilities = Object.freeze({
  images: false,
  sessionResume: true,
  toolAttachment: "mcp",
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

// ─── Claude CLI Caller ──────────────────────────────────────────────────────

/**
 * Call Claude Code CLI with a prompt.
 *
 * Prompt is piped via stdin (no command-line length limits).
 * Returns { output, stats } where stats has timing, char counts, and model info.
 *
 * @param {string} promptText - The prompt to send
 * @param {object} opts
 * @param {string} opts.role - Worker role: 'researcher' | 'planner' | 'dev' | 'assessor'
 * @param {boolean} opts.allowWrite - Allow file writes (dev role)
 * @param {string} opts.modelTier - 'cheap' | 'standard' | 'strong'
 * @param {string} opts.reasoningEffort - 'low' | 'medium' | 'high' — controls thinking depth
 * @param {string} opts.activity - Short description for the header
 * @param {boolean} opts.silent - Suppress console output
 * @param {boolean} opts.autoApprove - Skip tool permission prompts
 * @param {number} opts.maxTurns - Override max turns for this call
 * @param {boolean} opts.deepthink - Raise planning/research turn budget for deep repo-wide analysis
 * @returns {Promise<{output: string, stats: object}>}
 */
export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  allowWrite = false,
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
  loaderCwd = null,    // optional empty dir to spawn the claude process in (suppresses parent-walk CLAUDE.md discovery). Falls back to cwd.
  mcpCwd = null,       // optional override for MCP workspace root. Falls back to cwd.
  projectDir = null,   // project root for runtime path resolution
  abortSignal = null,  // AbortSignal — when aborted, kills the child process
  stallTimeout = null, // Override stall timeout in seconds (default: 600)
  needsImageGeneration = false,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  promptChars = 0,
  skipRolePrompt = false,
  recyclingMode = "fresh",
  priorSessionHandle = null,
  recordFinalPrompt = null, // (finalPrompt, { systemPrompt?, systemPromptFiles? }) => void
  disableAtlas = false,
  atlasPrefetchStatus = null,
  atlasConfig = null,
  executionMode = null,
  interactiveBackend = null,
  _remoteIssuedPolicy = null,
  _remoteToolSurface = null,
  mcpGate = null,
  nativeColdBoot = false,
} = {}) {
  const resolvedClaude = await getClaudeCommandAsync();
  const providerPathsForAtlas = normalizeProviderPaths({ cwd, projectDir });
  const mcpWorkspaceCwdForAtlas = mcpCwd ? path.resolve(mcpCwd) : providerPathsForAtlas.cwd;
  const assignmentUnitForAtlas = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const preparedAtlasMcp = await buildClaudeAtlasMcpConfigPayloadAsync(
    role,
    mcpWorkspaceCwdForAtlas,
    { assignmentUnit: assignmentUnitForAtlas, workItemId, disableAtlas, atlasConfig },
  );
  return new Promise((resolve, reject) => {
    void (async () => {
    let cleanupAtlasMcpConfig = () => {};
    let cleanupDeterministicMcpSession = () => null;
    let cleanupRolePromptFile = () => {};
    let cleanupStablePromptFile = () => {};
    let cleanupSystemPromptFile = () => {};
    const cleanupSetupFiles = (mcpAttachProofContext = null) => {
      const releaseResult = cleanupDeterministicMcpSession();
      let attachProofResult = null;
      if (mcpAttachProofContext) {
        try {
          attachProofResult = logProviderMcpAttachProofTelemetry({
            providerName: "claude",
            role,
            workItemId,
            jobId,
            attemptId,
            deterministicReadMcp: mcpAttachProofContext.deterministicReadMcp || null,
            releaseResult,
            exitCode: mcpAttachProofContext.exitCode ?? null,
            phase: mcpAttachProofContext.phase || "provider_cleanup",
          });
        } catch {
          attachProofResult = null;
        }
      }
      cleanupAtlasMcpConfig();
      cleanupRolePromptFile();
      cleanupStablePromptFile();
      cleanupSystemPromptFile();
      return { releaseResult, attachProofResult };
    };
    try {
    const args = [];
    const attachedSystemPromptFiles = [];
    const omitSessionPreamble = recyclingMode === "resume";
    const remoteSystemPromptText = omitSessionPreamble ? "" : String(remoteSystemPrompt || "").trim();

    const tierConfig = getModelTierConfig(modelTier);
    const modelToUse = selectExecutionModel({ jobModelName: modelName, globalModelOverride: getModelOverride(), tierModel: tierConfig.model });
    if (modelToUse) {
      args.push("--model", modelToUse);
    }

    // ── Max turns ──────────────────────────────────────────────────────────
    const turns = maxTurns || getMaxTurns(role, modelTier, complexity, deepthink, filesToModifyCount);
    const outputTokenLimit = normalizeMaxOutputTokens(maxOutputTokens)
      || getMaxOutputTokensForProvider("claude", { role });
    if (turns) {
      args.push("--max-turns", String(turns));
    }
    if (priorSessionHandle) {
      args.push("--resume", String(priorSessionHandle));
    }

    // Runtime agents must not load user/project settings. The per-job loader
    // cwd is empty by construction, so local is the only permitted source.
    args.push("--setting-sources", "local");
    args.push("--disable-slash-commands");
    args.push("--strict-mcp-config");
    if (nativeColdBoot) {
      // Benchmark/native controls must be a genuinely fresh Claude Code
      // agent: no CLAUDE.md, skills, plugins, hooks, configured MCP servers,
      // prior sessions, or persisted session state. Safe mode retains Claude's
      // built-in tools and auth/model selection.
      args.push("--safe-mode");
      args.push("--no-session-persistence");
    }

    const providerPaths = normalizeProviderPaths({ cwd, projectDir });
    const mcpWorkspaceCwd = mcpCwd ? path.resolve(mcpCwd) : providerPaths.cwd;
    const spawnCwd = loaderCwd ? path.resolve(loaderCwd) : providerPaths.cwd;
    const assignmentUnit = assignmentUnitForAtlas;
    const { attachment: atlasAttachment, payload: atlasMcpPayload } = preparedAtlasMcp;
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
    const disableSystemToolsResolved = resolveDisableSystemTools();
    const deterministicReadMcp = await buildClaudeDeterministicReadMcpConfigPayloadAsync(role, mcpWorkspaceCwd, {
      scopedFiles,
      createFiles,
      deleteFiles,
      createRoots,
      readRoots,
      allowWrite,
      projectDbWrite,
      projectDbCapability,
      needsImageGeneration,
      disableSystemTools: disableSystemToolsResolved,
      jobId,
      workItemId,
      attemptId,
      agentCallId,
      promptChars,
      atlasPrefetchStatus,
      atlasAvailable: atlasReadyForMcp,
      atlasGateEnabled: atlasToolGateEnabled,
      atlasConfig,
      remoteToolSurface: _remoteToolSurface,
      mcpGate,
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
      : atlasMcpPayload?.serverName;
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
    if (remoteSystemPromptText) {
      try {
        const rolePromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-role-"));
        const rolePromptPath = path.join(rolePromptDir, "remote-system.md");
        fs.writeFileSync(rolePromptPath, remoteSystemPromptText, "utf8");
        cleanupRolePromptFile = () => {
          try { fs.rmSync(rolePromptDir, { recursive: true, force: true }); } catch { /* no-op */ }
        };
        attachedSystemPromptFiles.push(rolePromptPath);
      } catch (setupErr) {
        cleanupSetupFiles();
        throw setupErr;
      }
    }
    let executionContract = buildExecutionContract({
      provider: "claude",
      role,
      roleMode,
      allowWrite,
      projectDbWrite,
      issuedToolSurface: issuedToolSurfaceForProviderPolicy(_remoteIssuedPolicy),
      agentHandoffCompactV1: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV3: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
      scopedFiles,
      createFiles,
      createRoots,
      deleteFiles,
      readRoots,
      needsImageGeneration,
      platform: process.platform,
      includeBaseTools: !(deterministicReadMcp.active || disableSystemToolsResolved),
      projectDir: providerPaths.cwd,
    });
    executionContract = appendExecutionTools(executionContract, deterministicReadMcp.contractTools || deterministicReadMcp.tools);
    executionContract = appendExecutionTools(executionContract, atlasContractTools);
    const cliToolConfig = buildClaudeCliToolConfig(executionContract, {
      autoApprove,
      scopedFiles,
      createFiles,
      createRoots,
      readRoots,
      scopeCwd: mcpWorkspaceCwd,
      deterministicReadMcpActive: deterministicReadMcp.active,
      disableSystemTools: disableSystemToolsResolved,
      webToolsEnabled: resolveWebToolsEnabled() && issuedWebAccessEnabled(_remoteIssuedPolicy),
    });
    // MCP servers are resolved here so their names can drive the permission
    // allowlist below. The Posse MCP gateway exposes the deterministic and
    // atlas.* suites from a single process, so do not attach a second ATLAS
    // MCP server when the gateway is already active.
    const atlasServedByGateway = !!deterministicReadMcp.active;
    const mergedMcpServers = {
      ...(deterministicReadMcp.payload?.mcpServers || {}),
      ...(atlasServedByGateway || !atlasReadyForMcp ? {} : (atlasMcpPayload?.mcpServers || {})),
    };
    const mcpServerNames = Object.keys(mergedMcpServers);

    // Permission route — single, platform-uniform path (never
    // --dangerously-skip-permissions; see buildClaudeToolPermissionArgs).
    const { toolsArg, allowedToolsArg } = buildClaudeToolPermissionArgs(cliToolConfig, mcpServerNames);
    args.push("--tools", toolsArg);
    if (allowedToolsArg) {
      args.push("--allowedTools", allowedToolsArg);
    }

    if ((role === "dev" && allowWrite) && !cliToolConfig.allowedTools && !cliToolConfig.dangerouslySkipPermissions) {
      throw new Error(
        `Dev role requires either file scope (scopedFiles/createFiles/createRoots) or autoApprove=true. ` +
        `Without one, tool calls block on permission prompts in headless mode.`
      );
    }
    if ((role === "artificer" && allowWrite) && !cliToolConfig.allowedTools && !cliToolConfig.dangerouslySkipPermissions && !(createRoots?.length > 0)) {
      throw new Error(`Artificer role requires either create_roots scope or autoApprove=true.`);
    }

    try {
      // mergedMcpServers / mcpServerNames are computed above (they drive the
      // --allowedTools rules); reuse them here to write the --mcp-config.
      logProviderMcpSurfaceTelemetry({
        providerName: "claude",
        role,
        workItemId,
        jobId,
        attemptId,
        deterministicReadMcp,
        atlasReadyForMcp,
        atlasContractTools,
        mcpServerNames: Object.keys(mergedMcpServers),
        cliToolConfig,
      });
      if (Object.keys(mergedMcpServers).length > 0) {
        const mcpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-atlas-v2-"));
        cleanupAtlasMcpConfig = () => {
          try { fs.rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* no-op */ }
        };
        const mcpConfigPath = path.join(mcpConfigDir, "claude-mcp-config.json");
        fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mergedMcpServers }, null, 2), "utf8");
        args.push("--mcp-config", mcpConfigPath);
      }
    } catch (setupErr) {
      cleanupSetupFiles();
      throw setupErr;
    }

    // ── Thinking / reasoning effort ─────────────────────────────────────
    // Three dimensions: tier.thinking (model capability), reasoningEffort (task need)
    //   high effort OR strong tier  → [ultrathink] deep reasoning prefix
    //   medium effort (default)     → no prefix (model's natural depth)
    //   low effort                  → conciseness prefix (skip analysis, just do it)
    const contractBlock = nativeColdBoot
      ? [
          "Execution contract:",
          "- This is a read-only native Claude Code research session.",
          "- Available tools: Read, Glob, Grep.",
          "- Use those native tools to inspect the repository before answering.",
          "- Do not use MCP, Atlas, prior sessions, or ambient memory.",
          "- Do not modify files.",
        ].join("\n")
      : renderExecutionContractBlock(executionContract);
    const stablePromptText = omitSessionPreamble
      ? ""
      : [contractBlock, stableContext].filter(Boolean).join("\n\n");
    if (stablePromptText.trim()) {
      try {
        const stablePromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-system-"));
        const stablePromptPath = path.join(stablePromptDir, "execution-context.md");
        fs.writeFileSync(stablePromptPath, stablePromptText, "utf8");
        cleanupStablePromptFile = () => {
          try { fs.rmSync(stablePromptDir, { recursive: true, force: true }); } catch { /* no-op */ }
        };
        attachedSystemPromptFiles.push(stablePromptPath);
      } catch (setupErr) {
        cleanupSetupFiles();
        throw setupErr;
      }
    }
    try {
      const systemPromptParts = [ISOLATED_SYSTEM_PROMPT];
      for (const filePath of attachedSystemPromptFiles) {
        try {
          const text = fs.readFileSync(filePath, "utf-8").trim();
          if (text) systemPromptParts.push(text);
        } catch {
          // Optional prompt files are best-effort; the isolation preamble
          // remains load-bearing even when a role has no extra prompt file.
        }
      }
      const systemPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claude-system-"));
      const systemPromptPath = path.join(systemPromptDir, "system.md");
      fs.writeFileSync(systemPromptPath, systemPromptParts.join("\n\n"), "utf8");
      cleanupSystemPromptFile = () => {
        try { fs.rmSync(systemPromptDir, { recursive: true, force: true }); } catch { /* no-op */ }
      };
      args.push("--system-prompt-file", systemPromptPath);
    } catch (setupErr) {
      cleanupSetupFiles();
      throw setupErr;
    }
    const basePrompt = promptText;
    let finalPrompt = basePrompt;
    if (deepthink) {
      finalPrompt = `[ultrathink] Deep-think budget is enabled for this task. Take the extra time needed to inspect the codebase carefully and synthesize before concluding.\n\n${basePrompt}`;
    } else if (tierConfig.thinking || reasoningEffort === "high") {
      finalPrompt = `[ultrathink] This is a complex task requiring deep reasoning.\n\n${basePrompt}`;
    } else if (reasoningEffort === "low") {
      finalPrompt = `Be direct and efficient. Skip detailed analysis — just execute the task.\n\n${basePrompt}`;
    }

    // Log the fully-assembled user-message prompt (contract + thinking prefix
    // + handoff packet content) along with BOTH the paths of the system
    // prompt files AND their concatenated contents. Without the contents,
    // grepping the prompt log for role-prompt text (e.g. "You are the
    // researcher…") finds nothing, which looks identical to "the role
    // portion was dropped" even though the files are folded into a
    // Posse-owned --system-prompt-file at runtime.
    if (typeof recordFinalPrompt === "function") {
      let systemPromptInline = null;
      try {
        const parts = [ISOLATED_SYSTEM_PROMPT];
        for (const filePath of attachedSystemPromptFiles) {
          try { parts.push(fs.readFileSync(filePath, "utf-8").trim()); }
          catch { /* best effort — skip missing/unreadable files */ }
        }
        if (parts.length > 0) systemPromptInline = parts.join("\n\n");
      } catch { /* recording must never break the call */ }
      recordFinalPrompt(finalPrompt, {
        systemPrompt: systemPromptInline,
        systemPromptFiles: attachedSystemPromptFiles,
      });
    }

    // When onLine is set, suppress direct stdout (display handles output)
    const directOutput = !onLine && !silent;
    const selectedExecutionMode = resolveClaudeExecutionMode({ requested: executionMode, interactiveBackend });

    // Visual framing
    const color = roleBrandColor(role, C.cyan);
    const icon = roleBrandIcon(role);
    const showHeader = directOutput && role !== "assessor";

    const tierLabel = tierConfig ? ` ${C[tierConfig.color] || ""}[${tierConfig.label}]${C.reset}` : "";
    const effortLabel = reasoningEffort !== "medium" ? ` ${C.dim}effort:${reasoningEffort}${C.reset}` : "";
    const modelLabel = modelToUse ? ` ${C.dim}model:${modelToUse}${C.reset}` : "";
    const turnsLabel = turns ? ` ${C.dim}turns:${turns}${C.reset}` : "";
    const modeLabel = selectedExecutionMode !== CLAUDE_EXECUTION_MODE_PRINT ? ` ${C.dim}mode:${selectedExecutionMode}${C.reset}` : "";
    const actLabel = activity ? `  ${C.dim}-- ${activity}${C.reset}` : "";

    if (showHeader) {
      console.log(`\n${color}+${"---".repeat(20)}+${C.reset}`);
      console.log(`${color}|${C.reset} [${icon}] ${color}${C.bold}${role.toUpperCase()}${C.reset}${tierLabel}${effortLabel}${modelLabel}${turnsLabel}${modeLabel}${actLabel}`);
      console.log(`${color}+${"---".repeat(20)}+${C.reset}`);
    }

    const startTime = Date.now();
    const childEnv = scrubClaudeChildEnv(buildRuntimeEnv(providerPaths.projectDir, providerPaths.cwd, process.env));
    // Clean, Posse-owned provider home from the MCP helper (generic + provider-
    // keyed). No-op until a `claude` home profile is registered.
    const providerHomeEnv = deterministicReadMcp.providerHomeEnv
      || deterministicReadMcp.serverConfig?.providerHomeEnv
      || null;
    if (providerHomeEnv?.isolated && providerHomeEnv.envVar) {
      childEnv[providerHomeEnv.envVar] = providerHomeEnv.home;
    }

    if (selectedExecutionMode === CLAUDE_EXECUTION_MODE_INTERACTIVE) {
      void (async () => {
        const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
        const baseTimeout = resolveProviderStallTimeout(stallTimeout);
        const timeoutMs = baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;
        try {
          const result = await new ClaudeInteractiveSession({
            args,
            cwd: spawnCwd,
            env: childEnv,
            timeoutMs,
            backend: interactiveBackend,
            abortSignal,
            onLine,
            directOutput,
            color,
            startTime,
          }).runProviderCall(finalPrompt);
          const mcpCleanup = cleanupSetupFiles({
            deterministicReadMcp,
            exitCode: result.exitCode,
            phase: "provider_close",
          });
          const enforceMcpAttachProof = !interactiveBackend;
          const durationMs = result.durationMs ?? (Date.now() - startTime);
          const output = String(result.output || "").trim();
          const interactiveUsage = result.usage && typeof result.usage === "object" ? result.usage : {};
          const hasInteractiveUsage = _usageNumberOrNull(interactiveUsage.input_tokens) != null
            || _usageNumberOrNull(interactiveUsage.output_tokens) != null
            || _usageNumberOrNull(interactiveUsage.cache_creation_input_tokens) != null
            || _usageNumberOrNull(interactiveUsage.cache_read_input_tokens) != null;
          const estimatedInputTokens = _usageNumberOrNull(interactiveUsage.input_tokens) ?? estimateTokensFromText(finalPrompt);
          const estimatedOutputTokens = _usageNumberOrNull(interactiveUsage.output_tokens) ?? estimateTokensFromText(output);
          const estimatedUsage = {
            input_tokens: estimatedInputTokens,
            output_tokens: estimatedOutputTokens,
            cache_creation_input_tokens: _usageNumberOrNull(interactiveUsage.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens: _usageNumberOrNull(interactiveUsage.cache_read_input_tokens) ?? undefined,
          };
          const apiEquivalentCostUsd = _estimateClaudeApiEquivalentCostUsd({
            modelName: modelToUse,
            modelTier,
            usage: estimatedUsage,
          });
          if (onLine) {
            onLine(`${C.dim}completed: ${(durationMs / 1000).toFixed(1)}s | ${output.length} chars via interactive session${C.reset}`);
          }
          const stats = {
            role,
            modelTier,
            reasoningEffort,
            modelName: modelToUse,
            promptChars: finalPrompt.length,
            outputChars: output.length,
            inputTokens: estimatedInputTokens,
            outputTokens: estimatedOutputTokens,
            cacheCreationInputTokens: _usageNumberOrNull(interactiveUsage.cache_creation_input_tokens),
            cacheReadInputTokens: _usageNumberOrNull(interactiveUsage.cache_read_input_tokens),
            cachedInputTokens: _usageNumberOrNull(interactiveUsage.cache_read_input_tokens),
            reasoningOutputTokens: _usageNumberOrNull(interactiveUsage.thinking_tokens ?? interactiveUsage.reasoning_output_tokens),
            costUsd: apiEquivalentCostUsd,
            totalCostUsd: null,
            numTurns: null,
            durationMs,
            exitCode: result.exitCode,
            maxTurns: turns,
            maxOutputTokens: outputTokenLimit,
            outputTruncated: false,
            outputLimitReason: null,
            toolUses: null,
            atlasMethod: atlasMethodForStats,
            sessionHandle: result.sessionHandle || null,
            priorSessionHandle: priorSessionHandle || null,
            sessionExpired: false,
            executionMode: CLAUDE_EXECUTION_MODE_INTERACTIVE,
            usageEstimated: !hasInteractiveUsage,
            interactiveCompletedBy: result.completedBy || null,
            mcpAttachProof: mcpCleanup.attachProofResult?.proof || null,
            mcpAttachMissingProof: enforceMcpAttachProof && mcpCleanup.attachProofResult?.missingProof === true,
          };
          if (stats.mcpAttachMissingProof) {
            const err = new Error("Claude deterministic MCP attach proof missing: provider exited without owner-observed initialize/tools-list.");
            err.code = "MCP_ATTACH_PROOF_MISSING";
            err.stats = stats;
            err.stdout = output || null;
            err.output = output || null;
            err.partialOutput = output || null;
            err.mcpAttachMissingProof = true;
            reject(err);
            return;
          }
          resolve({ output, stats });
        } catch (err) {
          cleanupSetupFiles({
            deterministicReadMcp,
            exitCode: null,
            phase: "provider_error",
          });
          const transcript = err?.transcript ? stripTerminalControls(err.transcript) : "";
          const timeoutText = /timed out/i.test(String(err?.message || ""));
          const preserveError = err?.name === "AbortError"
            || err instanceof InteractiveCliUnavailableError
            || err?.code === "INTERACTIVE_CLI_UNAVAILABLE";
          const wrapped = preserveError ? err : new Error(
            timeoutText
              ? `Claude interactive session timed out after ${timeoutMs / 1000}s waiting for idle state.`
              : `Claude interactive session failed: ${err?.message || err || "unknown error"}`
          );
          wrapped.code = wrapped.code || (timeoutText ? "CLAUDE_INTERACTIVE_TIMEOUT" : "CLAUDE_INTERACTIVE_FAILED");
          wrapped.stats = {
            role,
            modelTier,
            reasoningEffort,
            modelName: modelToUse,
            promptChars: finalPrompt.length,
            outputChars: transcript.length,
            durationMs: Date.now() - startTime,
            exitCode: null,
            maxTurns: turns,
            maxOutputTokens: outputTokenLimit,
            outputTruncated: false,
            outputLimitReason: null,
            atlasMethod: atlasMethodForStats,
            priorSessionHandle: priorSessionHandle || null,
            sessionExpired: !!priorSessionHandle && isClaudeResumeHandleExpiredError(`${transcript}\n${wrapped.message}`),
            executionMode: CLAUDE_EXECUTION_MODE_INTERACTIVE,
          };
          wrapped.stdout = transcript || null;
          wrapped.partialOutput = transcript || null;
          reject(wrapped);
        }
      })();
      return;
    }

    // Prompt is piped via stdin to avoid Windows 32K command-line length limit.
    // "-p" puts Claude Code in print mode reading from stdin.
    // "--output-format stream-json" gives us streaming JSONL with token usage stats.
    const fullArgs = [...resolvedClaude.args, ...args, "-p", "--verbose", "--output-format", "stream-json"];

    let proc;
    try {
      const launch = buildWindowsSpawn(resolvedClaude.command, fullArgs);
      proc = spawn(launch.command, launch.args, {
        cwd: spawnCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      });
      trackSpawnedProcess(proc, launch.command, {
        label: `claude:${role || "provider"}`,
        cwd: spawnCwd,
      });
    } catch (spawnErr) {
      cleanupSetupFiles();
      throw spawnErr;
    }

    const forceKillTimers = new Set();
    const scheduleForceKill = () => {
      const timer = setTimeout(() => {
        forceKillTimers.delete(timer);
        terminateSpawnedProcess(proc, { force: true });
      }, 3000);
      timer.unref?.();
      forceKillTimers.add(timer);
    };
    const clearForceKillTimers = () => {
      for (const timer of forceKillTimers) clearTimeout(timer);
      forceKillTimers.clear();
    };

    // Abort handling — kill the child process when signal fires
    if (abortSignal) {
      const onAbort = () => {
        terminateSpawnedProcess(proc, { force: false });
        scheduleForceKill();
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => abortSignal.removeEventListener("abort", onAbort));
      }
    }

    // Write prompt to stdin and close
    proc.stdin.on("error", () => {}); // prevent EPIPE crash if child exits early
    proc.stdin.write(finalPrompt);
    proc.stdin.end();

    let stderr = "";
    let lineCount = 0;
    let gotFirstOutput = false;
    let killedByStallDetector = false;

    // Role-aware stall timeout: researchers/planners legitimately run longer
    // with little or no streaming output (thinking models, large codebases).
    const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
    const baseTimeout = resolveProviderStallTimeout(stallTimeout);
    const STALL_TIMEOUT = baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;

    // stream-json state
    let jsonLineBuf = "";      // partial JSONL line buffer
    let fullOutput = "";       // accumulated text output from deltas
    let textLineBuf = "";      // buffer for assembling text lines from deltas
    // Hard cap on unbounded line buffers. A single JSONL message larger than
    // this is almost certainly a malformed stream (binary garbage from a
    // crashed child, or a line that never terminates) — drop it rather than
    // let memory grow without bound.
    const LINE_BUF_MAX = 16 * 1024 * 1024; // 16 MiB
    const toolUses = [];       // track tool calls: [{ tool, input }, ...]
    const seenToolUseKeys = new Set();
    let _pendingToolUse = null;  // current tool_use block from content_block_start
    let _pendingToolInput = "";  // accumulate input_json_delta for current tool
    let _lastChainReadPath = null; // remember so chain_verdict live log shows the file
    let resultData = null;     // final result message with usage stats
    let latestSessionHandle = null;

    function shouldShowPreResultToolTarget(displayName, target) {
      if (displayName === "list_files") return false;
      const normalized = String(target || "").replace(/\\/g, "/");
      if (!normalized) return false;
      if (normalized === "." || normalized === "src") return true;
      return !/(^|\/)\.(?:posse|git|claude|codex)(?:\/|$)/i.test(normalized);
    }

    function toolUseReplayKey(toolUse) {
      const id = typeof toolUse?.id === "string" && toolUse.id.trim() ? toolUse.id.trim() : null;
      if (id) return `id:${id}`;
      return `${toolUse?.tool || ""}\0${JSON.stringify(toolUse?.input ?? null)}`;
    }

    function recordCompletedToolUse(toolUse) {
      if (!toolUse?.tool) return;
      const normalized = {
        id: typeof toolUse.id === "string" && toolUse.id.trim() ? toolUse.id.trim() : null,
        tool: toolUse.tool,
        input: toolUse.input && typeof toolUse.input === "object" ? toolUse.input : null,
      };
      const key = toolUseReplayKey(normalized);
      if (seenToolUseKeys.has(key)) return;
      seenToolUseKeys.add(key);
      toolUses.push(normalized);

      if (onLine && normalized.tool) {
        // Strip MCP server prefixes so the live log shows the bare tool
        // name (e.g. "chain_read" instead of "mcp__posse-gateway__chain_read").
        const gatewayDisplayName = normalized.tool
          .replace(/^mcp__atlas-v2__/, "atlas.");
        let displayName = stripPosseMcpGatewayPrefix(gatewayDisplayName)
          .replace(/^mcp__atlas-v2__/, "atlas.");
        // The chain_read / chain_verdict pair gates a single file review.
        // chain_verdict's args never carry the file path (that lives in
        // the MCP server's chain state), so thread the path forward from
        // the most recent chain_read for a cleaner live log.
        let enrichedInput = normalized.input || {};
        if (displayName === "chain_read" && enrichedInput.path) {
          _lastChainReadPath = enrichedInput.path;
        } else if (displayName === "chain_verdict" && _lastChainReadPath && !enrichedInput.path) {
          enrichedInput = { ...enrichedInput, path: _lastChainReadPath };
          _lastChainReadPath = null; // consumed
        }
        displayName = formatAtlasToolUseDisplayName(normalized.tool, enrichedInput) || displayName;
        const target = summarizeObservedToolUse(normalized.tool, enrichedInput).target;
        if (target) {
          // Shorten absolute paths to relative when they start with cwd.
          try {
            const cwdNorm = providerPaths.cwd.replace(/\\/g, "/");
            const targetNorm = target.replace(/\\/g, "/");
            const short = targetNorm.startsWith(cwdNorm + "/")
              ? targetNorm.slice(cwdNorm.length + 1)
              : targetNorm;
            if (shouldShowPreResultToolTarget(displayName, short)) {
              onLine(`${C.dim}[tool] ${displayName}: ${short}${C.reset}`);
            } else {
              onLine(`${C.dim}[tool] ${displayName}${C.reset}`);
            }
          } catch (_e) {
            if (shouldShowPreResultToolTarget(displayName, target)) {
              onLine(`${C.dim}[tool] ${displayName}: ${target}${C.reset}`);
            } else {
              onLine(`${C.dim}[tool] ${displayName}${C.reset}`);
            }
          }
        } else {
          // No target (e.g. chain_verdict with only a verdict field) —
          // still log the tool name so the live stream shows activity.
          onLine(`${C.dim}[tool] ${displayName}${C.reset}`);
        }
      }
    }

    const spinFrames = ["|", "/", "-", "\\"];
    let spinIdx = 0;
    let lastActivity = Date.now();

    let heartbeat;
    if (directOutput) {
      heartbeat = setInterval(() => {
        if (!gotFirstOutput) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const frame = spinFrames[spinIdx++ % spinFrames.length];
          process.stdout.write(`\r${color}|${C.reset} ${C.dim}${frame} waiting... ${elapsed}s${C.reset}   `);
        }

        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          clearInterval(heartbeat);
          killedByStallDetector = true;
          const phase = gotFirstOutput ? "mid-execution" : "waiting for first output";
          process.stdout.write(`\r${color}|${C.reset} ${C.red}!! Stalled ${phase} (no output for ${(STALL_TIMEOUT / 1000)}s) -- killing process.${C.reset}\n`);
          terminateSpawnedProcess(proc, { force: false });
          scheduleForceKill();
        }
      }, 500);
    } else if (onLine) {
      heartbeat = setInterval(() => {
        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          clearInterval(heartbeat);
          killedByStallDetector = true;
          const phase = gotFirstOutput ? "mid-execution" : "waiting for first output";
          onLine(`${C.red}!! Stalled ${phase} (no output for ${(STALL_TIMEOUT / 1000)}s) -- killing process${C.reset}`);
          terminateSpawnedProcess(proc, { force: false });
          scheduleForceKill();
        }
      }, 500);
    } else {
      // Silent mode (no display, no direct output) — still need stall detection
      // or the process can hang forever with no way to recover.
      heartbeat = setInterval(() => {
        if (Date.now() - lastActivity > STALL_TIMEOUT) {
          clearInterval(heartbeat);
          killedByStallDetector = true;
          terminateSpawnedProcess(proc, { force: false });
          scheduleForceKill();
        }
      }, 500);
    }

    /** Emit accumulated text lines to onLine/directOutput. */
    function emitTextLines(text) {
      textLineBuf += text;
      const lines = textLineBuf.split("\n");
      textLineBuf = lines.pop(); // keep incomplete last line
      if (textLineBuf.length > LINE_BUF_MAX) {
        textLineBuf = textLineBuf.slice(-LINE_BUF_MAX);
      }
      for (const ln of lines) {
        if (directOutput) {
          process.stdout.write(`${color}|${C.reset} ${ln}\n`);
        } else if (onLine) {
          onLine(ln);
        }
        lineCount++;
      }
    }

    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");

    proc.stdout.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        lastActivity = Date.now();

        // Parse stream-json JSONL — each complete line is a JSON message
        jsonLineBuf += text;
        const jsonLines = jsonLineBuf.split("\n");
        jsonLineBuf = jsonLines.pop(); // keep incomplete last line
        if (jsonLineBuf.length > LINE_BUF_MAX) {
          if (onLine) onLine(`${C.yellow}stream-json line exceeded ${LINE_BUF_MAX} bytes without newline — dropping buffer${C.reset}`);
          jsonLineBuf = "";
        }

        for (const raw of jsonLines) {
          if (!raw.trim()) continue;
          try {
            const msg = JSON.parse(raw);
            latestSessionHandle = extractClaudeSessionHandleFromStreamMessage(msg) || latestSessionHandle;

          // Text content deltas — stream to display.
          // Accept any delta that carries text (text_delta, input_json_delta, etc.)
          // to avoid silently dropping output if the CLI changes delta types.
          const deltaText = msg.type === "content_block_delta" && msg.delta?.text;
          if (deltaText) {
            if (!gotFirstOutput) {
              gotFirstOutput = true;
              const waitTime = ((Date.now() - startTime) / 1000).toFixed(1);
              if (directOutput) {
                process.stdout.write(`\r${color}|${C.reset} ${C.dim}first output after ${waitTime}s${C.reset}                    \n`);
              } else if (onLine) {
                onLine(`${C.dim}first output after ${waitTime}s${C.reset}`);
              }
            }
            fullOutput += deltaText;
            emitTextLines(deltaText);
          }

          // Track tool use — capture tool name on block start, accumulate
          // input JSON from deltas, finalize on block stop.
          const startedToolUse = msg.type === "content_block_start"
            ? _normalizeClaudeToolUseBlock(msg.content_block)
            : null;
          if (startedToolUse) {
            _pendingToolUse = startedToolUse;
            _pendingToolInput = "";
          }
          if (_pendingToolUse && msg.type === "content_block_delta" && msg.delta?.type === "input_json_delta") {
            _pendingToolInput += msg.delta.partial_json || "";
          }
          if (msg.type === "content_block_stop" && _pendingToolUse) {
            try { _pendingToolUse.input = JSON.parse(_pendingToolInput); } catch { /* partial */ }
            recordCompletedToolUse(_pendingToolUse);
            _pendingToolUse = null;
            _pendingToolInput = "";
          }

          // Newer Claude Code stream-json sessions may emit complete
          // assistant messages with content[] tool_use blocks instead of
          // Anthropic-style content_block_start/content_block_delta events.
          for (const toolUse of _extractClaudeToolUsesFromStreamMessage(msg)) {
            recordCompletedToolUse(toolUse);
          }

          // Final result — contains usage stats and possibly full output
          if (msg.type === "result") {
            resultData = msg;
            // Only use result.result if it's more complete than what we accumulated
            // from content_block_delta events. This avoids wiping good output with
            // a truncated or final-turn-only result string.
            if (msg.result && typeof msg.result === "string" && msg.result.length > fullOutput.length) {
              fullOutput = msg.result;
            }
          }
          } catch {
            // Not valid JSON — may be a raw line during fallback, emit as text
            if (!gotFirstOutput) {
              gotFirstOutput = true;
            }
            if (directOutput) {
              process.stdout.write(`${color}|${C.reset} ${raw}\n`);
            } else if (onLine && raw.trim()) {
              onLine(raw);
            }
            fullOutput += raw + "\n";
            lineCount++;
          }
        }
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stream handler error");
        if (directOutput) process.stderr.write(`${color}|${C.reset} ${C.yellow}[stderr] ${msg}${C.reset}\n`);
        else if (onLine) onLine(`${C.yellow}[stderr] ${msg}${C.reset}`);
      }
    });

    proc.stderr.on("data", (chunk) => {
      try {
        const text = chunk.toString();
        stderr = appendBoundedText(stderr, text);
        lastActivity = Date.now();
        if (directOutput && text.trim()) {
          process.stderr.write(`${color}|${C.reset} ${C.dim}${C.yellow}[stderr] ${text.trim()}${C.reset}\n`);
        } else if (onLine && text.trim()) {
          onLine(`${C.yellow}[stderr] ${text.trim()}${C.reset}`);
        }
      } catch (handlerErr) {
        const msg = String(handlerErr?.message || handlerErr || "unknown stderr handler error");
        if (directOutput) process.stderr.write(`${color}|${C.reset} ${C.yellow}[stderr] ${msg}${C.reset}\n`);
        else if (onLine) onLine(`${C.yellow}[stderr] ${msg}${C.reset}`);
      }
    });

    proc.on("close", (code, signal) => {
      const mcpCleanup = cleanupSetupFiles({
        deterministicReadMcp,
        exitCode: code,
        phase: "provider_close",
      });
      if (heartbeat) clearInterval(heartbeat);
      clearForceKillTimers();
      const durationMs = Date.now() - startTime;
      const elapsed = (durationMs / 1000).toFixed(1);

      // Bug fix: flush remaining jsonLineBuf — if the final result message
      // arrived without a trailing newline, it's stuck here unparsed.
      if (jsonLineBuf.trim()) {
        try {
          const msg = JSON.parse(jsonLineBuf);
          latestSessionHandle = extractClaudeSessionHandleFromStreamMessage(msg) || latestSessionHandle;
          if (msg.type === "content_block_delta" && msg.delta?.text) {
            fullOutput += msg.delta.text;
            emitTextLines(msg.delta.text);
          }
          const startedToolUse = msg.type === "content_block_start"
            ? _normalizeClaudeToolUseBlock(msg.content_block)
            : null;
          if (startedToolUse) {
            _pendingToolUse = startedToolUse;
            _pendingToolInput = "";
          }
          if (_pendingToolUse && msg.type === "content_block_delta" && msg.delta?.type === "input_json_delta") {
            _pendingToolInput += msg.delta.partial_json || "";
          }
          if (msg.type === "content_block_stop" && _pendingToolUse) {
            try { _pendingToolUse.input = JSON.parse(_pendingToolInput); } catch { /* partial */ }
            recordCompletedToolUse(_pendingToolUse);
            _pendingToolUse = null;
            _pendingToolInput = "";
          }
          for (const toolUse of _extractClaudeToolUsesFromStreamMessage(msg)) {
            recordCompletedToolUse(toolUse);
          }
          if (msg.type === "result") {
            resultData = msg;
            if (msg.result && typeof msg.result === "string" && msg.result.length > fullOutput.length) {
              fullOutput = msg.result;
            }
          }
        } catch {
          // Not valid JSON — treat as raw text
          fullOutput += jsonLineBuf + "\n";
        }
        jsonLineBuf = "";
      }

      // Flush any remaining text in the line buffer
      if (textLineBuf.trim()) {
        if (directOutput) {
          process.stdout.write(`${color}|${C.reset} ${textLineBuf}\n`);
        } else if (onLine) {
          onLine(textLineBuf);
        }
        lineCount++;
      }

      if (directOutput) {
        // footer intentionally suppressed — elapsed time is logged via onLine/event system
      } else if (onLine) {
        // Show output chars when lineCount is 0 but we have output (common with
        // stream-json where output arrives via the result message, not deltas).
        const sizeHint = lineCount === 0 && fullOutput.length > 0
          ? ` (${fullOutput.length} chars via result)`
          : "";
        onLine(`${C.dim}completed: ${elapsed}s | ${lineCount} lines${sizeHint}${C.reset}`);
      }

      // Extract token usage from stream-json result, fallback to stderr parsing
      const usage = _extractStreamUsage(resultData);
      const stderrTokens = parseTokenUsage(stderr);
      const normalizedUsage = normalizeProviderUsage("claude", usage, { stderrTokens });
      const apiEquivalentCostUsd = _estimateClaudeApiEquivalentCostUsd({
        modelName: modelToUse,
        modelTier,
        usage,
        stderrTokens,
      });
      latestSessionHandle = extractClaudeSessionHandleFromStreamMessage(resultData) || latestSessionHandle;

      const stats = {
        role,
        modelTier,
        reasoningEffort,
        modelName: modelToUse,
        promptChars: finalPrompt.length,
        outputChars: fullOutput.length,
        inputTokens: normalizedUsage.inputTokens,
        outputTokens: normalizedUsage.outputTokens,
        cacheCreationInputTokens: normalizedUsage.cacheCreationInputTokens,
        cacheReadInputTokens: normalizedUsage.cacheReadInputTokens,
        cachedInputTokens: normalizedUsage.cachedInputTokens,
        reasoningOutputTokens: normalizedUsage.reasoningOutputTokens,
        costUsd: apiEquivalentCostUsd ?? resultData?.cost_usd ?? null,
        totalCostUsd: resultData?.total_cost_usd || null,
        numTurns: resultData?.num_turns || null,
        durationMs,
        exitCode: code,
        maxTurns: turns,
        maxOutputTokens: outputTokenLimit,
        outputTruncated: false,
        outputLimitReason: null,
        // The stream parser was active even when no tool_use blocks occurred.
        // Preserve [] as a known zero; null is reserved for execution modes
        // where tool telemetry is genuinely unavailable.
        toolUses,
        atlasMethod: atlasMethodForStats,
        sessionHandle: latestSessionHandle || null,
        priorSessionHandle: priorSessionHandle || null,
        sessionExpired: false,
        executionMode: CLAUDE_EXECUTION_MODE_PRINT,
        mcpAttachProof: mcpCleanup.attachProofResult?.proof || null,
        mcpAttachMissingProof: mcpCleanup.attachProofResult?.missingProof === true,
      };

      // Persist MCP-relevant CLI stderr (only when present) so a gateway
      // attach-under-load failure leaves a trace even on a clean exit, where
      // the stderr would otherwise be discarded. Best-effort; never throws.
      try {
        logProviderCliStderrTelemetry({
          providerName: "claude",
          role,
          workItemId,
          jobId,
          attemptId,
          exitCode: code,
          stderr,
          attachProof: stats.mcpAttachProof,
        });
      } catch { /* telemetry only */ }

      if (code !== 0) {
        const reason = killedByStallDetector ? "stall_kill" : "error";
        const exhaustedTurns = !killedByStallDetector
          && !fullOutput.trim()
          && resultData?.num_turns != null
          && turns != null
          && Number(resultData.num_turns) >= Number(turns);
        const prefix = killedByStallDetector
          ? `claude killed by stall detector (no output for ${baseTimeout * (STALL_ROLE_MULTIPLIER[role] || 1)}s)`
          : exhaustedTurns
            ? `claude exhausted turn budget (${resultData?.num_turns}/${turns})`
            : Number.isFinite(code)
              ? `claude exited ${code}`
              : signal
                ? `claude exited via signal ${signal}`
                : "claude exited with unknown status";
        // Build a tool-use summary so retries know what was already explored
        let toolSummary = "";
        if (toolUses.length > 0) {
          const lines = toolUses.map((toolUse) => summarizeObservedToolUse(toolUse.tool, toolUse.input || {}).summary);
          toolSummary = `\nTool calls (${toolUses.length}): ${lines.join("; ")}`;
        }
        const err = new Error(`${prefix}${stderr ? '\n' + stderr : ''}${fullOutput ? '\nPartial output: ' + fullOutput.slice(0, 500) : ''}${toolSummary}`);
        err.code = code;
        err.stats = stats;
        err.stallKill = killedByStallDetector;
        err.stderr = stderr || null;
        err.stdout = fullOutput || null;
        err.output = fullOutput || null;
        err.partialOutput = fullOutput || null;
        err.toolUses = toolUses.length > 0 ? toolUses : null;
        err.sessionExpired = !!priorSessionHandle && isClaudeResumeHandleExpiredError(`${stderr}\n${fullOutput}\n${prefix}`);
        if (err.sessionExpired) err.stats.sessionExpired = true;
        reject(err);
      } else {
        if (stats.mcpAttachMissingProof) {
          const err = new Error("Claude deterministic MCP attach proof missing: provider exited without owner-observed initialize/tools-list.");
          err.code = "MCP_ATTACH_PROOF_MISSING";
          err.stats = stats;
          err.stderr = stderr || null;
          err.stdout = fullOutput || null;
          err.output = fullOutput || null;
          err.partialOutput = fullOutput || null;
          err.toolUses = toolUses.length > 0 ? toolUses : null;
          err.mcpAttachMissingProof = true;
          reject(err);
          return;
        }
        // Detect empty output — likely the model exhausted its turn budget on
        // tool calls and never produced a final text response.
        if (!fullOutput.trim() && turns) {
          const usedTurns = resultData?.num_turns || "?";
          if (onLine) {
            onLine(`${C.yellow}⚠ empty output after ${usedTurns}/${turns} turns (${elapsed}s) — model may have exhausted turn budget on tool calls${C.reset}`);
          }
        }
        resolve({ output: fullOutput.trim(), stats });
      }
    });

    proc.on("error", (err) => {
      cleanupSetupFiles();
      if (heartbeat) clearInterval(heartbeat);
      clearForceKillTimers();
      const wrapped = new Error(
        `Failed to spawn claude at: ${resolvedClaude.command} ${resolvedClaude.args.join(" ")}\n` +
        `Is Claude Code installed? npm install -g @anthropic-ai/claude-code\n${err.message}`
      );
      wrapped.stats = {
        role,
        modelTier,
        modelName: modelToUse,
        promptChars: finalPrompt.length,
        outputChars: 0,
        durationMs: Date.now() - startTime,
        exitCode: null,
        maxTurns: turns,
        maxOutputTokens: outputTokenLimit,
        outputTruncated: false,
        outputLimitReason: null,
        executionMode: CLAUDE_EXECUTION_MODE_PRINT,
      };
      reject(wrapped);
    });
    } catch (err) {
      cleanupSetupFiles();
      reject(err);
    }
    })();
  });
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
