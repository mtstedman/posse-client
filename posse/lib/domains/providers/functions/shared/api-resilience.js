// lib/domains/providers/functions/shared/api-resilience.js
//
// Shared retry and circuit-breaker factories for API-backed providers.
// Each provider keeps its own breaker state while reusing the same logic.

import { PROVIDER_QUOTA_SCOPES } from "../../../../catalog/provider.js";
import {
  describeProviderQuota,
  parseProviderQuotaReset,
  PROVIDER_QUOTA_MAX_LONG_PAUSE_SEC,
  PROVIDER_WINDOW_LIMIT_REACHED_RE,
  providerQuotaResetWaitSec,
} from "./quota-reset.js";

export const MAX_RETRY_AFTER_SECONDS = 12 * 60 * 60;
export const MAX_RETRY_AFTER_COOLDOWN_MS = MAX_RETRY_AFTER_SECONDS * 1000;
export const LONG_RETRY_AFTER_WARNING_SECONDS = 10 * 60;

export function clampRetryAfterSeconds(sec, fallback = 30, max = MAX_RETRY_AFTER_SECONDS) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(Math.ceil(n), max));
}

function errorMessage(err) {
  return String(err?.message || err || "");
}

// Facts carried on a provider error from the moment it is first observed.
// Attempt handling can classify the same error long afterwards (a runtime
// fallback runs in between), so the provider that produced it and its parsed
// quota reset travel with it instead of being re-derived from the provider
// the job was assigned and the wall clock at handling time. The properties
// are non-enumerable so they stay out of serialized error payloads.
const ERROR_PROVIDER_KEY = "posseErrorProvider";
const ERROR_OBSERVED_AT_KEY = "posseErrorObservedAtMs";
const ERROR_QUOTA_RESET_KEY = "posseErrorQuotaReset";

function setHiddenErrorFact(err, key, value) {
  try {
    Object.defineProperty(err, key, { value, configurable: true, enumerable: false, writable: true });
  } catch {
    // A frozen or exotic error keeps working without the carried fact.
  }
}

/**
 * Stamp a provider error with the provider that produced it and when it was
 * first observed. The first stamp wins, so a rethrown error keeps its origin.
 * @returns {*} the same error.
 */
export function markProviderErrorObserved(err, providerName = null, nowMs = Date.now()) {
  if (!err || typeof err !== "object") return err;
  if (providerName && !err[ERROR_PROVIDER_KEY]) setHiddenErrorFact(err, ERROR_PROVIDER_KEY, String(providerName));
  if (!Number.isFinite(err[ERROR_OBSERVED_AT_KEY])) setHiddenErrorFact(err, ERROR_OBSERVED_AT_KEY, nowMs);
  return err;
}

/** The provider that produced a stamped error, or null when unknown. */
export function providerErrorSource(err) {
  const value = err && typeof err === "object" ? err[ERROR_PROVIDER_KEY] : null;
  return value ? String(value) : null;
}

// Parse a quota reset once, as of the error's first observation, and reuse
// it: re-reading "resets 5:40pm" at 17:46 would otherwise land on tomorrow.
function observedProviderQuotaReset(err, msg, nowMs) {
  const carried = err && typeof err === "object" ? err[ERROR_QUOTA_RESET_KEY] : null;
  if (carried && carried.text === msg) return carried.reset;
  markProviderErrorObserved(err, null, nowMs);
  const observedAtMs = Number.isFinite(err?.[ERROR_OBSERVED_AT_KEY]) ? err[ERROR_OBSERVED_AT_KEY] : nowMs;
  const reset = parseProviderQuotaReset(msg, { nowMs: observedAtMs });
  if (err && typeof err === "object") setHiddenErrorFact(err, ERROR_QUOTA_RESET_KEY, { text: msg, reset });
  return reset;
}

function errorStatus(err) {
  return Number(err?.status || err?.statusCode || err?.response?.status || 0) || null;
}

// Subscription-quota wordings: Codex/Claude "usage limit", Claude "session
// limit", "You've hit your weekly limit", and Claude's newer "5-hour limit
// reached" / "Weekly limit reached".
const USAGE_QUOTA_TEXT_RE = /usage limit|usage cap|out of usage|out of.*usage|over usage|usage exhausted|usage.*reset|quota exceeded|credit balance is too low|session limit|(?:hit|reached) your.*limit/i;

function isUsageQuotaText(msg) {
  return USAGE_QUOTA_TEXT_RE.test(msg) || PROVIDER_WINDOW_LIMIT_REACHED_RE.test(msg);
}

