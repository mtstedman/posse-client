// Claude Code must authenticate with its own OAuth/session credentials. A nearby
// Anthropic API key changes Claude Code's auth mode and can unexpectedly bill the
// direct API account, so every Claude child boundary uses this scrubber.
export function scrubClaudeChildEnv(childEnv = {}) {
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.CODEX_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.XAI_API_KEY;
  delete childEnv.GITHUB_TOKEN;
  // Force a blocking, upfront MCP attach at every Claude child boundary.
  if (childEnv.MCP_CONNECTION_NONBLOCKING === undefined) {
    childEnv.MCP_CONNECTION_NONBLOCKING = "0";
  }
  if (childEnv.ENABLE_TOOL_SEARCH === undefined) {
    childEnv.ENABLE_TOOL_SEARCH = "false";
  }
  return childEnv;
}
