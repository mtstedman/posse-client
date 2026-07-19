// lib/provider/provider-registry.js
//
// Registry for provider instances and provider-selection cursors.

import { BaseProvider } from "./BaseProvider.js";
import { ClaudeProvider } from "./claude/ClaudeProvider.js";
import { CodexProvider } from "./codex/CodexProvider.js";
import { OpenAIProvider } from "./openai/OpenAIProvider.js";
import { GrokProvider } from "./grok/GrokProvider.js";
import { CopilotProvider } from "./copilot/CopilotProvider.js";
import { PosseLocalProvider } from "./posse-local/PosseLocalProvider.js";

const PROVIDER_CLASS_BY_NAME = Object.freeze({
  claude: ClaudeProvider,
  codex: CodexProvider,
  openai: OpenAIProvider,
  grok: GrokProvider,
  copilot: CopilotProvider,
  "posse-local": PosseLocalProvider,
});

export class ProviderRegistry {
  constructor({ aliases = {} } = {}) {
    this.aliases = aliases;
    this.providers = new Map();
    this.loadErrors = new Map();
    // Narrow process-local routing cursor cache for provider and image round-robin.
    this.roleSelectionCursor = new Map();
  }

  canonicalName(providerName) {
    const normalized = String(providerName || "").trim().toLowerCase();
    return this.aliases[normalized] || normalized;
  }

  register(name, modOrProvider) {
    const canonical = this.canonicalName(name);
    const ProviderClass = PROVIDER_CLASS_BY_NAME[canonical] || null;
    if (!ProviderClass && !(modOrProvider instanceof BaseProvider)) {
      throw new Error(`Unsupported provider "${canonical}"; add a BaseProvider subclass before registration`);
    }
    const provider = modOrProvider instanceof BaseProvider
      ? modOrProvider
      : new ProviderClass({ module: modOrProvider });
    this.providers.set(canonical, provider);
    this.loadErrors.delete(canonical);
    return provider;
  }

  setLoadError(name, err) {
    this.loadErrors.set(this.canonicalName(name), err);
  }

  getLoadError(name) {
    return this.loadErrors.get(this.canonicalName(name)) || null;
  }

  has(name) {
    return this.providers.has(this.canonicalName(name));
  }

  get(name) {
    return this.providers.get(this.canonicalName(name)) || null;
  }

  cursorNext(key) {
    const cursor = this.roleSelectionCursor.get(key) || 0;
    this.roleSelectionCursor.set(key, cursor + 1);
    return cursor;
  }

  resetSelectionCursor() {
    this.roleSelectionCursor.clear();
  }
}