function hasRateLimitTextSignal(msg, status = null) {
  if (status === 429) return true;
  return /rate.?limit|429|too many requests/i.test(msg) || isUsageQuotaText(msg);
}

export function retryAfterHeader(err) {
  const headers = err?.headers || err?.response?.headers || null;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get("retry-after");
  return headers["retry-after"] || headers["Retry-After"] || null;
}

function parseDurationPartsSec(text) {
  const raw = String(text || "");
  const unitRe = /(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi;
  let total = 0;
  let matched = false;
  let match;
  while ((match = unitRe.exec(raw)) !== null) {
    matched = true;
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("h")) total += value * 3600;
    else if (unit.startsWith("m")) total += value * 60;
    else total += value;
  }
  return matched && total > 0 ? clampRetryAfterSeconds(total) : null;
}

function parseRetryDurationSec(msg, { allowBroad = false } = {}) {
  if (!msg) return null;
  const durationPart = String.raw`(?:(?:\d+)\s*(?:h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b[\s,]*(?:and\s+)?)`;
  const durationParts = String.raw`${durationPart}+`;
  const explicitDuration = msg.match(new RegExp(String.raw`\b(?:retry\s+after|retry[-_. ]?after[:=]|try\s+again\s+(?:in|after)|please\s+try\s+again\s+(?:in|after)|available\s+again\s+(?:in|after))\s*(${durationParts})`, "i"));
  if (explicitDuration) return parseDurationPartsSec(explicitDuration[1]);

  if (!allowBroad) return null;

  const durationMatch = msg.match(new RegExp(String.raw`\b(?:wait|reset(?:s)?|usage(?:\s+limit)?\s+reset(?:s)?|usage\s+exhausted)\s+(?:in|after)?\s*(${durationParts})`, "i"));
  if (!durationMatch) return null;
  return parseDurationPartsSec(durationMatch[1]);
}

export function classifyProviderError(err, {
  defaultBackoffSec = 15,
  rateLimitBackoffSec = 30,
  circuitBreakerBackoffSec = 15,
} = {}) {
  const msg = errorMessage(err);
  const status = errorStatus(err);
  const retryAfter = retryAfterHeader(err);
  const rateLimitTextSignal = hasRateLimitTextSignal(msg, status);

  // Circuit-breaker errors are synthetic local state; classify them before
  // provider retry hints so callers preserve the breaker reason and cooldown.
  if (/circuit breaker/i.test(msg) || err?.circuitBreaker) {
    const backoff = typeof circuitBreakerBackoffSec === "function"
      ? circuitBreakerBackoffSec()
      : circuitBreakerBackoffSec;
    return { backoffSec: clampRetryAfterSeconds(backoff, defaultBackoffSec), isRateLimit: true, source: "circuit_breaker" };
  }

  if (retryAfter) {
    // Retry-After may be either delta-seconds or an HTTP-date (RFC 7231).
    // parseFloat() on a date string yields NaN → silent 30s fallback, so fall
    // back to Date.parse() for the date form (mostly seen via proxies/CDNs). (B19)
    const numericSec = parseFloat(retryAfter);
    let sec = numericSec;
    if (!Number.isFinite(numericSec) || numericSec <= 0) {
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) sec = (dateMs - Date.now()) / 1000;
    }
    return { backoffSec: clampRetryAfterSeconds(sec), isRateLimit: true, source: "retry-after" };
  }

  const retryDurationSec = parseRetryDurationSec(msg, { allowBroad: rateLimitTextSignal });
  if (retryDurationSec) {
    return { backoffSec: retryDurationSec, isRateLimit: true, source: "retry-after" };
  }

  // Subscription quotas name a wall-clock reset ("resets 5:40pm (UTC)",
  // "try again at 3:45 PM"). The `quota` descriptor carries its scope and
  // parsed reset so callers can pause until then instead of failing.
  const nowMs = Date.now();
  const quotaReset = rateLimitTextSignal ? observedProviderQuotaReset(err, msg, nowMs) : null;
  if (quotaReset) {
    const quota = describeProviderQuota(msg, { reset: quotaReset });
    // Only an account-wide window blocks the whole provider until its reset;
    // a single model's cap keeps the short usage cooldown so other models on
    // the provider stay routable. A reset that already fired gets a short
    // cooldown, a dateless one is clamped to the session maximum, and a dated
    // weekly reset pauses the provider until then (bounded), not for 12h at
    // a time.
    return {
      backoffSec: quota.scope === PROVIDER_QUOTA_SCOPES.ACCOUNT
        ? clampRetryAfterSeconds(providerQuotaResetWaitSec(quota, nowMs), 30, PROVIDER_QUOTA_MAX_LONG_PAUSE_SEC)
        : 15 * 60,
      isRateLimit: true,
      source: "usage_reset",
      quota,
    };
  }

  if (isUsageQuotaText(msg)) {
    return {
      backoffSec: 15 * 60,
      isRateLimit: true,
      source: "usage_limit",
      quota: describeProviderQuota(msg, { reset: null }),
    };
  }

  if (status === 429 || /rate.?limit|429|too many requests/i.test(msg)) {
    return { backoffSec: rateLimitBackoffSec, isRateLimit: true, source: "rate_limit" };
  }

  if (status === 529 || /overloaded|API Error:\s*529|service unavailable/i.test(msg)) {
    return { backoffSec: 10, isRateLimit: true, source: "overloaded" };
  }

  if ((status >= 500 && status < 600) || /API Error:\s*5\d\d|internal server error/i.test(msg)) {
    return { backoffSec: 10, isRateLimit: false, source: "server_error" };
  }

  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection error/i.test(msg)) {
    return { backoffSec: 5, isRateLimit: false, source: "connection_error" };
  }

  if (/Failed to spawn|configuration.*corrupted/i.test(msg)) {
    return { backoffSec: 5, isRateLimit: false, source: "spawn_error" };
  }

  return { backoffSec: defaultBackoffSec, isRateLimit: false, source: "unknown" };
}

