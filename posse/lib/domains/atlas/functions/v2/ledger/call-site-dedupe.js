// @ts-check
//
// Per-edge SCIP/tree-sitter call dedupe for one blob's layer merge.
//
// Matching is one-to-one: each SCIP `calls` edge drops at most one
// tree-sitter `calls` edge with an equal callee, and each tree-sitter call is
// dropped at most once. Callees compare case-sensitively on the last segment
// of `to_name` after splitting on '.', '::', '#', '->', with one trailing '!'
// stripped (Rust macro `assert_eq!` vs SCIP `assert_eq`); an empty callee
// never matches. SCIP calls are processed by known start offset (unknown
// last), then known start line (unknown last), then candidate order. For
// each, among the still-unmatched same-callee tree-sitter calls:
//   (a) those whose byte range overlaps the SCIP call's (both known,
//       a.start < b.end && b.start < a.end) are tried first, taking the
//       innermost: smallest end - start, then larger start, then earlier
//       candidate order;
//   (b) otherwise the first one in candidate order whose known start line
//       equals the SCIP call's.
// Tree-sitter call ranges span the whole call expression (arguments and
// chain receiver included) while SCIP ranges span the callee identifier, so
// in `q.f(a).f(b)` both tree-sitter `f` calls overlap the inner SCIP `f`;
// innermost one-to-one matching pairs each SCIP call with its own expression.
// A tree-sitter call with neither a range nor a line is kept, as is every
// tree-sitter call SCIP never recorded, whatever the layer's call-proof
// coverage says. Posse-bin's native view merge applies the same rule.

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
 * Which merge candidates are tree-sitter calls to drop at a SCIP call site.
 *
 * @param {Array<{ kind: string, source: string, site: CallSite }>} candidates
 * @returns {boolean[]} per candidate, whether it is dropped
 */
export function treesitterCallsAtScipSites(candidates) {
  const dropped = candidates.map(() => false);
  /** @type {Map<string, number[]>} */
  const treesitterByCallee = new Map();
  /** @type {Array<{ index: number, callee: string }>} */
  const scipCalls = [];
  candidates.forEach(({ kind, source, site }, index) => {
    if (kind !== "calls") return;
    const callee = calleeName(site.name);
    if (!callee) return;
    if (source === "treesitter") {
      const indices = treesitterByCallee.get(callee) ?? [];
      indices.push(index);
      treesitterByCallee.set(callee, indices);
    } else if (source === "scip") {
      scipCalls.push({ index, callee });
    }
  });
  scipCalls.sort((left, right) => (
    compareKnownFirst(candidates[left.index].site.start, candidates[right.index].site.start)
    || compareKnownFirst(candidates[left.index].site.line, candidates[right.index].site.line)
    || left.index - right.index
  ));
  for (const { index: scipIndex, callee } of scipCalls) {
    const treesitter = treesitterByCallee.get(callee);
    if (!treesitter) continue;
    const scip = candidates[scipIndex].site;
    let matched = -1;
    if (scip.start != null && scip.end != null) {
      let bestSpan = Infinity;
      let bestStart = -Infinity;
      for (const index of treesitter) {
        const { start, end } = candidates[index].site;
        if (dropped[index] || start == null || end == null) continue;
        if (!(start < scip.end && scip.start < end)) continue;
        const span = end - start;
        if (span < bestSpan || (span === bestSpan && start > bestStart)) {
          matched = index;
          bestSpan = span;
          bestStart = start;
        }
      }
    }
    if (matched < 0 && scip.line != null) {
      matched = treesitter.find((index) => !dropped[index] && candidates[index].site.line === scip.line) ?? -1;
    }
    if (matched >= 0) dropped[matched] = true;
  }
  return dropped;
}

/**
 * Ascending order with null (unknown) after every known value.
 * @param {number | null} left
 * @param {number | null} right
 */
function compareKnownFirst(left, right) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return left - right;
}
