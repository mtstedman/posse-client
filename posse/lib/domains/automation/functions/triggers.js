import { demand, object } from "./policy.js";

const MAX_CRON_SCAN_MINUTES = 2 * 366 * 24 * 60;
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

export function previewOccurrences(trigger, count = 5, afterMs = Date.now()) {
  const out = []; let cursor = afterMs, lastLocalKey = null;
  for (let index = 0; index < Math.max(1, Math.min(20, count)); index++) {
    const next = nextOccurrence(trigger, cursor, { lastLocalKey });
    if (!next) break;
    out.push(new Date(next.at).toISOString()); cursor = next.at; lastLocalKey = next.localKey;
  }
  return out;
}

function nextCronOccurrence(trigger, afterMs, lastLocalKey) {
  const cron = parseCron(trigger.expression), fmt = formatter(trigger.timezone);
  let current = Math.floor(afterMs / 60000) * 60000;
  let previousParts = localParts(fmt, current);
  for (let scanned = 0; scanned < MAX_CRON_SCAN_MINUTES; scanned++) {
    current += 60000;
    const parts = localParts(fmt, current);
    const localKey = wallKey(parts);
    if (matchesCron(cron, parts) && (trigger.dst.repeat === "twice" || localKey !== lastLocalKey)) {
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
    previousParts = parts;
  }
  demand(false, "Cron trigger has no occurrence within two years", "invalid_trigger");
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
  const dayMatch = cron.day.has(parts.day), weekdayMatch = cron.weekday.has(parts.weekday);
  const calendarMatch = cron.dayWildcard ? weekdayMatch : cron.weekdayWildcard ? dayMatch : dayMatch || weekdayMatch;
  return cron.minute.has(parts.minute) && cron.hour.has(parts.hour) && cron.month.has(parts.month) && calendarMatch;
}
