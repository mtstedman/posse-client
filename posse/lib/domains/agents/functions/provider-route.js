import { getProvider, getProviderName } from "../../providers/functions/provider-selection.js";
import { getDefaultTierModel } from "../../providers/functions/model-catalog.js";
import { PROVIDER_OPTIONS } from "../../../catalog/provider.js";
import { resolveLocalModelId } from "../../../catalog/local-model.js";
import { PROVIDER_CAPABILITIES } from "../../../catalog/provider-capabilities.js";

const PROVIDERS = new Set(PROVIDER_OPTIONS);
// "local" names the on-machine provider: alone it lets the provider choose its
// best installed model; "local:<slug or model id>" pins one.
const LOCAL_ALIAS = "local", LOCAL_PROVIDER = "posse-local";
const MODEL_TIERS = new Map([
  ["fable", "cheap"], ["haiku", "cheap"], ["cheap", "cheap"],
  ["sonnet", "standard"], ["standard", "standard"],
  ["opus", "strong"], ["best", "strong"], ["opusplan", "strong"], ["strong", "strong"],
]);

export function resolveAgentProvider(model, override = "") {
  const explicitProvider = String(override || "").trim().toLowerCase();
  if (explicitProvider && !PROVIDERS.has(explicitProvider)) throw Object.assign(new Error(`Unknown agent provider ${explicitProvider}`), { code: "invalid_request" });
  const value = String(model || "").trim();
  const qualified = /^([a-z][a-z0-9-]*)(?::|\/)(.+)$/i.exec(value);
  const prefix = qualified ? qualified[1].toLowerCase() : value.toLowerCase() === LOCAL_ALIAS ? LOCAL_ALIAS : "";
  const named = prefix === LOCAL_ALIAS ? LOCAL_PROVIDER : PROVIDERS.has(prefix) ? prefix : "";
  const provider = explicitProvider || named || getProviderName("dev");
  const requestedModel = !named ? value : qualified ? qualified[2].trim() : "";
  if (provider === LOCAL_PROVIDER && named === LOCAL_PROVIDER) {
    // No pinned model: the local provider picks from what is installed.
    if (!requestedModel) return { provider, modelName: null };
    const local = resolveLocalModelId(requestedModel);
    if (local) return { provider, modelName: local };
  }
  const tier = MODEL_TIERS.get(requestedModel.toLowerCase());
  const modelName = tier ? getDefaultTierModel(provider, tier) : requestedModel;
  return { provider, modelName: !modelName || modelName === "auto" ? null : modelName };
}

export function agentProviderUsesNativeTools(providerName) {
  return typeof getProvider("dev", providerName).callAgentTurn === "function";
}

/**
 * True when the provider writes its own model-facing tool instructions for a
 * decision turn. Its model emits tool calls as constrained JSON text, so the
 * API-provider wording ("never print a tool-call JSON object") must not be
 * sent alongside them.
 */
export function agentProviderSuppliesToolProtocol(providerName) {
  return PROVIDER_CAPABILITIES[providerName]?.localGeneration === true;
}

export async function callAgentProvider(providerName, prompt, options = {}) {
  const provider = getProvider("dev", providerName);
  // The native host sees provider activity (including thinking/status frames)
  // that does not become public output. Let its inactivity watchdog own this
  // request instead of timing silence in the aggregated response above it.
  options.onInactivityWatchdog?.();
  // An API provider whose native binary accepts transcripts takes the whole
  // conversation as native messages, with or without tools. Otherwise it
  // takes the flattened prompt, through a decision turn only when tools exist.
  const transcript = options.transcript?.length && provider.supportsAgentTranscript?.() ? options.transcript : null;
  if ((options.tools?.length || transcript) && typeof provider.callAgentTurn === "function") {
    return await provider.callAgentTurn(prompt, {
      modelName: options.modelName || null,
      systemPrompt: options.systemPrompt || null,
      tools: options.tools || [],
      transcript,
      reasoningEffort: options.reasoningEffort || (options.tools?.length ? "low" : "medium"),
      promptCache: options.promptCache === true,
      allowToolBatching: options.allowToolBatching === true,
      maxOutputTokens: options.maxOutputTokens || (options.tools?.length ? 2048 : 8000),
      signal: options.signal,
      stallTimeout: options.idleSeconds || 1800, wallTimeoutMs: 0,
      onActivity: options.onActivity,
      cwd: options.cwd || process.cwd(),
    });
  }
  return await provider.callProvider(prompt, {
    role: "preflight",
    modelName: options.modelName || null,
    reasoningEffort: options.reasoningEffort || "medium",
    remoteSystemPrompt: options.systemPrompt || null,
    skipRolePrompt: true,
    silent: true,
    onActivity: options.onActivity,
    onLine: () => options.onActivity?.(),
    onAgentCommentary: () => options.onActivity?.(),
    onUsageProgress: () => options.onActivity?.(),
    stallTimeout: options.idleSeconds || 1800, wallTimeoutMs: 0,
    cwd: options.cwd || process.cwd(),
    maxTurns: 1,
    maxOutputTokens: options.maxOutputTokens || 8000,
    promptCache: options.promptCache === true,
    disableAtlas: true,
    disableSystemTools: true,
    disableAgentTools: true,
    abortSignal: options.signal,
  });
}
