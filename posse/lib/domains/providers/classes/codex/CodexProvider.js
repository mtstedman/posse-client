import { BaseProvider } from "../BaseProvider.js";
import { MCP_TOOL_DEADLINE_MODES } from "../../../../catalog/provider.js";

export class CodexProvider extends BaseProvider {
  static name = "codex";
  static capabilities = Object.freeze({ images: false, sessionResume: true, toolAttachment: "deterministic-bridge", mcpToolDeadline: MCP_TOOL_DEADLINE_MODES.SERVER_CONFIG });

  constructor({ module } = {}) {
    super({ name: CodexProvider.name, module });
  }
}
