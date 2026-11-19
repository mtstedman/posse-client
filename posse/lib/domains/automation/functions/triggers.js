import { demand, object } from "./policy.js";

const MAX_CRON_SCAN_MINUTES = 2 * 366 * 24 * 60;
const MINUTE_MS = 60000, DAY_MS = 24 * 60 * MINUTE_MS;
const formatterCache = new Map();

export function validateTrigger(value) {
  object(value, ["kind", "at", "every_seconds", "anchor", "expression", "timezone", "dst"], ["kind"]);
  if (value.kind === "once") {
    demand(Number.isFinite(Date.parse(value.at)), "One-time trigger requires an ISO instant");
  } else if (value.kind === "interval") {
    demand(Number.isInteger(value.every_seconds) && value.every_seconds >= 1 && value.every_seconds <= 31536000, "Invalid interval");
    demand(Number.isFinite(Date.parse(value.anchor)), "Interval trigger requires an ISO anchor");
  } else if (value.kind === "cron") {
    parseCron(value.expression);
    formatter(value.timezone);
    object(value.dst, ["gap", "repeat"], ["gap", "repeat"]);
    demand(["skip", "next_valid"].includes(value.dst.gap), "Invalid DST gap policy");
    demand(["once", "second", "twice"].includes(value.dst.repeat), "Invalid DST repeat policy");
  } else demand(false, "Unknown trigger kind");
  return structuredClone(value);
}

export function nextOccurrence(trigger, afterMs, { lastLocalKey = null } = {}) {
  validateTrigger(trigger);
  if (trigger.kind === "once") {
    const at = Date.parse(trigger.at);
    return at > afterMs ? { at, localKey: new Date(at).toISOString() } : null;
  }
  if (trigger.kind === "interval") {
    const anchor = Date.parse(trigger.anchor), interval = trigger.every_seconds * 1000;
    const at = afterMs < anchor ? anchor : anchor + (Math.floor((afterMs - anchor) / interval) + 1) * interval;
    return { at, localKey: new Date(at).toISOString() };
  }
  return nextCronOccurrence(trigger, afterMs, lastLocalKey);
}

// Moves a resuming schedule's occurrence forward when it is missing or stale.
// A past occurrence (the schedule was paused, parked for attention, or its
// owner was down) is not owed: resume at the next future one instead of
// firing the backlog. Shared by every scheduler so they cannot drift.
export function advanceStaleOccurrence(schedule, nowMs) {
  if (schedule.next_at != null && schedule.next_at > nowMs) return schedule;
  const next = nextOccurrence(schedule.trigger, nowMs - 1);
  demand(next, "Schedule has no future occurrence", "invalid_trigger");
  schedule.next_at = next.at; schedule.next_local_key = next.localKey;
  return schedule;
}

export function previewOccurrences(trigger, count = 5, afterMs = Date.now()) {
  const out = []; let cursor = afterMs, lastLocalKey = null;
  for (let index = 0; index < Math.max(1, Math.min(20, count)); index++) {
    const next = nextOccurrence(trigger, cursor, { lastLocalKey });
    if (!next) break;
    out.push(new Date(next.at).toISOString()); cursor = next.at; lastLocalKey = next.localKey;
  }
  return out;
}

// Finds the first instant a minute-by-minute scan from afterMs would fire
// at, without visiting every minute. Between offset changes the local wall
// clock runs with real time, so the search jumps straight to the instant
// of the next wall minute the expression matches (stepping by month, day,
// hour, then minute). Every instant it skips matches nothing and lies in a
// stretch of one clock offset, so the scan would have passed it by too. An
// offset change (a DST transition) inside a jump is located exactly, and
// that instant is decided like any other, which applies the DST gap and
// repeat policies to the wall minutes it skips or repeats.
function nextCronOccurrence(trigger, afterMs, lastLocalKey) {
  const cron = parseCron(trigger.expression), fmt = formatter(trigger.timezone);
  const start = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS, limit = start + MAX_CRON_SCAN_MINUTES * MINUTE_MS;
  let current = start, currentParts = localParts(fmt, current);
  for (;;) {
    const next = nextCronCandidate(cron, fmt, current, currentParts, limit);
    if (next == null) break;
    const previousParts = next - MINUTE_MS === current ? currentParts : localParts(fmt, next - MINUTE_MS);
    const parts = localParts(fmt, next);
    const found = cronDecision(trigger, cron, fmt, next, previousParts, parts, lastLocalKey);
    if (found) return found;
    current = next; currentParts = parts;
  }
  demand(false, "Cron trigger has no occurrence within two years", "invalid_trigger");
}

