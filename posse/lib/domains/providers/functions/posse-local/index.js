// @ts-check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ML_GENERATE_METHOD } from "../../../../catalog/binary.js";
import {
  GEMMA_LOCAL_MODEL_ID,
  LOCAL_MODEL_IDS,
  LOCAL_MODEL_PROFILES,
  QWEN_LOCAL_MODEL_ID,
} from "../../../../catalog/local-model.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import { runMlNativeMethodAsync } from "../../../../shared/native/functions/ml-invoke.js";
import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";
import { ToolCatalog } from "../../../../shared/tools/classes/ToolCatalog.js";
import { buildExecutionContract } from "../../../../shared/tools/functions/contract.js";
import {
  issuedToolSurfaceForProviderPolicy,
  narrowProviderOptionsToRemoteIssuance,
} from "../../../../shared/tools/functions/issued-tool-policy.js";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { isProviderEnabledByCatalog } from "../model-catalog-store.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { buildEmbeddedToolDefinitions } from "../shared/embedded-tools.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { escalateModelTier } from "../shared/turns.js";
import {
  buildLocalPlannerToolInstructions,
  formatGemmaLocalToolResult,
  formatLocalToolResult,
  LOCAL_PLANNER_TOOL_TURN_LIMIT,
  runLocalPlannerToolLoop,
} from "./tool-protocol.js";

export { extractJson };

export {
  GEMMA_LOCAL_MODEL_ID,
  LOCAL_MODEL_IDS,
  LOCAL_MODEL_PROFILES,
  QWEN_LOCAL_MODEL_ID,
};
const LOCAL_FILE_WRITE_ROLES = new Set(["dev", "artificer"]);
const LOCAL_FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

function normalizedScopedPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function singleExactWriteTarget({ scopedFiles, createFiles, createRoots, deleteFiles }) {
  if ((createRoots || []).length > 0 || (deleteFiles || []).length > 0) return null;
  const targets = [...new Set([
    ...(scopedFiles || []),
    ...(createFiles || []),
  ].map(normalizedScopedPath).filter(Boolean))];
  return targets.length === 1 ? targets[0] : null;
}

function bindMissingContextExampleToExactTarget(promptText, targetPath) {
  const prompt = String(promptText || "");
  if (!targetPath) return prompt;
  return prompt.replace(
    /(MISSING_CONTEXT:\s*\r?\n\s*-\s*)path\/to\/needed\/file\.js/g,
    `$1${targetPath}`,
  );
}

function toolResultFailed(result) {
  return result?.isError === true || /^Error:/i.test(String(result || "").trim());
}

function validLocalPlannerOutput(content) {
  const parsed = extractJson(String(content || ""));
  return Array.isArray(parsed)
    && parsed.every((task) => (
      task
      && typeof task === "object"
      && !Array.isArray(task)
      && typeof task.title === "string"
      && task.title.trim()
      && typeof task.description === "string"
      && task.description.trim()
    ));
}

function suppressedReplayCompletion(role, targetPath, name, args, result, context = {}) {
  if (normalizedScopedPath(args?.path) !== targetPath) return null;
  if (toolResultFailed(result)) return null;
  let completedMutation = null;
  let replaySummary = null;
  if (LOCAL_FILE_WRITE_TOOLS.has(name)) {
    completedMutation = name;
    replaySummary = "an identical model replay was suppressed without executing it again";
  } else if (name === "read_file") {
    const mutations = Array.isArray(context?.executedMutations) ? context.executedMutations : [];
    for (let index = mutations.length - 1; index >= 0; index -= 1) {
      const mutation = mutations[index];
      if (LOCAL_FILE_WRITE_TOOLS.has(mutation?.name)
        && normalizedScopedPath(mutation?.args?.path) === targetPath
        && !toolResultFailed(mutation?.result)) {
        completedMutation = mutation.name;
        replaySummary = "a redundant verification read was suppressed without executing it again";
        break;
      }
    }
  }
  if (!completedMutation) return null;
  const label = role === "artificer" ? "ARTIFICER RESULT" : "DEV RESULT";
  return [
    `--- ${label} START ---`,
    "status: COMPLETE",
    `summary: ${completedMutation} completed successfully for ${targetPath}; ${replaySummary}.`,
    `--- ${label} END ---`,
  ].join("\n");
}

export const capabilities = Object.freeze({
  images: false,
  sessionResume: false,
  toolAttachment: "function",
  localGeneration: true,
});

