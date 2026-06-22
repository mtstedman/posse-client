import { BaseProvider } from "../BaseProvider.js";

export class ClaudeProvider extends BaseProvider {
  static name = "claude";
  static capabilities = Object.freeze({ images: false, sessionResume: true });

  constructor({ module } = {}) {
    super({ name: ClaudeProvider.name, module });
    this.oauthPrimed = false;
    this.usageCache = null;
  }

  warmOauthSession(opts = {}) {
    const result = super.warmOauthSession(opts);
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        if (value?.ok) this.oauthPrimed = true;
        return value;
      });
    }
    if (result?.ok) this.oauthPrimed = true;
    return result;
  }

  async warmOauthSessionAsync(opts = {}) {
    const result = await super.warmOauthSessionAsync(opts);
    if (result?.ok) this.oauthPrimed = true;
    return result;
  }
}

