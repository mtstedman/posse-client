import { AGENT_HANDOFF_LIMITS } from "../../../../catalog/handoff.js";

// Intersect the citation with delivered ranges. Missing endpoints and internal
// gaps contribute no evidence; source bytes must still be validated by caller.
export function narrowCitationSegments(ranges, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start) return null;
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
  if (segments.length === 0 || segments.reduce((sum, range) => sum + range.end - range.start + 1, 0)
    > AGENT_HANDOFF_LIMITS.maxSelectorLines) return null;
  return segments;
}
