// lib/domains/providers/functions/shared/quota-reset.js
//
// Subscription-quota messages from the provider CLIs name a wall-clock reset
// instead of a Retry-After duration:
//   Claude: "You've hit your session limit · resets 5:40pm (UTC)"
//           "You've hit your weekly limit · resets Oct 9, 10am (Europe/London)"
//           "5-hour limit reached ∙ resets 3pm"
//           "Weekly limit reached ∙ resets Oct 9, 10am"
//   Codex:  "You've hit your usage limit. ... or try again at 3:45 PM."
//           "... try again at Oct 3rd, 2026 3:45 PM."
// Both CLIs format the reset in the host's local zone; Claude appends that
// IANA zone in parentheses, Codex omits it. A zone-less clock is therefore
// read in this process's zone: the CLI is our child and shares its TZ.

import { PROVIDER_QUOTA_SCOPES } from "../../../../catalog/provider.js";

// A clock that passed a few minutes ago is the reset that fired while the
// failure unwound (the CLIs print minutes, not seconds; an unstamped error
// can be re-read after a ten-minute runtime fallback, red-team run1250b #4),
// not the same time tomorrow or later today.
const JUST_RESET_GRACE_MS = 15 * 60 * 1000;
// Session windows (Claude's 5-hour session, Codex's primary window) reset a
// few hours out at most, so a dateless clock that passed today but recurs
// within this horizon (just after midnight) is tomorrow's reset.
const SESSION_RESET_HORIZON_MS = 6 * 60 * 60 * 1000;
// Weekly and daily windows can name a dateless clock up to a day ahead.
const LONG_WINDOW_LIMIT_RE = /\b(?:weekly|daily)\s+(?:usage\s+)?limit\b/i;
// Claude's 5-hour session window. Only this wording gets the session clamp:
// Codex's "usage limit" covers its weekly window too, and Codex prints a
// dateless clock only for a reset later the same day, however far ahead.
const SESSION_WINDOW_LIMIT_RE = /\b(?:session|5[- ]?hour|five[- ]hour)\s+limit\b/i;
const MODEL_NAME_RE = String.raw`(?:opus|sonnet|fable|haiku)`;
const WINDOW_NAME_RE = String.raw`(?:session|weekly|5[- ]?hour|five[- ]hour)`;
/**
 * Claude's "<window> limit reached" wordings: "5-hour limit reached ∙ resets
 * 3pm", "Weekly limit reached ∙ resets Oct 9, 10am", and the model-scoped
 * "Opus weekly limit reached". A window or model name is required, so
 * Posse's own "<x> limit reached" notices (replan, turn, coordination) never
 * read as a provider quota.
 */
export const PROVIDER_WINDOW_LIMIT_REACHED_RE = new RegExp(
  String.raw`\b(?:${MODEL_NAME_RE}(?:\s+${WINDOW_NAME_RE})?|${WINDOW_NAME_RE})\s+limit\s+reached\b`,
  "i",
);

// A reset that already fired waits a cooldown before the next try. It
// escalates with the job's prior quota pauses: a reset read as fired again
// and again (a lagging server, a DST fall-back hour) must not spend the pause
// caps within minutes.
export const PROVIDER_QUOTA_JUST_RESET_COOLDOWNS_SEC = Object.freeze([60, 5 * 60, 15 * 60, 30 * 60, 60 * 60]);
export const PROVIDER_QUOTA_JUST_RESET_COOLDOWN_SEC = PROVIDER_QUOTA_JUST_RESET_COOLDOWNS_SEC[0];
// A dateless session-window reset never pauses longer than this: a misread
// clock must not park a provider for most of a day.
export const PROVIDER_QUOTA_SESSION_MAX_WAIT_SEC = 6 * 60 * 60;
// A reset further out than this (a weekly cap) makes the provider unavailable
// for the run rather than a wait.
export const PROVIDER_QUOTA_MAX_RESET_WAIT_SEC = 24 * 60 * 60;
// Upper bound on a provider pause for a dated reset (a weekly window plus
// slack), so a misparsed date cannot pause a provider indefinitely.
export const PROVIDER_QUOTA_MAX_LONG_PAUSE_SEC = 8 * 24 * 60 * 60;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const FIXED_ZONE_OFFSET_MIN = {
  utc: 0, gmt: 0, z: 0,
  est: -5 * 60, edt: -4 * 60,
  cst: -6 * 60, cdt: -5 * 60,
  mst: -7 * 60, mdt: -6 * 60,
  pst: -8 * 60, pdt: -7 * 60,
};

