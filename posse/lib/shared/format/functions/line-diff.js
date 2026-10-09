// lib/shared/format/functions/line-diff.js
//
// In-process unified line diff between two texts (Myers' O((N+M)D) greedy
// algorithm after trimming the common prefix and suffix). Used where the
// harness compares content it already holds, so no subprocess is involved.

const DEFAULT_CONTEXT_LINES = 3;
// Edit distances beyond this are reported as unavailable rather than computed;
// callers fall back to describing the file as rewritten.
const DEFAULT_MAX_EDIT_DISTANCE = 4000;

function splitLines(text) {
  const value = String(text ?? "");
  if (value === "") return [];
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Shortest edit script between two line arrays, as ["=", "-", "+"] ops, or null
 * when the edit distance exceeds maxEditDistance.
 */
function editScript(a, b, maxEditDistance) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, maxEditDistance); d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
    if (found) break;
  }
  if (!found) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("="); x -= 1; y -= 1; }
    if (d > 0) ops.push(x === prevX ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/**
 * Unified diff of `before` -> `after` for one path, or "" when equal. Returns
 * null when the files differ too much to diff within maxEditDistance.
 *
 * @param {string | null} before
 * @param {string | null} after
 * @param {{ path?: string, context?: number, maxEditDistance?: number }} [options]
 * @returns {string | null}
 */
export function unifiedLineDiff(before, after, {
  path = "file",
  context = DEFAULT_CONTEXT_LINES,
  maxEditDistance = DEFAULT_MAX_EDIT_DISTANCE,
} = {}) {
  if ((before ?? null) === (after ?? null)) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const middle = editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), maxEditDistance);
  if (!middle) return null;
  const ops = [...Array(prefix).fill("="), ...middle, ...Array(suffix).fill("=")];

  // Walk the script once, recording each op's line in a and b.
  const rows = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    rows.push({ op, ai, bi });
    if (op !== "+") ai += 1;
    if (op !== "-") bi += 1;
  }
  const changed = rows.map((row, index) => (row.op === "=" ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return "";

  // Group changed rows into hunks whose context windows overlap.
  const hunks = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(rows.length - 1, changed[0] + context);
  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(rows.length - 1, index + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(rows.length - 1, index + context);
    }
  }
  hunks.push([start, end]);

  const out = [`--- ${before == null ? "/dev/null" : `a/${path}`}`, `+++ ${after == null ? "/dev/null" : `b/${path}`}`];
  for (const [from, to] of hunks) {
    const slice = rows.slice(from, to + 1);
    const aCount = slice.filter((row) => row.op !== "+").length;
    const bCount = slice.filter((row) => row.op !== "-").length;
    const aStart = aCount === 0 ? slice[0].ai : slice[0].ai + 1;
    const bStart = bCount === 0 ? slice[0].bi : slice[0].bi + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const row of slice) {
      if (row.op === "=") out.push(` ${a[row.ai]}`);
      else if (row.op === "-") out.push(`-${a[row.ai]}`);
      else out.push(`+${b[row.bi]}`);
    }
  }
  return `${out.join("\n")}\n`;
}
