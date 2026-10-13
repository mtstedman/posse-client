import { PROVIDER_CAPABILITIES } from "../../../../catalog/provider-capabilities.js";
import { readModelSetting } from "../shared/setting-read.js";
// @ts-check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GEMMA_LOCAL_MODEL_ID, LOCAL_MODEL_IDS, LOCAL_MODEL_PROFILES, QWEN_LOCAL_MODEL_ID } from "../../../../catalog/local-model.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import { dispatchLocalProvider } from "../../../../shared/native/functions/local-provider-dispatch.js";
import { buildNativeDispatchRequest, rejectRawCliControlOptions, runNativeDispatch } from "../shared/native-dispatch.js";
import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";
import { ToolCatalog } from "../../../../shared/tools/classes/ToolCatalog.js";
import { buildExecutionContract, renderProviderPromptContracts } from "../../../../shared/tools/functions/contract.js";
import { projectFunctionToolSurface } from "../../../../shared/tools/functions/provider-surface.js";
import { projectLocalToolDefinition } from "../../../../shared/tools/functions/provider-schema.js";
import { issuedToolSurfaceForProviderPolicy, narrowProviderOptionsToRemoteIssuance } from "../../../../shared/tools/functions/issued-tool-policy.js";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { isProviderEnabledByCatalog } from "../model-catalog-store.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { buildEmbeddedToolDefinitions } from "../shared/embedded-tools.js";
import { selectExecutionModel } from "../shared/model-selection.js";
import { escalateModelTier } from "../shared/turns.js";
import { buildLocalPlannerToolInstructions, LOCAL_PLANNER_TOOL_TURN_LIMIT } from "./tool-protocol.js";

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

export const capabilities = PROVIDER_CAPABILITIES["posse-local"];

export const MODEL_TIERS = Object.freeze({
  cheap: Object.freeze({ model: getProviderTierDefaults("posse-local").cheap.model, thinking: false, label: "LOCAL QWEN", color: "cyan" }),
  standard: Object.freeze({ model: getProviderTierDefaults("posse-local").standard.model, thinking: false, label: "LOCAL QWEN", color: "cyan" }),
  strong: Object.freeze({ model: getProviderTierDefaults("posse-local").strong.model, thinking: false, label: "LOCAL QWEN", color: "cyan" }),
});

export function defaultLocalGenerationModelRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "models");
}

export function defaultLocalGenerationRuntimeRoot(homeDir = os.homedir()) {
  return path.join(homeDir, ".posse", "runtime", "onnx-genai");
}


export function getModelTierConfig(tier = "standard") {
  const key = tier in MODEL_TIERS ? tier : "standard";
  const base = MODEL_TIERS[key];
  const configured = readModelSetting(`posse-local_model_${key}`);
  return { ...base, model: LOCAL_MODEL_IDS.includes(configured) ? configured : base.model };
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
    return { ready: false, reason: "local Qwen generation supports Linux x64 and Windows x64" };
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
      reason: "local Qwen model is not installed; run: posse local-models download qwen-code",
    };
  }
  return { ready: true, reason: null };
}

export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

