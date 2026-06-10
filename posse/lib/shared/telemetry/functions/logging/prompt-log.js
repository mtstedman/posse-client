// Stateful prompt logging now lives under lib/shared/telemetry/classes/logging/PromptLog.js.
// This module remains as a strangler wrapper for existing call sites.

import { getDefaultPromptLog, promptPreviewText } from "../../classes/logging/PromptLog.js";

export { promptPreviewText };

export function recordPrompt(payload = {}) {
  return getDefaultPromptLog().record(payload);
}

export function listPromptLogFiles() {
  return getDefaultPromptLog().listFiles();
}

export function readRecentPrompts({ limit = 50, jobId = null, role = null, agentCallId = null } = {}) {
  return getDefaultPromptLog().readRecent({ limit, jobId, role, agentCallId });
}

export function closePromptLog() {
  getDefaultPromptLog().close();
}