export function createCircuitBreaker({ cooldownMs = 60_000, maxCooldownMs = MAX_RETRY_AFTER_COOLDOWN_MS } = {}) {
  let open = false;
  let resetAt = 0;

  return {
    trip(retryAfterSec = null) {
      if (retryAfterSec != null && Number(retryAfterSec) <= 0) {
        open = false;
        resetAt = 0;
        return;
      }
      const cooldown = retryAfterSec != null
        ? Math.min(clampRetryAfterSeconds(retryAfterSec, cooldownMs / 1000, maxCooldownMs / 1000) * 1000, maxCooldownMs)
        : cooldownMs;
      open = true;
      resetAt = Date.now() + cooldown;
    },
    reset() {
      open = false;
      resetAt = 0;
    },
    isOpen() {
      if (open && Date.now() >= resetAt) open = false;
      return open;
    },
    getResetAt() {
      if (open && Date.now() >= resetAt) open = false;
      return open ? resetAt : 0;
    },
  };
}

export function createRetryWrapper({
  breaker,
  formatRateLimitMessage,
  formatRetryMessage,
  formatLongRetryAfterMessage,
} = {}) {
  function abortableDelay(waitMs, signal = null) {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, waitMs));
    if (signal.aborted) {
      const err = signal.reason instanceof Error ? signal.reason : new Error("Retry backoff aborted");
      err.aborted = true;
      throw err;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener?.("abort", onAbort);
        resolve();
      }, waitMs);
      const onAbort = () => {
        clearTimeout(timer);
        const err = signal.reason instanceof Error ? signal.reason : new Error("Retry backoff aborted");
        err.aborted = true;
        reject(err);
      };
      signal.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  // Rate-limit errors are not retried here. They trip the breaker and bubble to
  // the worker, which requeues the job for the provider-supplied cooldown.
  return async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 2000, emit = null, signal = null } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        const err = signal.reason instanceof Error ? signal.reason : new Error("Retry aborted");
        err.aborted = true;
        throw err;
      }
      try {
        return await fn();
      } catch (err) {
        const status = err.status || err.statusCode;
        const isRateLimit = status === 429 || /rate.?limit|too many requests/i.test(err.message);
        const retryable = isRateLimit || status === 500 || status === 502 || status === 503
          || /connection error|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(err.message);

        if (isRateLimit) {
          const retryAfter = retryAfterHeader(err);
          const retryAfterSec = retryAfter ? clampRetryAfterSeconds(parseFloat(retryAfter)) : null;
          breaker?.trip(retryAfterSec);
          if (emit && retryAfterSec >= LONG_RETRY_AFTER_WARNING_SECONDS) {
            const message = typeof formatLongRetryAfterMessage === "function"
              ? formatLongRetryAfterMessage(retryAfterSec)
              : `[retry-after] provider requested ${retryAfterSec}s; circuit breaker will stay open until then`;
            emit(message);
          }
          if (emit && typeof formatRateLimitMessage === "function") emit(formatRateLimitMessage());
          throw err;
        }

        if (!retryable || attempt === maxAttempts) throw err;

        const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
        if (emit && typeof formatRetryMessage === "function") emit(formatRetryMessage(status, waitMs, attempt, maxAttempts));
        await abortableDelay(waitMs, signal);
      }
    }
  };
}
