import { BaseProvider } from "../BaseProvider.js";

export class PosseLocalProvider extends BaseProvider {
  static name = "posse-local";
  static capabilities = Object.freeze({
    images: false,
    sessionResume: false,
    toolAttachment: null,
    localGeneration: true,
  });

  constructor({ module } = {}) {
    super({ name: PosseLocalProvider.name, module });
  }
}
