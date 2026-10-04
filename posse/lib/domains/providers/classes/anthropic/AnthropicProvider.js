import { BaseProvider } from "../BaseProvider.js";

export class AnthropicProvider extends BaseProvider {
  static name = "anthropic";
  static capabilities = Object.freeze({ sessionResume: false, toolAttachment: "function" });

  constructor({ module } = {}) {
    super({ name: AnthropicProvider.name, module });
  }
}