// The scan's decision at one instant, given the wall clock one minute
// earlier: an occurrence, or null to keep going.
function cronDecision(trigger, cron, fmt, current, previousParts, parts, lastLocalKey) {
  const localKey = wallKey(parts);
  if (matchesCron(cron, parts) && (trigger.dst.repeat === "twice" || localKey !== lastLocalKey)) {
    // A repeated hour can contain several scheduled minutes. Comparing only
    // the previous firing misses the second pass through an earlier minute.
    // Inspect the clock transition itself so this also works after restart.
    // A schedule created after the first pass of that wall minute waits for
    // the next day's occurrence when repeat is "once".
    if (trigger.dst.repeat === "once" && hasEarlierWallInstant(fmt, current, parts, localKey)) return null;
    if (trigger.dst.repeat === "second") {
      const repeated = repeatedWallInstant(fmt, current, localKey);
      return { at: repeated || current, localKey };
    }
    return { at: current, localKey };
  }
  if (trigger.dst.gap === "next_valid") {
    const missing = missingWallMinutes(previousParts, parts);
    if (missing.some(candidate => matchesCron(cron, candidate))) return { at: current, localKey };
  }
  return null;
}

// The next instant after `current` (at most `limit`) that the scan could
// act on: the instant of the next matching wall minute at the current clock
// offset, or the first instant of a new offset if the offset changes first.
// The offset is probed at least daily along the jump; no zone changes its
// offset twice within a day.
function nextCronCandidate(cron, fmt, current, currentParts, limit) {
  const wall = wallMs(currentParts), offset = wall - current;
  const matching = nextMatchingWall(cron, wall, wall + (limit - current) + 2 * DAY_MS);
  const candidate = matching == null ? Infinity : matching - offset, end = Math.min(candidate, limit);
  for (let probe = current; probe < end;) {
    const next = Math.min(end, probe + DAY_MS);
    if (wallMs(localParts(fmt, next)) - next !== offset) return firstOffsetChange(fmt, probe, next, offset);
    probe = next;
  }
  return candidate <= limit ? candidate : null;
}

// The first minute in (low, high] whose clock offset differs from `offset`;
// `low` has that offset and `high` does not.
function firstOffsetChange(fmt, low, high, offset) {
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / MINUTE_MS / 2) * MINUTE_MS;
    if (wallMs(localParts(fmt, middle)) - middle === offset) low = middle; else high = middle;
  }
  return high;
}

// The first wall minute after `afterWall` (wall time encoded as UTC
// milliseconds) that the expression matches, stepping by field, or null when
// none falls on or before `limitWall`.
function nextMatchingWall(cron, afterWall, limitWall) {
  let at = afterWall + MINUTE_MS;
  while (at <= limitWall) {
    const date = new Date(at);
    const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate(), hour = date.getUTCHours();
    if (!cron.month.has(month + 1)) at = Date.UTC(year, month + 1, 1);
    else if (!calendarMatches(cron, day, date.getUTCDay())) at = Date.UTC(year, month, day + 1);
    else if (!cron.hour.has(hour)) at = Date.UTC(year, month, day, hour + 1);
    else if (!cron.minute.has(date.getUTCMinutes())) at += MINUTE_MS;
    else return at;
  }
  return null;
}

