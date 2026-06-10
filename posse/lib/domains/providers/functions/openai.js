// lib/provider/openai.js
//
// Drop-in OpenAI provider for the posse orchestrator.
// Mirrors the shared provider surface: exports callProvider, extractJson, escalateTier,
// ask, askMultiline, C, MODEL_TIERS, getClaudeInfo.
//
// Uses OpenAI Responses API with function tool calling to provide
// file/shell access matching Claude Code's tool set per role.

import OpenAI from "openai";
import readline from "readline";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getAccountSetting } from "../../settings/functions/account-settings.js";
import { getSetting } from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getResolvedImageProtocol } from "../../artifacts/functions/index.js";
import { composeRemoteAssessorPromptForProvider } from "./helpers/remote-assessor-prompt.js";
import { appendExecutionTools, buildExecutionContract, renderExecutionContractBlock } from "../../../functions/tools/contract.js";
import { formatAtlasToolUseDisplayName } from "../../../functions/tools/mcp-surface.js";
import { buildEmbeddedToolDefinitions } from "./helpers/embedded-tools.js";
import { executeEmbeddedAtlasTool, resolveEmbeddedAtlasAction } from "../../integrations/functions/atlas-embedded.js";
import { buildDisabledAtlasAttachment, logAtlasAttachment, resolveAtlasAssignmentUnit, resolveAtlasExecutionAttachment } from "../../integrations/functions/atlas.js";
import {
  buildLockedToolError as buildGateLockedToolError,
  configureGate,
  isGateActive,
  isGatedTool,
  checkNativeToolAllowed,
  noteAtlasCall as noteGateAtlasCall,
  releaseGate,
  unlockForAtlasUnavailable,
  isFallbackAtlasPrefetchStatus,
} from "../../integrations/functions/deterministic-mcp/gate.js";
import { resolveAtlasToolGateEnabled } from "../../integrations/functions/deterministic-mcp/gate-settings.js";
import {
  TOOL_BASH,
  safePath as sharedSafePath,
  buildScopePredicates as sharedBuildScopePredicates,
  createDeterministicToolkit,
  createBashExecutor,
} from "../../../functions/toolkit/index.js";
import { classifyProviderError, createCircuitBreaker, createRetryWrapper } from "./helpers/api-resilience.js";
import { callAbortableResponsesCreate, createAbortableResponsesCaller } from "./helpers/abortable-responses.js";
import { execGenerateImageInternal } from "./helpers/image-generate-internal.js";
import { createStandardToolHandlerMap, executeToolWithMap } from "./helpers/tool-runtime.js";
import { getDefaultImageModel, getProviderTierDefaults } from "./model-catalog.js";
import { selectExecutionModel } from "./helpers/model-selection.js";
import { normalizeProviderUsage } from "./helpers/usage-normalization.js";
import { escalateModelTier, getMaxTurnsForProvider } from "./helpers/turns.js";
import { resolveProviderStallTimeout } from "./helpers/stall-timeout.js";
import { roleBrandColor, roleBrandIcon } from "../../ui/functions/display/helpers/brand.js";

const OPENAI_USAGE_WINDOW_DEFS = [
  { key: "session", label: "Session (5h)", durationMs: 5 * 60 * 60 * 1000 },
  { key: "week", label: "Week (7d)", durationMs: 7 * 24 * 60 * 60 * 1000 },
];

function abortableThrottle(ms, signal = null) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) {
    const err = signal.reason instanceof Error ? signal.reason : new Error("OpenAI throttle aborted");
    err.aborted = true;
    throw err;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = signal.reason instanceof Error ? signal.reason : new Error("OpenAI throttle aborted");
      err.aborted = true;
      reject(err);
    };
    signal.addEventListener?.("abort", onAbort, { once: true });
  });
}

// --- Lazy Client -------------------------------------------------------------
// Don't create the client at import time - only when actually making a call.
// This lets provider.js import openai.js without requiring OPENAI_API_KEY upfront.

let _client = null;
function buildOpenAiClientOptions(apiKey) {
  return { apiKey, maxRetries: 0 };
}

export function __testBuildOpenAiClientOptions(apiKey = "test-key") {
  return buildOpenAiClientOptions(apiKey);
}

function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required when using the OpenAI provider.\n" +
        "Set it in your environment or .env file."
      );
    }
    _client = new OpenAI(buildOpenAiClientOptions(apiKey));
  }
  return _client;
}

// --- Circuit Breaker ---------------------------------------------------------
// After the first rate-limit (429) or repeated transient failures, trip the
// breaker so all workers immediately fall back to Claude instead of each one
// independently retrying against a rate-limited endpoint.

const _circuitBreaker = createCircuitBreaker();

/** Check if the circuit breaker is currently open. Exported for worker logging. */
export function isCircuitOpen() {
  return _circuitBreaker.isOpen();
}

/**
 * Retry wrapper for OpenAI API calls that handles rate limits (429) and
 * transient server errors (500/502/503) with exponential backoff.
 * Trips the circuit breaker on 429 so other workers skip straight to fallback.
 * Respects Retry-After headers when present. This runs *inside* the stall
 * timeout so the stall timer covers the total wall-clock, not each attempt.
 */
