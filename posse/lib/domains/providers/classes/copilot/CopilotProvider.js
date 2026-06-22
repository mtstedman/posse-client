import { BaseProvider } from "../BaseProvider.js";

export class CopilotProvider extends BaseProvider {
  static name = "copilot";
  // sessionResume: unknown until Phase 0 probe confirms. Default false
  // (safer — forces a fresh call each turn) and lift once verified.
  static capabilities = Object.freeze({ images: false, sessionResume: false });

  constructor({ module } = {}) {
    super({ name: CopilotProvider.name, module });
  }
}
