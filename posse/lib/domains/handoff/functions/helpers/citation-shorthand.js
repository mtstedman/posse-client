import { AGENT_HANDOFF_LIMITS } from "../../../../catalog/handoff.js";

// Return only delivered segments. Missing boundary lines and wider internal
// gaps are not shorthand, and source bytes must still be validated by caller.
export function narrowCitationSegments(ranges, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || end < start || end - start + 1 > AGENT_HANDOFF_LIMITS.maxSelectorLines) return null;
  const segments = [];
  for (const range of ranges
    .filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
      && range.end >= start && range.start <= end)
    .map((range) => ({ start: Math.max(start, range.start), end: Math.min(end, range.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = segments.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else segments.push(range);
  }
  if (segments.length < 2 || segments[0].start !== start || segments.at(-1).end !== end
    || segments.some((range, i) => i > 0
      && range.start - segments[i - 1].end - 1 > AGENT_HANDOFF_LIMITS.maxShorthandGapLines)) return null;
  return segments;
}