const RESET_CLOCK_RE = new RegExp([
  // Lead: "resets", "reset at", "will reset at", "try again at", "available again at".
  String.raw`\b(?:resets?|(?:try|retry|available)(?:\s+again)?)(?:[^\d\n·∙]{0,24}?\s(?:at|on))?\s+`,
  // Optional date: "Oct 9, ", "Oct 9, 2027, ", "Oct 3rd, 2026 at ".
  String.raw`(?:(${MONTH_RE})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?`,
  // Clock: "5:40pm", "5pm", "17:40", "3:45 PM".
  String.raw`(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\b\.?)?`,
  // Codex /status suffix: "16:00 on 21 July".
  String.raw`(?:\s+on\s+(\d{1,2})\s+(${MONTH_RE}))?`,
  // Zone: "(UTC)", "(America/New_York)", " UTC", " GMT+2", " PDT".
  String.raw`(?:\s*\(([^)\n]{1,48})\)|\s+((?:utc|gmt)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?|z|[ecmp][sd]t)\b)?`,
].join(""), "gi");

// Legacy Claude CLI form: "Claude AI usage limit reached|1749924000".
const EPOCH_RESET_RE = /\blimit reached\|(\d{10,13})\b/i;

const LIMIT_NAME_RE = /\b(?:(opus|sonnet|fable|haiku)\s+(?=(?:session|weekly|daily|5[- ]?hour|five[- ]hour)[\s_-]+limit\b))?(session|weekly|usage|rate|daily|5[- ]?hour|five[- ]hour|opus|sonnet|fable|haiku)[\s_-]+limit\b/i;
// Model-scoped caps leave other models on the same provider usable, so they
// are an operator decision rather than a provider-wide pause.
const MODEL_QUOTA_RE = new RegExp([
  String.raw`\b(?:hit|reached) your ${MODEL_NAME_RE}\b[^\n.·∙]{0,24}\blimit\b`,
  String.raw`\b${MODEL_NAME_RE}(?:\s+${WINDOW_NAME_RE})?\s+limit\s+reached\b`,
  String.raw`\busage limit for\s+(?=[\w.-]*\d)[a-z][\w.-]*`,
].join("|"), "i");
// Billing exhaustion does not reset on a clock.
const BILLING_QUOTA_RE = /credit balance is too low|check your plan and billing|insufficient_quota|upgrade to (?:plus|pro|team)\b[^.\n]{0,40}\bto continue/i;

function monthIndex(text) {
  const index = MONTHS.indexOf(String(text || "").slice(0, 3).toLowerCase());
  return index >= 0 ? index : null;
}

