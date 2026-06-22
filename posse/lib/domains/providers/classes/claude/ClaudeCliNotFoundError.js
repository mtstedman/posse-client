export class ClaudeCliNotFoundError extends Error {
  constructor() {
    super("Could not find 'claude' on PATH. Install: npm install -g @anthropic-ai/claude-code");
    this.name = "ClaudeCliNotFoundError";
    this.code = "CLAUDE_CLI_NOT_FOUND";
  }
}
