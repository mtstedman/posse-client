import { ENVIRONMENT_SETUP_RUNTIME_CREDIT_CAP_MS } from "../../../catalog/tools/environment-setup.js";
import { jobHasLivePendingScopeRequest, jobHasLiveEnvironmentSetup } from "../../queue/functions/index.js";
import { baselineRuntimeClock } from "../../worker/classes/BaselineRuntimeClock.js";

export function runtimeWatchdogExempt(job, { nowMs = Date.now() } = {}) {
  return job?.job_type === "human_input" || jobHasLivePendingScopeRequest(job, { nowMs });
}

// Total watchdog credit a single dispatch may earn from live-scope waits.
// Each new scope request carries a fresh requested_at, so an uncapped
// exemption is indefinitely renewable by a scope-spamming agent; several
// sequential human-answered gates fit comfortably under this ceiling while
// a runaway worker still reaches the runtime cap.
const RUNTIME_EXEMPT_CREDIT_CAP_MS = 10 * 60_000;

export function runtimeWatchdogElapsedMs(entry, job, nowMs = Date.now()) {
  // An open human prompt is exempt without a credit cap (the prompt's own
  // DISPLAY_TIMEOUT_MS bounds it), but a human_input worker wedged before or
  // after the prompt parks still needs the last-resort runtime reap, so the
  // unconditional exemption is scoped to the parked status. Parked time is
  // credited back to startTime so the post-answer phase is not charged for it.
  if (job?.job_type === "human_input" && job.status === "waiting_on_human") {
    if (entry.humanGateExemptSince == null) entry.humanGateExemptSince = nowMs;
    return null;
  }
  if (entry.humanGateExemptSince != null) {
    entry.startTime += Math.max(0, nowMs - entry.humanGateExemptSince);
    entry.humanGateExemptSince = null;
  }
  if (creditedRuntimeExemption(entry, runtimeWatchdogExempt(job, { nowMs }), nowMs, {
    sinceKey: "runtimeExemptSince", creditKey: "runtimeExemptCreditMs", capMs: RUNTIME_EXEMPT_CREDIT_CAP_MS,
  })) return null;
  // A setup tool call blocks on the user and then on approved installers.
  // Its marker carries its own deadline; the separate credit keeps repeated
  // setup requests from exempting a runaway job indefinitely.
  if (creditedRuntimeExemption(entry, jobHasLiveEnvironmentSetup(job, { nowMs }), nowMs, {
    sinceKey: "environmentSetupExemptSince", creditKey: "environmentSetupExemptCreditMs", capMs: ENVIRONMENT_SETUP_RUNTIME_CREDIT_CAP_MS,
  })) return null;
  return Math.max(0, nowMs - entry.startTime - baselineRuntimeClock.elapsed(entry.job, nowMs));
}

// Exemption is honored only while cumulative credit remains; past the ceiling
// the wait counts as runtime again so the cap still binds. Credited time moves
// startTime forward when the exemption ends.
function creditedRuntimeExemption(entry, exempt, nowMs, { sinceKey, creditKey, capMs }) {
  const creditUsedMs = entry[creditKey] || 0;
  if (exempt) {
    if (entry[sinceKey] == null) entry[sinceKey] = nowMs;
    if (creditUsedMs + Math.max(0, nowMs - entry[sinceKey]) < capMs) return true;
  }
  if (entry[sinceKey] != null) {
    const appliedMs = Math.min(Math.max(0, nowMs - entry[sinceKey]), Math.max(0, capMs - creditUsedMs));
    entry.startTime += appliedMs;
    entry[creditKey] = creditUsedMs + appliedMs;
    entry[sinceKey] = null;
  }
  return false;
}
