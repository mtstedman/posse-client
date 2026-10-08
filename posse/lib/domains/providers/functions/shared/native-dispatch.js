import crypto from "node:crypto";
import { sortAgentToolDefinitions } from "../../../../shared/tools/functions/agent-schema.js";
import path from "node:path";
import { mcpClientToolDeadlineMs } from "../../../../catalog/mcp.js";
import { readPlannerDispatchPolicy } from "../../../planning/functions/planner-dispatch-policy.js";

import { dispatchProvider } from "../../../../shared/native/functions/provider-dispatch-client.js";

import { PROVIDER_DISPATCH_PROVIDERS, PROVIDER_DISPATCH_AUTH_MODES } from "../../../../catalog/binary.js";

const MAX_WALL_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 1_000_000;
const TASK_MODES = new Set(["code", "db", "artifact", "research"]);

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value, fallback, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function taskModeFor({ taskMode, roleMode, projectDbCapability }) {
  const explicit = String(taskMode || "").trim().toLowerCase();
  if (TASK_MODES.has(explicit)) return explicit;
  if (String(projectDbCapability || "none") !== "none") return "db";
  if (String(roleMode || "").trim().toLowerCase() === "web") return "research";
  return "code";
}

export function buildNativeDispatchRequest(provider, promptText, {
  dispatchId,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  systemPrompt = null,
  baseInstructions = null,
  authMode = null,
  promptCache = false,
  decision = null,
  image = null,
  budgetExemptToolIds = [],
  stableContext = null,
  modelTier = "standard",
  modelName = null,
  reasoningEffort = "medium",
  role = "planner",
  roleMode = null,
  taskMode = null,
  allowWrite = false,
  allowTests = true,
  projectDbCapability = "none",
  issuedToolIds = [],
  resolvedSkillIds = [],
  cwd,
  readRoots = [],
  createRoots = [],
  scopedFiles = [],
  createFiles = [],
  deleteFiles = [],
  maxTurns,
  maxOutputTokens,
  stallTimeoutMs,
  wallTimeoutMs = null,
  maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  priorSessionHandle = null,
  recyclingMode = "fresh",
} = {}) {
  if (!PROVIDER_DISPATCH_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported provider dispatch adapter: ${String(provider)}`);
  }
  if (authMode != null && (provider !== "codex" || !PROVIDER_DISPATCH_AUTH_MODES.includes(authMode))) {
    throw new Error("Unsupported provider authentication mode");
  }
  if (baseInstructions != null && provider !== "codex") {
    throw new Error("Unsupported provider base instructions");
  }
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const turns = positiveInteger(maxTurns, 1, 256);
  const outputTokens = positiveInteger(maxOutputTokens, 1, 2_000_000);
  const stallMs = positiveInteger(stallTimeoutMs, 1_000, MAX_WALL_TIMEOUT_MS);
  const tools = [...new Set(stringList(issuedToolIds))].sort();
  const api = ["anthropic", "openai", "grok"].includes(provider);
  if (decision != null && !api) throw new Error("Decision turns require an API provider");
  if (image != null && (!["openai", "grok"].includes(provider) || decision != null || tools.length)) {
    throw new Error("Image turns require a tool-free image provider");
  }
  if (budgetExemptToolIds.some(id => !tools.includes(id)) || (!api && budgetExemptToolIds.length)) {
    throw new Error("Budget-exempt tools must be issued API tools");
  }
  const toolMs = mcpClientToolDeadlineMs(tools, {
    agentDispatchTimeoutMs: tools.includes("tools.dispatch_agent")
      ? readPlannerDispatchPolicy({ projectDir: resolvedCwd }).toolTimeoutSec * 1_000
      : null,
  });
  const wallMs = positiveInteger(
    wallTimeoutMs,
    Math.min(MAX_WALL_TIMEOUT_MS, Math.max(stallMs * turns, tools.length ? toolMs + stallMs : stallMs)),
    MAX_WALL_TIMEOUT_MS,
  );
  const skills = [...new Set(stringList(resolvedSkillIds))].sort();
  return {
    id: String(dispatchId || `${provider}-${crypto.randomUUID()}`),
    provider,
    ...(decision == null ? {} : { decision: { ...decision, tools: sortAgentToolDefinitions(decision.tools) } }),
    ...(image == null ? {} : { image }),
    ...(authMode == null ? {} : { authMode }),
    identity: { jobId, workItemId, attemptId, agentCallId },
    prompt: {
      text: String(promptText || ""),
      ...(provider === "anthropic" && promptCache ? { cache: true } : {}),
      ...(baseInstructions == null ? {} : { baseInstructions: String(baseInstructions) }),
      stableContext: stableContext == null ? null : String(stableContext),
      system: systemPrompt == null ? null : String(systemPrompt),
    },
    model: {
      tier: String(modelTier || "standard"),
      name: modelName == null ? null : String(modelName),
      reasoningEffort: String(reasoningEffort || "medium"),
    },
    execution: {
      role: String(role || "planner"),
      roleMode: roleMode == null ? null : String(roleMode),
      taskMode: taskModeFor({ taskMode, roleMode, projectDbCapability }),
      allowWrite: allowWrite === true,
      allowTests: allowTests !== false,
      projectDbCapability: String(projectDbCapability || "none"),
      issuedToolIds: tools,
      ...(budgetExemptToolIds.length ? { budgetExemptToolIds: [...new Set(budgetExemptToolIds)] } : {}),
      // dispatchProvider replaces this with the digest of the exact descriptor
      // projection loaded through the attached gate before it starts Rust.
      issuedToolSurfaceDigest: null,
      resolvedSkillIds: skills,
      skillManifestDigest: sha256Json({
        ids: skills,
        // Skill bodies are already part of the finalized system prompt. Bind
        // the digest to that delivered text so an ID-stable content change is
        // still visible at the native boundary.
        systemPrompt: systemPrompt == null ? null : String(systemPrompt),
      }),
    },
    scope: {
      cwd: resolvedCwd,
      readRoots: stringList(readRoots),
      createRoots: stringList(createRoots),
      scopedFiles: stringList(scopedFiles),
      createFiles: stringList(createFiles),
      deleteFiles: stringList(deleteFiles),
    },
    limits: {
      maxTurns: turns,
      maxOutputTokens: outputTokens,
      stallTimeoutMs: stallMs,
      wallTimeoutMs: Math.max(stallMs, wallMs),
      toolTimeoutMs: Math.min(toolMs, Math.max(stallMs, wallMs)),
      maxToolResultChars: positiveInteger(maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS, 8 * 1024 * 1024),
    },
    session: {
      priorHandle: priorSessionHandle == null ? null : String(priorSessionHandle),
      recyclingMode: recyclingMode === "resume" ? "resume" : "fresh",
    },
  };
}

export async function runNativeDispatch(request, {
  abortSignal = null,
  mcpGate = null,
  projectDir = null,
  silent = false,
  onLine = null,
  onAgentCommentary = null,
  onProviderToolUse = null,
  onProviderToolResult = null,
  onUsageSegment = null,
  onUsageProgress = null,
  dispatch = dispatchProvider,
} = {}) {
  let sawUsageSegment = false;
  const notifyUsage = (callback, usage) => {
    try { callback?.(usage); } catch { /* accounting persistence cannot break provider execution */ }
  };
  const toolUses = [];
  let lineBuffer = "";
  const emitOutput = (text) => {
    if (!text) return;
    if (!onLine) {
      if (!silent) process.stdout.write(text);
      return;
    }
    lineBuffer += text;
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) !== -1) {
      onLine(lineBuffer.slice(0, newline));
      lineBuffer = lineBuffer.slice(newline + 1);
    }
  };
  const commonStats = {
    provider: request.provider,
    role: request.execution.role,
    modelTier: request.model.tier,
    modelName: request.model.name,
    reasoningEffort: request.model.reasoningEffort,
    priorSessionHandle: request.session.priorHandle,
    maxTurns: request.limits.maxTurns,
    maxOutputTokens: request.limits.maxOutputTokens,
    executionMode: "native-dispatch",
  };
  const flushOutput = () => {
    const remaining = lineBuffer;
    lineBuffer = "";
    if (remaining && onLine) onLine(remaining);
  };
  try {
    const result = await dispatch(request, {
      signal: abortSignal,
      mcpGate,
      projectDir,
      onEvent: (event) => {
        if (event.type === "output.delta") emitOutput(String(event.text || ""));
        else if (event.type === "commentary") onAgentCommentary?.(String(event.text || ""));
        else if (event.type === "status") onLine?.(String(event.message || event.text || ""));
        else if (event.type === "usage.segment") {
          sawUsageSegment = true;
          notifyUsage(onUsageSegment, event.usage || event);
        } else if (event.type === "usage.progress") notifyUsage(onUsageProgress, event.usage || event);
        else if (event.type === "tool.requested") {
          const toolUse = {
            id: String(event.toolCallId || ""),
            tool: String(event.name || ""),
            input: event.input && typeof event.input === "object" ? event.input : {},
          };
          toolUses.push(toolUse);
          onProviderToolUse?.(toolUse);
        } else if (event.type === "tool.completed") {
          onProviderToolResult?.({
            id: String(event.toolCallId || ""),
            isError: event.ok === false,
          });
        }
      },
    });
    flushOutput();
    const stats = {
      ...commonStats,
      outputTruncated: false,
      outputLimitReason: null,
      ...(result.stats || {}),
      toolUses,
      toolUsesLoggedByToolkit: true,
      sessionHandle: result.sessionHandle || null,
    };
    // Native request checkpoints already carry their own ordinals. Appending
    // an aggregate checkpoint would overwrite ordinal 1 or double count usage.
    if (!sawUsageSegment && (stats.inputTokens != null || stats.outputTokens != null)) {
      notifyUsage(onUsageSegment, {
        requestOrdinal: 1,
        provider: request.provider,
        modelName: stats.modelName || request.model.name,
        inputTokens: stats.inputTokens ?? 0,
        cachedInputTokens: stats.cachedInputTokens ?? 0,
        cacheCreationInputTokens: stats.cacheCreationInputTokens ?? 0,
        outputTokens: stats.outputTokens ?? 0,
        requestContextInputTokens: stats.inputTokens ?? 0,
        durationMs: stats.durationMs ?? null,
        usageSource: "aggregate_only",
        precision: "aggregate_only",
      });
    }
    return { output: result.output, stats };
  } catch (error) {
    flushOutput();
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    error.output = details.partialOutput || error.output || "";
    error.partialOutput = error.output;
    error.stats = {
      ...commonStats,
      ...(details.stats || error.stats || {}),
      toolUses,
      toolUsesLoggedByToolkit: true,
    };
    error.toolUses = toolUses;
    throw error;
  }
}
