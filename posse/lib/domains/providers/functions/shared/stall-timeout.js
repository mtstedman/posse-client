import { readStallTimeoutSec } from "../../../scheduler/functions/config.js";
import { getJob, jobHasLivePendingScopeRequest } from "../../../queue/functions/index.js";
import { subAgentRuntime } from "../../../sub-agent/classes/SubAgentRuntime.js";
import { webResearchRuntime } from "../../../web-research/classes/WebResearchRuntime.js";

export function resolveProviderStallTimeout(stallTimeout = null) {
  const parsed = Number(stallTimeout);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : readStallTimeoutSec();
}

export function liveScopeWaitPausesProviderStall(jobId) {
  if (!jobId) return false;
  try {
    return jobHasLivePendingScopeRequest(getJob(jobId));
  } catch {
    return false;
  }
}

// A parent call blocked inside a wait_all research dispatch produces no
// provider output for as long as its children run (up to the child timeout
// ceiling, which equals the planner stall threshold). The children carry their
// own timeouts and stall detectors, so the parent's silence is not a stall.
export function childDispatchPausesProviderStall(agentCallId) {
  if (!agentCallId) return false;
  try {
    return subAgentRuntime.hasRunningBatchForParent(agentCallId)
      || webResearchRuntime.hasRunningDispatchForParent(agentCallId);
  } catch {
    return false;
  }
}

export function providerStallPaused({ jobId = null, agentCallId = null } = {}) {
  return liveScopeWaitPausesProviderStall(jobId) || childDispatchPausesProviderStall(agentCallId);
}
