// Protect subprocess evidence from credentials held by the parent process.
const SENSITIVE_PARENT_ENV_NAME_RE = /(?:^|_)(?:api_?key|access_?key|private_?key|token|secret|credential|password|passwd|pwd|auth|oauth|bearer|pat|cookie)(?:_|$)|(?:^|_)session_(?:key|id)(?:_|$)|^posse_key$/i;

export function parentSecretValues(baseEnv = process.env) {
  return [...new Set(Object.entries(baseEnv || {})
    .filter(([key, value]) => !/^(?:OLD)?PWD$/i.test(key) && SENSITIVE_PARENT_ENV_NAME_RE.test(key) && String(value || "").length >= 6)
    .map(([, value]) => String(value)))]
    .sort((a, b) => b.length - a.length);
}

// Length of the longest prefix of pattern which is a suffix of text. The
// linear scan avoids quadratic work for long, repeated private input values.
function boundaryOverlap(pattern, text) {
  if (!pattern || !text) return 0;
  const fallback = new Uint32Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i += 1) {
    while (matched && pattern[i] !== pattern[matched]) matched = fallback[matched - 1];
    if (pattern[i] === pattern[matched]) matched += 1;
    fallback[i] = matched;
  }
  let matched = 0;
  for (let i = Math.max(0, text.length - pattern.length); i < text.length; i += 1) {
    while (matched && text[i] !== pattern[matched]) matched = fallback[matched - 1];
    if (text[i] === pattern[matched]) matched += 1;
  }
  return matched;
}

// A boundary fragment shorter than this is too ambiguous to attribute to a
// secret: most truncated output starts or ends with a character some
// credential also contains, and so short a fragment reveals nothing. Matches
// the minimum literal length redactSecretValues accepts.
const MIN_BOUNDARY_OVERLAP = 4;

// Match original text so overlapping values cannot obscure one another. Keep
// only each literal's next occurrence, then merge overlapping match intervals.
// Truncated boundaries participate in the same union: masking a fragment also
// masks every complete value crossing that boundary, including overlap chains.
export function redactLiteralValues(value, replacements, { truncatedStart = false, truncatedEnd = false } = {}) {
  let text = String(value ?? "");
  if (truncatedStart) text = text.replace(/^\uFFFD+/, "");
  if (truncatedEnd) text = text.replace(/\uFFFD+$/, "");
  const matches = [];
  const seen = new Set();
  let start = 0, end = 0;
  for (const [literal, label] of replacements) {
    if (typeof literal !== "string" || !literal || seen.has(literal)) continue;
    seen.add(literal);
    matches.push({ literal, label, next: text.indexOf(literal), length: literal.length });
    if (truncatedStart) start = Math.max(start, boundaryOverlap(text.slice(0, literal.length), literal));
    if (truncatedEnd) end = Math.max(end, boundaryOverlap(literal, text));
  }
  const boundaryLabel = "[REDACTED:truncated-secret]";
  if (start >= MIN_BOUNDARY_OVERLAP) matches.push({ next: 0, length: start, label: boundaryLabel, boundary: true });
  if (end >= MIN_BOUNDARY_OVERLAP) matches.push({ next: text.length - end, length: end, label: boundaryLabel, boundary: true });
  let cursor = 0, output = "";
  while (true) {
    let first = null;
    for (const match of matches) {
      if (match.next >= 0 && (!first || match.next < first.next
        || (match.next === first.next && match.length > first.length))) first = match;
    }
    if (!first) break;
    const from = first.next;
    let to = from + first.length, label = first.label, expanded;
    do {
      expanded = false;
      for (const match of matches) {
        while (match.next >= 0 && match.next < to) {
          to = Math.max(to, match.next + match.length);
          if (match.boundary) label = boundaryLabel;
          match.next = match.literal ? text.indexOf(match.literal, match.next + 1) : -1;
          expanded = true;
        }
      }
    } while (expanded);
    output += text.slice(cursor, from) + label;
    cursor = to;
  }
  return output + text.slice(cursor);
}

export function redactExactValues(value, secrets, options = {}) {
  return redactLiteralValues(value, secrets.map(secret => [secret, "[REDACTED:parent-env]"]), options);
}
