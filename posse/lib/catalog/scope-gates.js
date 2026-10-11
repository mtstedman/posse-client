// Title signals for a broad task whose declared writable scope is narrow.
// Strong signals can enforce the gate; weak signals only warrant a warning.
export const BROAD_SCOPE_STRONG_TITLE_PATTERNS = Object.freeze([
  /\bsitewide\b/i,
  /\bcross[- ]page\b/i,
  /\b(?:all|every)\s+(?:pages|forms|routes|views)\b/i,
  /\bwhole\s+(?:site|app)\b/i,
  /\baudit\b/i,
]);

export const BROAD_SCOPE_WEAK_TITLE_PATTERNS = Object.freeze([
  /\breview\b/i,
  /\bux\b/i,
  /\bui\b/i,
  /\bflow\b/i,
  /\bforms?\b/i,
  /\bpages?\b/i,
  /\boverall\b/i,
  /\bpolish\b/i,
  /\bglow[- ]?up\b/i,
  /\bhigh value\b/i,
  /\bedge cases?\b/i,
]);
