import { verifyProviderDispatchCapabilitiesSync } from "../../../../shared/native/functions/engagement-client.js";

// posse-remote owns the Claude CLI: it finds the executable and advertises the
// claude adapter only when it can run it.
export function getClaudeReadiness() {
  try {
    verifyProviderDispatchCapabilitiesSync("claude");
    return { ready: true, reason: null };
  } catch (err) {
    return { ready: false, reason: String(err?.message || err) };
  }
}

export function isReady() {
  return getClaudeReadiness();
}
