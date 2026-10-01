// lib/domains/worker/functions/helpers/provider-quota-pause.js
//
// A provider subscription quota (Claude "session limit · resets 5:40pm (UTC)",
// Codex "usage limit ... try again at 3:45 PM") is a wait for the provider's
// reset, not a failed attempt. These helpers decide between pausing the job
// until the reset (no attempt penalty) and the durable-capacity dead letter,
// and bound the penalty-free provider requeues so none of them loops forever.

import { PROVIDER_QUOTA_SCOPES } from "../../../../catalog/provider.js";
import {
  isProviderQuotaBackoff,
  PROVIDER_QUOTA_MAX_RESET_WAIT_SEC,
  providerQuotaResetWaitSec,
} from "../../../providers/functions/shared/quota-reset.js";

export { isProviderQuotaBackoff, PROVIDER_QUOTA_MAX_RESET_WAIT_SEC };

// Attempt error_text prefixes are load-bearing: the requeue caps below read
// the attempt history by them.
export const PROVIDER_QUOTA_PAUSE_PREFIX = "Provider quota pause:";
export const PROVIDER_PAUSED_PREFIX = "Provider paused:";
export const PROVIDER_ERROR_PREFIX = "Provider error:";

// Consecutive quota pauses a job may take before it is treated as durable
// capacity exhaustion. With unparseable resets the default backoff doubles
// 15m -> 30m -> 60m, so eight pauses span ~6.75h: past a 5h session window.
export const MAX_PROVIDER_QUOTA_PAUSES = 8;
// Consecutive penalty-free transient provider-error requeues before the
// normal fail path. (B7)
export const MAX_PROVIDER_ERROR_REQUEUES = 8;
// Consecutive preflight bounces (the provider was paused and no fallback was
// free) before the job takes the normal fail path. Each bounce waits for the
// pause to end, and the jobs that keep re-tripping the pause are bounded by
// the caps above, so this only stops a job that never gets its turn.
export const MAX_PROVIDER_PAUSED_BOUNCES = 24;
export const PROVIDER_QUOTA_DEFAULT_PAUSE_SEC = 15 * 60;
export const PROVIDER_QUOTA_MAX_DEFAULT_PAUSE_SEC = 60 * 60;
// Spread resumed jobs past the reset instead of starting them all at once.
const RESUME_JITTER_MIN_SEC = 15;
const RESUME_JITTER_SPAN_SEC = 60;

export function providerQuotaResumeJitterSec(random = Math.random) {
  const sample = Number(random());
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.999) : 0.5;
  return RESUME_JITTER_MIN_SEC + Math.floor(unit * RESUME_JITTER_SPAN_SEC);
}

const PROVIDER_INTERRUPTION_KINDS = Object.freeze([
  ["quotaPauses", PROVIDER_QUOTA_PAUSE_PREFIX],
  ["pausedBounces", PROVIDER_PAUSED_PREFIX],
  ["providerErrors", PROVIDER_ERROR_PREFIX],
]);

function providerInterruptionKind(row) {
  if (row?.status !== "interrupted") return null;
  const text = String(row.error_text || "");
  return PROVIDER_INTERRUPTION_KINDS.find(([, prefix]) => text.startsWith(prefix))?.[0] || null;
}

/**
 * Walk the job's newest attempts while they are penalty-free provider
 * interruptions (quota pauses, paused-provider bounces, transient provider
 * errors) and count each kind. Any other attempt ends the streak. Each cap
 * counts its own kind and skips the others, so interleaving them (a 429
 * between bounces) cannot reset a cap.
 * @returns {{ quotaPauses: number, pausedBounces: number, providerErrors: number }}
 */
export function providerInterruptionStreak(attempts = [], { excludeAttemptId = null } = {}) {
  const streak = { quotaPauses: 0, pausedBounces: 0, providerErrors: 0 };
  // Penalty-free requeues refund the attempt, so attempt numbers repeat; the
  // row id is the insertion order.
  const ordered = [...attempts]
    .filter((row) => row && row.id !== excludeAttemptId)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0) || Number(b.attempt_number || 0) - Number(a.attempt_number || 0));
  for (const row of ordered) {
    const kind = providerInterruptionKind(row);
    if (!kind) break;
    streak[kind] += 1;
  }
  return streak;
}

