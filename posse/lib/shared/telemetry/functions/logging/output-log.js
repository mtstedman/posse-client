// Stateful output logging now lives under lib/shared/telemetry/classes/logging/OutputLog.js.
// This module remains as a strangler wrapper for existing call sites.

import { getDefaultOutputLog } from "../../classes/logging/OutputLog.js";

export function recordOutput(payload = {}) {
  return getDefaultOutputLog().record(payload);
}

export function listOutputLogFiles() {
  return getDefaultOutputLog().listFiles();
}

export function readRecentOutputs({ limit = 50, jobId = null, role = null, agentCallId = null } = {}) {
  return getDefaultOutputLog().readRecent({ limit, jobId, role, agentCallId });
}

export function closeOutputLog() {
  getDefaultOutputLog().close();
}
