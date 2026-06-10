// lib/provider/helpers/api-resilience.js
//
// Shared retry and circuit-breaker factories for API-backed providers.
// Each provider keeps its own breaker state while reusing the same logic.

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

function errorStatus(err) {
  return Number(err?.status || err?.statusCode || err?.response?.status || 0) || null;
}

function hasRateLimitTextSignal(msg, status = null) {
  if (status === 429) return true;
  return /rate.?limit|429|too many requests|usage limit|usage cap|out of usage|out of.*usage|over usage|usage exhausted|usage.*reset|quota exceeded|credit balance is too low/i.test(msg);
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

function parseRetryClockSec(msg, now = new Date(Date.now())) {
  if (!msg) return null;
  const clockMatch = msg.match(
    /(?:try again|retry|available again|reset(?:s)?(?: your usage)?|usage(?: limit)? reset(?:s)?)\D+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(utc|gmt|z|est|edt|cst|cdt|mst|mdt|pst|pdt)?\b/i
  );
  if (!clockMatch) return null;
  let hour = parseInt(clockMatch[1], 10);
  const minute = parseInt(clockMatch[2] || "0", 10);
  const meridiem = clockMatch[3] ? clockMatch[3].toLowerCase() : null;
  const zone = clockMatch[4] ? clockMatch[4].toLowerCase() : null;
  if (!zone) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zoneOffsets = {
    utc: 0, gmt: 0, z: 0,
    est: -5 * 60, edt: -4 * 60,
    cst: -6 * 60, cdt: -5 * 60,
    mst: -7 * 60, mdt: -6 * 60,
    pst: -8 * 60, pdt: -7 * 60,
  };
  const offsetMin = zoneOffsets[zone];
  if (!Number.isFinite(offsetMin)) return null;
  let targetMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ) - (offsetMin * 60 * 1000);
  if (targetMs <= now.getTime()) targetMs += 24 * 60 * 60 * 1000;
  return clampRetryAfterSeconds((targetMs - now.getTime()) / 1000, 30);
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

  const retryClockSec = rateLimitTextSignal ? parseRetryClockSec(msg) : null;
  if (retryClockSec) {
    return { backoffSec: retryClockSec, isRateLimit: true, source: "usage_reset" };
  }

  if (/usage limit|usage cap|out of usage|out of.*usage|over usage|usage exhausted|usage.*reset|quota exceeded|credit balance is too low/i.test(msg)) {
    return { backoffSec: 15 * 60, isRateLimit: true, source: "usage_limit" };
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