const withRetry = createRetryWrapper({
  breaker: _circuitBreaker,
  formatRateLimitMessage: () => `${C.yellow}[circuit-breaker] OpenAI rate-limited - breaker tripped, falling back to alt provider${C.reset}`,
  formatRetryMessage: (status, waitMs, attempt, maxAttempts) => `${C.yellow}[retry] ${status || "transient"} error, retrying in ${(waitMs / 1000).toFixed(1)}s (${attempt}/${maxAttempts})${C.reset}`,
});

// --- Capabilities ------------------------------------------------------------

export const capabilities = Object.freeze({
  images: true,
  sessionResume: true,
  toolAttachment: "function",
});

export function getCredentialEnvVars() {
  return ["OPENAI_API_KEY"];
}

export function buildImageClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI image generation.");
  }
  return new OpenAI({ apiKey, maxRetries: 0 });
}

function isReasoningModelName(modelName) {
  const normalized = String(modelName || "").trim().toLowerCase();
  return /^o\d+(?:-|$)/.test(normalized) || normalized.startsWith("gpt-5");
}

export function __testIsReasoningModelName(modelName) {
  return isReasoningModelName(modelName);
}

// --- Colors ------------------------------------------------------------------

export const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

// --- Model Tier Config ------------------------------------------------------