export const MODEL_TIERS = Object.freeze({
  cheap: Object.freeze({ model: getProviderTierDefaults("posse-local").cheap.model, thinking: false, label: "LOCAL QWEN", color: "cyan" }),
  standard: Object.freeze({ model: getProviderTierDefaults("posse-local").standard.model, thinking: false, label: "LOCAL QWEN", color: "cyan" }),
  strong: Object.freeze({ model: getProviderTierDefaults("posse-local").strong.model, thinking: false, label: "LOCAL GEMMA", color: "magenta" }),
});

export function defaultLocalGenerationModelRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "models");
}

export function defaultLocalGenerationRuntimeRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "runtime", "onnx-genai");
}

function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  return { ...base, model: readModelSetting(`posse-local_model_${key}`) || base.model };
}

export function hasCredentials() {
  return true;
}

export function getCredentialEnvVars() {
  return [];
}

export function isLocalGenerationEnabled({ getSettingFn = getSetting } = {}) {
  if (isProviderEnabledByCatalog("posse-local")) return true;
  try {
    return /^(1|true|yes|on)$/i.test(String(getSettingFn(SETTING_KEYS.POSSE_LOCAL_GENERATION_ENABLED) || "").trim());
  } catch {
    return false;
  }
}

export function isReady({
  manager = nativeBinaries,
  modelRoot = defaultLocalGenerationModelRoot(),
  getSettingFn = getSetting,
} = {}) {
  if (!isLocalGenerationEnabled({ getSettingFn })) {
    return { ready: false, reason: "local text generation is disabled by the model catalog" };
  }
  if (process.arch !== "x64" || !["linux", "win32"].includes(process.platform)) {
    return { ready: false, reason: "local Qwen/Gemma generation supports Linux x64 and Windows x64" };
  }
  if (!manager.shouldUse("ml")) {
    return { ready: false, reason: "native ML runtime is disabled" };
  }
  const resolvedModelRoot = path.resolve(modelRoot);
  const hasInstalledModel = LOCAL_MODEL_IDS.some((modelId) => {
    const installedDirectory = path.join(resolvedModelRoot, LOCAL_MODEL_PROFILES[modelId].profileId);
    return fs.existsSync(path.join(installedDirectory, ".posse-model-package.json"));
  });
  if (!hasInstalledModel) {
    return {
      ready: false,
      reason: "local Qwen/Gemma models are not installed; run: posse local-models download qwen-code (or gemma-it)",
    };
  }
  return { ready: true, reason: null };
}

export function getClaudeInfo() {
  return { cmd: "posse-ml", args: [ML_GENERATE_METHOD] };
}

export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

