import { extractJson as defaultExtractJson } from "../../../shared/format/functions/json.js";

import { classifyProviderError } from "../functions/helpers/api-resilience.js";

export class BaseProvider {
  static name = null;
  static modelTiers = {};
  static capabilities = Object.freeze({ sessionResume: false });

  constructor({
    name = null,
    module = null,
  } = {}) {
    if (this.constructor === BaseProvider) {
      throw new Error("BaseProvider is abstract; instantiate a concrete provider class");
    }
    this.name = name || this.constructor.name?.replace(/Provider$/, "").toLowerCase() || null;
    this.module = module || {};
    this.call = this.call.bind(this);
    this.callProvider = this.callProvider.bind(this);
  }

  get MODEL_TIERS() {
    return this.module.MODEL_TIERS || this.constructor.modelTiers || {};
  }

  get modelTiers() {
    return this.MODEL_TIERS;
  }

  get capabilities() {
    return this.module.capabilities || this.constructor.capabilities || {};
  }

  get C() {
    return this.module.C;
  }

  get ask() {
    return this.module.ask;
  }

  get askMultiline() {
    return this.module.askMultiline;
  }

  getModelTierConfig(tier = "standard") {
    if (typeof this.module.getModelTierConfig === "function") {
      return this.module.getModelTierConfig(tier);
    }
    const key = tier in this.MODEL_TIERS ? tier : "standard";
    return this.MODEL_TIERS[key] || this.MODEL_TIERS.standard || {};
  }

  hasCapability(name) {
    return Boolean(this.capabilities?.[name]);
  }

  escalateTier(currentTier, attemptCount, options = {}) {
    if (typeof this.module.escalateTier === "function") {
      return this.module.escalateTier(currentTier, attemptCount, options);
    }
    return currentTier;
  }

  async call(promptText, opts = {}) {
    return await this.callProvider(promptText, opts);
  }

  async callProvider(promptText, opts = {}) {
    if (typeof this.module.callProvider !== "function") {
      throw new Error(`Provider "${this.name}" does not implement callProvider()`);
    }
    return await this.module.callProvider(promptText, opts);
  }

  parseErrorBackoff(err) {
    if (typeof this.module.parseErrorBackoff === "function") {
      return this.module.parseErrorBackoff(err);
    }
    return classifyProviderError(err, { defaultBackoffSec: 15 });
  }

  getRateLimitState() {
    if (typeof this.module.getRateLimitState === "function") {
      return this.module.getRateLimitState();
    }
    return { blocked: false, retryInSec: 0, reason: "" };
  }

  tripRateLimit(backoffSec, reason = "") {
    if (typeof this.module.tripRateLimit === "function") {
      return this.module.tripRateLimit(backoffSec, reason);
    }
  }

  hasCredentials() {
    if (typeof this.module.hasCredentials === "function") {
      return this.module.hasCredentials();
    }
    return true;
  }

  // Env-var names the provider needs to authenticate. Empty array means the
  // provider does not use env-var credentials (e.g. CLI-managed auth like
  // claude, OAuth like codex). Used by isProviderReady() to produce a
  // consistent "<VAR> not set" error message without per-provider branches.
  getCredentialEnvVars() {
    if (typeof this.module.getCredentialEnvVars === "function") {
      return this.module.getCredentialEnvVars();
    }
    return [];
  }

  // How this provider exposes ATLAS/deterministic tools to the model. Used by
  // tool-descriptors.js to render the right contract line without
  // `if (provider === "...")` branches. Values:
  //   "mcp"                  — tools attached via MCP server config
  //   "function"             — tools embedded as function/tool definitions
  //   "deterministic-bridge" — tools surfaced via Posse's gateway bridge
  //   null                   — not supported
  getToolAttachmentMode() {
    if (typeof this.module.getToolAttachmentMode === "function") {
      return this.module.getToolAttachmentMode();
    }
    return this.capabilities?.toolAttachment || null;
  }

  // Construct a provider-specific image-generation client (currently an
  // OpenAI-shaped client, since both openai and grok use that SDK). Throws
  // if the provider does not support images or is missing credentials.
  buildImageClient(opts = {}) {
    if (typeof this.module.buildImageClient === "function") {
      return this.module.buildImageClient(opts);
    }
    throw new Error(`Provider "${this.name}" does not implement buildImageClient()`);
  }

  isReady() {
    if (typeof this.module.isReady === "function") {
      return this.module.isReady();
    }
    return { ready: true, reason: null };
  }

  getClaudeInfo() {
    if (typeof this.module.getClaudeInfo === "function") {
      return this.module.getClaudeInfo();
    }
    return { available: false, version: null, path: null };
  }

  extractJson(text) {
    if (typeof this.module.extractJson === "function") {
      return this.module.extractJson(text);
    }
    return defaultExtractJson(text);
  }

  getUsageSummary(opts = {}) {
    if (typeof this.module.getUsageSummary === "function") {
      return this.module.getUsageSummary(opts);
    }
    return null;
  }

  async refreshUsageSummary(opts = {}) {
    if (typeof this.module.refreshUsageSummary === "function") {
      return await this.module.refreshUsageSummary(opts);
    }
    return this.getUsageSummary(opts);
  }

  warmOauthSession(opts = {}) {
    if (typeof this.module.warmOauthSession === "function") {
      return this.module.warmOauthSession(opts);
    }
    return { attempted: false, ok: true, skipped: "not-supported" };
  }

  async warmOauthSessionAsync(opts = {}) {
    if (typeof this.module.warmOauthSessionAsync === "function") {
      return await this.module.warmOauthSessionAsync(opts);
    }
    return this.warmOauthSession(opts);
  }
}
