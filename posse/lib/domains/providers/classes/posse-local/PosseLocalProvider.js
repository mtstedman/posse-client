import { BaseProvider } from "../BaseProvider.js";

export class PosseLocalProvider extends BaseProvider {
  static name = "posse-local";
  static capabilities = Object.freeze({
    images: true,
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

  /** Whether a local image model can generate here: installed, on a supported platform. */
  isImageReady(options = {}) {
    if (typeof this.module.isImageReady === "function") return this.module.isImageReady(options);
    return { ready: false, reason: "local image generation is unavailable" };
  }
}
