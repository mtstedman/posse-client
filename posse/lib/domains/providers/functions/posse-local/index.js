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

function explicitExactEditIntent(promptText, targetPath) {
  if (!targetPath) return null;
  const prompt = String(promptText || "");
  const pattern = /\breplace\s+(?:the\s+)?exact\s+(?:paragraph\s+)?text\s+(["'`])([^\r\n]{1,2000}?)\1\s+with\s+(["'`])([^\r\n]{1,2000}?)\3/gi;
  const replacements = new Map();
  for (const match of prompt.matchAll(pattern)) {
    const oldString = String(match[2] || "");
    const newString = String(match[4] || "");
    if (!oldString || !newString || oldString === newString) continue;
    replacements.set(JSON.stringify([oldString, newString]), { oldString, newString });
  }
  if (replacements.size !== 1) return null;
  const replacement = [...replacements.values()][0];
  return {
    name: "edit_file",
    arguments: {
      path: targetPath,
      old_string: replacement.oldString,
      new_string: replacement.newString,
    },
  };
}

function repairNoopExactEditCall(call, exactIntent) {
  if (!exactIntent || call?.name !== "edit_file") return call;
  const args = call?.arguments;
  if (normalizedScopedPath(args?.path) !== exactIntent.arguments.path) return call;
  if (typeof args?.old_string !== "string" || typeof args?.new_string !== "string") return call;
  if (args.old_string !== args.new_string) return call;
  return exactIntent;
}

function repairModelNativeFullFileEditCall(call, targetPath, exactSource) {
  if (!targetPath || call?.name !== "edit_file") return call;
  const args = call?.arguments;
  if (!args || typeof args.content !== "string") return call;
  if (args.path != null && normalizedScopedPath(args.path) !== targetPath) return call;
  if (typeof exactSource !== "string") {
    return {
      name: "read_file",
      arguments: { path: targetPath },
    };
  }
  const sourceHasTrailingNewline = /\r?\n$/.test(exactSource);
  const sourceLineCount = exactSource.split(/\r?\n/).length - (sourceHasTrailingNewline ? 1 : 0);
  const lineDecodedContent = !args.content.includes("\n") && /\\[nr]/.test(args.content)
    ? args.content
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
    : args.content;
  // Local models sometimes escape source delimiters as if a single-quoted
  // string were nested inside JSON. Decode only quote escapes that sit at a
  // source-token boundary; preserve apostrophes/quotes embedded in literals.
  const decodedContent = lineDecodedContent
    .replace(/(^|[\s(=,:;])\\'/gm, "$1'")
    .replace(/\\'(?=[\s),.;}\]])/g, "'")
    .replace(/(^|[\s(=,:;])\\"/gm, '$1"')
    .replace(/\\"(?=[\s),.;}\]])/g, '"');
  const sourceExtension = path.extname(targetPath).toLowerCase();
  const sourceContent = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx"]).has(sourceExtension)
    ? decodedContent.replace(
      /\/((?:\\.|[^/\r\n])+)\/([dgimsuvy]*)/g,
      (_literal, body, flags) => `/${String(body).replace(/\\\\(?=[bBdDsSwW])/g, "\\")}/${flags}`,
    )
    : decodedContent;
  const replacement = sourceHasTrailingNewline && !/\r?\n$/.test(sourceContent)
    ? `${sourceContent}\n`
    : sourceContent;
  return {
    name: "edit_file",
    arguments: {
      path: targetPath,
      replaceLines: {
        start: 0,
        end: sourceLineCount,
        content: replacement,
      },
    },
  };
}

function normalizeJavascriptRegexEscapes(value, targetPath) {
  if (typeof value !== "string") return value;
  const sourceExtension = path.extname(targetPath).toLowerCase();
  if (!new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx"]).has(sourceExtension)) {
    return value;
  }
  return value.replace(
    /\/((?:\\.|[^/\r\n])+)\/([dgimsuvy]*)/g,
    (_literal, body, flags) => `/${String(body).replace(/\\\\(?=[bBdDsSwW])/g, "\\")}/${flags}`,
  );
}

function repairModelNativeExactEditCall(call, targetPath, exactSource) {
  if (!targetPath || call?.name !== "edit_file" || typeof exactSource !== "string") return call;
  const args = call?.arguments;
  if (!args || typeof args.old_string !== "string" || typeof args.new_string !== "string") return call;
  if (args.path != null && normalizedScopedPath(args.path) !== targetPath) return call;
  const normalizedOld = normalizeJavascriptRegexEscapes(args.old_string, targetPath);
  const normalizedNew = normalizeJavascriptRegexEscapes(args.new_string, targetPath);
  const candidates = [...new Set([
    normalizedOld,
    normalizedOld.trim(),
  ].filter(Boolean))];
  const exactOld = candidates.find((candidate) => exactSource.includes(candidate));
  if (!exactOld) return {
    ...call,
    arguments: { ...args, new_string: normalizedNew },
  };
  return {
    ...call,
    arguments: {
      ...args,
      path: targetPath,
      old_string: exactOld,
      new_string: normalizedNew,
    },
  };
}

function exactEditRecoveryHint(name, result, targetPath, exactSource) {
  if (name !== "edit_file" || typeof exactSource !== "string") return null;
  const content = typeof result === "string" ? result : JSON.stringify(result ?? null);
  if (!/old_string not found|made no changes|POSSE_LOCAL_LITERAL_CONSTRAINT/i.test(content)) return null;
  return [
    `EXACT EDIT RECOVERY: ${targetPath} is already loaded. Do not guess another old_string.`,
    "Return the full corrected file through this exact adapter envelope:",
    '{"tool":"edit_file","content":"FULL CORRECTED FILE CONTENT"}',
    "The content must implement every literal constraint from the original task and assessor feedback while preserving unrelated source.",
  ].join("\n");
}

function isRecoverableExactEditFailure(name, result, targetPath, exactSource) {
  if (name !== "edit_file" || !targetPath || typeof exactSource !== "string") return false;
  const content = typeof result === "string" ? result : JSON.stringify(result ?? null);
  return /old_string not found|made no changes|POSSE_LOCAL_LITERAL_CONSTRAINT/i.test(content);
}

function localLiteralConstraintExpansion(promptText) {
  const prompt = String(promptText || "");
  const rules = [];
  if (/lowercase(?:\s+only)?\s+ASCII|lowercase\s+ASCII\s+letters?/i.test(prompt)) {
    rules.push([
      "ASCII-only lowercasing: do not call toLowerCase() on the whole value.",
      "Use value.replace(/[A-Z]/g, (character) => character.toLowerCase()) so non-ASCII characters stay unchanged.",
    ].join(" "));
  }
  if (/(?:runs?\s+of\s+)?spaces?\s+(?:or|and)\s+underscores?/i.test(prompt)) {
    rules.push([
      "Literal space/underscore separators: use /[ _]+/g for the inner separator run.",
      "Do not use \\s there; edge whitespace trimming is a separate trim() operation.",
    ].join(" "));
  }
  if (/remove\s+leading\s*(?:\/|and)\s*trailing\s+hyphens?/i.test(prompt)) {
    rules.push("Hyphen removal: replace the leading/trailing hyphen regex with the empty string '', never with another hyphen.");
  }
  if (rules.length === 0) return null;
  return [
    "LOCAL LITERAL CONSTRAINT EXPANSION (mechanically derived from the task):",
    ...rules.map((rule) => `- ${rule}`),
    "Apply these category-preserving recipes to the loaded source; they are required behavior, not optional examples.",
  ].join("\n");
}

function localMutationText(args) {
  if (typeof args?.new_string === "string") return args.new_string;
  if (typeof args?.content === "string") return args.content;
  if (typeof args?.replaceLines?.content === "string") return args.replaceLines.content;
  return null;
}

function repairLocalLiteralConstraintText(promptText, content) {
  const prompt = String(promptText || "");
  let repaired = String(content || "");
  if (/lowercase(?:\s+only)?\s+ASCII|lowercase\s+ASCII\s+letters?/i.test(prompt)
    && /\.toLowerCase\(\)/.test(repaired)
    && !/\[A-Z\]/.test(repaired)) {
    repaired = repaired.replace(
      /\.toLowerCase\(\)/g,
      ".replace(/[A-Z]/g, (character) => character.toLowerCase())",
    );
  }
  if (/(?:runs?\s+of\s+)?spaces?\s+(?:or|and)\s+underscores?/i.test(prompt)) {
    repaired = repaired
      .replace(/\/\\s\+\|_\+?\/g/g, "/[ _]+/g")
      .replace(/\/_\+?\|\\s\+\/g/g, "/[ _]+/g");
  }
  if (/remove\s+leading\s*(?:\/|and)\s*trailing\s+hyphens?/i.test(prompt)) {
    repaired = repaired.replace(
      /(\.replace\(\/\^-\+\|-\+\$\/g,\s*)(["'])-\2(\))/g,
      "$1$2$2$3",
    );
  }
  return repaired;
}

function repairLocalLiteralConstraintCall(call, promptText) {
  if (call?.name !== "edit_file") return call;
  const args = call?.arguments;
  const content = localMutationText(args);
  if (!args || content == null) return call;
  const repaired = repairLocalLiteralConstraintText(promptText, content);
  if (repaired === content) return call;
  if (typeof args.new_string === "string") {
    return { ...call, arguments: { ...args, new_string: repaired } };
  }
  if (typeof args.content === "string") {
    return { ...call, arguments: { ...args, content: repaired } };
  }
  return {
    ...call,
    arguments: {
      ...args,
      replaceLines: { ...args.replaceLines, content: repaired },
    },
  };
}

function localLiteralConstraintViolation(promptText, args) {
  const prompt = String(promptText || "");
  const content = localMutationText(args);
  if (typeof content !== "string") return null;
  const violations = [];
  if (/lowercase(?:\s+only)?\s+ASCII|lowercase\s+ASCII\s+letters?/i.test(prompt)
    && /\.toLowerCase\(\)/.test(content)
    && !/\[A-Z\]/.test(content)) {
    violations.push("whole-value toLowerCase() widens ASCII-only lowercasing; use an explicit [A-Z] replacement callback");
  }
  if (/(?:runs?\s+of\s+)?spaces?\s+(?:or|and)\s+underscores?/i.test(prompt)
    && /\\s/.test(content)
    && !/\[ _\]\+/.test(content)) {
    violations.push("\\s widens the requested literal space/underscore separator class; use /[ _]+/g");
  }
  if (/remove\s+leading\s*(?:\/|and)\s*trailing\s+hyphens?/i.test(prompt)
    && /\.replace\(\/\^-\+\|-\+\$\/g,\s*(["'])-\1\)/.test(content)) {
    violations.push("leading/trailing hyphens must be replaced with the empty string, not another hyphen");
  }
  if (violations.length === 0) return null;
  return `Error: POSSE_LOCAL_LITERAL_CONSTRAINT: ${violations.join("; ")}. No file mutation ran. Apply the literal constraint expansion and retry with the full corrected file.`;
}

function toolResultFailed(result) {
  return result?.isError === true
    || result?.ok === false
    || /^Error:/i.test(String(result || "").trim());
}

function structuredReadContent(result) {
  if (result && typeof result === "object" && typeof result.content === "string") {
    return result.content;
  }
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" && typeof parsed.content === "string"
      ? parsed.content
      : null;
  } catch {
    return null;
  }
}

function validLocalRoleOutput(role, content) {
  const text = String(content || "").trim();
  const label = role === "artificer" ? "ARTIFICER RESULT" : "DEV RESULT";
  const statuses = role === "artificer"
    ? "COMPLETE|PARTIAL|BLOCKED"
    : "COMPLETE|VERIFIED_NO_CHANGE|PARTIAL|BLOCKED";
  const exact = text.match(new RegExp(
    `^---\\s*${label} START\\s*---\\s*([\\s\\S]*?)\\s*---\\s*${label} END\\s*---$`,
    "i",
  ));
  if (exact && new RegExp(`^\\s*status:\\s*(?:${statuses})\\s*$`, "im").test(exact[1])) return true;
  // Preserve the compact legacy response accepted by existing direct provider
  // callers. Worker execution still materializes/enforces the canonical block.
  return new RegExp(`^${label}:\\s*(?:${statuses})$`, "i").test(text);
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
    _subAgentChild = false,
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
  const executionRole = _subAgentChild === true ? "subagent" : role;
  const toolRoleEligible = _subAgentChild === true
    || (role === "planner" && !allowWrite)
    || (LOCAL_FILE_WRITE_ROLES.has(role) && fileWriteAuthorized);
  const toolEligible = toolRoleEligible
    && LOCAL_MODEL_IDS.includes(selected)
    && typeof mcpGate?.callTool === "function"
    && issuedToolSurface.length > 0;
  const executionContract = toolEligible
    ? buildExecutionContract({
      provider: "posse-local",
      role: executionRole,
      allowWrite,
      issuedToolSurface,
      agentHandoffCompactV1: _remoteIssuedPolicy?.coordination?.agentHandoffCompactV1 === true,
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
  const exactEditIntent = exactWriteTarget && !exactCreateTarget
    ? explicitExactEditIntent(promptText, exactWriteTarget)
    : null;
  const exactTargetPreloaded = !!(
    exactWriteTarget
    && String(stableContext || "").includes("PRELOADED EDITABLE FILE CONTEXT:")
    && String(stableContext || "").includes(`=== ${exactWriteTarget}`)
  );
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
    })
    .sort((left, right) => {
      if (!fileWriteAuthorized) return 0;
      const priority = (tool) => LOCAL_FILE_WRITE_TOOLS.has(String(tool?.name || "")) ? 0 : 1;
      return priority(left) - priority(right);
    });
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
    remoteSystemPrompt,
    stableContext,
    localLiteralConstraintExpansion(promptText),
    toolInstructions,
  ]
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
  try {
    if (toolMode) {
      let readCount = 0;
      let successfulExactRead = exactTargetPreloaded;
      let successfulMutation = false;
      let recoverableExactEditFailure = false;
      let exactSourceContent = null;
      const maxReads = Math.max(0, Number(fallbackReads) || 0);
      const loop = await runLocalPlannerToolLoop({
      messages,
      tools: toolDefinitions,
      turnLimit: localLoopTurnLimit,
      formatResult: (name, result) => {
        const formatted = selected === GEMMA_LOCAL_MODEL_ID
          ? formatGemmaLocalToolResult(name, result, profile.maxToolResultChars)
          : formatLocalToolResult(name, result, profile.maxToolResultChars);
        if (!terminalHandoffIssued) return formatted;
        const recoveryHint = exactEditRecoveryHint(
          name,
          result,
          exactWriteTarget,
          exactSourceContent,
        );
        recoverableExactEditFailure = isRecoverableExactEditFailure(
          name,
          result,
          exactWriteTarget,
          exactSourceContent,
        ) || (recoverableExactEditFailure && !successfulMutation);
        const nextAction = requireMutationBeforeFinal && !successfulMutation
          ? recoverableExactEditFailure
            ? 'NEXT ACTION REQUIRED: The prior edit failure is recoverable. Return {"tool":"edit_file","content":"FULL CORRECTED FILE CONTENT"} now. Do not return prose or agent_handoff.'
            : "NEXT ACTION REQUIRED: No file mutation has succeeded. Return exactly one edit_file or write_file JSON call now using the exact source above. Do not return prose and do not call agent_handoff yet."
          : name === "agent_handoff" && !toolResultFailed(result)
            ? "The terminal handoff is staged. Wait for its receipt; do not call another tool or return prose."
            : "NEXT ACTION REQUIRED: Return exactly one agent_handoff JSON call now. Do not return prose or a role-result block.";
        return [formatted, recoveryHint, nextAction].filter(Boolean).join("\n");
      },
      normalizeCall: exactWriteTarget
        ? (call) => {
          const fullFileRepaired = repairModelNativeFullFileEditCall(
            call,
            exactWriteTarget,
            exactSourceContent,
          );
          const exactEditRepaired = repairModelNativeExactEditCall(
            fullFileRepaired,
            exactWriteTarget,
            exactSourceContent,
          );
          const literalConstraintRepaired = repairLocalLiteralConstraintCall(
            exactEditRepaired,
            promptText,
          );
          const repaired = exactEditIntent
            ? repairNoopExactEditCall(literalConstraintRepaired, exactEditIntent)
            : literalConstraintRepaired;
          const mutationBeforeRead = !exactCreateTarget
            && !exactTargetPreloaded
            && readCount === 0
            && maxReads > 0
            && toolDefinitions.some((tool) => String(tool?.name || "") === "read_file")
            && LOCAL_FILE_WRITE_TOOLS.has(String(repaired?.name || ""))
            && normalizedScopedPath(repaired?.arguments?.path) === exactWriteTarget;
          if (mutationBeforeRead) {
            return {
              name: "read_file",
              arguments: { path: exactWriteTarget },
            };
          }
          return repaired;
        }
        : null,
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
      missingContextCall: LOCAL_FILE_WRITE_ROLES.has(role)
        && exactWriteTarget
        && maxReads > 0
        && toolDefinitions.some((tool) => String(tool?.name || "") === "read_file")
        ? { name: "read_file", arguments: { path: exactWriteTarget } }
        : null,
      requiredFinalTool: terminalHandoffIssued ? "agent_handoff" : null,
      requireMutationBeforeFinal,
      validateFinalOutput: role === "planner"
        ? validLocalPlannerOutput
        : LOCAL_FILE_WRITE_ROLES.has(role) && !terminalHandoffIssued
          ? (output) => validLocalRoleOutput(role, output)
          : null,
      generate,
      execute: async (name, args) => {
        if (
          name === "agent_handoff"
          && fileWriteAuthorized
          && exactWriteTarget
          && !successfulMutation
        ) {
          const status = String(args?.status || "COMPLETE").trim().toUpperCase();
          const blocker = String(args?.blocker || "").trim();
          if (
            status === "BLOCKED"
            && successfulExactRead
            && /\b(?:missing|unavailable|cannot access|can't access)\b[\s\S]*\b(?:context|source|file)\b/i.test(blocker)
          ) {
            return `Error: ${exactWriteTarget} was read successfully and its raw source is present in the prior tool result. Do not report missing context; use edit_file with an exact old_string copied from that content.`;
          }
          if (status === "BLOCKED" && successfulExactRead && recoverableExactEditFailure) {
            return `Error: The rejected edit is recoverable and ${exactWriteTarget} is fully loaded. Do not finish BLOCKED. Return {"tool":"edit_file","content":"FULL CORRECTED FILE CONTENT"} with every task and assessor constraint applied.`;
          }
          if (!new Set(["BLOCKED", "VERIFIED_NO_CHANGE"]).has(status)) {
            return "Error: A successful file mutation is required before COMPLETE or PARTIAL agent_handoff. The prior read_file result contains raw exact source; context is not missing. Use the authorized edit_file or write_file tool now, then submit agent_handoff.";
          }
        }
        let callArgs = args;
        if (LOCAL_FILE_WRITE_TOOLS.has(name)
          && normalizedScopedPath(args?.path) === exactWriteTarget) {
          const constraintError = localLiteralConstraintViolation(promptText, args);
          if (constraintError) return constraintError;
        }
        if (name === "read_file") {
          readCount += 1;
          if (readCount > maxReads) {
            return `Error: Fallback read budget exhausted (max ${maxReads}). Use the supplied context or another authorized retrieval tool.`;
          }
          if (args.maxBytes == null && args.search == null && args.jsonPath == null) {
            callArgs = {
              ...args,
              // Structured read mode includes raw content separately from its
              // display-only numbered view. Reserve space for result metadata.
              maxBytes: Math.max(1, profile.maxToolResultChars - 768),
            };
          }
        }
        const result = await mcpGate.callTool(name, callArgs);
        if (
          name === "read_file"
          && normalizedScopedPath(callArgs?.path) === exactWriteTarget
          && !toolResultFailed(result)
        ) {
          successfulExactRead = true;
          exactSourceContent = structuredReadContent(result) ?? exactSourceContent;
        }
        if (LOCAL_FILE_WRITE_TOOLS.has(name) && !toolResultFailed(result)) {
          successfulMutation = true;
          recoverableExactEditFailure = false;
        }
        return result;
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
  } catch (error) {
    const usage = nativeResults.reduce((totals, result) => ({
      inputTokens: totals.inputTokens + (Number(result?.usage?.inputTokens) || 0),
      outputTokens: totals.outputTokens + (Number(result?.usage?.outputTokens) || 0),
    }), { inputTokens: 0, outputTokens: 0 });
    if (!error.stats) {
      error.stats = {
        durationMs: Date.now() - started,
        outputChars: 0,
        promptChars: user.length,
        exitCode: 1,
        modelName: selected,
        inputTokens: usage.inputTokens || null,
        outputTokens: usage.outputTokens || null,
        role,
        modelTier,
        reasoningEffort: "disabled",
        maxTurns: toolMode ? localLoopTurnLimit : 1,
        maxOutputTokens: outputLimit,
        numTurns: toolTurns,
        toolUses,
        costUsd: 0,
      };
    }
    throw error;
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
      maxTurns: toolMode ? localLoopTurnLimit : 1,
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