export const MODEL_TIERS = {
  cheap: {
    model: getProviderTierDefaults("openai").cheap.model,
    thinking: false,
    label: "$ CHEAP",
    color: "dim",
    effort: "low",
  },
  standard: {
    model: getProviderTierDefaults("openai").standard.model,
    thinking: false,
    label: "STANDARD",
    color: "cyan",
    effort: "medium",
  },
  strong: {
    model: getProviderTierDefaults("openai").strong.model,
    thinking: false,
    label: "STRONG",
    color: "magenta",
    effort: "high",
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
  return readModelSetting("openai_model") || null;
}

function readOpenAiLimitSetting(key) {
  try {
    const stored = getSetting(key);
    if (stored != null && String(stored).trim() !== "") {
      const parsed = parseInt(String(stored).trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Ignore DB-read failures and fall back to null.
  }

  return null;
}

function getOpenAiUsageLimits() {
  return {
    session: _readPositiveIntValue(getAccountSetting(SETTING_KEYS.OPENAI_ACCOUNT_LIMIT_TOKENS_SESSION))
      ?? readOpenAiLimitSetting("openai_limit_tokens_session"),
    week: _readPositiveIntValue(getAccountSetting(SETTING_KEYS.OPENAI_ACCOUNT_LIMIT_TOKENS_WEEK))
      ?? readOpenAiLimitSetting("openai_limit_tokens_week"),
  };
}

function _readPositiveIntValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = parseInt(String(value).trim(), 10);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
}

function _readPercentValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = parseFloat(String(value).trim());
  return !Number.isNaN(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

function _buildAccountSnapshotWindow(key, label) {
  const usedTokens = _readPositiveIntValue(getAccountSetting(`openai_account_used_tokens_${key}`));
  const limitTokens = _readPositiveIntValue(getAccountSetting(`openai_account_limit_tokens_${key}`));
  const observedPct = _readPercentValue(getAccountSetting(`openai_account_observed_pct_${key}`));

  let resolvedUsed = usedTokens;
  let resolvedLimit = limitTokens;
  if (resolvedUsed == null && resolvedLimit != null && observedPct != null) {
    resolvedUsed = Math.round(resolvedLimit * (observedPct / 100));
  }
  if (resolvedLimit == null && resolvedUsed != null && observedPct != null) {
    resolvedLimit = Math.ceil(resolvedUsed / (observedPct / 100));
  }
  if (resolvedUsed == null && resolvedLimit == null && observedPct == null) return null;

  return {
    key,
    label,
    durationMs: null,
    usedTokens: resolvedUsed ?? 0,
    limitTokens: resolvedLimit ?? null,
    remainingTokens: resolvedLimit == null ? null : Math.max(0, resolvedLimit - (resolvedUsed ?? 0)),
    resetAt: null,
    observedPct,
    limitSource: resolvedLimit != null ? "account_snapshot" : null,
  };
}

function getOpenAiAccountUsageSummary() {
  const windows = [
    _buildAccountSnapshotWindow("session", "Session (5h)"),
    _buildAccountSnapshotWindow("week", "Week (7d)"),
  ].filter(Boolean);
  if (windows.length === 0) return null;
  return {
    provider: "openai",
    source: "account-snapshot",
    subscriptionType: null,
    rateLimitTier: null,
    windows,
  };
}

function summarizeOpenAiUsageEntries(entries, nowMs, limits) {
  return OPENAI_USAGE_WINDOW_DEFS.map((def) => {
    const cutoff = nowMs - def.durationMs;
    const matching = entries.filter((entry) => entry.timestampMs >= cutoff);
    const usedTokens = matching.reduce((sum, entry) => sum + entry.totalTokens, 0);
    const oldestTs = matching.reduce((min, entry) => Math.min(min, entry.timestampMs), Number.POSITIVE_INFINITY);
    const limitTokens = limits[def.key] ?? null;
    const remainingTokens = limitTokens == null ? null : Math.max(0, limitTokens - usedTokens);
    const resetAt = Number.isFinite(oldestTs) ? new Date(oldestTs + def.durationMs).toISOString() : null;

    return {
      key: def.key,
      label: def.label,
      durationMs: def.durationMs,
      usedTokens,
      limitTokens,
      remainingTokens,
      resetAt,
    };
  });
}

function loadOpenAiUsageEntries(nowMs) {
  const weekWindow = OPENAI_USAGE_WINDOW_DEFS.find((def) => def.key === "week")?.durationMs || (7 * 24 * 60 * 60 * 1000);
  const oldestRelevantIso = new Date(nowMs - weekWindow).toISOString();
  const db = getDb();
  const rows = db.prepare(`
    SELECT created_at, input_tokens, output_tokens
    FROM agent_calls
    WHERE provider = 'openai'
      AND created_at >= ?
      AND COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) > 0
    ORDER BY created_at ASC
  `).all(oldestRelevantIso);

  return rows.flatMap((row) => {
    const timestampMs = Date.parse(row.created_at);
    const totalTokens = (row.input_tokens || 0) + (row.output_tokens || 0);
    if (!Number.isFinite(timestampMs) || totalTokens <= 0) return [];
    return [{ timestampMs, totalTokens }];
  });
}

export function getUsageSummary({ nowMs = Date.now() } = {}) {
  const entries = loadOpenAiUsageEntries(nowMs);
  const localUsedTokens = entries.reduce((sum, entry) => sum + (entry.totalTokens || 0), 0);
  const accountSummary = getOpenAiAccountUsageSummary();
  if (accountSummary) {
    return {
      ...accountSummary,
      localUsedTokens,
    };
  }
  return {
    provider: "openai",
    source: "posse-agent-calls",
    subscriptionType: null,
    rateLimitTier: null,
    localUsedTokens,
    windows: summarizeOpenAiUsageEntries(entries, nowMs, getOpenAiUsageLimits()),
  };
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return {
    ...base,
    model: readModelSetting(`openai_model_${key}`) || base.model,
  };
}

export function hasCredentials() {
  return !!process.env.OPENAI_API_KEY;
}

// --- Max Turns Config --------------------------------------------------------

function getMaxTurns(role, modelTier = "standard", complexity = null, filesToModifyCount = null, deepthink = false) {
  return getMaxTurnsForProvider("openai", { role, modelTier, complexity, filesToModifyCount, deepthink });
}

export function getClaudeInfo() {
  return { cmd: "openai-responses-api", args: [] };
}

// --- Tier escalation --------------------------------------------------------

export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

// --- JSON extraction --------------------------------------------------------

// Import the shared extractJson from claude.js - same sanitisation, trailing-
// comma stripping, and truncation repair logic for both providers.
import { extractJson as _extractJsonClaude } from "./claude.js";
export const extractJson = _extractJsonClaude;

// --- Tool Definitions -------------------------------------------------------


// --- Image Generation Tool ---------------------------------------------------
// Uses DALL-E 3 via raw API call. Expensive - only offered to dev agents
// on image/content-mode tasks so the model can't casually call it during code work.

/** Build the generate_image tool definition based on configured model. */
function buildImageTool() {
  const protocol = getResolvedImageProtocol();
  const imageModel = protocol.model || getDefaultImageModel("openai");
  const isGptImage = imageModel.startsWith("gpt-image");

  return {
    type: "function",
    name: "generate_image",
    description:
      `Generate an image using ${imageModel}. EXPENSIVE - only use for ` +
      "high-value images that are central to the task. For decorative or " +
      "placeholder images, describe what should go there and note it in your " +
      "output instead. Returns the file path of the saved image.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate. Be specific about style, composition, colors, and content.",
        },
        path: {
          type: "string",
          description: "File path to save the image. Relative to working directory. Allowed extensions: see artifact protocol config (default: .png, .jpg, .jpeg, .webp).",
        },
        size: {
          type: "string",
          enum: isGptImage
            ? ["1024x1024", "1536x1024", "1024x1536", "auto"]
            : ["1024x1024", "1792x1024", "1024x1792"],
          description: "Image dimensions. Default: 1024x1024.",
        },
        quality: {
          type: "string",
          enum: isGptImage
            ? ["low", "medium", "high", "auto"]
            : ["standard", "hd"],
          description: isGptImage
            ? "Image quality. Default: medium. Use 'high' for hero/banner images."
            : "Image quality. Default: standard. Use 'hd' for hero/banner images.",
        },
      },
      required: ["prompt", "path"],
      additionalProperties: false,
    },
  };
}

// Build a read-only bash variant with a restricted description for non-write roles
function bashReadOnly(extra = "") {
  return {
    ...TOOL_BASH,
    description:
      "Execute a READ-ONLY shell command (ls, cat, head, tail, find, wc, git log, git diff, etc.). " +
      "Do NOT use this to modify files or run destructive commands." +
      (extra ? " " + extra : ""),
  };
}

