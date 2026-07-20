import { BaseProvider } from "../BaseProvider.js";

export class PosseLocalProvider extends BaseProvider {
  static name = "posse-local";
  static capabilities = Object.freeze({
    images: false,
    sessionResume: false,
    toolAttachment: "function",
    localGeneration: true,
  });

  constructor({ module } = {}) {
    super({ name: PosseLocalProvider.name, module });
  }

  isLocalGenerationEnabled(options = {}) {
    if (typeof this.module.isLocalGenerationEnabled === "function") {
      return this.module.isLocalGenerationEnabled(options);
    }
    return false;
  }
}