export async function callProvider(promptText, opts = {}) {
  const requestedAllowWrite = opts?.allowWrite === true;
  const requestedProjectDbWrite = opts?.projectDbWrite === true;
  const requestedImageGeneration = opts?.needsImageGeneration === true;
  const effectiveOpts = narrowProviderOptionsToRemoteIssuance(opts || {});
  const {
    role = "planner",
    modelTier = "standard",
    modelName = null,
    maxTurns = null,
    maxOutputTokens = null,
    remoteSystemPrompt = null,
    stableContext = null,
    allowWrite = false,
    projectDbWrite = false,
    scopedFiles = null,
    createFiles = null,
    createRoots = null,
    readRoots = null,
    deleteFiles = null,
    needsImageGeneration = false,
    priorSessionHandle = null,
    onLine = null,
    abortSignal = null,
    recordFinalPrompt = null,
    cwd = null,
    fallbackReads = null,
    // AgentDispatcher attaches this capability as non-enumerable so option
    // spreads cannot leak it. Read the original options as the fallback after
    // remote-policy narrowing performs its defensive shallow copy.
    mcpGate = opts?.mcpGate || null,
    _remoteIssuedPolicy = null,
    manager = nativeBinaries,
    modelRoot = defaultLocalGenerationModelRoot(),
    runtimeRoot = defaultLocalGenerationRuntimeRoot(),
    timeoutMs = 15 * 60 * 1000,
  } = effectiveOpts;

  if (requestedProjectDbWrite || requestedImageGeneration || projectDbWrite || needsImageGeneration) {
    const error = new Error("The local Qwen/Gemma provider cannot write project databases or generate images.");
    /** @type {any} */ (error).code = "POSSE_LOCAL_TOOLS_UNSUPPORTED";
    throw error;
  }
  const remoteProviderMatches = String(_remoteIssuedPolicy?.provider || "").trim().toLowerCase() === "posse-local";
  const issuedToolSurface = remoteProviderMatches
    ? (issuedToolSurfaceForProviderPolicy(_remoteIssuedPolicy) || [])
    : [];
  const issuedLocalWriteTools = issuedToolSurface
    .filter((entry) => entry.startsWith("tools."))
    .map((entry) => entry.slice("tools.".length))
    .filter((name) => LOCAL_FILE_WRITE_TOOLS.has(name));
  const fileWriteAuthorized = allowWrite
    && LOCAL_FILE_WRITE_ROLES.has(role)
    && typeof mcpGate?.callTool === "function"
    && issuedLocalWriteTools.length > 0;
  if (requestedAllowWrite && !fileWriteAuthorized) {
    const error = new Error("Local file writes require a signed dev/artificer tool surface, an Agent MCP gate, and an issued write_file or edit_file tool.");
    /** @type {any} */ (error).code = "POSSE_LOCAL_WRITE_BRIDGE_UNAUTHORIZED";
    throw error;
  }
  const readiness = isReady({ manager, modelRoot });
  if (!readiness.ready) {
    const error = new Error(readiness.reason || "The local text-generation provider is unavailable.");
    /** @type {any} */ (error).code = "POSSE_LOCAL_NOT_READY";
    throw error;
  }
  if (priorSessionHandle) {
    const error = new Error("The local Qwen/Gemma provider does not support session resume.");
    /** @type {any} */ (error).code = "POSSE_LOCAL_SESSION_RESUME_UNSUPPORTED";
    throw error;
  }
  const tier = getModelTierConfig(modelTier);
  const selected = selectExecutionModel({
    jobModelName: modelName,
    globalModelOverride: null,
    tierModel: tier.model,
  });
  if (!LOCAL_MODEL_IDS.includes(selected)) {
    const error = new Error(`Unsupported posse-local model: ${selected}`);
    /** @type {any} */ (error).code = "POSSE_LOCAL_MODEL_UNSUPPORTED";
    throw error;
  }
  const profile = LOCAL_MODEL_PROFILES[selected];
  const installedDirectory = path.join(path.resolve(modelRoot), profile.profileId);
  if (!fs.existsSync(path.join(installedDirectory, ".posse-model-package.json"))) {
    const error = new Error(`Local model ${selected} is not installed. Run: posse local-models download ${profile.shorthand}`);
    /** @type {any} */ (error).code = "POSSE_LOCAL_MODEL_NOT_INSTALLED";
    throw error;
  }

  const workingDir = path.resolve(cwd || process.cwd());
  const toolTurnLimit = Math.max(
    1,
    Math.floor(Math.min(
      LOCAL_PLANNER_TOOL_TURN_LIMIT,
      profile.maxToolTurns,
      Number(maxTurns) || profile.maxToolTurns,
    )),
  );
  const toolRoleEligible = (role === "planner" && !allowWrite)
    || (LOCAL_FILE_WRITE_ROLES.has(role) && fileWriteAuthorized);
  const toolEligible = toolRoleEligible
    && LOCAL_MODEL_IDS.includes(selected)
    && typeof mcpGate?.callTool === "function"
    && issuedToolSurface.length > 0;
  const executionContract = toolEligible
    ? buildExecutionContract({
      provider: "posse-local",
      role,
      allowWrite,
      issuedToolSurface,
      scopedFiles,
      createFiles,
      createRoots,
      readRoots,
      deleteFiles,
      fallbackReads,
      projectDir: workingDir,
    })
    : null;
  const exactWriteTarget = fileWriteAuthorized
    ? singleExactWriteTarget({ scopedFiles, createFiles, createRoots, deleteFiles })
    : null;
  const exactCreateTarget = exactWriteTarget
    && (createFiles || []).map(normalizedScopedPath).includes(exactWriteTarget)
    ? exactWriteTarget
    : null;
  const toolDefinitions = (executionContract
    ? buildEmbeddedToolDefinitions(executionContract)
    : [])
    .filter((tool) => {
      const entry = ToolCatalog.get(tool?.name);
      if (entry?.capabilityFlags?.shell) return false;
      if (entry?.capabilityFlags?.write) {
        if (exactCreateTarget && String(tool?.name || "") === "edit_file") return false;
        if (exactWriteTarget && !exactCreateTarget && String(tool?.name || "") === "write_file") return false;
        return fileWriteAuthorized && LOCAL_FILE_WRITE_TOOLS.has(String(tool?.name || ""));
      }
      return true;
    });
  const toolInstructions = buildLocalPlannerToolInstructions(toolDefinitions, toolTurnLimit, {
    allowFileWrites: fileWriteAuthorized,
    writeScope: fileWriteAuthorized ? {
      modifyFiles: scopedFiles || [],
      createFiles: createFiles || [],
      createRoots: createRoots || [],
    } : null,
  });
  const toolMode = toolDefinitions.length > 0;
  const system = [remoteSystemPrompt, stableContext, toolInstructions]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const user = bindMissingContextExampleToExactTarget(promptText, exactWriteTarget);
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  recordFinalPrompt?.(user, { systemPrompt: system || null, systemPromptFiles: [] });
  const outputLimit = Math.max(1, Math.min(
    profile.maxOutputTokens,
    Number(maxOutputTokens) || profile.maxOutputTokens,
  ));
  const started = Date.now();
  const nativeResults = [];
  const generate = async (generationMessages, { stream = false } = {}) => {
    let lineBuffer = "";
    const result = /** @type {any} */ (await runMlNativeMethodAsync(ML_GENERATE_METHOD, {
      modelId: selected,
      messages: generationMessages,
      generation: { mode: "greedy", maxOutputTokens: outputLimit },
      reasoning: { mode: "disabled", expose: false },
    }, {
      modelRoot: path.resolve(modelRoot),
      runtimeRoot: path.resolve(runtimeRoot),
      manager,
      timeoutMs,
      signal: abortSignal || undefined,
      idempotent: true,
      onProgress: (event) => {
        if (!stream || event?.kind !== "ml.generation.delta" || typeof event.delta !== "string") return;
        lineBuffer += event.delta;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        for (const line of lines) onLine?.(line);
      },
    }));
    if (stream && lineBuffer) onLine?.(lineBuffer);
    nativeResults.push(result);
    return result;
  };

  let content;
  let toolUses = null;
  let toolTurns = 0;
  if (toolMode) {
    let readCount = 0;
    const maxReads = Math.max(0, Number(fallbackReads) || 0);
    const loop = await runLocalPlannerToolLoop({
      messages,
      tools: toolDefinitions,
      turnLimit: toolTurnLimit,
      formatResult: (name, result) => selected === GEMMA_LOCAL_MODEL_ID
        ? formatGemmaLocalToolResult(name, result, profile.maxToolResultChars)
        : formatLocalToolResult(name, result, profile.maxToolResultChars),
      completeSuppressedReplay: exactWriteTarget
        ? (name, args, result, context) => suppressedReplayCompletion(
          role,
          exactWriteTarget,
          name,
          args,
          result,
          context,
        )
        : null,
      finalOutputHint: role === "planner"
        ? "Return only the planner task JSON array required by the original request. Its first non-whitespace character must be [ and its last must be ]."
        : `Return only the required ${role} result block in the original format, with an honest COMPLETE or BLOCKED status.`,
      validateFinalOutput: role === "planner" ? validLocalPlannerOutput : null,
      generate,
      execute: async (name, args) => {
        if (name === "read_file") {
          readCount += 1;
          if (readCount > maxReads) {
            return `Error: Fallback read budget exhausted (max ${maxReads}). Use the supplied context or another authorized retrieval tool.`;
          }
        }
        return await mcpGate.callTool(name, args);
      },
    });
    content = loop.content;
    toolUses = loop.toolUses;
    toolTurns = loop.toolTurns;
    for (const line of content.split("\n")) onLine?.(line);
  } else {
    const result = await generate(messages, { stream: true });
    content = String(result?.content || "").trim();
  }

  const usage = nativeResults.reduce((totals, result) => ({
    inputTokens: totals.inputTokens + (Number(result?.usage?.inputTokens) || 0),
    outputTokens: totals.outputTokens + (Number(result?.usage?.outputTokens) || 0),
  }), { inputTokens: 0, outputTokens: 0 });
  const lastResult = nativeResults.at(-1) || null;
  const outputTruncated = nativeResults.some((result) => result?.finishReason === "length");
  return {
    output: content,
    stats: {
      durationMs: Date.now() - started,
      outputChars: content.length,
      promptChars: user.length,
      exitCode: 0,
      modelName: selected,
      responseId: null,
      sessionHandle: null,
      priorSessionHandle: null,
      sessionExpired: false,
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
      longContextInputTokens: usage.inputTokens || null,
      role,
      modelTier,
      reasoningEffort: "disabled",
      maxTurns: toolMode ? toolTurnLimit : 1,
      maxOutputTokens: outputLimit,
      outputTruncated,
      outputLimitReason: outputTruncated ? "max_output_tokens" : null,
      numTurns: toolTurns,
      toolUses,
      toolUsesLoggedByToolkit: false,
      atlasMethod: null,
      localProfileId: lastResult?.profileId || null,
      coldStart: nativeResults.some((result) => result?.timing?.coldStart === true),
      costUsd: 0,
    },
  };
}
