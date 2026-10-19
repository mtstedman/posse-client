import { parseJobPayload } from "./payload.js";
import { getLatestAttempt } from "./attempts.js";

// A job blocked inside an environment setup tool call is waiting on the user
// or on approved installers, not making provider progress. The marker carries
// its own deadline and attempt, so a marker left behind by a crashed call
// expires and never exempts a later attempt.
export function jobHasLiveEnvironmentSetup(job, { nowMs = Date.now() } = {}) {
  if (!job) return false;
  const live = parseJobPayload(job)?._environment_setup_live;
  const deadlineMs = Date.parse(String(live?.deadline_at || ""));
  if (!Number.isFinite(deadlineMs) || Number(nowMs) > deadlineMs) return false;
  const attempt = getLatestAttempt(job.id);
  return attempt?.status === "running" && Number(attempt.id) === Number(live.attempt_id);
}
