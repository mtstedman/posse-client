import { BaseProvider } from "../BaseProvider.js";

export class CodexProvider extends BaseProvider {
  static name = "codex";
  static capabilities = Object.freeze({ images: false, sessionResume: true, toolAttachment: "deterministic-bridge" });

  constructor({ module } = {}) {
    super({ name: CodexProvider.name, module });
  }
}