function hasEarlierWallInstant(fmt, instant, parts, localKey) {
  const windowMinutes = 180;
  const earlier = localParts(fmt, instant - windowMinutes * 60000);
  // Outside a backward transition, avoid scanning the preceding three hours.
  if (wallMs(parts) - wallMs(earlier) >= windowMinutes * 60000) return false;
  for (let offset = 1; offset <= windowMinutes; offset++) {
    if (wallKey(localParts(fmt, instant - offset * 60000)) === localKey) return true;
  }
  return false;
}

function repeatedWallInstant(fmt, first, localKey) {
  for (let offset = 1; offset <= 180; offset++) {
    const candidate = first + offset * 60000;
    if (wallKey(localParts(fmt, candidate)) === localKey) return candidate;
  }
  return null;
}

function formatter(timezone) {
  demand(typeof timezone === "string" && timezone.length > 0 && timezone.length <= 80, "Cron timezone is required");
  if (!formatterCache.has(timezone)) {
    try {
      formatterCache.set(timezone, new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }));
    } catch { demand(false, "Invalid IANA timezone", "invalid_trigger"); }
  }
  return formatterCache.get(timezone);
}

function localParts(fmt, instant) {
  const values = Object.fromEntries(fmt.formatToParts(new Date(instant)).filter(item => item.type !== "literal").map(item => [item.type, item.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), weekday };
}

// Wall-clock time as if it were UTC, in milliseconds.
function wallMs(parts) { return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute); }
function wallKey(parts) { return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`; }
function pad(value) { return String(value).padStart(2, "0"); }

function missingWallMinutes(before, after) {
  const left = Date.UTC(before.year, before.month - 1, before.day, before.hour, before.minute);
  const right = Date.UTC(after.year, after.month - 1, after.day, after.hour, after.minute);
  const gap = Math.round((right - left) / 60000);
  if (gap <= 1 || gap > 180) return [];
  const result = [];
  for (let offset = 1; offset < gap; offset++) {
    const date = new Date(left + offset * 60000);
    result.push({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), weekday: date.getUTCDay() });
  }
  return result;
}

function parseCron(expression) {
  demand(typeof expression === "string", "Cron expression is required");
  const fields = expression.trim().split(/\s+/);
  demand(fields.length === 5, "Cron requires five fields");
  return {
    minute: parseField(fields[0], 0, 59), hour: parseField(fields[1], 0, 23),
    day: parseField(fields[2], 1, 31), month: parseField(fields[3], 1, 12),
    weekday: parseField(fields[4], 0, 7, true),
    dayWildcard: fields[2] === "*", weekdayWildcard: fields[4] === "*",
  };
}

function parseField(text, minimum, maximum, sunday = false) {
  const values = new Set();
  for (const segment of text.split(",")) {
    const [rangeText, stepText] = segment.split("/");
    demand(stepText === undefined || /^\d+$/.test(stepText), "Invalid cron step");
    const step = stepText === undefined ? 1 : Number(stepText);
    demand(step >= 1 && step <= maximum - minimum + 1, "Invalid cron step");
    let start, end;
    if (rangeText === "*") { start = minimum; end = maximum; }
    else if (/^\d+$/.test(rangeText)) { start = Number(rangeText); end = start; }
    else {
      const match = /^(\d+)-(\d+)$/.exec(rangeText); demand(match, "Invalid cron field");
      start = Number(match[1]); end = Number(match[2]);
    }
    demand(start >= minimum && end <= maximum && start <= end, "Cron field is out of range");
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return values;
}

function matchesCron(cron, parts) {
  return cron.minute.has(parts.minute) && cron.hour.has(parts.hour) && cron.month.has(parts.month) && calendarMatches(cron, parts.day, parts.weekday);
}

// Day of month and weekday: either may match when both are restricted.
function calendarMatches(cron, day, weekday) {
  const dayMatch = cron.day.has(day), weekdayMatch = cron.weekday.has(weekday);
  return cron.dayWildcard ? weekdayMatch : cron.weekdayWildcard ? dayMatch : dayMatch || weekdayMatch;
}