// Default max fallback reads dev is allowed (escape hatch for researcher gaps)
// Can be overridden per-call via fallbackReads option (set from routing packet budgets)
const DEFAULT_FALLBACK_READS = 3;

/** Return the tool set appropriate for a given role + write permission.
 *  Researcher gets chain_read/chain_verdict through the execution contract.
 *  Planner and assessor get read-only deterministic tools.
 *  Dev gets mutation tools + standard read tools.
 *  Image generation is reserved for artificer tasks. */
function getToolsForRole(contract) {
  return buildEmbeddedToolDefinitions(contract, {
    bash: contract?.role === "assessor"
      ? bashReadOnly("Also allowed: node, npm test, npm run.")
      : TOOL_BASH,
    generate_image: buildImageTool(),
  });
}

const {
  execReadFile: deterministicReadFile,
  execWriteFile: deterministicWriteFile,
  execEditFile: deterministicEditFile,
  execListFiles: deterministicListFiles,
  execSearchFiles: deterministicSearchFiles,
  execGitHistory: deterministicGitHistory,
  execInspectFile: deterministicInspectFile,
  execHashFile: deterministicHashFile,
  execResizeImage: deterministicResizeImage,
  execValidateArtifactOutput: deterministicValidateArtifactOutput,
  execPruneArtifactOutput: deterministicPruneArtifactOutput,
  execReadImageMetadata: deterministicReadImageMetadata,
  execOptimizeImage: deterministicOptimizeImage,
  execReencodeImage: deterministicReencodeImage,
  execCleanImage: deterministicCleanImage,
  execExtractImageText: deterministicExtractImageText,
} = createDeterministicToolkit({ safePath: sharedSafePath });
const deterministicBash = createBashExecutor();
const standardToolHandlers = createStandardToolHandlerMap({
  deterministicReadFile,
  deterministicWriteFile,
  deterministicEditFile,
  deterministicListFiles,
  deterministicSearchFiles,
  deterministicGitHistory,
  deterministicInspectFile,
  deterministicHashFile,
  deterministicResizeImage,
  deterministicValidateArtifactOutput,
  deterministicPruneArtifactOutput,
  deterministicReadImageMetadata,
  deterministicOptimizeImage,
  deterministicReencodeImage,
  deterministicCleanImage,
  deterministicExtractImageText,
  deterministicBash,
  execGenerateImage,
  safePath: sharedSafePath,
});
// --- Image Generation --------------------------------------------------------

async function execGenerateImage(args, cwd, scopePredicates) {
  return execGenerateImageInternal(args, {
    cwd,
    scopePredicates,
    safePathImpl: sharedSafePath,
  });
}

/** Dispatch a single tool call. Returns a string result.
 *  scopePredicates: { canEdit, canCreate, hasScope } from buildScopePredicates.
 *
 *  Applies the researcher ATLAS-first gate: when the gate is active and
 *  locked, gated native tools return a verbose isError-style message
 *  instead of dispatching. After any embedded ATLAS call, we classify the
 *  string result (empty / error / useful) and notify the gate so it can
 *  unlock on the primary or fallback path. */
async function executeTool(name, argsStr, cwd, allowWrite, scopePredicates, atlasConfig = null, gateScopeKey = null) {
  // Route 1: researcher gate on native tools. The gate is scoped to the
  // current job via observation context, so concurrent researcher jobs
  // don't cross-pollute unlock state.
  const gateArgs = parseGateToolArgs(argsStr);
  if (isGateActive({ scopeKey: gateScopeKey }) && isGatedTool(name)) {
    const gateDecision = checkNativeToolAllowed(name, gateArgs, { cwd, scopeKey: gateScopeKey });
    if (!gateDecision.allowed) {
      return buildGateLockedToolError(name, { args: gateArgs, cwd, scopeKey: gateScopeKey, atlasNameStyle: "embedded" });
    }
  }

  const atlasAction = resolveEmbeddedAtlasAction(name);
  const result = await executeToolWithMap(name, argsStr, { cwd, allowWrite, scopePredicates, chainScopeKey: gateScopeKey }, {
    handlers: standardToolHandlers,
    onUnknown: (toolName, args) => {
      if (atlasAction) {
        return executeEmbeddedAtlasTool(atlasAction, args, { cwd, config: atlasConfig || undefined });
      }
      return `Error: Unknown tool "${toolName}"`;
    },
  });

  // Route 2: if this was an ATLAS call, classify the result and notify the
  // gate. The embedded executor returns "Error: ..." on failure, "ATLAS
  // returned no output." on an empty successful call, and trimmed JSON or
  // text otherwise. Treat non-empty, non-error strings as useful.
  if (atlasAction) {
    const text = typeof result === "string" ? result : String(result ?? "");
    const errored = /^Error:/i.test(text);
    const empty = !errored && (text.trim().length === 0 || text.trim() === "ATLAS returned no output.");
    noteGateAtlasCall({ action: atlasAction, ok: !errored, empty, args: gateArgs, cwd, scopeKey: gateScopeKey });
  }

  return result;
}

