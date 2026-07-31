// A job's provider pin belongs to that job's execution role. Copying the pin
// to another job is denied unless the caller names one of these continuity
// routes and the source/target job types match the route exactly.

export const PROVIDER_AFFINITY_ROUTES = Object.freeze({
  REPAIR_CONTINUATION: "repair_continuation",
  FILE_REQUEST_CONTINUATION: "file_request_continuation",
  REPLACEMENT_RETRY: "replacement_retry",
});

const KNOWN_PROVIDER_AFFINITY_ROUTES = new Set(Object.values(PROVIDER_AFFINITY_ROUTES));
const DEV_JOB_TYPES = new Set(["dev", "fix"]);

export function providerForAffinityRoute(sourceJob, targetJobType, route) {
  if (!KNOWN_PROVIDER_AFFINITY_ROUTES.has(route)) {
    throw new Error(`Unknown provider affinity route: ${route || "(missing)"}`);
  }

  const sourceJobType = String(sourceJob?.job_type || "").trim().toLowerCase();
  const normalizedTargetJobType = String(targetJobType || "").trim().toLowerCase();
  const sourceProvider = String(sourceJob?.provider || "").trim() || null;
  if (!sourceProvider || !sourceJobType || !normalizedTargetJobType) return null;

  if (route === PROVIDER_AFFINITY_ROUTES.REPAIR_CONTINUATION) {
    return DEV_JOB_TYPES.has(sourceJobType) && normalizedTargetJobType === "fix"
      ? sourceProvider
      : null;
  }

  if (route === PROVIDER_AFFINITY_ROUTES.FILE_REQUEST_CONTINUATION) {
    return DEV_JOB_TYPES.has(sourceJobType) && normalizedTargetJobType === "dev"
      ? sourceProvider
      : null;
  }

  return sourceJobType === normalizedTargetJobType ? sourceProvider : null;
}