/**
 * Count the job's consecutive quota pauses, newest first. Paused-provider
 * bounces and transient provider errors neither count nor break the streak.
 */
export function countConsecutiveProviderQuotaPauses(attempts = [], options = {}) {
  return providerInterruptionStreak(attempts, options).quotaPauses;
}

/** True when a provider pause outlasts any wait worth holding a job for. */
export function isLongProviderPause(retryInSec) {
  return Number(retryInSec) > PROVIDER_QUOTA_MAX_RESET_WAIT_SEC;
}

function formatWait(sec) {
  const minutes = Math.max(1, Math.round(sec / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${String(rest).padStart(2, "0")}m` : `${hours}h`;
}

/**
 * Plan the response to a provider quota failure.
 *
 * `providerName` is the provider that reported the quota. It can be a
 * fallback the job was routed to because its own provider was paused; then
 * `homeProviderName` names the job's own provider and `homeProviderPauseSec`
 * that provider's remaining pause. The quota provider stays paused for its
 * full wait, but the job resumes as soon as its own provider is free, and a
 * fallback's durable quota (model-scoped, billing, weekly) does not
 * dead-letter a job whose own provider is only briefly paused.
 *
 * `waitSec` is the quota provider's pause; `jobWaitSec` the job's.
 *
 * @returns {{ action: "durable", reason: string, detail: string }
 *   | { action: "pause", waitSec: number, jobWaitSec: number, jitterSec: number,
 *       readyAtMs: number, resetAtMs: number|null, resetLabel: string|null,
 *       limitName: string, pauseNumber: number, summary: string }}
 */
export function planProviderQuotaPause({
  providerName,
  backoff,
  priorPauses = 0,
  providerPauseSec = 0,
  homeProviderName = null,
  homeProviderPauseSec = 0,
  nowMs = Date.now(),
  random = Math.random,
} = {}) {
  const quota = backoff?.quota || {};
  const limitName = quota.limitName || "usage limit";
  if (priorPauses >= MAX_PROVIDER_QUOTA_PAUSES) {
    return {
      action: "durable",
      reason: "pause_cap",
      detail: `${providerName} ${limitName} persisted through ${priorPauses} quota pauses`,
    };
  }

  const resetAtMs = Number(quota.reset?.resetAtMs);
  const resetKnown = Number.isFinite(resetAtMs);
  const resetLabel = resetKnown ? (quota.reset.label || new Date(resetAtMs).toISOString()) : null;
  const untilResetSec = resetKnown ? Math.ceil((resetAtMs - nowMs) / 1000) : null;
  let durable = null;
  if (quota.scope === PROVIDER_QUOTA_SCOPES.MODEL || quota.scope === PROVIDER_QUOTA_SCOPES.BILLING) {
    durable = {
      action: "durable",
      reason: quota.scope === PROVIDER_QUOTA_SCOPES.MODEL ? "model_quota" : "billing_quota",
      detail: quota.scope === PROVIDER_QUOTA_SCOPES.MODEL
        ? `${providerName} ${limitName} is model-scoped`
        : `${providerName} billing quota does not reset on a clock`,
    };
  } else if (resetKnown && untilResetSec > PROVIDER_QUOTA_MAX_RESET_WAIT_SEC) {
    durable = {
      action: "durable",
      reason: "reset_too_far",
      detail: `${providerName} ${limitName} resets ${resetLabel}`,
    };
  }
  const homeDiffers = !!homeProviderName && homeProviderName !== providerName;
  const homePauseSec = homeDiffers ? Math.max(0, Math.ceil(Number(homeProviderPauseSec) || 0)) : 0;
  if (durable && (!homeDiffers || isLongProviderPause(homePauseSec))) return durable;

  let waitSec;
  let providerSummary;
  if (durable) {
    // Only the fallback is out of capacity: leave its pause as it is.
    waitSec = Math.max(0, Math.ceil(Number(providerPauseSec) || 0));
    providerSummary = `provider ${durable.detail}`;
  } else if (resetKnown) {
    // A reset that already fired gets a cooldown that escalates with the
    // job's prior pauses (1m, 5m, 15m, ...); a dateless session-window reset
    // is clamped to the session maximum.
    waitSec = providerQuotaResetWaitSec(quota, nowMs, { priorPauses });
    const resetDetail = untilResetSec <= 0
      ? `reset ${resetLabel} has passed; retrying in ${formatWait(waitSec)}`
      : (waitSec < untilResetSec ? `resets ${resetLabel}; rechecking in ${formatWait(waitSec)}` : `waiting until ${resetLabel}`);
    providerSummary = `provider ${providerName} ${limitName} — ${resetDetail}`;
  } else {
    waitSec = Math.min(
      PROVIDER_QUOTA_DEFAULT_PAUSE_SEC * (2 ** Math.max(0, priorPauses)),
      PROVIDER_QUOTA_MAX_DEFAULT_PAUSE_SEC,
    );
    providerSummary = `provider ${providerName} ${limitName} — reset time not reported; waiting ${formatWait(waitSec)}`;
  }
  // Never resume before the provider-wide pause other jobs are honoring.
  waitSec = Math.max(waitSec, Math.ceil(Number(providerPauseSec) || 0));
  // On a fallback's quota the job resumes when either provider frees up; on
  // a fallback that is out of capacity, only its own provider will.
  const jobWaitSec = !homeDiffers ? waitSec : (durable ? homePauseSec : Math.min(waitSec, homePauseSec));
  const jitterSec = providerQuotaResumeJitterSec(random);
  const summary = homeDiffers && (durable || jobWaitSec < waitSec)
    ? `${providerSummary}; job resumes on ${homeProviderName}${jobWaitSec > 0 ? ` in ${formatWait(jobWaitSec)}` : ""}`
    : providerSummary;
  return {
    action: "pause",
    waitSec,
    jobWaitSec,
    jitterSec,
    readyAtMs: nowMs + (jobWaitSec + jitterSec) * 1000,
    resetAtMs: resetKnown ? resetAtMs : null,
    resetLabel,
    limitName,
    pauseNumber: priorPauses + 1,
    summary,
  };
}

/**
 * Plan the requeue for a call the provider client rejected before launch
 * because its provider is paused and no unpaused fallback was available.
 */
export function planProviderPausedRequeue({
  providerName,
  retryInSec = 0,
  reason = "",
  nowMs = Date.now(),
  random = Math.random,
} = {}) {
  const waitSec = Math.max(0, Math.ceil(Number(retryInSec) || 0));
  const jitterSec = providerQuotaResumeJitterSec(random);
  const resumeAt = new Date(nowMs + waitSec * 1000).toISOString().slice(11, 16);
  return {
    waitSec,
    jitterSec,
    readyAtMs: nowMs + (waitSec + jitterSec) * 1000,
    summary: `provider ${providerName} paused${reason ? ` (${reason})` : ""} — waiting until ${resumeAt} UTC`,
  };
}

const PROVIDER_LIMIT_LINE_RE = /limit|quota|rate|429|overloaded|too many requests|unavailable/i;

function providerInterruptionExcerpt(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((entry) => PROVIDER_LIMIT_LINE_RE.test(entry)) || lines[0] || "";
  return line.replace(/^Partial output:\s*/i, "").slice(0, 160);
}

/**
 * The retry-prompt replacement for a previous attempt that a provider pause
 * or transient provider error interrupted. Rendering its error text as
 * "PREVIOUS ATTEMPT FAILED" tells the agent its work failed when the
 * provider only stopped it. Returns null for any other previous error.
 * @returns {{ lastError: null, block: string } | null}
 */
export function providerInterruptionRetryContext(lastError) {
  const text = typeof lastError === "string" ? lastError.trim() : "";
  const kind = providerInterruptionKind({ status: "interrupted", error_text: text });
  if (!kind) return null;
  const prefix = PROVIDER_INTERRUPTION_KINDS.find(([name]) => name === kind)[1];
  const excerpt = providerInterruptionExcerpt(text.slice(prefix.length));
  const cause = kind === "pausedBounces"
    ? "It never started: the provider was paused for a usage or rate limit."
    : (kind === "quotaPauses"
      ? `The provider paused it for a usage limit until the limit reset${excerpt ? ` (${excerpt})` : ""}.`
      : `A transient provider error stopped it${excerpt ? ` (${excerpt})` : ""}.`);
  return {
    lastError: null,
    block: [
      "PREVIOUS ATTEMPT INTERRUPTED BY THE PROVIDER:",
      `  ${cause}`,
      "  That was not a failure of the work: carry on with the task as specified.",
      "",
    ].join("\n"),
  };
}
