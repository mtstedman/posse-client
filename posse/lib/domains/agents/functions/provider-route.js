import { getProvider, getProviderName } from "../../providers/functions/provider-selection.js";
import { getDefaultTierModel } from "../../providers/functions/model-catalog.js";

const PROVIDERS = new Set(["claude", "anthropic", "openai", "codex", "grok", "copilot", "posse-local"]);
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
  const provider = explicitProvider || (qualified && PROVIDERS.has(qualified[1].toLowerCase()) ? qualified[1].toLowerCase() : getProviderName("dev"));
  const requestedModel = qualified && PROVIDERS.has(qualified[1].toLowerCase()) ? qualified[2].trim() : value;
  const tier = MODEL_TIERS.get(requestedModel.toLowerCase());
  const modelName = tier ? getDefaultTierModel(provider, tier) : requestedModel;
  return { provider, modelName: !modelName || modelName === "auto" ? null : modelName };
}

export async function callAgentProvider(providerName, prompt, options = {}) {
  const provider = getProvider("dev", providerName);
  return await provider.callProvider(prompt, {
    role: "preflight",
    modelName: options.modelName || null,
    reasoningEffort: options.reasoningEffort || "medium",
    remoteSystemPrompt: options.systemPrompt || null,
    skipRolePrompt: true,
    silent: true,
    onLine: () => {},
    cwd: options.cwd || process.cwd(),
    maxTurns: 1,
    maxOutputTokens: options.maxOutputTokens || 8000,
    disableAtlas: true,
    disableSystemTools: true,
    disableAgentTools: true,
    nativeColdBoot: true,
  });
}
