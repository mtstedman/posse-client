import crypto from "node:crypto";
import path from "node:path";

import { dispatchProvider } from "../../../../shared/native/functions/provider-dispatch-client.js";

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

export function buildClaudeNativeDispatchRequest(promptText, {
  dispatchId,
  jobId = null,
  workItemId = null,
  attemptId = null,
  agentCallId = null,
  systemPrompt = null,
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
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const turns = positiveInteger(maxTurns, 1, 256);
  const outputTokens = positiveInteger(maxOutputTokens, 1, 2_000_000);
  const stallMs = positiveInteger(stallTimeoutMs, 1_000, MAX_WALL_TIMEOUT_MS);
  const wallMs = positiveInteger(
    wallTimeoutMs,
    Math.min(MAX_WALL_TIMEOUT_MS, Math.max(stallMs, stallMs * turns)),
    MAX_WALL_TIMEOUT_MS,
  );
  const skills = [...new Set(stringList(resolvedSkillIds))].sort();
  const tools = [...new Set(stringList(issuedToolIds))];
  return {
    id: String(dispatchId || `claude-${crypto.randomUUID()}`),
    provider: "claude",
    identity: { jobId, workItemId, attemptId, agentCallId },
    prompt: {
      text: String(promptText || ""),
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
      maxToolResultChars: positiveInteger(maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS, 8 * 1024 * 1024),
    },
    session: {
      priorHandle: priorSessionHandle == null ? null : String(priorSessionHandle),
      recyclingMode: recyclingMode === "resume" ? "resume" : "fresh",
    },
  };
}

export async function runClaudeNativeDispatch(request, {
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
} = {}) {
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
  try {
    const result = await dispatchProvider(request, {
      signal: abortSignal,
      mcpGate,
      projectDir,
      onEvent: (event) => {
        if (event.type === "output.delta") emitOutput(String(event.text || ""));
        else if (event.type === "commentary") onAgentCommentary?.(String(event.text || ""));
        else if (event.type === "status") onLine?.(String(event.message || event.text || ""));
        else if (event.type === "usage.segment") onUsageSegment?.(event.usage || event);
        else if (event.type === "usage.progress") onUsageProgress?.(event.usage || event);
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
    if (lineBuffer && onLine) onLine(lineBuffer);
    const stats = {
      ...(result.stats || {}),
      toolUses,
      toolUsesLoggedByToolkit: true,
      sessionHandle: result.sessionHandle || null,
      priorSessionHandle: request.session.priorHandle,
      maxTurns: request.limits.maxTurns,
      maxOutputTokens: request.limits.maxOutputTokens,
      outputTruncated: false,
      outputLimitReason: null,
      executionMode: "native-dispatch",
    };
    if (stats.inputTokens != null || stats.outputTokens != null) {
      try {
        onUsageSegment?.({
          requestOrdinal: 1,
          provider: "claude",
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
      } catch { /* accounting persistence cannot break provider execution */ }
    }
    return { output: result.output, stats };
  } catch (error) {
    if (lineBuffer && onLine) onLine(lineBuffer);
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    error.output = details.partialOutput || error.output || "";
    error.partialOutput = error.output;
    error.stats = details.stats || error.stats || {
      maxTurns: request.limits.maxTurns,
      maxOutputTokens: request.limits.maxOutputTokens,
      executionMode: "native-dispatch",
    };
    error.toolUses = toolUses;
    throw error;
  }
}
