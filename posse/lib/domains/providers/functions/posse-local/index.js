// @ts-check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ML_GENERATE_METHOD } from "../../../../catalog/binary.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import { runMlNativeMethodAsync } from "../../../../shared/native/functions/ml-invoke.js";
import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";
import { extractJson } from "../../../../shared/format/functions/json.js";
import { isProviderEnabledByCatalog } from "../model-catalog-store.js";
import { getProviderTierDefaults } from "../model-catalog.js";
import { selectExecutionModel } from "../shared/model-selection.js";

export { extractJson };

export const QWEN_LOCAL_MODEL_ID = "qwen2.5-coder-3b-instruct";
export const GEMMA_LOCAL_MODEL_ID = "gemma-2-2b-it";
export const LOCAL_MODEL_IDS = Object.freeze([QWEN_LOCAL_MODEL_ID, GEMMA_LOCAL_MODEL_ID]);

export const capabilities = Object.freeze({
  images: false,
  sessionResume: false,
  toolAttachment: null,
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
  const selected = getModelTierConfig("standard").model;
  const installedDirectory = path.join(path.resolve(modelRoot), `${selected}-int4-cpu`);
  if (!fs.existsSync(path.join(installedDirectory, ".posse-model-package.json"))) {
    const shorthand = selected === QWEN_LOCAL_MODEL_ID ? "qwen-code" : "gemma-it";
    return {
      ready: false,
      reason: `local model ${selected} is not installed; run: posse local-models download ${shorthand}`,
    };
  }
  return { ready: true, reason: null };
}

export function getClaudeInfo() {
  return { cmd: "posse-ml", args: [ML_GENERATE_METHOD] };
}

export function escalateTier(currentTier, attemptCount) {
  if (attemptCount <= 0) return currentTier;
  return currentTier === "cheap" ? "standard" : "strong";
}

export async function callProvider(promptText, opts = {}) {
  const {
    role = "planner",
    modelTier = "standard",
    modelName = null,
    maxOutputTokens = null,
    remoteSystemPrompt = null,
    stableContext = null,
    allowWrite = false,
    projectDbWrite = false,
    needsImageGeneration = false,
    priorSessionHandle = null,
    onLine = null,
    abortSignal = null,
    recordFinalPrompt = null,
    manager = nativeBinaries,
    modelRoot = defaultLocalGenerationModelRoot(),
    runtimeRoot = defaultLocalGenerationRuntimeRoot(),
    timeoutMs = 15 * 60 * 1000,
  } = opts || {};

  if (allowWrite || projectDbWrite || needsImageGeneration) {
    const error = new Error("The local Qwen/Gemma provider is prompt-only and cannot run tools, modify files, query project databases, or generate images.");
    error.code = "POSSE_LOCAL_TOOLS_UNSUPPORTED";
    throw error;
  }
  const readiness = isReady({ manager, modelRoot });
  if (!readiness.ready) {
    const error = new Error(readiness.reason || "The local text-generation provider is unavailable.");
    error.code = "POSSE_LOCAL_NOT_READY";
    throw error;
  }
  if (priorSessionHandle) {
    const error = new Error("The local Qwen/Gemma provider does not support session resume.");
    error.code = "POSSE_LOCAL_SESSION_RESUME_UNSUPPORTED";
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
    error.code = "POSSE_LOCAL_MODEL_UNSUPPORTED";
    throw error;
  }
  const installedDirectory = path.join(path.resolve(modelRoot), `${selected}-int4-cpu`);
  if (!fs.existsSync(path.join(installedDirectory, ".posse-model-package.json"))) {
    const shorthand = selected === QWEN_LOCAL_MODEL_ID ? "qwen-code" : "gemma-it";
    const error = new Error(`Local model ${selected} is not installed. Run: posse local-models download ${shorthand}`);
    error.code = "POSSE_LOCAL_MODEL_NOT_INSTALLED";
    throw error;
  }

  const system = [remoteSystemPrompt, stableContext]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const user = String(promptText || "");
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: user },
  ];
  recordFinalPrompt?.(user, { systemPrompt: system || null, systemPromptFiles: [] });
  const outputLimit = Math.max(1, Math.min(4096, Number(maxOutputTokens) || 512));
  let lineBuffer = "";
  const started = Date.now();
  const result = await runMlNativeMethodAsync(ML_GENERATE_METHOD, {
    modelId: selected,
    messages,
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
      if (event?.kind !== "ml.generation.delta" || typeof event.delta !== "string") return;
      lineBuffer += event.delta;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";
      for (const line of lines) onLine?.(line);
    },
  });
  if (lineBuffer) onLine?.(lineBuffer);
  const content = String(result?.content || "").trim();
  const usage = result?.usage || {};
  return {
    output: content,
    stats: {
      durationMs: Number(result?.timing?.totalMs) || (Date.now() - started),
      outputChars: content.length,
      promptChars: user.length,
      exitCode: 0,
      modelName: selected,
      responseId: null,
      sessionHandle: null,
      priorSessionHandle: null,
      sessionExpired: false,
      inputTokens: Number(usage.inputTokens) || null,
      outputTokens: Number(usage.outputTokens) || null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
      longContextInputTokens: Number(usage.inputTokens) || null,
      role,
      modelTier,
      reasoningEffort: "disabled",
      maxTurns: 1,
      maxOutputTokens: outputLimit,
      outputTruncated: result?.finishReason === "length",
      outputLimitReason: result?.finishReason === "length" ? "max_output_tokens" : null,
      numTurns: 0,
      toolUses: null,
      toolUsesLoggedByToolkit: false,
      atlasMethod: null,
      localProfileId: result?.profileId || null,
      coldStart: result?.timing?.coldStart === true,
      costUsd: 0,
    },
  };
}
