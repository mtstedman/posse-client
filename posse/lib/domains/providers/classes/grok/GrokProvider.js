import { BaseProvider } from "../BaseProvider.js";

export class GrokProvider extends BaseProvider {
  static name = "grok";
  static capabilities = Object.freeze({ images: true, sessionResume: false, toolAttachment: "function" });

  constructor({ module } = {}) {
    super({ name: GrokProvider.name, module });
  }
}
