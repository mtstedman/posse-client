import { JOB_TOOL_USAGE_PAYLOAD_KEY } from "../../../catalog/job.js";
import { parseJobPayload } from "./payload.js";
import { getJob, runInTransaction, updateJobPayload } from "./queue-store.js";

// Durable per-job counters for agent-tool allowances (see
// JOB_TOOL_USAGE_COUNTERS), kept on the job payload.

function usageIn(payload, counter) {
  const value = Number(payload?.[JOB_TOOL_USAGE_PAYLOAD_KEY]?.[counter]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** @param {number} jobId @param {string} counter @returns {number} */
export function jobToolUsage(jobId, counter) {
  return usageIn(parseJobPayload(getJob(jobId)), counter);
}

/**
 * Add `delta` (negative to refund) to one of the job's counters, never below
 * zero. An increase that would pass `limit` is refused and nothing changes.
 *
 * @param {number} jobId
 * @param {string} counter
 * @param {number} delta
 * @param {{ limit?: number }} [options]
 * @returns {boolean} whether the change was recorded
 */
export function adjustJobToolUsage(jobId, counter, delta, { limit = Infinity } = {}) {
  return runInTransaction(() => {
    const job = getJob(jobId);
    if (!job) return false;
    const payload = parseJobPayload(job);
    const used = usageIn(payload, counter);
    const next = Math.max(0, used + delta);
    if (delta > 0 && next > limit) return false;
    if (next === used) return true;
    const usage = payload[JOB_TOOL_USAGE_PAYLOAD_KEY];
    payload[JOB_TOOL_USAGE_PAYLOAD_KEY] = {
      ...(usage && typeof usage === "object" && !Array.isArray(usage) ? usage : {}),
      [counter]: next,
    };
    updateJobPayload(job.id, JSON.stringify(payload));
    return true;
  });
}
