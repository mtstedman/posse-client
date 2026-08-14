import { readStallTimeoutSec } from "../../../scheduler/functions/config.js";
import { getJob, jobHasLivePendingScopeRequest } from "../../../queue/functions/index.js";

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