function parseGateToolArgs(argsStr) {
  try {
    const parsed = typeof argsStr === "string" ? JSON.parse(argsStr || "{}") : argsStr;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// --- Prompt loading ---------------------------------------------------------

function _parseToolInput(argsStr) {
  try {
    return JSON.parse(argsStr);
  } catch {
    return null;
  }
}

// --- OpenAI Caller (with multi-turn tool use) ------------------------------

export async function callProvider(promptText, {
  role = "planner",
  roleMode = null,
  allowWrite = false,
  scopedFiles = null,   // files_to_modify
  createFiles = null,   // files_to_create
  createRoots = null,   // create_roots directories
  deleteFiles = null,   // files_to_delete
  stableContext = null,
  remoteSystemPrompt = null,
  modelTier = "standard",
  modelName = null,     // explicit model override from delegator
  reasoningEffort = "medium",
  activity = "",
  silent = false,
  autoApprove = false,
  maxTurns = null,
  complexity = null,   // 1-5 planner complexity score - drives dynamic turn budget
  filesToModifyCount = null, // dev turn scaling input from planner scope size
  deepthink = false,
  jobDir = null,
  onLine = null,
  cwd = null,
  abortSignal = null,
  stallTimeout = null,  // stall detection timeout in seconds
  fallbackReads = null, // max fallback read_file calls (from routing packet budgets)
  taskMode = "code",    // task mode - informational (not used for tool gating)
  needsImageGeneration = false, // explicit flag - enables generate_image tool
  skipRolePrompt = false,
  recyclingMode = "fresh",
  priorSessionHandle = null,
  recordFinalPrompt = null, // (finalPrompt, { systemPrompt?, systemPromptFiles? }) => void
  jobId = null,
  workItemId = null,
  atlasPrefetchStatus = null,
  disableAtlas = false,
  atlasConfig = null,
} = {}) {
  // Circuit breaker - if OpenAI was recently rate-limited, fail fast so the
  // worker falls back to Claude immediately instead of piling on.
  if (isCircuitOpen()) {
    const err = new Error("OpenAI circuit breaker open - rate-limited, falling back");
    err.circuitBreaker = true;
    throw err;
  }

  const client = getClient();
  const tierConfig = getModelTierConfig(modelTier);
  const modelToUse = selectExecutionModel({ jobModelName: modelName, globalModelOverride: getModelOverride(), tierModel: tierConfig.model });
  const effort = reasoningEffort || tierConfig.effort || "medium";
  const turnLimit = maxTurns || getMaxTurns(role, modelTier, complexity, filesToModifyCount, deepthink);
  const workingDir = cwd || process.cwd();
  const assignmentUnit = resolveAtlasAssignmentUnit({
    workItemId,
    fallback: `${activity || ""}\n${String(promptText || "").slice(0, 512)}`,
  });
  const atlasAttachment = disableAtlas
    ? buildDisabledAtlasAttachment({ role, providerName: "openai", reason: "artifact route" })
    : resolveAtlasExecutionAttachment({
      role,
      providerName: "openai",
      cwd: workingDir,
      assignmentUnit,
      workItemId,
      config: atlasConfig || undefined,
    });
  const atlasMethodForStats = disableAtlas ? null : (atlasAttachment?.method || "baseline");
  logAtlasAttachment({
    attachment: atlasAttachment,
    jobId,
    workItemId,
    providerName: "openai",
    role,
  });
  if (atlasAttachment.failClosed) {
    const err = new Error(
      `ATLAS required mode blocks ${role} on openai (${atlasAttachment.requiredFailureReason || "unavailable"}).`
    );
    err.code = "ATLAS_REQUIRED_BLOCKED";
    err.atlas = atlasAttachment;
    throw err;
  }
  const atlasToolGateEnabled = resolveAtlasToolGateEnabled();
  const remoteAssessorPrompt = (!skipRolePrompt && !remoteSystemPrompt)
    ? await composeRemoteAssessorPromptForProvider(promptText, {
      role,
      providerName: "openai",
      workingDir,
      activity,
      scopedFiles,
      atlasAttachment,
      atlasConfig,
    })
    : null;
  if (remoteAssessorPrompt) {
    promptText = remoteAssessorPrompt.promptText;
    stableContext = remoteAssessorPrompt.stableContext || stableContext;
    remoteSystemPrompt = remoteAssessorPrompt.remoteSystemPrompt || remoteSystemPrompt;
    skipRolePrompt = true;
  }

  let executionContract = buildExecutionContract({
    provider: "openai",
    role,
    roleMode,
    allowWrite,
    needsImageGeneration,
    scopedFiles,
    createFiles,
    createRoots,
    deleteFiles,
    fallbackReads,
    platform: process.platform,
  });
  executionContract = appendExecutionTools(executionContract, atlasAttachment.tools);
  const contractBlock = renderExecutionContractBlock(executionContract);
  const omitSessionPreamble = recyclingMode === "resume";
  const remoteSystemPromptText = omitSessionPreamble ? null : (String(remoteSystemPrompt || "").trim() || null);
  const systemPrompt = [
    remoteSystemPromptText,
    omitSessionPreamble ? null : contractBlock,
    omitSessionPreamble ? null : stableContext,
  ].filter(Boolean).join("\n\n") || null;
  const tools = getToolsForRole(executionContract);
  const directOutput = !onLine && !silent;

  // Build scope predicates for tool execution
  const scopePredicates = sharedBuildScopePredicates(workingDir, {
    modifyFiles: scopedFiles || [],
    createFiles: createFiles || [],
    deleteFiles: deleteFiles || [],
    createRoots: createRoots || [],
  });

  // -- Assemble initial input --
  const userText = [
    activity ? `ACTIVITY: ${activity}` : null,
    tools.length > 0 ? `MAX TOOL TURNS: ${turnLimit}` : null,
    `WORKING DIRECTORY: ${workingDir}`,
    jobDir ? `JOB DIR: ${jobDir}` : null,
    "",
    promptText,
  ].filter(Boolean).join("\n");

  const input = [
    ...(systemPrompt
      ? [{ role: "developer", content: [{ type: "input_text", text: systemPrompt }] }]
      : []),
    { role: "user", content: [{ type: "input_text", text: userText }] },
  ];

  // Log the fully-assembled user-message prompt and the role's inline system
  // prompt so the log shows exactly what was sent to the model.
  if (typeof recordFinalPrompt === "function") {
    recordFinalPrompt(userText, { systemPrompt });
  }

  // -- Visual framing --
  const color = roleBrandColor(role, C.cyan);
  const icon = roleBrandIcon(role);
  const showHeader = directOutput && role !== "assessor";

  if (showHeader) {
    const tierLabel = ` ${C[tierConfig.color] || ""}[${tierConfig.label}]${C.reset}`;
    const modelLabel = ` ${C.dim}model:${modelToUse}${C.reset}`;
    const actLabel = activity ? `  ${C.dim}-- ${activity}${C.reset}` : "";
    console.log(`\n${color}+${"---".repeat(20)}+${C.reset}`);
    console.log(`${color}|${C.reset} [${icon}] ${color}${C.bold}${role.toUpperCase()}${C.reset}${tierLabel}${modelLabel} ${C.dim}(openai)${C.reset}${actLabel}`);
    console.log(`${color}+${"---".repeat(20)}+${C.reset}`);
  }

  /** Emit a line to display or onLine callback. */
  const emit = (line) => {
    if (directOutput) process.stdout.write(`${color}|${C.reset} ${line}\n`);
    else if (onLine) onLine(line);
  };

  const start = Date.now();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalReasoningOutputTokens = 0;
  let maxSingleTurnInputTokens = 0;
  let turnCount = 0;
  let readCount = 0;
  const maxReads = fallbackReads ?? DEFAULT_FALLBACK_READS;
  let allText = "";
  const toolUses = [];
  let latestResponseId = null;

  // -- Stall detection --
  // Role-aware multiplier matching claude.js behavior
  const STALL_ROLE_MULTIPLIER = { researcher: 2, planner: 2 };
  const baseStallSec = resolveProviderStallTimeout(stallTimeout);
  const stallMs = baseStallSec * (STALL_ROLE_MULTIPLIER[role] || 1) * 1000;

  const createResponse = createAbortableResponsesCaller({
    client,
    providerLabel: "OpenAI",
    externalSignal: abortSignal,
    stallMs,
    baseStallSec,
    withRetry,
    emit,
  });

  const addUsage = (usage) => {
    if (!usage) return;
    const normalized = normalizeProviderUsage("openai", usage);
    const inputTokens = normalized.inputTokens ?? 0;
    totalInputTokens += inputTokens;
    totalOutputTokens += normalized.outputTokens ?? 0;
    totalCachedInputTokens += normalized.cachedInputTokens ?? 0;
    totalReasoningOutputTokens += normalized.reasoningOutputTokens ?? 0;
    maxSingleTurnInputTokens = Math.max(maxSingleTurnInputTokens, inputTokens);
  };

  // Configure the ATLAS-first gate for this call. Capture the resolved scope
  // key so release and tool callbacks do not depend on ambient async context.
  const gateScopeKey = configureGate({
    role,
    atlasAvailable: !disableAtlas && !!atlasAttachment?.active,
    enabled: atlasToolGateEnabled,
    scopeKey: jobId != null ? `job:${jobId}` : null,
  });
  const normalizedAtlasPrefetchStatus = String(atlasPrefetchStatus || "").trim().toLowerCase();
  if (
    atlasAttachment?.active
    && isFallbackAtlasPrefetchStatus(normalizedAtlasPrefetchStatus)
  ) {
    unlockForAtlasUnavailable({ reason: `prefetch_${normalizedAtlasPrefetchStatus}`, scopeKey: gateScopeKey });
  }

  try {
    // -- Build request options --
    const createOpts = {
      model: modelToUse,
      input,
      ...(tools.length > 0 ? { tools } : {}),
    };
    if (priorSessionHandle) {
      createOpts.previous_response_id = String(priorSessionHandle);
    }

    // Reasoning effort is for OpenAI reasoning families; skip gpt-4.x to avoid API errors.
    const isReasoningModel = isReasoningModelName(modelToUse);
    if (isReasoningModel) {
      createOpts.reasoning = { effort };
    }

    emit(`${C.dim}calling ${modelToUse}...${C.reset}`);

    let response = await createResponse(createOpts, priorSessionHandle ? "resume call" : "initial call");
    latestResponseId = response.id || latestResponseId;

    // Track tokens
    addUsage(response.usage);

    // -- Tool-use conversation loop (bounded) --
    const THROTTLE_MS = 200; // minimum delay between API calls to avoid rate limits

    while (true) {
      // Check abort
      if (abortSignal?.aborted) {
        emit(`${C.red}[aborted] Signal received, stopping.${C.reset}`);
        break;
      }

      // Collect text output from this turn (don't dump to log - only tool calls & status)
      const turnText = response.output_text || "";
      if (turnText) {
        allText += (allText ? "\n" : "") + turnText;
      }

      // Check for function calls
      const functionCalls = (response.output || []).filter(
        (item) => item.type === "function_call"
      );

      // No function calls ? model is done
      if (functionCalls.length === 0) break;

      // Hard turn cap - system decides when to stop, not the model
      if (turnCount >= turnLimit) {
        emit(`${C.yellow}[cap] Reached ${turnLimit} tool turns - forcing final answer${C.reset}`);

        // Send tool results + force-stop instruction so model wraps up
        const stubResults = functionCalls.map(call => ({
          type: "function_call_output",
          call_id: call.call_id,
          output: "(turn limit reached - tool call skipped)",
        }));
        const finalOpts = {
          model: modelToUse,
          previous_response_id: response.id,
          input: [
            ...stubResults,
            { role: "user", content: [{ type: "input_text", text:
              "SYSTEM: Tool turn limit reached. You must now produce your final answer. Do not call any more tools." }] },
          ],
          // No tools - force text-only response
        };
        if (isReasoningModel) finalOpts.reasoning = { effort };

        await abortableThrottle(THROTTLE_MS, abortSignal);
        const finalResponse = await createResponse(finalOpts, "final answer");
        latestResponseId = finalResponse.id || latestResponseId;
        addUsage(finalResponse.usage);
        const finalText = finalResponse.output_text || "";
        if (finalText) allText += (allText ? "\n" : "") + finalText;
        break;
      }

      turnCount++;
      emit(
        `${C.dim}-- turn ${turnCount}/${turnLimit}: ` +
        `${functionCalls.length} tool call(s) --${C.reset}`
      );

      // Execute each tool call (with fallback read budget)
      const toolResults = [];
      for (const call of functionCalls) {
        const callInput = _parseToolInput(call.arguments);
        toolUses.push({ tool: call.name, input: callInput });

        // -- Enforce read budget --
        if (call.name === "read_file") {
          readCount++;
          if (readCount > maxReads) {
            emit(`${C.yellow}  [budget] read_file denied - ${maxReads} fallback reads exhausted${C.reset}`);
            toolResults.push({
              type: "function_call_output",
              call_id: call.call_id,
              output: `Error: Fallback read budget exhausted (max ${maxReads}). The file contents you need should already be in the prompt context. If critical context is missing, return MISSING_CONTEXT with the files you need.`,
            });
            continue;
          }
          emit(`${C.yellow}  [fallback read ${readCount}/${maxReads}]${C.reset}`);
        }

        const toolStart = Date.now();
        const shortArgs = (call.arguments || "").slice(0, 100);
        const displayToolName = formatAtlasToolUseDisplayName(call.name, callInput) || call.name;
        emit(`${C.dim}  [tool] ${displayToolName}(${shortArgs}${shortArgs.length >= 100 ? "..." : ""})${C.reset}`);

        const rawResult = await executeTool(call.name, call.arguments, workingDir, allowWrite, scopePredicates, atlasConfig, gateScopeKey);
        const toolMs = Date.now() - toolStart;
        // executeTool can yield non-strings (e.g. error paths in tool handlers
        // that surface objects). Coerce before .length / .slice so a single
        // misbehaving tool does not crash the whole turn.
        const result = typeof rawResult === "string" ? rawResult : String(rawResult ?? "");

        // Truncate very large tool results to stay within context budget
        const truncated = result.length > 100000
          ? result.slice(0, 100000) + "\n... (truncated at 100 KB)"
          : result;

        toolResults.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: truncated,
        });

        emit(`${C.dim}  [done] ${displayToolName} (${toolMs}ms, ${result.length} chars)${C.reset}`);
      }

      // Throttle before next API call
      await abortableThrottle(THROTTLE_MS, abortSignal);

      // Send tool results back to OpenAI
      const nextOpts = {
        model: modelToUse,
        previous_response_id: response.id,
        input: toolResults,
        ...(tools.length > 0 ? { tools } : {}),
      };
      if (isReasoningModel) {
        nextOpts.reasoning = { effort };
      }

      response = await createResponse(nextOpts, `turn ${turnCount}`);
      latestResponseId = response.id || latestResponseId;

      // Track tokens
      addUsage(response.usage);
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    emit(`${C.red}[error] OpenAI API call failed: ${err.message}${C.reset}`);

    const wrapped = new Error(`OpenAI API error: ${err.message}`);
    wrapped.cause = err;
    if (err?.code) wrapped.code = err.code;
    if (err?.code === "ASYNC_GATE_BUSY" || err?.code === "ASYNC_GATE_TIMEOUT") {
      wrapped.gateContention = true;
    }
    const sessionExpired = Boolean(priorSessionHandle)
      && /previous_response_id|response.*not.*found|not.*found.*response|expired|invalid.*response/i.test(String(err?.message || ""));
    if (sessionExpired) wrapped.sessionExpired = true;
    wrapped.stats = {
      durationMs,
      outputChars: allText.length,
      promptChars: promptText.length,
      exitCode: 1,
      modelName: modelToUse,
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
      cachedInputTokens: totalCachedInputTokens || null,
      reasoningOutputTokens: totalReasoningOutputTokens || null,
      longContextInputTokens: maxSingleTurnInputTokens || null,
      role,
      modelTier,
      reasoningEffort: effort,
      maxTurns: turnLimit,
      toolUses: toolUses.length > 0 ? toolUses : null,
      toolUsesLoggedByToolkit: true,
      atlasMethod: atlasMethodForStats,
      sessionHandle: latestResponseId,
      priorSessionHandle: priorSessionHandle || null,
      sessionExpired,
    };
    wrapped.toolUses = toolUses.length > 0 ? toolUses : null;
    if (err.stallKill) wrapped.stallKill = true;
    if (err.name === "AbortError" || err.aborted) {
      wrapped.name = "AbortError";
      wrapped.aborted = true;
    }
    throw wrapped;
  } finally {
    releaseGate({ scopeKey: gateScopeKey });
  }

  const durationMs = Date.now() - start;
  const elapsed = (durationMs / 1000).toFixed(1);
  const totalTokens = totalInputTokens + totalOutputTokens;
  emit(
    `${C.dim}completed: ${elapsed}s | ${turnCount} tool turn(s) | ` +
    `${totalTokens} tokens${C.reset}`
  );

  // footer intentionally suppressed - elapsed time is logged via onLine/event system

  return {
    output: allText.trim(),
    stats: {
      durationMs,
      outputChars: allText.length,
      promptChars: promptText.length,
      exitCode: 0,
      modelName: modelToUse,
      responseId: latestResponseId,
      sessionHandle: latestResponseId,
      priorSessionHandle: priorSessionHandle || null,
      sessionExpired: false,
      inputTokens: totalInputTokens || null,
      outputTokens: totalOutputTokens || null,
      cachedInputTokens: totalCachedInputTokens || null,
      reasoningOutputTokens: totalReasoningOutputTokens || null,
      longContextInputTokens: maxSingleTurnInputTokens || null,
      role,
      modelTier,
      reasoningEffort: effort,
      maxTurns: turnLimit,
      numTurns: turnCount,
      toolUses: toolUses.length > 0 ? toolUses : null,
      toolUsesLoggedByToolkit: true,
      atlasMethod: atlasMethodForStats,
    },
  };
}


// --- Input helpers ----------------------------------------------------------

export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let resolved = false;
    rl.question(question, (answer) => {
      resolved = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!resolved) resolve("");
    });
  });
}

