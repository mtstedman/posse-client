import { buildNativeDispatchRequest, runNativeDispatch } from "../shared/native-dispatch.js";

// Compatibility exports while Claude callers migrate to the common boundary.
export function buildClaudeNativeDispatchRequest(promptText, options = {}) {
  return buildNativeDispatchRequest("claude", promptText, options);
}

export const runClaudeNativeDispatch = runNativeDispatch;
