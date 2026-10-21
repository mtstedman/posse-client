import crypto from "node:crypto";
import fs from "node:fs";
import { sortAgentToolDefinitions } from "../../../../shared/tools/functions/agent-schema.js";
import path from "node:path";
import { mcpClientToolDeadlineMs } from "../../../../catalog/mcp.js";
import { RAW_CLI_CONTROL_OPTIONS } from "../../../../catalog/provider.js";
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

function isWithinDir(dir, target) {
  const relative = path.relative(dir, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Mirrors the native protocol's scope rule: every writable scope path stays
// under the canonical cwd, lexically and through symlinks. The native
// rejection surfaces as a dispatch exit that reads like a provider failure
// and is retried; this check fails the same request up front instead.
export function assertDispatchScopeWithinCwd(cwd, { createRoots = [], scopedFiles = [], createFiles = [], deleteFiles = [] } = {}) {
  let canonicalCwd;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    return; // native dispatch reports an unavailable cwd itself
  }
  for (const [label, values] of [["createRoots", createRoots], ["scopedFiles", scopedFiles], ["createFiles", createFiles], ["deleteFiles", deleteFiles]]) {
    for (const value of stringList(values)) {
      if (!value) continue;
      const resolved = path.resolve(canonicalCwd, value);
      let existing = resolved;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
      let canonical = existing;
      try { canonical = fs.realpathSync(existing); } catch { /* lexical check below still applies */ }
      if (!isWithinDir(canonicalCwd, resolved) || !isWithinDir(canonicalCwd, canonical)) {
        const err = new Error(`Dispatch scope.${label} escapes scope.cwd: ${value} is outside ${canonicalCwd}`);
        err.code = "POSSE_DISPATCH_SCOPE_ESCAPE";
        err.classification = "configuration";
        throw err;
      }
    }
  }
}

// A caller that still asks for a raw CLI control would otherwise get an
// ordinary Posse turn and mistake it for the control it wanted.
export function rejectRawCliControlOptions(provider, options = {}) {
  for (const name of RAW_CLI_CONTROL_OPTIONS) {
    const value = options?.[name];
    if (value === undefined || value === null || value === false) continue;
    throw new Error(`The ${provider} provider does not accept ${name}: raw CLI controls belong to the harness, and Posse provider turns run only through native dispatch.`);
  }
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
  allowWeb = false,
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
  transcript = null,
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
  assertDispatchScopeWithinCwd(resolvedCwd, { createRoots, scopedFiles, createFiles, deleteFiles });
  const turns = positiveInteger(maxTurns, 1, 256);
  const outputTokens = positiveInteger(maxOutputTokens, 1, 2_000_000);
  const stallMs = positiveInteger(stallTimeoutMs, 1_000, MAX_WALL_TIMEOUT_MS);
  const tools = [...new Set(stringList(issuedToolIds))].sort();
  const api = ["anthropic", "openai", "grok"].includes(provider);
  if (decision != null && !api && provider !== "posse-local") throw new Error("Decision turns require an API or local provider");
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
      ...(Array.isArray(transcript) && transcript.length ? { transcript } : {}),
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
      ...(allowWeb === true ? { allowWeb: true } : {}),
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
          const toolUse = toolUses.findLast((use) => use.id === String(event.toolCallId || ""));
          if (toolUse && event.ok === false) toolUse.status = "failed";
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
        // The measured cache-write TTL split, when the adapter reported it.
        cacheCreation5mTokens: stats.cacheCreation5mTokens ?? null,
        cacheCreation1hTokens: stats.cacheCreation1hTokens ?? null,
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
    // The adapter's contract reason is recorded beside the message, never in
    // it: callers classify the message (rate limits, stalls) by pattern.
    const reason = typeof details.diagnostic?.reason === "string"
      ? details.diagnostic.reason.trim().slice(0, 300)
      : "";
    if (reason) error.providerDiagnostic = reason;
    error.stats = {
      ...commonStats,
      ...(details.stats || error.stats || {}),
      toolUses,
      toolUsesLoggedByToolkit: true,
    };
    // A dispatch that ends early, failed or cancelled, still reports every
    // model request it completed: those are its turns.
    if (Number(error.stats.modelRequests) > 0) error.stats.numTurns ??= error.stats.modelRequests;
    // A cancelled dispatch (Posse's terminal handoff stop) keeps that usage as
    // partial usage after the stop, as the CLI paths do.
    if (error.code === "provider_dispatch_cancelled" && Number(error.stats.modelRequests) > 0
      && error.stats.inputTokens != null && error.stats.outputTokens != null) {
      error.stats.usagePartialAfterStop = true;
    }
    error.toolUses = toolUses;
    throw error;
  }
}
