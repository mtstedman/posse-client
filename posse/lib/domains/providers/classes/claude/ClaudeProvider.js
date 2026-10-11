import { BaseProvider } from "../BaseProvider.js";

export class ClaudeProvider extends BaseProvider {
  static name = "claude";
  static capabilities = Object.freeze({ images: false, sessionResume: true, toolAttachment: "mcp" });

  constructor({ module } = {}) {
    super({ name: ClaudeProvider.name, module });
    this.oauthPrimed = false;
    this.usageCache = null;
  }

  async warmOauthSessionAsync(opts = {}) {
    const result = await super.warmOauthSessionAsync(opts);
    if (result?.ok) this.oauthPrimed = true;
    return result;
  }
}
