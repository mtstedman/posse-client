// @ts-check
//
// Per-edge SCIP/tree-sitter call dedupe for one blob's layer merge.
//
// A tree-sitter `calls` edge is dropped iff a SCIP `calls` edge in the same
// merged blob calls the same callee at the same call site:
//   (a) both byte ranges are known and overlap
//       (a.start < b.end && b.start < a.end), or
//   (b) both start lines are known and equal.
// Callees compare case-sensitively on the last segment of `to_name` after
// splitting on '.', '::', '#', '->', with one trailing '!' stripped (Rust
// macro `assert_eq!` vs SCIP `assert_eq`); an empty callee never matches.
// The callee check keeps an outer tree-sitter call whose range (the whole
// call expression, arguments included) merely contains a SCIP call to
// something else. Missing ranges fall back to (b); a missing line as well
// keeps the edge. Tree-sitter calls SCIP never recorded are kept, whatever
// the layer's call-proof coverage says. Posse-bin's native view merge applies
// the same rule.

/**
 * @typedef {{
 *   start: number | null,
 *   end: number | null,
 *   line: number | null,
 *   name: string | null | undefined,
 * }} CallSite
 */

const CALLEE_SEPARATORS = /\.|::|#|->/;

/**
 * @param {string | null | undefined} name
 * @returns {string}
 */
function calleeName(name) {
  if (typeof name !== "string" || !name) return "";
  const parts = name.split(CALLEE_SEPARATORS);
  const segment = parts[parts.length - 1];
  return segment.endsWith("!") ? segment.slice(0, -1) : segment;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function callSiteOffset(value) {
  return Number.isInteger(value) ? /** @type {number} */ (value) : null;
}

/**
 * Build a matcher answering "is this tree-sitter call site already a SCIP
 * call site?" for one blob.
 *
 * @param {CallSite[]} scipSites
 * @returns {(site: CallSite) => boolean}
 */
export function scipCallSiteMatcher(scipSites) {
  /** @type {Map<string, Array<{ start: number, end: number }>>} */
  const rangesByCallee = new Map();
  /** @type {Set<string>} */
  const lineCallees = new Set();
  for (const site of scipSites) {
    const callee = calleeName(site.name);
    if (!callee) continue;
    if (site.start != null && site.end != null) {
      const ranges = rangesByCallee.get(callee) ?? [];
      ranges.push({ start: site.start, end: site.end });
      rangesByCallee.set(callee, ranges);
    }
    if (site.line != null) lineCallees.add(`${site.line}\0${callee}`);
  }
  /** @type {Map<string, { starts: number[], prefixMaxEnd: number[] }>} */
  const overlapIndex = new Map();
  for (const [callee, ranges] of rangesByCallee) {
    ranges.sort((left, right) => left.start - right.start);
    // prefixMaxEnd[i] = max end over ranges[0..i]; ranges starting before a
    // site's end overlap it iff the largest of their ends exceeds its start.
    const prefixMaxEnd = [];
    let maxEnd = -Infinity;
    for (const range of ranges) {
      maxEnd = Math.max(maxEnd, range.end);
      prefixMaxEnd.push(maxEnd);
    }
    overlapIndex.set(callee, { starts: ranges.map((range) => range.start), prefixMaxEnd });
  }

  return (site) => {
    const callee = calleeName(site.name);
    if (!callee) return false;
    const index = overlapIndex.get(callee);
    if (index && site.start != null && site.end != null) {
      const count = countBelow(index.starts, site.end);
      if (count > 0 && index.prefixMaxEnd[count - 1] > site.start) return true;
    }
    return site.line != null && lineCallees.has(`${site.line}\0${callee}`);
  };
}

/**
 * Number of sorted values strictly below `limit`.
 * @param {number[]} sorted
 * @param {number} limit
 */
function countBelow(sorted, limit) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < limit) low = mid + 1;
    else high = mid;
  }
  return low;
}