function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Resolve a zone named by the message (or the host zone when it names none)
// to either a fixed UTC offset or a validated IANA zone. An unrecognized
// explicit zone returns null: guessing would mis-time the pause.
function resolveZone(raw, fallbackZone) {
  const text = String(raw || "").trim();
  if (!text) {
    const host = resolveZone(fallbackZone || hostTimeZone(), null);
    return host ? { ...host, source: "host" } : null;
  }
  const fixed = /^(utc|gmt|z|[ecmp][sd]t)(?:\s*([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(text);
  if (fixed) {
    const base = FIXED_ZONE_OFFSET_MIN[fixed[1].toLowerCase()];
    const sign = fixed[2] === "-" ? -1 : 1;
    const extra = fixed[2] ? sign * ((Number(fixed[3]) * 60) + Number(fixed[4] || 0)) : 0;
    const name = fixed[1].toLowerCase() === "z" ? "UTC" : text.toUpperCase().replace(/\s+/g, "");
    return { name, offsetMin: base + extra, source: "message" };
  }
  try {
    const iana = new Intl.DateTimeFormat("en-US", { timeZone: text }).resolvedOptions().timeZone;
    return { name: iana, iana, source: "message" };
  } catch {
    return null;
  }
}

function zonedParts(utcMs, zone) {
  if (zone.offsetMin != null) {
    const shifted = new Date(utcMs + zone.offsetMin * 60_000);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth(),
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    };
  }
  const parts = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: zone.iana,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month - 1,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

function zoneOffsetMs(utcMs, zone) {
  if (zone.offsetMin != null) return zone.offsetMin * 60_000;
  const p = zonedParts(utcMs, zone);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - (utcMs - (utcMs % 1000));
}

// Wall-clock time in `zone` to epoch ms. Date.UTC normalizes day overflow,
// so day + 1 crosses month/year ends; the second pass settles DST shifts. A
// wall time skipped by a spring-forward gap resolves to the first instant
// after the gap rather than an hour early.
function zonedWallTimeToUtcMs(year, month, day, hour, minute, zone) {
  const asUtc = Date.UTC(year, month, day, hour, minute, 0, 0);
  const firstPass = asUtc - zoneOffsetMs(asUtc, zone);
  const secondPass = asUtc - zoneOffsetMs(firstPass, zone);
  const landed = zonedParts(secondPass, zone);
  return landed.hour === hour && landed.minute === minute ? secondPass : Math.max(firstPass, secondPass);
}

export function formatQuotaResetLabel(resetAtMs, zone = { name: "UTC", offsetMin: 0 }, nowMs = Date.now()) {
  const target = zonedParts(resetAtMs, zone);
  const today = zonedParts(nowMs, zone);
  const clock = `${String(target.hour).padStart(2, "0")}:${String(target.minute).padStart(2, "0")}`;
  const sameDay = target.year === today.year && target.month === today.month && target.day === today.day;
  const date = sameDay ? "" : `${MONTHS[target.month][0].toUpperCase()}${MONTHS[target.month].slice(1)} ${target.day} `;
  return `${date}${clock} ${zone.name}`;
}

// Pick the reset a dated clock names. Without a year the nearest of last,
// this and next year's date wins, so a date that passed moments ago reads as
// fired rather than a year out.
function pickDatedReset(candidates, nowMs) {
  const justFired = candidates.find((ms) => ms <= nowMs && nowMs - ms <= JUST_RESET_GRACE_MS);
  if (justFired != null) return justFired;
  return [...candidates].sort((a, b) => Math.abs(a - nowMs) - Math.abs(b - nowMs))[0];
}

// Pick the reset a dateless clock names from yesterday's, today's and
// tomorrow's occurrence. The CLIs print a reset that is still ahead, and
// Codex prints a dateless clock only for a reset later the same day, so:
// - a clock a few minutes past (yesterday's, just across midnight, too) is
//   the reset that fired while the failure unwound;
// - today's occurrence still ahead is the reset, however far ahead;
// - a clock that passed today names tomorrow's reset when that is within the
//   session horizon (just after midnight) or the window is weekly or daily;
// - otherwise the nearer reading wins: a clock a short while ago is a reset
//   that fired before this observation, not the same time tomorrow.
function pickTimeOfDayReset([yesterday, today, tomorrow], nowMs, { longWindow = false } = {}) {
  const justFired = [today, yesterday].find((ms) => ms <= nowMs && nowMs - ms <= JUST_RESET_GRACE_MS);
  if (justFired != null) return justFired;
  if (today > nowMs) return today;
  if (tomorrow - nowMs <= SESSION_RESET_HORIZON_MS || longWindow) return tomorrow;
  return nowMs - today < tomorrow - nowMs ? today : tomorrow;
}

function resetFromClockMatch(match, { nowMs, timeZone, longWindow = false }) {
  const [, monthText, dayText, yearText, hourText, minuteText, meridiem, suffixDayText, suffixMonthText, parenZone, bareZone] = match;
  if (minuteText == null && !meridiem) return null;
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.toLowerCase() === "p" && hour < 12) hour += 12;
    if (meridiem.toLowerCase() === "a" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;

  const zone = resolveZone(parenZone || bareZone || "", timeZone);
  if (!zone) return null;

  const explicitMonth = monthText != null ? monthIndex(monthText) : (suffixMonthText != null ? monthIndex(suffixMonthText) : null);
  const explicitDay = dayText != null ? Number(dayText) : (suffixDayText != null ? Number(suffixDayText) : null);
  const explicitYear = yearText != null ? Number(yearText) : null;
  if ((monthText != null || suffixMonthText != null) && (explicitMonth == null || !(explicitDay >= 1 && explicitDay <= 31))) return null;

  const today = zonedParts(nowMs, zone);
  const dated = explicitMonth != null;
  let resetAtMs;
  if (dated) {
    // An explicit full date already in the past means the reset has fired.
    const years = explicitYear != null ? [explicitYear] : [today.year - 1, today.year, today.year + 1];
    resetAtMs = pickDatedReset(years.map((year) => zonedWallTimeToUtcMs(year, explicitMonth, explicitDay, hour, minute, zone)), nowMs);
  } else {
    resetAtMs = pickTimeOfDayReset(
      [-1, 0, 1].map((offset) => zonedWallTimeToUtcMs(today.year, today.month, today.day + offset, hour, minute, zone)),
      nowMs,
      { longWindow },
    );
  }
  if (!Number.isFinite(resetAtMs)) return null;
  return {
    resetAtMs,
    timeZone: zone.name,
    zoneSource: zone.source,
    label: formatQuotaResetLabel(resetAtMs, zone, nowMs),
    matched: match[0].trim(),
    dated,
  };
}

/**
 * Parse the reset time out of a provider quota message, read as of `nowMs`
 * (pass the moment the message was first observed: a dateless clock is
 * resolved relative to it). `dated` is true when the message names the date
 * (or an epoch), false for a time of day.
 * @returns {{ resetAtMs: number, timeZone: string, zoneSource: string, label: string, matched: string, dated: boolean } | null}
 */
export function parseProviderQuotaReset(text, { nowMs = Date.now(), timeZone = null } = {}) {
  const message = String(text || "");
  if (!message) return null;
  const epoch = EPOCH_RESET_RE.exec(message);
  if (epoch) {
    const raw = Number(epoch[1]);
    const resetAtMs = epoch[1].length > 10 ? raw : raw * 1000;
    if (Number.isFinite(resetAtMs) && resetAtMs > 0) {
      const zone = { name: "UTC", offsetMin: 0 };
      return {
        resetAtMs,
        timeZone: zone.name,
        zoneSource: "epoch",
        label: formatQuotaResetLabel(resetAtMs, zone, nowMs),
        matched: epoch[0],
        dated: true,
      };
    }
  }
  const longWindow = LONG_WINDOW_LIMIT_RE.test(message);
  for (const match of message.matchAll(RESET_CLOCK_RE)) {
    const reset = resetFromClockMatch(match, { nowMs, timeZone, longWindow });
    if (reset) return reset;
  }
  return null;
}

/** True for a quota named after Claude's 5-hour session window. */
export function isSessionWindowQuota(quota) {
  return SESSION_WINDOW_LIMIT_RE.test(String(quota?.limitName || ""));
}

/**
 * The cooldown before retrying a reset that already fired, escalating with
 * the job's prior consecutive quota pauses: 1m, 5m, 15m, 30m, then 1h.
 */
export function providerQuotaJustResetCooldownSec(priorPauses = 0) {
  const index = Math.max(0, Math.floor(Number(priorPauses) || 0));
  return PROVIDER_QUOTA_JUST_RESET_COOLDOWNS_SEC[Math.min(index, PROVIDER_QUOTA_JUST_RESET_COOLDOWNS_SEC.length - 1)];
}

/**
 * Seconds from `nowMs` until a described quota's parsed reset, as a pause
 * length: a reset that already fired gets the just-reset cooldown (escalated
 * by `priorPauses`), and a dateless session-window reset is clamped to the
 * session maximum. Any other reset (dated, weekly, or a Codex same-day clock)
 * is returned unclamped.
 * @param {{ limitName?: string, reset?: { resetAtMs: number, dated?: boolean } | null }} quota
 * @param {number} [nowMs]
 * @param {{ priorPauses?: number }} [options]
 * @returns {number|null} null when the quota has no parsed reset.
 */
export function providerQuotaResetWaitSec(quota, nowMs = Date.now(), { priorPauses = 0 } = {}) {
  const resetAtMs = Number(quota?.reset?.resetAtMs);
  if (!Number.isFinite(resetAtMs)) return null;
  const waitSec = Math.ceil((resetAtMs - nowMs) / 1000);
  if (waitSec <= 0) return providerQuotaJustResetCooldownSec(priorPauses);
  if (quota.reset.dated === true || !isSessionWindowQuota(quota)) return waitSec;
  return Math.min(waitSec, PROVIDER_QUOTA_SESSION_MAX_WAIT_SEC);
}

/**
 * Describe a provider quota message: its scope (account-wide window, a single
 * model's cap, or billing), the named limit, and the parsed reset if any.
 */
export function describeProviderQuota(text, { nowMs = Date.now(), timeZone = null, reset } = {}) {
  const message = String(text || "");
  const scope = BILLING_QUOTA_RE.test(message)
    ? PROVIDER_QUOTA_SCOPES.BILLING
    : (MODEL_QUOTA_RE.test(message) ? PROVIDER_QUOTA_SCOPES.MODEL : PROVIDER_QUOTA_SCOPES.ACCOUNT);
  const limitMatch = LIMIT_NAME_RE.exec(message);
  // "5-hour limit" is Claude's session window; name it so.
  const windowName = limitMatch ? limitMatch[2].toLowerCase().replace(/^(?:5[- ]?hour|five[- ]hour)$/, "session") : null;
  const limitName = limitMatch
    ? `${limitMatch[1] ? `${limitMatch[1].toLowerCase()} ` : ""}${windowName} limit`
    : "usage limit";
  return {
    scope,
    limitName,
    reset: reset === undefined ? parseProviderQuotaReset(message, { nowMs, timeZone }) : reset,
  };
}

/** True for classifyProviderError results that describe a subscription quota. */
export function isProviderQuotaBackoff(backoff) {
  return backoff?.source === "usage_reset" || backoff?.source === "usage_limit";
}