export function askMultiline(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const lines = [];
    let resolved = false;
    console.log(prompt);
    console.log(`${C.dim}(finish with a single "." on its own line)${C.reset}`);

    rl.on("line", (line) => {
      if (line.trim() === ".") {
        resolved = true;
        rl.close();
        resolve(lines.join("\n").trim());
        return;
      }
      lines.push(line);
    });
    rl.on("close", () => {
      if (!resolved) resolve(lines.join("\n").trim());
    });
  });
}

// --- Rate Limit State ------------------------------------------------------
// Unified with the circuit breaker: getRateLimitState reports the breaker's
// state so the worker-level backoff uses real numbers from Retry-After headers.

/**
 * Trip the rate limit (delegates to circuit breaker).
 */
export function tripRateLimit(backoffSec, reason = "") {
  _circuitBreaker.trip(backoffSec);
}

/**
 * Check if OpenAI is currently rate-limited.
 * @returns {{ blocked: boolean, retryInSec: number, reason: string }}
 */
export function getRateLimitState() {
  if (!isCircuitOpen()) {
    return { blocked: false, retryInSec: 0, reason: "" };
  }
  const resetAt = _circuitBreaker.getResetAt();
  const remaining = Math.max(0, resetAt - Date.now());
  return { blocked: true, retryInSec: Math.ceil(remaining / 1000), reason: "circuit_breaker" };
}

/**
 * Parse an OpenAI error and return the recommended backoff.
 * Uses real Retry-After headers when available.
 *
 * @param {Error} err
 * @returns {{ backoffSec: number, isRateLimit: boolean, source: string }}
 */
export function parseErrorBackoff(err) {
  return classifyProviderError(err, {
    defaultBackoffSec: 15,
    circuitBreakerBackoffSec: () => getRateLimitState().retryInSec || 15,
  });
}

export const __testSafePath = sharedSafePath;
export const __testBuildScopePredicates = sharedBuildScopePredicates;
export const __testInspectFile = deterministicInspectFile;
export const __testResizeImage = deterministicResizeImage;
export const __testCallAbortableResponsesCreate = callAbortableResponsesCreate;
export const __testGetToolsForRole = getToolsForRole;