export async function callProvider(promptText, opts = {}) {
  rejectRawCliControlOptions("posse-local", opts);
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
    allowTests = false,
    projectDbWrite = false,
    scopedFiles = null,
    createFiles = null,
    createRoots = null,
    readRoots = null,
    deleteFiles = null,
    needsImageGeneration = false,
    priorSessionHandle = null,
    recordFinalPrompt = null,
    cwd = null,
    fallbackReads = null,
    // AgentDispatcher attaches this capability as non-enumerable so option
    // spreads cannot leak it. Read the original options as the fallback after
    // remote-policy narrowing performs its defensive shallow copy.
    mcpGate = opts?.mcpGate || null,
    _remoteIssuedPolicy = null,
    _subAgentChild = false,
    manager = nativeBinaries,
    modelRoot = defaultLocalGenerationModelRoot(),
    runtimeRoot = defaultLocalGenerationRuntimeRoot(),
    timeoutMs = 15 * 60 * 1000,
  } = effectiveOpts;

  if (requestedProjectDbWrite || requestedImageGeneration || projectDbWrite || needsImageGeneration) {
    const error = new Error("The local Qwen provider cannot write project databases or generate images.");
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
    const error = new Error("The local Qwen provider does not support session resume.");
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
  const executionRole = _subAgentChild === true ? "subagent" : role;
  const toolRoleEligible = _subAgentChild === true
    || (role === "planner" && !allowWrite)
    || (LOCAL_FILE_WRITE_ROLES.has(role) && fileWriteAuthorized);
  const toolEligible = toolRoleEligible
    && LOCAL_MODEL_IDS.includes(selected)
    && typeof mcpGate?.callTool === "function"
    && issuedToolSurface.length > 0;
  let executionContract = toolEligible
    ? buildExecutionContract({
      provider: "posse-local",
      role: executionRole,
      allowWrite,
      allowTests,
      issuedToolSurface,
      agentHandoffCompactV1: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
      agentHandoffCompactV3: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV3 === true,
      researchInvestigation: _remoteIssuedPolicy?.coordination?.researchInvestigationV1 === true,
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
  const exactTargetPreloaded = !!(
    exactWriteTarget
    && String(stableContext || "").includes("PRELOADED EDITABLE FILE CONTEXT:")
    && String(stableContext || "").includes(`=== ${exactWriteTarget}`)
  );
  const embeddedToolDefinitions = executionContract
    ? buildEmbeddedToolDefinitions(executionContract)
    : [];
  const embeddedToolNames = new Set(embeddedToolDefinitions.map((tool) => String(tool?.name || "")));
  const toolDefinitions = embeddedToolDefinitions
    .filter((tool) => {
      const entry = ToolCatalog.get(tool?.name);
      if (entry?.capabilityFlags?.shell) return false;
      if (entry?.capabilityFlags?.write) {
        if (
          exactCreateTarget
          && String(tool?.name || "") === "edit_file"
          && embeddedToolNames.has("write_file")
        ) return false;
        if (exactWriteTarget && !exactCreateTarget && String(tool?.name || "") === "write_file") return false;
        return fileWriteAuthorized && LOCAL_FILE_WRITE_TOOLS.has(String(tool?.name || ""));
      }
      return true;
    })
    .sort((left, right) => {
      if (!fileWriteAuthorized) return 0;
      const priority = (tool) => LOCAL_FILE_WRITE_TOOLS.has(String(tool?.name || "")) ? 0 : 1;
      return priority(left) - priority(right);
    })
    .map(projectLocalToolDefinition);
  if (executionContract) {
    executionContract = projectFunctionToolSurface(executionContract, toolDefinitions);
  }
  const terminalHandoffIssued = toolDefinitions.some((tool) => String(tool?.name || "") === "agent_handoff");
  // Terminal local calls may need one bounded protocol correction plus the
  // final handoff after the ordinary tool budget. These are coordination
  // repairs, not extra mutation authority.
  const localLoopTurnLimit = terminalHandoffIssued
    ? toolTurnLimit + 2
    : toolTurnLimit;
  const requireMutationBeforeFinal = terminalHandoffIssued
    && fileWriteAuthorized
    && !!exactWriteTarget;
  const toolInstructions = buildLocalPlannerToolInstructions(toolDefinitions, localLoopTurnLimit, {
    allowFileWrites: fileWriteAuthorized,
    writeScope: fileWriteAuthorized ? {
      modifyFiles: scopedFiles || [],
      createFiles: createFiles || [],
      createRoots: createRoots || [],
    } : null,
    requiredFinalTool: terminalHandoffIssued ? "agent_handoff" : null,
    requireMutationBeforeFinal,
  });
  const toolMode = toolDefinitions.length > 0;
  const system = [
    renderProviderPromptContracts(remoteSystemPrompt, executionContract || {}),
    stableContext,
    toolInstructions,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const user = bindMissingContextExampleToExactTarget(promptText, exactWriteTarget);
  recordFinalPrompt?.(user, { systemPrompt: system || null, systemPromptFiles: [] });
  const outputLimit = Math.max(1, Math.min(
    profile.maxOutputTokens,
    Number(maxOutputTokens) || profile.maxOutputTokens,
  ));
  const issuedToolIds = toolDefinitions.map(tool => {
    const name = String(tool.name);
    return issuedToolSurface.includes(name) ? name : `tools.${name}`;
  });
  const request = buildNativeDispatchRequest("posse-local", user, {
    ...effectiveOpts, role, cwd: workingDir, modelTier, modelName: selected,
    systemPrompt: system || null, stableContext: null, reasoningEffort: "none", issuedToolIds,
    scopedFiles: scopedFiles || [], createFiles: createFiles || [], createRoots: createRoots || [],
    readRoots: readRoots || [], deleteFiles: deleteFiles || [],
    maxTurns: toolMode ? localLoopTurnLimit : 1, maxOutputTokens: outputLimit,
    maxToolResultChars: profile.maxToolResultChars, stallTimeoutMs: timeoutMs, wallTimeoutMs: timeoutMs,
  });
  request.local = { fallbackReads: Math.max(0, Math.floor(Number(fallbackReads) || 0)), exactTargetPreloaded };
  return await runNativeDispatch(request, {
    ...opts, mcpGate: toolMode ? mcpGate : null, projectDir: workingDir,
    dispatch: opts.dispatch || ((request, options) => dispatchLocalProvider(request, {
      ...options, manager, modelRoot: path.resolve(modelRoot), runtimeRoot: path.resolve(runtimeRoot),
    })),
  });
}

// Registered agents own their tool execution. Ask Rust for one validated
// decision, using the same local codec and usage accounting as provider turns.
export function supportsAgentTranscript() { return true; }
export async function callAgentTurn(promptText, options = {}) {
  const modelName = options.modelName || getModelTierConfig().model;
  const profile = LOCAL_MODEL_PROFILES[modelName];
  if (!profile) throw new Error(`Unsupported posse-local model: ${modelName}`);
  const modelRoot = options.modelRoot || defaultLocalGenerationModelRoot();
  const manager = options.manager || nativeBinaries;
  const readiness = isReady({ manager, modelRoot });
  if (!readiness.ready) throw new Error(readiness.reason);
  if (!fs.existsSync(path.join(modelRoot, profile.profileId, ".posse-model-package.json"))) throw new Error(`Local model ${modelName} is not installed`);
  const tools = (options.tools || []).map(tool => ({
    name: tool.name, description: tool.description || "",
    inputSchema: tool.parameters || tool.input_schema || tool.inputSchema || { type: "object", properties: {} },
  }));
  let instructions = buildLocalPlannerToolInstructions(tools.map(tool => ({ ...tool, parameters: tool.inputSchema })), null, {
    allowFileWrites: tools.some(tool => LOCAL_FILE_WRITE_TOOLS.has(tool.name)),
  });
  if (options.allowToolBatching === true) {
    instructions = instructions
      .replace("Call at most one tool per response.", "You may return a JSON array of up to 8 independent tool-call objects.")
      .replace("return exactly one JSON object and no explanatory text", "return one JSON object or a JSON array of independent calls, with no explanatory text");
  }
  const transcript = options.transcript?.length ? options.transcript : null;
  const request = buildNativeDispatchRequest("posse-local", transcript ? "" : promptText, {
    ...options, modelName, role: "preflight", reasoningEffort: "none", transcript,
    systemPrompt: [options.systemPrompt, instructions].filter(Boolean).join("\n\n"),
    maxTurns: 1, maxOutputTokens: Math.min(profile.maxOutputTokens, Number(options.maxOutputTokens) || profile.maxOutputTokens),
    stallTimeoutMs: options.timeoutMs || 15 * 60 * 1000, maxToolResultChars: profile.maxToolResultChars,
    issuedToolIds: tools.map(tool => tool.name), decision: { tools, allowBatching: options.allowToolBatching === true },
  });
  const result = await runNativeDispatch(request, {
    abortSignal: options.signal, silent: true,
    dispatch: options.dispatch || ((request, opts) => dispatchLocalProvider(request, {
      ...opts, manager, modelRoot, runtimeRoot: options.runtimeRoot || defaultLocalGenerationRuntimeRoot(),
    })),
  });
  return { ...result, toolCalls: result.stats.toolDecisions || [], providerContent: null };
}
