import { BaseProvider } from "../BaseProvider.js";

export class OpenAIProvider extends BaseProvider {
  static name = "openai";
  static capabilities = Object.freeze({ images: true, sessionResume: true });

  constructor({ module } = {}) {
    super({ name: OpenAIProvider.name, module });
  }
}

